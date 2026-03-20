import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import {
  listTenants,
  getTenant,
  getTenantTokens,
  getTenantDeployments,
  getTenantStatusCounts,
} from "../db/queries";
import { pushCredentials } from "../lib/credentials";
import { provisionTenant } from "../lib/provision";
import { provisionLinearLabels } from "../lib/linear-labels";
import { getDb } from "../db/client";
import { FlyClient } from "../lib/fly";
import { Layout } from "./layout";
import { DashboardPage } from "./dashboard";
import { TenantListPage } from "./tenant-list";
import { TenantDetailPage } from "./tenant-detail";
import {
  SuccessToast,
  ErrorToast,
  InfoToast,
  BulkResultToast,
} from "./actions";

const PLATFORMS = ["slack", "linear", "github"] as const;

type Env = {
  Bindings: ControlPlaneEnv;
  Variables: { accessEmail: string };
};

const portal = new Hono<Env>();

/** Returns true if the request was initiated by HTMX (partial swap). */
function isHtmxRequest(c: {
  req: { header: (name: string) => string | undefined };
}): boolean {
  return c.req.header("hx-request") === "true";
}

// ─── Pages ───────────────────────────────────────────────────────

/** GET /portal/dashboard */
portal.get("/dashboard", async (c) => {
  const counts = await getTenantStatusCounts(c.env);
  const page = <DashboardPage counts={counts} />;

  if (isHtmxRequest(c)) return c.html(page);
  return c.html(
    <Layout email={c.get("accessEmail")} currentPath="/portal/dashboard">
      {page}
    </Layout>,
  );
});

/** GET /portal/tenants */
portal.get("/tenants", async (c) => {
  const tenants = await listTenants(c.env);
  const page = <TenantListPage tenants={tenants} />;

  if (isHtmxRequest(c)) return c.html(page);
  return c.html(
    <Layout email={c.get("accessEmail")} currentPath="/portal/tenants">
      {page}
    </Layout>,
  );
});

/** GET /portal/tenants/:team_id */
portal.get("/tenants/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const tenant = await getTenant(c.env, teamId);
  if (!tenant) return c.html(<ErrorToast message="Tenant not found" />, 404);

  const [tokens, deployments] = await Promise.all([
    getTenantTokens(c.env, teamId),
    getTenantDeployments(c.env, teamId),
  ]);

  const page = (
    <TenantDetailPage
      tenant={tenant}
      tokens={tokens}
      deployments={deployments}
    />
  );

  if (isHtmxRequest(c)) return c.html(page);
  return c.html(
    <Layout
      email={c.get("accessEmail")}
      currentPath={`/portal/tenants/${teamId}`}
    >
      {page}
    </Layout>,
  );
});

// ─── Actions (return toast fragments) ────────────────────────────

/** POST /portal/actions/:team_id/reprovision */
portal.post("/actions/:team_id/reprovision", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);
  const fly = new FlyClient(c.env.FLY_API_TOKEN, c.env.FLY_APP);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant)
    return c.html(<ErrorToast message={`Tenant ${teamId} not found`} />, 404);
  if (tenant.status === "destroyed")
    return c.html(<ErrorToast message="Tenant is destroyed" />, 400);

  // Destroy old machine + volume (best effort)
  if (tenant.fly_machine_id) {
    try {
      await fly.destroyMachine(tenant.fly_machine_id);
    } catch {
      /* best effort */
    }
  }
  if (tenant.fly_volume_id) {
    try {
      await fly.deleteVolume(tenant.fly_volume_id);
    } catch {
      /* best effort */
    }
  }

  await sql`
    UPDATE deployments SET status = 'stopped', finished_at = now()
    WHERE tenant_id = ${teamId} AND status IN ('deploying', 'running')
  `;
  await sql`
    UPDATE tenants SET status = 'pending', fly_machine_id = NULL, fly_volume_id = NULL,
      fly_app_name = NULL, instance_url = NULL, updated_at = now()
    WHERE id = ${teamId}
  `;
  for (const p of PLATFORMS) {
    await c.env.ROUTING_TABLE.delete(`${p}:${teamId}`);
  }

  c.executionCtx.waitUntil(
    provisionTenant(c.env, teamId).catch((err) =>
      console.error(`Reprovisioning failed for ${teamId}:`, err),
    ),
  );

  return c.html(<InfoToast message={`Reprovisioning ${tenant.name}...`} />);
});

/** DELETE /portal/actions/:team_id */
portal.delete("/actions/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);
  const fly = new FlyClient(c.env.FLY_API_TOKEN, c.env.FLY_APP);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant)
    return c.html(<ErrorToast message={`Tenant ${teamId} not found`} />, 404);

  if (tenant.fly_machine_id) {
    try {
      await fly.destroyMachine(tenant.fly_machine_id);
    } catch {
      /* best effort */
    }
  }
  if (tenant.fly_volume_id) {
    try {
      await fly.deleteVolume(tenant.fly_volume_id);
    } catch {
      /* best effort */
    }
  }

  await sql`
    UPDATE deployments SET status = 'stopped', finished_at = now()
    WHERE tenant_id = ${teamId} AND status IN ('deploying', 'running')
  `;
  for (const p of PLATFORMS) {
    await c.env.ROUTING_TABLE.delete(`${p}:${teamId}`);
  }
  await sql`
    UPDATE tenants SET status = 'destroyed', fly_machine_id = NULL, fly_volume_id = NULL,
      instance_url = NULL, updated_at = now()
    WHERE id = ${teamId}
  `;

  return c.html(<SuccessToast message={`Tenant ${tenant.name} destroyed`} />);
});

/** POST /portal/actions/:team_id/push-credentials */
portal.post("/actions/:team_id/push-credentials", async (c) => {
  const teamId = c.req.param("team_id");
  try {
    await pushCredentials(c.env, teamId);
    return c.html(
      <SuccessToast message={`Credentials pushed to ${teamId}`} />,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.html(
      <ErrorToast message={`Push credentials failed: ${message}`} />,
    );
  }
});

/** POST /portal/actions/:team_id/push-labels */
portal.post("/actions/:team_id/push-labels", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [token] = await sql`
    SELECT access_token FROM integration_tokens
    WHERE tenant_id = ${teamId} AND platform = 'linear'
  `;
  if (!token)
    return c.html(
      <ErrorToast message="No Linear integration for this tenant" />,
    );

  try {
    await provisionLinearLabels(token.access_token);
    return c.html(<SuccessToast message={`Labels pushed to ${teamId}`} />);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.html(
      <ErrorToast message={`Push labels failed: ${message}`} />,
    );
  }
});

/** POST /portal/actions/push-credentials — bulk push to all active tenants */
portal.post("/actions/push-credentials", async (c) => {
  const sql = getDb(c.env);
  const tenants = await sql`
    SELECT id FROM tenants WHERE status = 'active' AND fly_machine_id IS NOT NULL
  `;

  let succeeded = 0;
  let failed = 0;
  for (const tenant of tenants) {
    try {
      await pushCredentials(c.env, tenant.id);
      succeeded++;
    } catch {
      failed++;
    }
  }

  return c.html(
    <BulkResultToast
      action="Push credentials"
      total={tenants.length}
      succeeded={succeeded}
      failed={failed}
    />,
  );
});

/** POST /portal/actions/push-labels — bulk push Linear labels */
portal.post("/actions/push-labels", async (c) => {
  const sql = getDb(c.env);
  const tokens = await sql`
    SELECT t.id AS tenant_id, it.access_token
    FROM tenants t
    JOIN integration_tokens it ON it.tenant_id = t.id
    WHERE t.status = 'active' AND it.platform = 'linear'
  `;

  let succeeded = 0;
  let failed = 0;
  for (const row of tokens) {
    try {
      await provisionLinearLabels(row.access_token);
      succeeded++;
    } catch {
      failed++;
    }
  }

  return c.html(
    <BulkResultToast
      action="Push labels"
      total={tokens.length}
      succeeded={succeeded}
      failed={failed}
    />,
  );
});

export default portal;
