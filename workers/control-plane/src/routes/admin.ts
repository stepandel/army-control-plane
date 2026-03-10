import { Hono } from "hono";
import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient } from "../lib/fly";

const admin = new Hono<{ Bindings: ControlPlaneEnv }>();

const PLATFORMS = ["slack", "linear", "github"] as const;

/** GET /admin/tenants — list all tenants + status */
admin.get("/tenants", async (c) => {
  const sql = getDb(c.env);
  const tenants = await sql`
    SELECT id, name, platform, status, fly_app_name, instance_url, created_at, updated_at
    FROM tenants ORDER BY created_at DESC
  `;
  return c.json(tenants);
});

/** GET /admin/tenants/:team_id — single tenant detail + integration status */
admin.get("/tenants/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);

  const tokens = await sql`
    SELECT id, platform, token_type, scopes, created_at
    FROM integration_tokens WHERE tenant_id = ${teamId}
  `;
  const deployments = await sql`
    SELECT * FROM deployments WHERE tenant_id = ${teamId} ORDER BY created_at DESC
  `;

  // Build integration status per platform
  const integrations = PLATFORMS.map((p) => ({
    platform: p,
    connected: tokens.some((t) => t.platform === p),
    token_count: tokens.filter((t) => t.platform === p).length,
  }));

  return c.json({ ...tenant, integrations, tokens, deployments });
});

/** DELETE /admin/tenants/:team_id — destroy machine, delete KV entries, mark destroyed */
admin.delete("/tenants/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);
  const fly = new FlyClient(c.env.FLY_API_TOKEN, c.env.FLY_APP);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);

  // Destroy Fly machine
  if (tenant.fly_machine_id) {
    try {
      await fly.destroyMachine(tenant.fly_machine_id);
    } catch (err) {
      console.error(`Fly cleanup failed for ${teamId}:`, err);
      // Continue with DB/KV cleanup even if Fly fails
    }
  }

  // Mark any running deployment as stopped
  await sql`
    UPDATE deployments SET status = 'stopped', finished_at = now()
    WHERE tenant_id = ${teamId} AND status IN ('deploying', 'running')
  `;

  // Remove all KV routes
  for (const p of PLATFORMS) {
    await c.env.ROUTING_TABLE.delete(`${p}:${teamId}`);
  }

  // Mark tenant as destroyed
  await sql`
    UPDATE tenants
    SET status = 'destroyed', fly_machine_id = NULL, instance_url = NULL, updated_at = now()
    WHERE id = ${teamId}
  `;

  return c.json({ team_id: teamId, status: "destroyed" });
});

/** POST /admin/tenants/:team_id/reprovision — destroy + recreate machine */
admin.post("/tenants/:team_id/reprovision", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);
  const fly = new FlyClient(c.env.FLY_API_TOKEN, c.env.FLY_APP);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);
  if (tenant.status === "destroyed") return c.json({ error: "Tenant is destroyed, cannot reprovision" }, 400);

  // Destroy old Fly machine
  if (tenant.fly_machine_id) {
    try {
      await fly.destroyMachine(tenant.fly_machine_id);
    } catch (err) {
      console.error(`Fly cleanup failed for ${teamId}:`, err);
    }
  }

  // Mark old deployment as stopped
  await sql`
    UPDATE deployments SET status = 'stopped', finished_at = now()
    WHERE tenant_id = ${teamId} AND status IN ('deploying', 'running')
  `;

  // Reset tenant to pending so provision can run
  await sql`
    UPDATE tenants
    SET status = 'pending', fly_machine_id = NULL, fly_app_name = NULL, instance_url = NULL, updated_at = now()
    WHERE id = ${teamId}
  `;

  // Remove old KV routes
  for (const p of PLATFORMS) {
    await c.env.ROUTING_TABLE.delete(`${p}:${teamId}`);
  }

  // Trigger provisioning
  c.executionCtx.waitUntil(
    fetch(`${c.env.BASE_URL}/provision/${teamId}`, { method: "POST" }),
  );

  return c.json({ team_id: teamId, status: "reprovisioning" });
});

export default admin;
