import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient } from "./fly";
import { buildMachineEnv } from "./machine-env";

/**
 * Provision a new Fly machine for a tenant.
 * Creates the machine, updates DB + KV, records deployment.
 * Throws on failure after rolling back tenant status.
 */
export async function provisionTenant(env: ControlPlaneEnv, tenantId: string) {
  const sql = getDb(env);
  const fly = new FlyClient(env.FLY_API_TOKEN, env.FLY_APP);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  if (tenant.status === "active") throw new Error(`Tenant ${tenantId} already provisioned`);

  await sql`UPDATE tenants SET status = 'provisioning', updated_at = now() WHERE id = ${tenantId}`;

  const machineName = `army-${tenantId.toLowerCase()}`;
  const internalSecret = crypto.randomUUID();

  try {
    // Gather credentials to inject as env vars
    const tokens = await sql`
      SELECT platform, token_type, access_token
      FROM integration_tokens WHERE tenant_id = ${tenantId}
    `;

    const machineEnv = buildMachineEnv(env, tenantId, internalSecret, tokens);

    // Create volume + machine together (retries across regions on capacity errors)
    const volumeName = `state_${tenantId.toLowerCase()}`;
    const { machine, volume } = await fly.createMachineWithVolume(machineName, machineEnv, volumeName, 1);
    const instanceUrl = `https://${env.FLY_APP}.fly.dev`;

    // Update tenant record
    await sql`
      UPDATE tenants
      SET fly_app_name = ${env.FLY_APP},
          fly_machine_id = ${machine.id},
          fly_volume_id = ${volume.id},
          instance_url = ${instanceUrl},
          status = 'active',
          updated_at = now()
      WHERE id = ${tenantId}
    `;

    // Record deployment
    const imageRef = `registry.fly.io/${env.FLY_APP}:latest`;
    await sql`
      INSERT INTO deployments (tenant_id, fly_machine_id, image_ref, status)
      VALUES (${tenantId}, ${machine.id}, ${imageRef}, 'running')
    `;

    // Write KV routing entries for webhook-based platforms only.
    // Slack uses Socket Mode (outbound WebSocket from the machine), so no routing entry needed.
    const webhookPlatforms = await sql`
      SELECT DISTINCT platform, external_id FROM integration_tokens
      WHERE tenant_id = ${tenantId} AND platform != 'slack' AND external_id IS NOT NULL
    `;
    const route: TenantRoute = { instance_url: instanceUrl, internal_secret: internalSecret, fly_machine_id: machine.id };

    for (const { platform, external_id } of webhookPlatforms) {
      await env.ROUTING_TABLE.put(`${platform}:${external_id}`, JSON.stringify(route));
    }

    return { tenantId, machineId: machine.id, machineName, instanceUrl };
  } catch (err) {
    await sql`UPDATE tenants SET status = 'pending', updated_at = now() WHERE id = ${tenantId}`;
    throw err;
  }
}
