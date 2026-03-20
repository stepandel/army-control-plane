import type { FC } from "hono/jsx";
import type { TenantStatusCounts } from "../db/queries";

export const DashboardPage: FC<{ counts: TenantStatusCounts }> = ({
  counts,
}) => (
  <div>
    <div class="page-header">
      <h1>Dashboard</h1>
    </div>
    <div class="cards">
      <div class="card">
        <div class="card-label">Total Tenants</div>
        <div class="card-value">{counts.total}</div>
      </div>
      <div class="card">
        <div class="card-label">Active</div>
        <div class="card-value" style="color: var(--green)">
          {counts.active}
        </div>
      </div>
      <div class="card">
        <div class="card-label">Provisioning</div>
        <div class="card-value" style="color: var(--yellow)">
          {counts.provisioning}
        </div>
      </div>
      <div class="card">
        <div class="card-label">Pending</div>
        <div class="card-value">{counts.pending}</div>
      </div>
      <div class="card">
        <div class="card-label">Suspended</div>
        <div class="card-value" style="color: var(--orange)">
          {counts.suspended}
        </div>
      </div>
      <div class="card">
        <div class="card-label">Destroyed</div>
        <div class="card-value" style="color: var(--red)">
          {counts.destroyed}
        </div>
      </div>
    </div>
  </div>
);
