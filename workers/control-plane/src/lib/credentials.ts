import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import type postgres from "postgres";
import { getDb } from "../db/client";
import { FlyClient } from "./fly";
import { buildMachineEnv } from "./machine-env";
import { decryptIfEncrypted } from "./crypto";

/**
 * Push all integration tokens to a tenant's Fly machine.
 *
 * Sensitive values are set as encrypted Fly app secrets,
 * non-sensitive values go to machine config.env.
 */
export async function pushCredentials(env: ControlPlaneEnv, tenantId: string, sql?: postgres.Sql) {
  const db = sql ?? getDb(env);
  const sharedImage = `registry.fly.io/${env.FLY_APP}:latest`;

  const [tenant] = await db`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  if (tenant.status !== "active") throw new Error(`Tenant ${tenantId} not active`);
  if (!tenant.fly_machine_id) throw new Error(`Tenant ${tenantId} has no Fly machine`);

  const fly = new FlyClient(env.FLY_API_TOKEN_VERA, tenant.fly_app_name, sharedImage);

  const tokens = await db`
    SELECT platform, token_type, access_token
    FROM integration_tokens
    WHERE tenant_id = ${tenantId}
  `;

  if (tokens.length === 0) throw new Error(`No tokens to push for ${tenantId}`);

  // Decrypt tokens and anthropic key before building machine env
  const decryptedTokens = await Promise.all(
    tokens.map(async (t) => ({
      ...t,
      access_token: await decryptIfEncrypted(t.access_token, env.ENCRYPTION_KEY),
    })),
  );
  const anthropicKey = tenant.anthropic_api_key
    ? await decryptIfEncrypted(tenant.anthropic_api_key, env.ENCRYPTION_KEY)
    : null;

  const envResult = buildMachineEnv(env, tenantId, crypto.randomUUID(), decryptedTokens, anthropicKey, tenant.vera_production, tenant.tracing_provider, tenant.subscription_status);

  // Per-tenant app: secrets are encrypted, config.env has only non-sensitive values
  await fly.setSecrets(tenant.fly_app_name, envResult.secrets);
  await fly.updateMachine(tenant.fly_machine_id, envResult.config, tenant.fly_volume_id);

  // Write KV routing entries for all platforms with an external_id
  const internalSecret = envResult.secrets.INTERNAL_SECRET;
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
