import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient } from "./fly";

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

  const machineEnv: Record<string, string> = {
    TEAM_ID: tenantId,
    CONTROL_PLANE_URL: env.BASE_URL,
    INTERNAL_SECRET: crypto.randomUUID(),
    SLACK_APP_TOKEN: env.SLACK_APP_TOKEN,
  };

  for (const t of tokens) {
    const key = `${t.platform.toUpperCase()}_${t.token_type.toUpperCase()}_TOKEN`;
    machineEnv[key] = t.access_token;
  }

  await fly.updateMachine(tenant.fly_machine_id, machineEnv);

  return {
    tenantId,
    pushed: tokens.map((t) => ({ platform: t.platform, type: t.token_type })),
  };
}
