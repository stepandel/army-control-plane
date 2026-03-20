import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient } from "../lib/fly";
import { pushCredentials } from "../lib/credentials";
import { provisionTenant } from "../lib/provision";
import { provisionLinearLabels } from "../lib/linear-labels";
import { Layout } from "../portal/layout";
import {
  StatusBadge,
  FlashMessage,
  formatDate,
  IntegrationPill,
  ActionForm,
} from "../portal/components";

const portal = new Hono<{ Bindings: ControlPlaneEnv }>();

const PLATFORMS = ["slack", "linear", "github"] as const;

// ─── Pages ──────────────────────────────────────────────────────

/** GET / — Tenant list */
portal.get("/", async (c) => {
  const sql = getDb(c.env);
  const tenants = await sql`
    SELECT id, name, platform, status, fly_app_name, instance_url, created_at, updated_at
    FROM tenants ORDER BY created_at DESC
  `;

  const success = c.req.query("success");
  const error = c.req.query("error");

  const total = tenants.length;
  const active = tenants.filter((t) => t.status === "active").length;
  const pending = tenants.filter(
    (t) => t.status === "pending" || t.status === "provisioning",
  ).length;
  const destroyed = tenants.filter((t) => t.status === "destroyed").length;

  return c.html(
    <Layout title="Tenants">
      <FlashMessage success={success} error={error} />
      <div class="page-header">
        <div>
          <h1>Tenants</h1>
          <p class="subtitle">Manage all tenant workspaces</p>
        </div>
        <div class="btn-group">
          <ActionForm
            action="/portal/bulk/push-credentials"
            label="Push All Credentials"
            variant="primary"
            size="sm"
          />
          <ActionForm
            action="/portal/bulk/push-labels"
            label="Push All Labels"
            size="sm"
          />
        </div>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="stat-value">{total}</div>
          <div class="stat-label">Total</div>
        </div>
        <div class="stat">
          <div class="stat-value" style="color: var(--success)">
            {active}
          </div>
          <div class="stat-label">Active</div>
        </div>
        <div class="stat">
          <div class="stat-value" style="color: var(--warning)">
            {pending}
          </div>
          <div class="stat-label">Pending</div>
        </div>
        <div class="stat">
          <div class="stat-value" style="color: var(--danger)">
            {destroyed}
          </div>
          <div class="stat-label">Destroyed</div>
        </div>
      </div>

      {tenants.length === 0 ? (
        <div class="empty">
          <h2>No tenants yet</h2>
          <p>
            Tenants are created when a Slack workspace installs the app via
            OAuth.
          </p>
        </div>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>ID</th>
                <th>Platform</th>
                <th>Status</th>
                <th>Instance URL</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr
                  class="clickable-row"
                  onclick={`window.location='/portal/tenants/${t.id}'`}
                >
                  <td style="font-weight: 600">{t.name}</td>
                  <td>
                    <span style="font-family: var(--mono); font-size: 0.8125rem">
                      {t.id}
                    </span>
                  </td>
                  <td style="text-transform: capitalize">{t.platform}</td>
                  <td>
                    <StatusBadge status={t.status} />
                  </td>
                  <td>
                    {t.instance_url ? (
                      <a
                        href={t.instance_url}
                        target="_blank"
                        rel="noopener"
                        style="font-size: 0.8125rem"
                      >
                        {new URL(t.instance_url).hostname}
                      </a>
                    ) : (
                      <span style="color: var(--text-muted)">—</span>
                    )}
                  </td>
                  <td style="color: var(--text-muted); font-size: 0.8125rem; white-space: nowrap">
                    {formatDate(t.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>,
  );
});

/** GET /tenants/:team_id — Tenant detail */
portal.get("/tenants/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant) {
    return c.html(
      <Layout title="Not Found">
        <div class="empty">
          <h2>Tenant not found</h2>
          <p>No tenant with ID "{teamId}" exists.</p>
          <a
            href="/portal"
            class="btn"
            style="margin-top: 1rem; display: inline-flex"
          >
            ← Back to tenants
          </a>
        </div>
      </Layout>,
      404,
    );
  }

  const tokens = await sql`
    SELECT id, platform, token_type, scopes, created_at
    FROM integration_tokens WHERE tenant_id = ${teamId}
  `;
  const deployments = await sql`
    SELECT * FROM deployments WHERE tenant_id = ${teamId} ORDER BY created_at DESC LIMIT 10
  `;
  const integrations = PLATFORMS.map((p) => ({
    platform: p,
    connected: tokens.some((t) => t.platform === p),
    token_count: tokens.filter((t) => t.platform === p).length,
  }));

  const success = c.req.query("success");
  const error = c.req.query("error");
  const hasLinear = integrations.find(
    (i) => i.platform === "linear",
  )?.connected;
  const isActive = tenant.status === "active";
  const isDestroyed = tenant.status === "destroyed";

  return c.html(
    <Layout title={tenant.name}>
      <div class="breadcrumb">
        <a href="/portal">Tenants</a>
        <span class="sep">/</span>
        <span>{tenant.name}</span>
      </div>

      <FlashMessage success={success} error={error} />

      <div class="page-header">
        <div>
          <h1>
            {tenant.name} <StatusBadge status={tenant.status} />
          </h1>
          <p class="subtitle" style="font-family: var(--mono)">
            {tenant.id}
          </p>
        </div>
        {!isDestroyed && (
          <div class="btn-group">
            {isActive && (
              <ActionForm
                action={`/portal/tenants/${teamId}/push-credentials`}
                label="Push Credentials"
                variant="primary"
                size="sm"
              />
            )}
            {isActive && hasLinear && (
              <ActionForm
                action={`/portal/tenants/${teamId}/push-labels`}
                label="Push Labels"
                size="sm"
              />
            )}
            <ActionForm
              action={`/portal/tenants/${teamId}/confirm-reprovision`}
              label="Reprovision"
              size="sm"
              confirm={true}
            />
            <ActionForm
              action={`/portal/tenants/${teamId}/confirm-destroy`}
              label="Destroy"
              variant="danger"
              size="sm"
              confirm={true}
            />
          </div>
        )}
      </div>

      {/* Tenant Info */}
      <div class="card">
        <h2>Tenant Info</h2>
        <div class="info-grid">
          <div class="info-item">
            <label>Platform</label>
            <span style="text-transform: capitalize">{tenant.platform}</span>
          </div>
          <div class="info-item">
            <label>Fly App</label>
            <span class="mono">{tenant.fly_app_name || "—"}</span>
          </div>
          <div class="info-item">
            <label>Machine ID</label>
            <span class="mono">{tenant.fly_machine_id || "—"}</span>
          </div>
          <div class="info-item">
            <label>Volume ID</label>
            <span class="mono">{tenant.fly_volume_id || "—"}</span>
          </div>
          <div class="info-item">
            <label>Instance URL</label>
            {tenant.instance_url ? (
              <a
                href={tenant.instance_url}
                target="_blank"
                rel="noopener"
                class="mono"
              >
                {tenant.instance_url}
              </a>
            ) : (
              <span class="mono">—</span>
            )}
          </div>
          <div class="info-item">
            <label>Created</label>
            <span>{formatDate(tenant.created_at)}</span>
          </div>
          <div class="info-item">
            <label>Updated</label>
            <span>{formatDate(tenant.updated_at)}</span>
          </div>
        </div>
      </div>

      {/* Integrations */}
      <div class="card">
        <h2>Integrations</h2>
        <div class="integrations">
          {integrations.map((i) => (
            <IntegrationPill platform={i.platform} connected={i.connected} />
          ))}
        </div>
        {tokens.length > 0 && (
          <div style="margin-top: 1rem">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th>Type</th>
                    <th>Scopes</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr>
                      <td style="text-transform: capitalize">{t.platform}</td>
                      <td>{t.token_type}</td>
                      <td
                        style="font-size: 0.75rem; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
                        title={t.scopes}
                      >
                        {t.scopes || "—"}
                      </td>
                      <td style="color: var(--text-muted); font-size: 0.8125rem; white-space: nowrap">
                        {formatDate(t.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Deployments */}
      <div class="card">
        <h2>Deployments</h2>
        {deployments.length === 0 ? (
          <p style="color: var(--text-muted); font-size: 0.875rem">
            No deployments yet.
          </p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Machine ID</th>
                  <th>Image</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Finished</th>
                </tr>
              </thead>
              <tbody>
                {deployments.map((d) => (
                  <tr>
                    <td>
                      <span class="mono" style="font-size: 0.8125rem">
                        {d.fly_machine_id}
                      </span>
                    </td>
                    <td>
                      <span class="mono" style="font-size: 0.8125rem">
                        {d.image_ref}
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={d.status} />
                    </td>
                    <td style="color: var(--text-muted); font-size: 0.8125rem; white-space: nowrap">
                      {formatDate(d.created_at)}
                    </td>
                    <td style="color: var(--text-muted); font-size: 0.8125rem; white-space: nowrap">
                      {formatDate(d.finished_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>,
  );
});

/** GET /tenants/:team_id/confirm-destroy — Confirmation page */
portal.get("/tenants/:team_id/confirm-destroy", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);
  const [tenant] =
    await sql`SELECT id, name, status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.redirect("/portal?error=Tenant+not+found");

  return c.html(
    <Layout title="Confirm Destroy">
      <div class="card confirm-card">
        <h1 style="color: var(--danger)">Destroy Tenant</h1>
        <p>
          This will permanently destroy the Fly machine, remove all KV routing
          entries, and mark the tenant as destroyed. This action cannot be
          undone.
        </p>
        <p>
          Tenant:{" "}
          <span class="tenant-name">
            {tenant.name} ({tenant.id})
          </span>
        </p>
        <div
          class="btn-group"
          style="justify-content: center; margin-top: 1rem"
        >
          <a href={`/portal/tenants/${teamId}`} class="btn">
            Cancel
          </a>
          <form
            method="post"
            action={`/portal/tenants/${teamId}/destroy`}
            class="inline"
          >
            <button type="submit" class="btn btn-danger">
              Destroy Tenant
            </button>
          </form>
        </div>
      </div>
    </Layout>,
  );
});

/** GET /tenants/:team_id/confirm-reprovision — Confirmation page */
portal.get("/tenants/:team_id/confirm-reprovision", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);
  const [tenant] =
    await sql`SELECT id, name, status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.redirect("/portal?error=Tenant+not+found");
  if (tenant.status === "destroyed")
    return c.redirect(
      `/portal/tenants/${teamId}?error=Cannot+reprovision+a+destroyed+tenant`,
    );

  return c.html(
    <Layout title="Confirm Reprovision">
      <div class="card confirm-card">
        <h1 style="color: var(--warning)">Reprovision Tenant</h1>
        <p>
          This will destroy the current Fly machine and create a new one. The
          tenant will be briefly unavailable during reprovisioning.
        </p>
        <p>
          Tenant:{" "}
          <span class="tenant-name">
            {tenant.name} ({tenant.id})
          </span>
        </p>
        <div
          class="btn-group"
          style="justify-content: center; margin-top: 1rem"
        >
          <a href={`/portal/tenants/${teamId}`} class="btn">
            Cancel
          </a>
          <form
            method="post"
            action={`/portal/tenants/${teamId}/reprovision`}
            class="inline"
          >
            <button type="submit" class="btn btn-primary">
              Reprovision
            </button>
          </form>
        </div>
      </div>
    </Layout>,
  );
});

// ─── Actions (POST with redirect) ──────────────────────────────

/** POST /tenants/:team_id/destroy — Destroy tenant and redirect */
portal.post("/tenants/:team_id/destroy", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);
  const fly = new FlyClient(c.env.FLY_API_TOKEN, c.env.FLY_APP);

  try {
    const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
    if (!tenant) return c.redirect("/portal?error=Tenant+not+found");

    if (tenant.fly_machine_id) {
      try {
        await fly.destroyMachine(tenant.fly_machine_id);
      } catch (err) {
        console.error(`Fly machine cleanup failed for ${teamId}:`, err);
      }
    }
    if (tenant.fly_volume_id) {
      try {
        await fly.deleteVolume(tenant.fly_volume_id);
      } catch (err) {
        console.error(`Fly volume cleanup failed for ${teamId}:`, err);
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
      UPDATE tenants
      SET status = 'destroyed', fly_machine_id = NULL, fly_volume_id = NULL, instance_url = NULL, updated_at = now()
      WHERE id = ${teamId}
    `;

    return c.redirect(
      `/portal?success=Tenant+${encodeURIComponent(tenant.name)}+destroyed`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.redirect(
      `/portal/tenants/${teamId}?error=${encodeURIComponent(msg)}`,
    );
  }
});

/** POST /tenants/:team_id/reprovision — Reprovision tenant and redirect */
portal.post("/tenants/:team_id/reprovision", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);
  const fly = new FlyClient(c.env.FLY_API_TOKEN, c.env.FLY_APP);

  try {
    const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
    if (!tenant) return c.redirect("/portal?error=Tenant+not+found");
    if (tenant.status === "destroyed")
      return c.redirect(
        `/portal/tenants/${teamId}?error=Cannot+reprovision+destroyed+tenant`,
      );

    if (tenant.fly_machine_id) {
      try {
        await fly.destroyMachine(tenant.fly_machine_id);
      } catch (err) {
        console.error(`Fly machine cleanup failed for ${teamId}:`, err);
      }
    }
    if (tenant.fly_volume_id) {
      try {
        await fly.deleteVolume(tenant.fly_volume_id);
      } catch (err) {
        console.error(`Fly volume cleanup failed for ${teamId}:`, err);
      }
    }

    await sql`
      UPDATE deployments SET status = 'stopped', finished_at = now()
      WHERE tenant_id = ${teamId} AND status IN ('deploying', 'running')
    `;

    await sql`
      UPDATE tenants
      SET status = 'pending', fly_machine_id = NULL, fly_volume_id = NULL, fly_app_name = NULL, instance_url = NULL, updated_at = now()
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

    return c.redirect(
      `/portal/tenants/${teamId}?success=Reprovisioning+started`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.redirect(
      `/portal/tenants/${teamId}?error=${encodeURIComponent(msg)}`,
    );
  }
});

/** POST /tenants/:team_id/push-credentials */
portal.post("/tenants/:team_id/push-credentials", async (c) => {
  const teamId = c.req.param("team_id");
  try {
    await pushCredentials(c.env, teamId);
    return c.redirect(
      `/portal/tenants/${teamId}?success=Credentials+pushed+successfully`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.redirect(
      `/portal/tenants/${teamId}?error=${encodeURIComponent(msg)}`,
    );
  }
});

/** POST /tenants/:team_id/push-labels */
portal.post("/tenants/:team_id/push-labels", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [token] = await sql`
    SELECT access_token FROM integration_tokens
    WHERE tenant_id = ${teamId} AND platform = 'linear'
  `;
  if (!token)
    return c.redirect(
      `/portal/tenants/${teamId}?error=No+Linear+integration+found`,
    );

  try {
    await provisionLinearLabels(token.access_token);
    return c.redirect(
      `/portal/tenants/${teamId}?success=Linear+labels+pushed`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.redirect(
      `/portal/tenants/${teamId}?error=${encodeURIComponent(msg)}`,
    );
  }
});

/** POST /bulk/push-credentials — Push credentials to all active tenants */
portal.post("/bulk/push-credentials", async (c) => {
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

  return c.redirect(
    `/portal?success=Credentials+pushed:+${succeeded}+ok,+${failed}+failed`,
  );
});

/** POST /bulk/push-labels — Push Linear labels to all connected tenants */
portal.post("/bulk/push-labels", async (c) => {
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

  return c.redirect(
    `/portal?success=Labels+pushed:+${succeeded}+ok,+${failed}+failed`,
  );
});

export default portal;
