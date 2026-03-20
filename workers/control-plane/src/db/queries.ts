import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "./client";

export interface TenantRow {
  id: string;
  name: string;
  platform: string;
  fly_app_name: string | null;
  fly_machine_id: string | null;
  fly_volume_id: string | null;
  instance_url: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface TokenRow {
  id: string;
  tenant_id: string;
  platform: string;
  token_type: string;
  scopes: string | null;
  external_id: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface DeploymentRow {
  id: string;
  tenant_id: string;
  fly_machine_id: string;
  image_ref: string;
  status: string;
  created_at: string;
  finished_at: string | null;
}

export interface TenantStatusCounts {
  total: number;
  active: number;
  provisioning: number;
  pending: number;
  suspended: number;
  destroyed: number;
}

export async function listTenants(env: ControlPlaneEnv): Promise<TenantRow[]> {
  const sql = getDb(env);
  const rows = await sql`
    SELECT id, name, platform, fly_app_name, fly_machine_id, fly_volume_id,
           instance_url, status, created_at, updated_at
    FROM tenants ORDER BY created_at DESC
  `;
  return rows as unknown as TenantRow[];
}

export async function getTenant(
  env: ControlPlaneEnv,
  teamId: string,
): Promise<TenantRow | null> {
  const sql = getDb(env);
  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  return (tenant as unknown as TenantRow) ?? null;
}

export async function getTenantTokens(
  env: ControlPlaneEnv,
  teamId: string,
): Promise<TokenRow[]> {
  const sql = getDb(env);
  const rows = await sql`
    SELECT id, tenant_id, platform, token_type, scopes, external_id, expires_at, created_at
    FROM integration_tokens WHERE tenant_id = ${teamId}
  `;
  return rows as unknown as TokenRow[];
}

export async function getTenantDeployments(
  env: ControlPlaneEnv,
  teamId: string,
): Promise<DeploymentRow[]> {
  const sql = getDb(env);
  const rows = await sql`
    SELECT id, tenant_id, fly_machine_id, image_ref, status, created_at, finished_at
    FROM deployments WHERE tenant_id = ${teamId} ORDER BY created_at DESC
  `;
  return rows as unknown as DeploymentRow[];
}

export async function getTenantStatusCounts(
  env: ControlPlaneEnv,
): Promise<TenantStatusCounts> {
  const sql = getDb(env);
  const rows = await sql`
    SELECT status, COUNT(*)::int AS count FROM tenants GROUP BY status
  `;
  const counts: TenantStatusCounts = {
    total: 0,
    active: 0,
    provisioning: 0,
    pending: 0,
    suspended: 0,
    destroyed: 0,
  };
  for (const row of rows) {
    const status = row.status as keyof Omit<TenantStatusCounts, "total">;
    if (status in counts) counts[status] = row.count as number;
    counts.total += row.count as number;
  }
  return counts;
}
