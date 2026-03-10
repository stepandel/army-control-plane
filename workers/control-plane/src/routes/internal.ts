import { Hono } from "hono";
import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import { getDb } from "../db/client";

const internal = new Hono<{ Bindings: ControlPlaneEnv }>();

/**
 * Verify the per-tenant INTERNAL_SECRET from the Authorization header.
 * The machine receives this secret as an env var during provisioning.
 * We look it up from KV (stored in the TenantRoute) to validate.
 */
async function verifyInternalSecret(
  env: ControlPlaneEnv,
  teamId: string,
  authHeader: string | undefined,
): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);

  // Check all platform routes for this tenant — they all share the same internal_secret
  for (const platform of ["slack", "linear", "github"]) {
    const route = await env.ROUTING_TABLE.get<TenantRoute>(`${platform}:${teamId}`, "json");
    if (route) {
      return route.internal_secret === token;
    }
  }

  return false;
}

/**
 * POST /internal/register
 * Called by a Fly instance after boot to register its URL.
 * Auth: Bearer <INTERNAL_SECRET>
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

  const authorized = await verifyInternalSecret(c.env, body.team_id, c.req.header("authorization"));
  if (!authorized) return c.json({ error: "Unauthorized" }, 401);

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

  // Preserve existing internal_secret when updating KV routes
  const existingRoute = await c.env.ROUTING_TABLE.get<TenantRoute>(`slack:${body.team_id}`, "json");
  const internalSecret = existingRoute?.internal_secret ?? crypto.randomUUID();

  const route: TenantRoute = {
    instance_url: body.instance_url,
    internal_secret: internalSecret,
  };

  // Update KV routing table for all connected platforms
  const tokens = await sql`SELECT DISTINCT platform FROM integration_tokens WHERE tenant_id = ${body.team_id}`;
  for (const { platform } of tokens) {
    await c.env.ROUTING_TABLE.put(`${platform}:${body.team_id}`, JSON.stringify(route));
  }

  return c.json({ registered: true, team_id: body.team_id });
});

/**
 * GET /internal/credentials/:team_id
 * Called by a Fly instance on boot to fetch all its integration credentials.
 * Auth: Bearer <INTERNAL_SECRET>
 * Returns tokens grouped by platform.
 */
internal.get("/credentials/:team_id", async (c) => {
  const teamId = c.req.param("team_id");

  const authorized = await verifyInternalSecret(c.env, teamId, c.req.header("authorization"));
  if (!authorized) return c.json({ error: "Unauthorized" }, 401);

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
