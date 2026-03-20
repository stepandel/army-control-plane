import type { FC } from "hono/jsx";
import type { TenantRow, TokenRow, DeploymentRow } from "../db/queries";
import { StatusBadge, PlatformBadge, TimeAgo } from "./components";

const PLATFORMS = ["slack", "linear", "github"] as const;

interface TenantDetailProps {
  tenant: TenantRow;
  tokens: TokenRow[];
  deployments: DeploymentRow[];
}

export const TenantDetailPage: FC<TenantDetailProps> = ({
  tenant,
  tokens,
  deployments,
}) => {
  const integrations = PLATFORMS.map((p) => ({
    platform: p,
    connected: tokens.some((t) => t.platform === p),
    tokenCount: tokens.filter((t) => t.platform === p).length,
  }));

  return (
    <div>
      <div class="page-header">
        <h1>
          <a
            href="/portal/tenants"
            hx-get="/portal/tenants"
            hx-target="#content"
            hx-push-url="true"
            style="color: var(--text-muted); text-decoration: none"
          >
            Tenants
          </a>
          {" / "}
          {tenant.name}
        </h1>
        <div class="btn-group">
          {tenant.status !== "destroyed" && (
            <>
              <button
                class="btn btn-sm"
                hx-post={`/portal/actions/${tenant.id}/push-credentials`}
                hx-target="#toasts"
                hx-swap="afterbegin"
              >
                Push Credentials
              </button>
              <button
                class="btn btn-sm"
                hx-post={`/portal/actions/${tenant.id}/push-labels`}
                hx-target="#toasts"
                hx-swap="afterbegin"
              >
                Push Labels
              </button>
              <button
                class="btn btn-sm"
                hx-post={`/portal/actions/${tenant.id}/reprovision`}
                hx-target="#toasts"
                hx-swap="afterbegin"
                hx-confirm={`Reprovision ${tenant.name}?`}
              >
                Reprovision
              </button>
              <button
                class="btn btn-sm btn-danger"
                hx-delete={`/portal/actions/${tenant.id}`}
                hx-target="#toasts"
                hx-swap="afterbegin"
                hx-confirm={`DESTROY tenant "${tenant.name}" (${tenant.id})? This cannot be undone.`}
              >
                Destroy
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tenant Info */}
      <div class="detail-section">
        <h2>Tenant Info</h2>
        <div class="detail-grid">
          <div class="detail-label">Team ID</div>
          <div class="detail-value mono">{tenant.id}</div>
          <div class="detail-label">Name</div>
          <div class="detail-value">{tenant.name}</div>
          <div class="detail-label">Status</div>
          <div class="detail-value">
            <StatusBadge status={tenant.status} />
          </div>
          <div class="detail-label">Platform</div>
          <div class="detail-value">
            <PlatformBadge platform={tenant.platform} />
          </div>
          <div class="detail-label">Fly App</div>
          <div class="detail-value mono">{tenant.fly_app_name ?? "—"}</div>
          <div class="detail-label">Machine ID</div>
          <div class="detail-value mono">{tenant.fly_machine_id ?? "—"}</div>
          <div class="detail-label">Volume ID</div>
          <div class="detail-value mono">{tenant.fly_volume_id ?? "—"}</div>
          <div class="detail-label">Instance URL</div>
          <div class="detail-value mono">{tenant.instance_url ?? "—"}</div>
          <div class="detail-label">Created</div>
          <div class="detail-value">
            <TimeAgo date={tenant.created_at} />
          </div>
          <div class="detail-label">Updated</div>
          <div class="detail-value">
            <TimeAgo date={tenant.updated_at} />
          </div>
        </div>
      </div>

      {/* Integrations */}
      <div class="detail-section">
        <h2>Integrations</h2>
        <div class="integrations-grid">
          {integrations.map((i) => (
            <div
              class={`integration-card ${i.connected ? "integration-connected" : "integration-disconnected"}`}
            >
              <span class={`dot ${i.connected ? "dot-green" : "dot-gray"}`} />
              <div>
                <PlatformBadge platform={i.platform} />
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem">
                  {i.connected
                    ? `${i.tokenCount} token${i.tokenCount > 1 ? "s" : ""}`
                    : "Not connected"}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tokens */}
      {tokens.length > 0 && (
        <div class="detail-section">
          <h2>Tokens</h2>
          <table>
            <thead>
              <tr>
                <th>Platform</th>
                <th>Type</th>
                <th>Scopes</th>
                <th>External ID</th>
                <th>Expires</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr>
                  <td>
                    <PlatformBadge platform={t.platform} />
                  </td>
                  <td class="mono">{t.token_type}</td>
                  <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; font-size: 0.75rem">
                    {t.scopes ?? "—"}
                  </td>
                  <td class="mono">{t.external_id ?? "—"}</td>
                  <td>
                    {t.expires_at ? <TimeAgo date={t.expires_at} /> : "—"}
                  </td>
                  <td>
                    <TimeAgo date={t.created_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Deployments */}
      {deployments.length > 0 && (
        <div class="detail-section">
          <h2>Deployments</h2>
          <table>
            <thead>
              <tr>
                <th>Machine ID</th>
                <th>Image</th>
                <th>Status</th>
                <th>Started</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr>
                  <td class="mono">{d.fly_machine_id}</td>
                  <td
                    class="mono"
                    style="max-width: 200px; overflow: hidden; text-overflow: ellipsis"
                  >
                    {d.image_ref}
                  </td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td>
                    <TimeAgo date={d.created_at} />
                  </td>
                  <td>
                    {d.finished_at ? <TimeAgo date={d.finished_at} /> : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
