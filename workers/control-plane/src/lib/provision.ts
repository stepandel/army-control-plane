import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient, type GuestConfig } from "./fly";
import { buildMachineEnv } from "./machine-env";
import { decryptIfEncrypted } from "./crypto";

function buildGuest(tenant: Record<string, unknown>): GuestConfig | undefined {
  return tenant.memory_mb || tenant.cpus
    ? { cpu_kind: "shared", cpus: (tenant.cpus as number) ?? 1, memory_mb: (tenant.memory_mb as number) ?? 1024 }
    : undefined;
}

/** Generate a unique app name: army-{tenantId}-{4 hex chars} */
function generateAppName(tenantId: string): string {
  const suffix = crypto.randomUUID().slice(0, 4);
  return `army-${tenantId.toLowerCase()}-${suffix}`;
}

/**
 * Provision a brand-new Fly app + machine for a tenant (app-per-tenant model).
 * Creates: Fly app → IPs → Tigris bucket → volume + machine.
 * Updates DB + KV and records deployment.
 * On failure: deletes the app (bucket is kept) and rolls back tenant status.
 */
export async function provisionTenant(env: ControlPlaneEnv, tenantId: string) {
  const sql = getDb(env);
  const fly = new FlyClient(env.FLY_API_TOKEN_VERA, env.FLY_APP);
  const sharedImage = `registry.fly.io/${env.FLY_APP}:latest`;

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  if (tenant.status === "active") throw new Error(`Tenant ${tenantId} already provisioned`);

  await sql`UPDATE tenants SET status = 'provisioning', updated_at = now() WHERE id = ${tenantId}`;

  const appName = generateAppName(tenantId);
  const internalSecret = crypto.randomUUID();
  const guest = buildGuest(tenant);

  try {
    // 1. Create dedicated Fly app
    await fly.createApp(appName, env.FLY_ORG);

    // 2. Allocate IPs (required for .fly.dev routing)
    await fly.allocateSharedIp(appName);
    await fly.allocateIpV6(appName);

    // 3. Create Tigris storage bucket (credentials auto-set as app secrets)
    await fly.createTigrisBucket(appName, env.FLY_ORG, appName);

    // 4. Create volume + machine
    const tenantFly = new FlyClient(env.FLY_API_TOKEN_VERA, appName, sharedImage);
    const { machine, volume, instanceUrl } = await createMachineForTenant(
      env, sql, tenantFly, tenantId, appName, internalSecret, tenant, guest,
    );

    // 5. Update tenant record
    await sql`
      UPDATE tenants
      SET fly_app_name = ${appName},
          fly_machine_id = ${machine.id},
          fly_volume_id = ${volume.id},
          instance_url = ${instanceUrl},
          status = 'active',
          updated_at = now()
      WHERE id = ${tenantId}
    `;

    // 6. Record deployment + write KV routes
    await recordDeploymentAndRoutes(env, sql, tenantId, machine.id, sharedImage, instanceUrl, internalSecret);

    return { tenantId, machineId: machine.id, machineName: appName, instanceUrl };
  } catch (err) {
    // Clean up the app on failure (bucket is kept for data preservation)
    try { await fly.deleteApp(appName); } catch { /* best effort */ }
    await sql`UPDATE tenants SET status = 'pending', updated_at = now() WHERE id = ${tenantId}`;
    throw err;
  }
}

/**
 * Reprovision a tenant by destroying the old machine + volume and creating
 * new ones inside the existing Fly app. App, IPs, and Tigris bucket are preserved.
 */
export async function reprovisionTenant(env: ControlPlaneEnv, tenantId: string) {
  const sql = getDb(env);
  const sharedImage = `registry.fly.io/${env.FLY_APP}:latest`;

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  if (tenant.status === "destroyed") throw new Error(`Tenant ${tenantId} is destroyed`);
  if (!tenant.fly_app_name) throw new Error(`Tenant ${tenantId} has no Fly app — use provisionTenant instead`);

  const appName = tenant.fly_app_name as string;
  const tenantFly = new FlyClient(env.FLY_API_TOKEN_VERA, appName, sharedImage);

  // 1. Destroy old machine + volume (best effort)
  if (tenant.fly_machine_id) {
    try { await tenantFly.destroyMachine(tenant.fly_machine_id); } catch { /* best effort */ }
  }
  if (tenant.fly_volume_id) {
    try { await tenantFly.deleteVolume(tenant.fly_volume_id); } catch { /* best effort */ }
  }

  // 2. Mark old deployment as stopped
  await sql`
    UPDATE deployments SET status = 'stopped', finished_at = now()
    WHERE tenant_id = ${tenantId} AND status IN ('deploying', 'running')
  `;

  await sql`
    UPDATE tenants
    SET status = 'provisioning', fly_machine_id = NULL, fly_volume_id = NULL, updated_at = now()
    WHERE id = ${tenantId}
  `;

  const internalSecret = crypto.randomUUID();
  const guest = buildGuest(tenant);

  try {
    // 3. Create new volume + machine in the same app
    const { machine, volume, instanceUrl } = await createMachineForTenant(
      env, sql, tenantFly, tenantId, appName, internalSecret, tenant, guest,
    );

    // 4. Update tenant record (app name stays the same)
    await sql`
      UPDATE tenants
      SET fly_machine_id = ${machine.id},
          fly_volume_id = ${volume.id},
          instance_url = ${instanceUrl},
          status = 'active',
          updated_at = now()
      WHERE id = ${tenantId}
    `;

    // 5. Record deployment + write KV routes
    await recordDeploymentAndRoutes(env, sql, tenantId, machine.id, sharedImage, instanceUrl, internalSecret);

    return { tenantId, machineId: machine.id, machineName: appName, instanceUrl };
  } catch (err) {
    await sql`UPDATE tenants SET status = 'pending', updated_at = now() WHERE id = ${tenantId}`;
    throw err;
  }
}

// ── Shared helpers ──────────────────────────────────────────────

async function createMachineForTenant(
  env: ControlPlaneEnv,
  sql: ReturnType<typeof getDb>,
  fly: FlyClient,
  tenantId: string,
  appName: string,
  internalSecret: string,
  tenant: Record<string, unknown>,
  guest?: GuestConfig,
) {
  const rawTokens = await sql`
    SELECT platform, token_type, access_token
    FROM integration_tokens WHERE tenant_id = ${tenantId}
  `;
  const tokens = await Promise.all(
    rawTokens.map(async (t) => ({
      ...t,
      access_token: await decryptIfEncrypted(t.access_token, env.ENCRYPTION_KEY),
    })),
  );
  const anthropicKey = tenant.anthropic_api_key
    ? await decryptIfEncrypted(tenant.anthropic_api_key as string, env.ENCRYPTION_KEY)
    : null;
  const { secrets, config } = buildMachineEnv(env, tenantId, internalSecret, tokens, anthropicKey, tenant.vera_production as boolean, tenant.tracing_provider as string, tenant.subscription_status as string);

  // Set sensitive values as encrypted app secrets (no machines exist yet, so no restart triggered)
  await fly.setSecrets(appName, secrets);

  // Create machine with only non-sensitive config — secrets are injected automatically at boot
  const volumeName = "anton_state";
  const { machine, volume } = await fly.createMachineWithVolume(appName, config, volumeName, 1, guest);
  const instanceUrl = `https://${appName}.fly.dev`;

  return { machine, volume, instanceUrl };
}

async function recordDeploymentAndRoutes(
  env: ControlPlaneEnv,
  sql: ReturnType<typeof getDb>,
  tenantId: string,
  machineId: string,
  imageRef: string,
  instanceUrl: string,
  internalSecret: string,
) {
  await sql`
    INSERT INTO deployments (tenant_id, fly_machine_id, image_ref, status)
    VALUES (${tenantId}, ${machineId}, ${imageRef}, 'running')
  `;

  const webhookPlatforms = await sql`
    SELECT DISTINCT platform, external_id FROM integration_tokens
    WHERE tenant_id = ${tenantId} AND external_id IS NOT NULL
  `;
  const route: TenantRoute = { instance_url: instanceUrl, internal_secret: internalSecret, fly_machine_id: machineId };

  for (const { platform, external_id } of webhookPlatforms) {
    await env.ROUTING_TABLE.put(`${platform}:${external_id}`, JSON.stringify(route));
  }
}
