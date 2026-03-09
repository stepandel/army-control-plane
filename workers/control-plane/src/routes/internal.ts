import { Hono } from "hono";
import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import { getDb } from "../db/client";

const internal = new Hono<{ Bindings: ControlPlaneEnv }>();

/**
 * POST /internal/register
 * Called by a Fly instance after boot to register its URL.
 * Body: { team_id: string, instance_url: string, machine_id: string }
 */
internal.post("/register", async (c) => {
  const body = await c.req.json<{
    team_id: string;
    instance_url: string;
    machine_id: string;
  }>();

  if (!body.team_id || !body.instance_url || !body.machine_id) {
    return c.json({ error: "Missing team_id, instance_url, or machine_id" }, 400);
  }

  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${body.team_id}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  // Update tenant with live instance details
  await sql`
    UPDATE tenants
    SET instance_url = ${body.instance_url},
        fly_machine_id = ${body.machine_id},
        status = 'active',
        updated_at = now()
    WHERE id = ${body.team_id}
  `;

  // Update KV routing table for all connected platforms
  const tokens = await sql`SELECT DISTINCT platform FROM integration_tokens WHERE tenant_id = ${body.team_id}`;
  const internalSecret = tenant.internal_secret ?? crypto.randomUUID();
  const route: TenantRoute = {
    instance_url: body.instance_url,
    internal_secret: internalSecret,
  };

  for (const { platform } of tokens) {
    await c.env.ROUTING_TABLE.put(
      `${platform}:${body.team_id}`,
      JSON.stringify(route),
    );
  }

  return c.json({ registered: true, team_id: body.team_id });
});

/**
 * GET /internal/credentials/:team_id
 * Called by a Fly instance on boot to fetch all its integration credentials.
 * Returns tokens grouped by platform.
 */
internal.get("/credentials/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT id, status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const tokens = await sql`
    SELECT platform, token_type, access_token, refresh_token, scopes, expires_at
    FROM integration_tokens
    WHERE tenant_id = ${teamId}
  `;

  // Group by platform
  const credentials: Record<string, unknown[]> = {};
  for (const t of tokens) {
    (credentials[t.platform] ??= []).push({
      token_type: t.token_type,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      scopes: t.scopes,
      expires_at: t.expires_at,
    });
  }

  return c.json({ team_id: teamId, credentials });
});

export default internal;
