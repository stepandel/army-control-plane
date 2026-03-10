import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient } from "../lib/fly";

const credentials = new Hono<{ Bindings: ControlPlaneEnv }>();

/**
 * POST /credentials/:tenantId/push
 * Pushes integration tokens to the tenant's Fly machine by updating its env vars.
 * The machine reboots to pick up the new config.
 */
credentials.post("/:tenantId/push", async (c) => {
  const tenantId = c.req.param("tenantId");
  const sql = getDb(c.env);
  const fly = new FlyClient(c.env.FLY_API_TOKEN, c.env.FLY_APP);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  if (tenant.status !== "active") return c.json({ error: "Tenant not active" }, 400);
  if (!tenant.fly_machine_id) {
    return c.json({ error: "Tenant has no Fly machine" }, 400);
  }

  const tokens = await sql`
    SELECT platform, token_type, access_token
    FROM integration_tokens
    WHERE tenant_id = ${tenantId}
  `;

  if (tokens.length === 0) return c.json({ error: "No tokens to push" }, 404);

  // Build env vars from all tokens
  const machineEnv: Record<string, string> = {
    TEAM_ID: tenantId,
    CONTROL_PLANE_URL: c.env.BASE_URL,
    INTERNAL_SECRET: crypto.randomUUID(),
  };

  for (const t of tokens) {
    const key = `${t.platform.toUpperCase()}_${t.token_type.toUpperCase()}_TOKEN`;
    machineEnv[key] = t.access_token;
  }

  // Update machine — this reboots it with the new env
  await fly.updateMachine(tenant.fly_machine_id, machineEnv);

  return c.json({
    tenantId,
    pushed: tokens.map((t) => ({ platform: t.platform, type: t.token_type })),
    rebooted: true,
  });
});

export default credentials;
