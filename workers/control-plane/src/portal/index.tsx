import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { Layout } from "./components/layout";
import { StatusBadge, PlatformBadge } from "./components/status-badge";
import { getDb } from "../db/client";

const portal = new Hono<{
  Bindings: ControlPlaneEnv;
  Variables: { accessEmail: string };
}>();

// ─── Dashboard ───────────────────────────────────────────────────

portal.get("/", async (c) => {
  const sql = getDb(c.env);
  const email = c.get("accessEmail");

  const tenants = await sql`
    SELECT id, name, platform, status, fly_app_name, instance_url, created_at, updated_at
    FROM tenants ORDER BY created_at DESC
  `;

  // Get integration status for all tenants in one query
  const tokenRows = await sql`
    SELECT tenant_id, platform FROM integration_tokens
  `;
  const integrationMap = new Map<string, Set<string>>();
  for (const row of tokenRows) {
    if (!integrationMap.has(row.tenant_id)) {
      integrationMap.set(row.tenant_id, new Set());
    }
    integrationMap.get(row.tenant_id)!.add(row.platform);
  }

  const total = tenants.length;
  const active = tenants.filter((t) => t.status === "active").length;
  const pending = tenants.filter((t) => t.status === "pending" || t.status === "provisioning").length;

  return c.html(
    <Layout title="Dashboard" email={email}>
      <div class="page-header">
        <h1>Dashboard</h1>
        <p>Manage all Army tenants and their integrations</p>
      </div>

      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-label">Total Tenants</div>
          <div class="stat-value">{total}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active</div>
          <div class="stat-value" style="color: var(--green)">{active}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Pending</div>
          <div class="stat-value" style="color: var(--yellow)">{pending}</div>
        </div>
      </div>

      {tenants.length === 0 ? (
        <div class="empty-state">
          <h2>No tenants yet</h2>
          <p>Get started by connecting a Slack workspace</p>
          <a href="/portal/setup" class="btn btn-primary">Set Up First Tenant</a>
        </div>
      ) : (
        <div>
          <h2>Tenants</h2>
          {tenants.map((t) => {
            const platforms = integrationMap.get(t.id) ?? new Set();
            return (
              <a href={`/portal/tenants/${t.id}`} class="tenant-row">
                <div class="tenant-info">
                  <div>
                    <div class="tenant-name">{t.name}</div>
                    <div class="tenant-id">{t.id}</div>
                  </div>
                </div>
                <div class="tenant-meta">
                  <div class="platform-badges">
                    <PlatformBadge platform="slack" connected={platforms.has("slack")} />
                    <PlatformBadge platform="linear" connected={platforms.has("linear")} />
                    <PlatformBadge platform="github" connected={platforms.has("github")} />
                  </div>
                  <StatusBadge status={t.status} />
                  <span class="timestamp">{formatDate(t.created_at)}</span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </Layout>,
  );
});

// ─── Tenant Detail ───────────────────────────────────────────────

portal.get("/tenants/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const email = c.get("accessEmail");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant) {
    return c.html(
      <Layout title="Not Found" email={email}>
        <div class="empty-state">
          <h2>Tenant not found</h2>
          <p>No tenant exists with ID "{teamId}"</p>
          <a href="/portal" class="btn btn-primary">Back to Dashboard</a>
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

  const platforms = ["slack", "linear", "github"] as const;
  const integrations = platforms.map((p) => ({
    platform: p,
    connected: tokens.some((t) => t.platform === p),
    token_count: tokens.filter((t) => t.platform === p).length,
  }));

  const isActive = tenant.status === "active";
  const isDestroyed = tenant.status === "destroyed";

  return c.html(
    <Layout title={tenant.name} email={email}>
      <a href="/portal" class="back-link">← Back to Dashboard</a>

      <div class="page-header">
        <div style="display: flex; align-items: center; gap: 12px;">
          <h1>{tenant.name}</h1>
          <StatusBadge status={tenant.status} />
        </div>
        <p>Tenant ID: {tenant.id}</p>
      </div>

      {/* Tenant Details */}
      <div class="card section">
        <h2>Details</h2>
        <div class="detail-grid">
          <div class="detail-item">
            <span class="detail-label">Primary Platform</span>
            <span class="detail-value">{tenant.platform}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Fly App</span>
            <span class="detail-value">{tenant.fly_app_name ?? "—"}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Machine ID</span>
            <span class="detail-value">{tenant.fly_machine_id ?? "—"}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Instance URL</span>
            <span class="detail-value">{tenant.instance_url ?? "—"}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Created</span>
            <span class="detail-value">{formatDate(tenant.created_at)}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Updated</span>
            <span class="detail-value">{formatDate(tenant.updated_at)}</span>
          </div>
        </div>
      </div>

      {/* Integrations */}
      <div class="section">
        <h2>Integrations</h2>
        <div class="integration-grid">
          {integrations.map((i) => (
            <div class="integration-card">
              <div class="integration-header">
                <span class="integration-platform">{i.platform}</span>
                {i.connected ? (
                  <span class="badge badge-active">Connected</span>
                ) : (
                  <span class="badge badge-pending">Not connected</span>
                )}
              </div>
              <div class="integration-status">
                {i.connected
                  ? `${i.token_count} token${i.token_count !== 1 ? "s" : ""}`
                  : "No tokens"}
              </div>
              {!i.connected && isActive && i.platform !== "slack" && (
                <div style="margin-top: 12px">
                  <a
                    href={`/oauth/${i.platform}/install?tenant_id=${teamId}`}
                    class="btn btn-primary"
                    style="font-size: 12px; padding: 6px 12px;"
                  >
                    Connect {i.platform}
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div class="card section">
        <h2>Actions</h2>
        <div class="actions">
          <button
            class="btn"
            data-label="Push Credentials"
            onclick={`portalAction('/admin/tenants/${teamId}/push-credentials', 'POST')`}
            disabled={!isActive}
          >
            Push Credentials
          </button>
          <button
            class="btn"
            data-label="Push Labels"
            onclick={`portalAction('/admin/tenants/${teamId}/push-labels', 'POST')`}
            disabled={!isActive}
          >
            Push Labels
          </button>
          <button
            class="btn"
            data-label="Reprovision"
            onclick={`portalAction('/admin/tenants/${teamId}/reprovision', 'POST', 'This will destroy and recreate the machine. Continue?')`}
            disabled={isDestroyed}
          >
            Reprovision
          </button>
          <button
            class="btn btn-danger"
            data-label="Destroy"
            onclick={`portalAction('/admin/tenants/${teamId}', 'DELETE', 'This will permanently destroy this tenant and its machine. This cannot be undone. Continue?')`}
            disabled={isDestroyed}
          >
            Destroy Tenant
          </button>
        </div>
      </div>

      {/* Deployments */}
      <div class="card section">
        <div class="card-header">
          <h2 style="margin-bottom: 0">Deployments</h2>
        </div>
        {deployments.length === 0 ? (
          <p style="color: var(--text-dim)">No deployments recorded</p>
        ) : (
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
                  <td style="font-family: 'SF Mono', Monaco, monospace; font-size: 13px;">
                    {d.fly_machine_id}
                  </td>
                  <td style="font-family: 'SF Mono', Monaco, monospace; font-size: 13px;">
                    {truncate(d.image_ref, 40)}
                  </td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td class="timestamp">{formatDate(d.created_at)}</td>
                  <td class="timestamp">{d.finished_at ? formatDate(d.finished_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>,
  );
});

// ─── Setup Page ──────────────────────────────────────────────────

portal.get("/setup", async (c) => {
  const email = c.get("accessEmail");
  const baseUrl = c.env.BASE_URL;

  return c.html(
    <Layout title="Setup" email={email}>
      <div class="page-header">
        <h1>Set Up a New Tenant</h1>
        <p>Follow these steps to onboard a new Slack workspace to Army</p>
      </div>

      <div class="setup-steps">
        <div class="setup-step">
          <div class="step-number">1</div>
          <div class="step-content">
            <h3>Install Slack App</h3>
            <p>
              Click the button below to start the Slack OAuth flow. This will create a new tenant
              and provision a Fly.io machine automatically.
            </p>
            <div style="margin-top: 12px">
              <a href="/oauth/slack/install" class="btn btn-primary">
                Add to Slack
              </a>
            </div>
          </div>
        </div>

        <div class="setup-step">
          <div class="step-number">2</div>
          <div class="step-content">
            <h3>Wait for Provisioning</h3>
            <p>
              After authorizing the Slack app, a Fly.io machine will be created for the tenant.
              This usually takes 30–60 seconds. Check the tenant's status on the{" "}
              <a href="/portal" style="color: var(--accent)">Dashboard</a> — it will change from{" "}
              <code>pending</code> → <code>provisioning</code> → <code>active</code>.
            </p>
          </div>
        </div>

        <div class="setup-step">
          <div class="step-number">3</div>
          <div class="step-content">
            <h3>Connect Linear (Optional)</h3>
            <p>
              Once the tenant is <code>active</code>, go to the tenant detail page and click
              "Connect Linear". This adds webhook routing for Linear events.
            </p>
          </div>
        </div>

        <div class="setup-step">
          <div class="step-number">4</div>
          <div class="step-content">
            <h3>Connect GitHub (Optional)</h3>
            <p>
              Similarly, click "Connect GitHub" on the tenant detail page to install the GitHub App.
              This enables webhook delivery for GitHub events.
            </p>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>API Base URL</h3>
        <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 8px">
          Your control plane API is accessible at:
        </p>
        <div class="detail-value">{baseUrl}</div>
      </div>
    </Layout>,
  );
});

// ─── Helpers ─────────────────────────────────────────────────────

function formatDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

export default portal;
