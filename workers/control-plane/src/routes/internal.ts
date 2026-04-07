import { Hono } from "hono";
import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import { getDb } from "../db/client";
import { refreshLinearToken } from "../lib/token-refresh";
import { pushCredentials } from "../lib/credentials";
import { decryptIfEncrypted } from "../lib/crypto";

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
    fly_machine_id: body.machine_id,
  };

  // Update KV routing table for all connected platforms
  const tokens =
    await sql`SELECT DISTINCT platform FROM integration_tokens WHERE tenant_id = ${body.team_id}`;
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

  // Decrypt and group by platform
  const credentials: Record<string, unknown[]> = {};
  for (const t of tokens) {
    const bucket = credentials[t.platform] ?? [];
    credentials[t.platform] = bucket;
    bucket.push({
      token_type: t.token_type,
      access_token: await decryptIfEncrypted(t.access_token, c.env.ENCRYPTION_KEY),
      refresh_token: t.refresh_token
        ? await decryptIfEncrypted(t.refresh_token, c.env.ENCRYPTION_KEY)
        : null,
      scopes: t.scopes,
      expires_at: t.expires_at,
    });
  }

  return c.json({ team_id: teamId, credentials });
});

/**
 * POST /internal/refresh-token/:team_id
 * Called by a Fly instance when it gets a 401 from Linear.
 * Refreshes the Linear token and pushes updated credentials.
 * Auth: Bearer <INTERNAL_SECRET>
 */
internal.post("/refresh-token/:team_id", async (c) => {
  const teamId = c.req.param("team_id");

  const authorized = await verifyInternalSecret(c.env, teamId, c.req.header("authorization"));
  if (!authorized) return c.json({ error: "Unauthorized" }, 401);

  const refreshed = await refreshLinearToken(c.env, teamId);
  if (!refreshed) return c.json({ error: "Token refresh failed" }, 502);

  // Push updated credentials to the machine
  c.executionCtx.waitUntil(
    pushCredentials(c.env, teamId).catch((err) =>
      console.error(`Credential push after refresh failed for ${teamId}:`, err),
    ),
  );

  // Return the new token immediately so the agent can retry without waiting for the push
  const sql = getDb(c.env);
  const [token] = await sql`
    SELECT access_token, expires_at FROM integration_tokens
    WHERE tenant_id = ${teamId} AND platform = 'linear'
  `;

  return c.json({
    refreshed: true,
    linear_access_token: await decryptIfEncrypted(token.access_token, c.env.ENCRYPTION_KEY),
    expires_at: token.expires_at,
  });
});

export default internal;
