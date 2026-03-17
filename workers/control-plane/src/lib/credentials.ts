import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient } from "./fly";
import { buildMachineEnv } from "./machine-env";

/**
 * Push all integration tokens to a tenant's Fly machine as env vars.
 * The machine reboots to pick up the new config.
 */
export async function pushCredentials(env: ControlPlaneEnv, tenantId: string) {
  const sql = getDb(env);
  const fly = new FlyClient(env.FLY_API_TOKEN, env.FLY_APP);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  if (tenant.status !== "active") throw new Error(`Tenant ${tenantId} not active`);
  if (!tenant.fly_machine_id) throw new Error(`Tenant ${tenantId} has no Fly machine`);

  const tokens = await sql`
    SELECT platform, token_type, access_token
    FROM integration_tokens
    WHERE tenant_id = ${tenantId}
  `;

  if (tokens.length === 0) throw new Error(`No tokens to push for ${tenantId}`);

  const machineEnv = buildMachineEnv(env, tenantId, crypto.randomUUID(), tokens);

  await fly.updateMachine(tenant.fly_machine_id, machineEnv);

  // Write KV routing entries for all webhook-based platforms
  const internalSecret = machineEnv.INTERNAL_SECRET;
  const route: TenantRoute = { instance_url: tenant.instance_url, internal_secret: internalSecret, fly_machine_id: tenant.fly_machine_id };
  const platformKeys = await sql`
    SELECT DISTINCT platform, external_id FROM integration_tokens
    WHERE tenant_id = ${tenantId} AND platform != 'slack' AND external_id IS NOT NULL
  `;
  for (const { platform, external_id } of platformKeys) {
    await env.ROUTING_TABLE.put(`${platform}:${external_id}`, JSON.stringify(route));
  }

  return {
    tenantId,
    pushed: tokens.map((t) => ({ platform: t.platform, type: t.token_type })),
  };
}
