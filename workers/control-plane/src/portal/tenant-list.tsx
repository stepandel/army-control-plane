import type { FC } from "hono/jsx";
import type { TenantRow } from "../db/queries";
import { StatusBadge, PlatformBadge, TimeAgo } from "./components";

export const TenantListPage: FC<{ tenants: TenantRow[] }> = ({ tenants }) => (
  <div>
    <div class="page-header">
      <h1>Tenants ({tenants.length})</h1>
    </div>
    <table
      hx-get="/portal/tenants"
      hx-trigger="every 30s"
      hx-target="closest table"
      hx-swap="outerHTML"
    >
      <thead>
        <tr>
          <th>Name</th>
          <th>Team ID</th>
          <th>Status</th>
          <th>Platform</th>
          <th>Instance</th>
          <th>Updated</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {tenants.map((t) => (
          <tr>
            <td>
              <a
                href={`/portal/tenants/${t.id}`}
                hx-get={`/portal/tenants/${t.id}`}
                hx-target="#content"
                hx-push-url="true"
                style="color: var(--accent); text-decoration: none"
              >
                {t.name}
              </a>
            </td>
            <td class="mono">{t.id}</td>
            <td>
              <StatusBadge status={t.status} />
            </td>
            <td>
              <PlatformBadge platform={t.platform} />
            </td>
            <td
              class="mono"
              style="max-width: 200px; overflow: hidden; text-overflow: ellipsis"
            >
              {t.instance_url ?? "—"}
            </td>
            <td>
              <TimeAgo date={t.updated_at} />
            </td>
            <td>
              <div class="btn-group">
                {t.status !== "destroyed" && (
                  <>
                    <button
                      class="btn btn-sm"
                      hx-post={`/portal/actions/${t.id}/push-credentials`}
                      hx-target="#toasts"
                      hx-swap="afterbegin"
                    >
                      Creds
                    </button>
                    <button
                      class="btn btn-sm"
                      hx-post={`/portal/actions/${t.id}/reprovision`}
                      hx-target="#toasts"
                      hx-swap="afterbegin"
                      hx-confirm={`Reprovision ${t.name}?`}
                    >
                      Reprovision
                    </button>
                    <button
                      class="btn btn-sm btn-danger"
                      hx-delete={`/portal/actions/${t.id}`}
                      hx-target="#toasts"
                      hx-swap="afterbegin"
                      hx-confirm={`DESTROY tenant "${t.name}" (${t.id})? This cannot be undone.`}
                    >
                      Destroy
                    </button>
                  </>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
