import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient, type GuestConfig } from "../lib/fly";
import { pushCredentials } from "../lib/credentials";
import { refreshLinearToken, refreshExpiringTokens } from "../lib/token-refresh";
import { provisionTenant, reprovisionTenant } from "../lib/provision";
import { provisionLinearLabels } from "../lib/linear-labels";

const admin = new Hono<{ Bindings: ControlPlaneEnv }>();

const PLATFORMS = ["slack", "linear", "github"] as const;

/** GET /admin/tenants — list all tenants + status */
admin.get("/tenants", async (c) => {
  const sql = getDb(c.env);
  const tenants = await sql`
    SELECT id, name, platform, status, fly_app_name, fly_machine_id, fly_volume_id, instance_url,
           (anthropic_api_key IS NOT NULL) AS has_custom_anthropic_key,
           created_at, updated_at
    FROM tenants ORDER BY created_at DESC
  `;
  return c.json(tenants);
});

/** GET /admin/tenants/:team_id — single tenant detail + integration status */
admin.get("/tenants/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);

  const tokens = await sql`
    SELECT id, platform, token_type, scopes, created_at
    FROM integration_tokens WHERE tenant_id = ${teamId}
  `;
  const deployments = await sql`
    SELECT * FROM deployments WHERE tenant_id = ${teamId} ORDER BY created_at DESC
  `;

  // Build integration status per platform
  const integrations = PLATFORMS.map((p) => ({
    platform: p,
    connected: tokens.some((t) => t.platform === p),
    token_count: tokens.filter((t) => t.platform === p).length,
  }));

  return c.json({ ...tenant, integrations, tokens, deployments });
});

/** DELETE /admin/tenants/:team_id — destroy machine/app, delete KV entries, mark destroyed */
admin.delete("/tenants/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);

  // Destroy Fly resources: per-tenant app or legacy machine+volume
  if (tenant.fly_app_name && tenant.fly_app_name !== c.env.FLY_APP) {
    // Per-tenant app (vera-ai org): delete the app — bucket is kept
    const fly = new FlyClient(c.env.FLY_API_TOKEN, c.env.FLY_APP);
    try {
      await fly.deleteApp(tenant.fly_app_name);
    } catch (err) {
      console.error(`Fly app deletion failed for ${teamId}:`, err);
    }
  } else {
    // Legacy shared app (personal org)
    const legacyFly = new FlyClient(c.env.FLY_API_TOKEN_LEGACY, c.env.FLY_APP);
    if (tenant.fly_machine_id) {
      try {
        await legacyFly.destroyMachine(tenant.fly_machine_id);
      } catch (err) {
        console.error(`Fly machine cleanup failed for ${teamId}:`, err);
      }
    }
    if (tenant.fly_volume_id) {
      try {
        await legacyFly.deleteVolume(tenant.fly_volume_id);
      } catch (err) {
        console.error(`Fly volume cleanup failed for ${teamId}:`, err);
      }
    }
  }

  // Mark any running deployment as stopped
  await sql`
    UPDATE deployments SET status = 'stopped', finished_at = now()
    WHERE tenant_id = ${teamId} AND status IN ('deploying', 'running')
  `;

  // Remove all KV routes
  for (const p of PLATFORMS) {
    await c.env.ROUTING_TABLE.delete(`${p}:${teamId}`);
  }

  // Mark tenant as destroyed
  await sql`
    UPDATE tenants
    SET status = 'destroyed', fly_machine_id = NULL, fly_volume_id = NULL, fly_app_name = NULL, instance_url = NULL, updated_at = now()
    WHERE id = ${teamId}
  `;

  return c.json({ team_id: teamId, status: "destroyed" });
});

/** POST /admin/tenants/:team_id/reprovision — destroy machine+volume, recreate in same app */
admin.post("/tenants/:team_id/reprovision", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT id, status, fly_app_name FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);
  if (tenant.status === "destroyed") return c.json({ error: "Tenant is destroyed, cannot reprovision" }, 400);

  // Legacy tenants without a per-tenant app need full provisioning
  const handler = tenant.fly_app_name && tenant.fly_app_name !== c.env.FLY_APP
    ? reprovisionTenant
    : provisionTenant;

  c.executionCtx.waitUntil(
    handler(c.env, teamId).catch((err) =>
      console.error(`Reprovisioning failed for ${teamId}:`, err),
    ),
  );

  return c.json({ team_id: teamId, status: "reprovisioning" });
});

/** PATCH /admin/tenants/:team_id/resize — resize a tenant's machine CPU/memory */
admin.patch("/tenants/:team_id/resize", async (c) => {
  const teamId = c.req.param("team_id");
  const body = await c.req.json<{ memory_mb?: number; cpus?: number }>();

  // Validate input
  if (body.memory_mb !== undefined) {
    if (!Number.isInteger(body.memory_mb) || body.memory_mb < 256 || body.memory_mb % 256 !== 0) {
      return c.json({ error: "memory_mb must be a positive integer and a multiple of 256" }, 400);
    }
  }
  if (body.cpus !== undefined) {
    if (!Number.isInteger(body.cpus) || body.cpus < 1) {
      return c.json({ error: "cpus must be a positive integer >= 1" }, 400);
    }
  }
  if (body.memory_mb === undefined && body.cpus === undefined) {
    return c.json({ error: "Request body must include at least one of: memory_mb, cpus" }, 400);
  }

  const sql = getDb(c.env);
  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);

  // Update DB columns
  const newMemory = body.memory_mb ?? tenant.memory_mb;
  const newCpus = body.cpus ?? tenant.cpus;
  await sql`
    UPDATE tenants
    SET memory_mb = ${newMemory}, cpus = ${newCpus}, updated_at = now()
    WHERE id = ${teamId}
  `;

  // If tenant has an active machine, resize it via Fly API
  if (tenant.status === "active" && tenant.fly_machine_id && tenant.fly_app_name) {
    const sharedImage = `registry.fly.io/${c.env.FLY_APP}:latest`;
    const tenantFly = new FlyClient(c.env.FLY_API_TOKEN, tenant.fly_app_name, sharedImage);
    const guest: GuestConfig = {
      cpu_kind: "shared",
      cpus: newCpus ?? 2,
      memory_mb: newMemory ?? 1024,
    };
    try {
      await tenantFly.resizeMachine(tenant.fly_machine_id, guest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({
        team_id: teamId,
        memory_mb: newMemory,
        cpus: newCpus,
        resize_error: message,
      }, 200);
    }
  }

  return c.json({
    team_id: teamId,
    memory_mb: newMemory,
    cpus: newCpus,
    machine_resized: tenant.status === "active" && !!tenant.fly_machine_id,
  });
});

/** PATCH /admin/tenants/:team_id/vera-production — toggle VERA_PRODUCTION for a tenant */
admin.patch("/tenants/:team_id/vera-production", async (c) => {
  const teamId = c.req.param("team_id");
  const body = await c.req.json<{ enabled: boolean }>();

  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "Request body must include { enabled: boolean }" }, 400);
  }

  const sql = getDb(c.env);
  const [tenant] = await sql`SELECT id, status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);

  await sql`
    UPDATE tenants SET vera_production = ${body.enabled}, updated_at = now()
    WHERE id = ${teamId}
  `;

  // Push updated env to the machine if it's active
  if (tenant.status === "active") {
    try {
      await pushCredentials(c.env, teamId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ team_id: teamId, vera_production: body.enabled, push_error: message }, 200);
    }
  }

  return c.json({ team_id: teamId, vera_production: body.enabled });
});

/** POST /admin/tenants/push-credentials — push credentials to all active tenants */
admin.post("/tenants/push-credentials", async (c) => {
  const sql = getDb(c.env);
  const tenants = await sql`
    SELECT id FROM tenants WHERE status = 'active' AND fly_machine_id IS NOT NULL
  `;

  const results: { tenant_id: string; status: "ok" | "error"; error?: string }[] = [];

  for (const tenant of tenants) {
    try {
      await pushCredentials(c.env, tenant.id);
      results.push({ tenant_id: tenant.id, status: "ok" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`pushCredentials failed for ${tenant.id}:`, message);
      results.push({ tenant_id: tenant.id, status: "error", error: message });
    }
  }

  const succeeded = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "error").length;

  return c.json({ total: results.length, succeeded, failed, results });
});

/** POST /admin/tenants/:team_id/push-credentials — push credentials to a single tenant */
admin.post("/tenants/:team_id/push-credentials", async (c) => {
  const teamId = c.req.param("team_id");
  try {
    const result = await pushCredentials(c.env, teamId);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

/** POST /admin/tenants/:team_id/refresh-token — refresh Linear token for a single tenant */
admin.post("/tenants/:team_id/refresh-token", async (c) => {
  const teamId = c.req.param("team_id");

  const refreshed = await refreshLinearToken(c.env, teamId);
  if (!refreshed) return c.json({ error: "Token refresh failed" }, 502);

  try {
    await pushCredentials(c.env, teamId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ team_id: teamId, refreshed: true, push_error: message }, 200);
  }

  return c.json({ team_id: teamId, refreshed: true });
});

/** POST /admin/refresh-tokens — refresh all Linear tokens that have a refresh_token */
admin.post("/refresh-tokens", async (c) => {
  const sql = getDb(c.env);

  const candidates = await sql`
    SELECT it.tenant_id, it.expires_at
    FROM integration_tokens it
    JOIN tenants t ON t.id = it.tenant_id
    WHERE it.platform = 'linear'
      AND it.refresh_token IS NOT NULL
      AND t.status = 'active'
  `;

  if (candidates.length === 0) {
    return c.json({ total: 0, refreshed: 0, failed: 0, results: [], message: "No Linear tokens with refresh_token found" });
  }

  const results: { tenant_id: string; expires_at: string | null; status: "refreshed" | "failed"; error?: string }[] = [];

  for (const { tenant_id, expires_at } of candidates) {
    try {
      const refreshed = await refreshLinearToken(c.env, tenant_id);
      if (!refreshed) {
        results.push({ tenant_id, expires_at, status: "failed", error: "refreshLinearToken returned false" });
        continue;
      }
      await pushCredentials(c.env, tenant_id);
      results.push({ tenant_id, expires_at, status: "refreshed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ tenant_id, expires_at, status: "failed", error: message });
    }
  }

  const refreshed = results.filter((r) => r.status === "refreshed").length;
  const failed = results.filter((r) => r.status === "failed").length;

  return c.json({ total: results.length, refreshed, failed, results });
});

/** POST /admin/tenants/push-labels — provision Linear labels for all tenants with Linear connected */
admin.post("/tenants/push-labels", async (c) => {
  const sql = getDb(c.env);
  const tokens = await sql`
    SELECT t.id AS tenant_id, it.access_token
    FROM tenants t
    JOIN integration_tokens it ON it.tenant_id = t.id
    WHERE t.status = 'active' AND it.platform = 'linear'
  `;

  const results: { tenant_id: string; status: "ok" | "error"; error?: string }[] = [];

  for (const row of tokens) {
    try {
      await provisionLinearLabels(row.access_token);
      results.push({ tenant_id: row.tenant_id, status: "ok" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`pushLabels failed for ${row.tenant_id}:`, message);
      results.push({ tenant_id: row.tenant_id, status: "error", error: message });
    }
  }

  const succeeded = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "error").length;

  return c.json({ total: results.length, succeeded, failed, results });
});

/** POST /admin/tenants/:team_id/push-labels — provision Linear labels for a single tenant */
admin.post("/tenants/:team_id/push-labels", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [token] = await sql`
    SELECT access_token FROM integration_tokens
    WHERE tenant_id = ${teamId} AND platform = 'linear'
  `;
  if (!token) return c.json({ error: "No Linear integration for this tenant" }, 404);

  try {
    await provisionLinearLabels(token.access_token);
    return c.json({ tenant_id: teamId, status: "ok" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

/** GET /admin/tenants/legacy — list tenants still on the shared app */
admin.get("/tenants/legacy", async (c) => {
  const sql = getDb(c.env);
  const legacyTenants = await sql`
    SELECT id, name, status, fly_app_name, fly_machine_id
    FROM tenants
    WHERE status = 'active' AND fly_app_name = ${c.env.FLY_APP}
  `;
  return c.json({ count: legacyTenants.length, tenants: legacyTenants });
});

/** POST /admin/tenants/:team_id/migrate-to-per-app — migrate a single legacy tenant to per-tenant app */
admin.post("/tenants/:team_id/migrate-to-per-app", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`
    SELECT id, name, fly_app_name, fly_machine_id, fly_volume_id
    FROM tenants WHERE id = ${teamId}
  `;
  if (!tenant) return c.json({ error: "Not found" }, 404);
  if (tenant.fly_app_name !== c.env.FLY_APP) {
    return c.json({ error: "Tenant is not on the shared app — already migrated or never provisioned" }, 400);
  }

  // 1. Destroy old machine + volume on shared app (personal org)
  const legacyFly = new FlyClient(c.env.FLY_API_TOKEN_LEGACY, c.env.FLY_APP);
  if (tenant.fly_machine_id) {
    try { await legacyFly.destroyMachine(tenant.fly_machine_id); } catch { /* best effort */ }
  }
  if (tenant.fly_volume_id) {
    try { await legacyFly.deleteVolume(tenant.fly_volume_id); } catch { /* best effort */ }
  }

  // 2. Mark old deployment as stopped
  await sql`
    UPDATE deployments SET status = 'stopped', finished_at = now()
    WHERE tenant_id = ${teamId} AND status IN ('deploying', 'running')
  `;

  // 3. Reset tenant to pending so provisionTenant can run
  await sql`
    UPDATE tenants
    SET status = 'pending', fly_machine_id = NULL, fly_volume_id = NULL,
        fly_app_name = NULL, instance_url = NULL, updated_at = now()
    WHERE id = ${teamId}
  `;

  // 4. Provision under per-tenant app
  await provisionTenant(c.env, teamId);

  return c.json({ tenant_id: teamId, name: tenant.name, status: "migrated" });
});

export default admin;
