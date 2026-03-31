import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient, type GuestConfig } from "./fly";
import { buildMachineEnv } from "./machine-env";

/**
 * Provision a new Fly machine for a tenant using the app-per-tenant model.
 * Creates a dedicated Fly app, allocates IPs, then creates volume + machine.
 * Updates DB + KV and records deployment.
 * Throws on failure after cleaning up the app and rolling back tenant status.
 */
export async function provisionTenant(env: ControlPlaneEnv, tenantId: string) {
  const sql = getDb(env);
  const fly = new FlyClient(env.FLY_API_TOKEN, env.FLY_APP);
  const sharedImage = `registry.fly.io/${env.FLY_APP}:latest`;

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  if (tenant.status === "active") throw new Error(`Tenant ${tenantId} already provisioned`);

  await sql`UPDATE tenants SET status = 'provisioning', updated_at = now() WHERE id = ${tenantId}`;

  const appName = `army-${tenantId.toLowerCase()}`;
  const internalSecret = crypto.randomUUID();

  // Build guest config from tenant sizing columns (NULL = use defaults)
  const guest: GuestConfig | undefined =
    tenant.memory_mb || tenant.cpus
      ? {
          cpu_kind: "shared",
          cpus: tenant.cpus ?? 2,
          memory_mb: tenant.memory_mb ?? 1024,
        }
      : undefined;

  try {
    // 1. Create dedicated Fly app for this tenant
    await fly.createApp(appName, env.FLY_ORG);

    // 2. Allocate IPs (required for .fly.dev routing)
    await fly.allocateSharedIp(appName);
    await fly.allocateIpV6(appName);

    // 3. Create a FlyClient scoped to the per-tenant app
    const tenantFly = new FlyClient(env.FLY_API_TOKEN, appName, sharedImage);

    // 4. Gather credentials to inject as env vars
    const tokens = await sql`
      SELECT platform, token_type, access_token
      FROM integration_tokens WHERE tenant_id = ${tenantId}
    `;

    const machineEnv = buildMachineEnv(env, tenantId, internalSecret, tokens, tenant.anthropic_api_key, tenant.vera_production);

    // 5. Create volume + machine together (retries across regions on capacity errors)
    const volumeName = "anton_state";
    const { machine, volume } = await tenantFly.createMachineWithVolume(appName, machineEnv, volumeName, 1, guest);
    const instanceUrl = `https://${appName}.fly.dev`;

    // 6. Update tenant record with per-tenant app name
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

    // 7. Record deployment
    await sql`
      INSERT INTO deployments (tenant_id, fly_machine_id, image_ref, status)
      VALUES (${tenantId}, ${machine.id}, ${sharedImage}, 'running')
    `;

    // 8. Write KV routing entries for all platforms with an external_id
    const webhookPlatforms = await sql`
      SELECT DISTINCT platform, external_id FROM integration_tokens
      WHERE tenant_id = ${tenantId} AND external_id IS NOT NULL
    `;
    const route: TenantRoute = { instance_url: instanceUrl, internal_secret: internalSecret, fly_machine_id: machine.id };

    for (const { platform, external_id } of webhookPlatforms) {
      await env.ROUTING_TABLE.put(`${platform}:${external_id}`, JSON.stringify(route));
    }

    return { tenantId, machineId: machine.id, machineName: appName, instanceUrl };
  } catch (err) {
    // Clean up the created app on failure (best effort)
    try { await fly.deleteApp(appName); } catch { /* best effort */ }
    await sql`UPDATE tenants SET status = 'pending', updated_at = now() WHERE id = ${tenantId}`;
    throw err;
  }
}
