import { Hono } from "hono";
import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import { getDb } from "../db/client";

const provision = new Hono<{ Bindings: ControlPlaneEnv }>();

/**
 * POST /provision/:tenantId
 * Provisions a new Fly machine for a tenant and updates KV routing table.
 * Called internally after OAuth completes.
 */
provision.post("/:tenantId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const sql = getDb(c.env);

  // Fetch tenant
  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  if (tenant.status === "active") return c.json({ error: "Already provisioned" }, 409);

  // Mark as provisioning
  await sql`UPDATE tenants SET status = 'provisioning', updated_at = now() WHERE id = ${tenantId}`;

  // TODO: Call Fly.io Machines API to create machine
  // For now, stub the response
  const flyAppName = `army-${tenantId.toLowerCase()}`;
  const instanceUrl = `https://${flyAppName}.fly.dev`;
  const internalSecret = crypto.randomUUID();

  // Update tenant record
  await sql`
    UPDATE tenants
    SET fly_app_name = ${flyAppName},
        instance_url = ${instanceUrl},
        status = 'active',
        updated_at = now()
    WHERE id = ${tenantId}
  `;

  // Write KV routing entry for each platform this tenant uses
  const tokens = await sql`SELECT DISTINCT platform FROM integration_tokens WHERE tenant_id = ${tenantId}`;
  const route: TenantRoute = { instance_url: instanceUrl, internal_secret: internalSecret };

  for (const { platform } of tokens) {
    await c.env.ROUTING_TABLE.put(
      `${platform}:${tenantId}`,
      JSON.stringify(route),
    );
  }

  return c.json({ tenantId, flyAppName, instanceUrl, status: "active" });
});

export default provision;
