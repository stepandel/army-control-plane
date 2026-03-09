import { Hono } from "hono";
import type { ControlPlaneEnv } from "@vera/shared";
import { getDb } from "../db/client";

const admin = new Hono<{ Bindings: ControlPlaneEnv }>();

/** GET /admin/tenants — list all tenants */
admin.get("/tenants", async (c) => {
  const sql = getDb(c.env);
  const tenants = await sql`SELECT id, name, platform, status, fly_app_name, instance_url, created_at FROM tenants ORDER BY created_at DESC`;
  return c.json(tenants);
});

/** GET /admin/tenants/:id — single tenant detail */
admin.get("/tenants/:id", async (c) => {
  const sql = getDb(c.env);
  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${c.req.param("id")}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);

  const tokens = await sql`SELECT id, platform, token_type, scopes, created_at FROM integration_tokens WHERE tenant_id = ${tenant.id}`;
  const deployments = await sql`SELECT * FROM deployments WHERE tenant_id = ${tenant.id} ORDER BY created_at DESC`;

  return c.json({ ...tenant, tokens, deployments });
});

/** POST /admin/tenants/:id/suspend — suspend a tenant */
admin.post("/tenants/:id/suspend", async (c) => {
  const tenantId = c.req.param("id");
  const sql = getDb(c.env);

  await sql`UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = ${tenantId}`;

  // Remove KV routes so router stops forwarding
  const tokens = await sql`SELECT DISTINCT platform FROM integration_tokens WHERE tenant_id = ${tenantId}`;
  for (const { platform } of tokens) {
    await c.env.ROUTING_TABLE.delete(`${platform}:${tenantId}`);
  }

  return c.json({ tenantId, status: "suspended" });
});

export default admin;
