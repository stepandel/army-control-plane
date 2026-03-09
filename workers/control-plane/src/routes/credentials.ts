import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";

const credentials = new Hono<{ Bindings: ControlPlaneEnv }>();

/**
 * POST /credentials/:tenantId/push
 * Pushes integration tokens to the tenant's Fly machine as secrets.
 */
credentials.post("/:tenantId/push", async (c) => {
  const tenantId = c.req.param("tenantId");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  if (tenant.status !== "active") return c.json({ error: "Tenant not active" }, 400);

  const tokens = await sql`
    SELECT platform, token_type, access_token
    FROM integration_tokens
    WHERE tenant_id = ${tenantId}
  `;

  if (tokens.length === 0) return c.json({ error: "No tokens to push" }, 404);

  // TODO: Call Fly.io Machines API to set secrets on the machine
  // For now, just acknowledge
  return c.json({
    tenantId,
    pushed: tokens.map((t) => ({ platform: t.platform, type: t.token_type })),
  });
});

export default credentials;
