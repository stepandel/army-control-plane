import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import type postgres from "postgres";
import { getDb } from "../db/client";
import { FlyClient, isLegacyApp } from "./fly";
import { buildMachineEnv } from "./machine-env";

/**
 * Push all integration tokens to a tenant's Fly machine as env vars.
 * The machine reboots to pick up the new config.
 * Scopes FlyClient to the tenant's own app (works for both legacy shared-app
 * and new per-tenant-app tenants).
 */
export async function pushCredentials(env: ControlPlaneEnv, tenantId: string, sql?: postgres.Sql) {
  const db = sql ?? getDb(env);
  const sharedImage = `registry.fly.io/${env.FLY_APP}:latest`;

  const [tenant] = await db`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  if (tenant.status !== "active") throw new Error(`Tenant ${tenantId} not active`);
  if (!tenant.fly_machine_id) throw new Error(`Tenant ${tenantId} has no Fly machine`);

  // Scope FlyClient to the tenant's app (per-tenant or legacy shared)
  const flyToken = isLegacyApp(tenant.fly_app_name) ? env.FLY_API_TOKEN : env.FLY_API_TOKEN_VERA;
  const fly = new FlyClient(flyToken, tenant.fly_app_name, sharedImage);

  const tokens = await db`
    SELECT platform, token_type, access_token
    FROM integration_tokens
    WHERE tenant_id = ${tenantId}
  `;

  if (tokens.length === 0) throw new Error(`No tokens to push for ${tenantId}`);

  const machineEnv = buildMachineEnv(env, tenantId, crypto.randomUUID(), tokens, tenant.anthropic_api_key, tenant.vera_production);

  await fly.updateMachine(tenant.fly_machine_id, machineEnv, tenant.fly_volume_id);

  // Write KV routing entries for all platforms with an external_id
  const internalSecret = machineEnv.INTERNAL_SECRET;
  const route: TenantRoute = { instance_url: tenant.instance_url, internal_secret: internalSecret, fly_machine_id: tenant.fly_machine_id };
  const platformKeys = await db`
    SELECT DISTINCT platform, external_id FROM integration_tokens
    WHERE tenant_id = ${tenantId} AND external_id IS NOT NULL
  `;
  for (const { platform, external_id } of platformKeys) {
    await env.ROUTING_TABLE.put(`${platform}:${external_id}`, JSON.stringify(route));
  }

  return {
    tenantId,
    pushed: tokens.map((t) => ({ platform: t.platform, type: t.token_type })),
  };
}
