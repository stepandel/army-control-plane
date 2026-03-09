import { Hono } from "hono";
import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient } from "../lib/fly";

const provision = new Hono<{ Bindings: ControlPlaneEnv }>();

/**
 * POST /provision/:tenantId
 * Provisions a new Fly app + machine for a tenant and updates KV routing table.
 * Called internally after OAuth completes.
 */
provision.post("/:tenantId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const sql = getDb(c.env);
  const fly = new FlyClient(c.env.FLY_API_TOKEN);

  // Fetch tenant
  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  if (tenant.status === "active") return c.json({ error: "Already provisioned" }, 409);

  // Mark as provisioning
  await sql`UPDATE tenants SET status = 'provisioning', updated_at = now() WHERE id = ${tenantId}`;

  const flyAppName = `army-${tenantId.toLowerCase()}`;
  const internalSecret = crypto.randomUUID();

  try {
    // 1. Create Fly app
    await fly.createApp(flyAppName, c.env.FLY_ORG);

    // 2. Gather credentials to inject as env vars
    const tokens = await sql`
      SELECT platform, token_type, access_token
      FROM integration_tokens WHERE tenant_id = ${tenantId}
    `;

    const machineEnv: Record<string, string> = {
      TEAM_ID: tenantId,
      CONTROL_PLANE_URL: c.env.BASE_URL,
      INTERNAL_SECRET: internalSecret,
    };

    for (const t of tokens) {
      const key = `${t.platform.toUpperCase()}_${t.token_type.toUpperCase()}_TOKEN`;
      machineEnv[key] = t.access_token;
    }

    // 3. Create and start machine
    const machine = await fly.createMachine(flyAppName, `${flyAppName}-web`, machineEnv);

    const instanceUrl = `https://${flyAppName}.fly.dev`;

    // 4. Update tenant record
    await sql`
      UPDATE tenants
      SET fly_app_name = ${flyAppName},
          fly_machine_id = ${machine.id},
          instance_url = ${instanceUrl},
          status = 'active',
          updated_at = now()
      WHERE id = ${tenantId}
    `;

    // 5. Record deployment
    await sql`
      INSERT INTO deployments (tenant_id, fly_machine_id, image_ref, status)
      VALUES (${tenantId}, ${machine.id}, ${`registry.fly.io/pi-agent-images:latest`}, 'running')
    `;

    // 6. Write KV routing entries
    const platforms = await sql`SELECT DISTINCT platform FROM integration_tokens WHERE tenant_id = ${tenantId}`;
    const route: TenantRoute = { instance_url: instanceUrl, internal_secret: internalSecret };

    for (const { platform } of platforms) {
      await c.env.ROUTING_TABLE.put(`${platform}:${tenantId}`, JSON.stringify(route));
    }

    return c.json({
      tenantId,
      flyAppName,
      machineId: machine.id,
      instanceUrl,
      status: "active",
    });
  } catch (err) {
    // Roll back status on failure
    await sql`UPDATE tenants SET status = 'pending', updated_at = now() WHERE id = ${tenantId}`;
    console.error(`Provisioning failed for ${tenantId}:`, err);
    return c.json(
      { error: "Provisioning failed", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

export default provision;
