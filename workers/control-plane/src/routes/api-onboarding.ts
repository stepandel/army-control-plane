import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { pushCredentials } from "../lib/credentials";
import { encrypt, decryptIfEncrypted } from "../lib/crypto";

const apiOnboarding = new Hono<{ Bindings: ControlPlaneEnv }>();

// ─── Tenant + integrations ─────────────────────────────────────

apiOnboarding.get("/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT id, name, status, anthropic_api_key, telemetry_enabled FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "not_found" }, 404);

  const tokens =
    await sql`SELECT platform FROM integration_tokens WHERE tenant_id = ${teamId}`;

  return c.json({
    tenant: {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      has_anthropic_key: !!tenant.anthropic_api_key,
      telemetry_enabled: tenant.telemetry_enabled,
    },
    integrations: tokens.map((t) => (t as Record<string, string>).platform),
  });
});

// ─── Status polling ────────────────────────────────────────────

apiOnboarding.get("/:team_id/status", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);
  const [tenant] = await sql`SELECT status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "not_found" }, 404);
  return c.json({ status: tenant.status });
});

// ─── Anthropic API key BYOK ────────────────────────────────────

apiOnboarding.post("/:team_id/anthropic-key", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const body = await c.req.json<{ api_key?: string }>();
  if (!body.api_key || typeof body.api_key !== "string" || !body.api_key.startsWith("sk-ant-")) {
    return c.json({ error: "Invalid API key — must start with sk-ant-" }, 400);
  }

  const [tenant] = await sql`SELECT id, status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const encApiKey = await encrypt(body.api_key, c.env.ENCRYPTION_KEY);
  await sql`UPDATE tenants SET anthropic_api_key = ${encApiKey}, updated_at = now() WHERE id = ${teamId}`;

  if (tenant.status === "active") {
    c.executionCtx.waitUntil(
      pushCredentials(c.env, teamId).catch((err) =>
        console.error(`pushCredentials failed after BYOK set for ${teamId}:`, err),
      ),
    );
  }

  return c.json({ success: true, status: "custom_key_set" });
});

apiOnboarding.delete("/:team_id/anthropic-key", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT id, status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  await sql`UPDATE tenants SET anthropic_api_key = NULL, updated_at = now() WHERE id = ${teamId}`;

  if (tenant.status === "active") {
    c.executionCtx.waitUntil(
      pushCredentials(c.env, teamId).catch((err) =>
        console.error(`pushCredentials failed after BYOK reset for ${teamId}:`, err),
      ),
    );
  }

  return c.json({ success: true, status: "using_default" });
});

// ─── Telemetry opt-out ────────────────────────────────────────

apiOnboarding.patch("/:team_id/telemetry", async (c) => {
  const teamId = c.req.param("team_id");
  const body = await c.req.json<{ enabled: boolean }>();

  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "Request body must include { enabled: boolean }" }, 400);
  }

  const sql = getDb(c.env);
  const [tenant] = await sql`SELECT id, status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  await sql`
    UPDATE tenants SET telemetry_enabled = ${body.enabled}, updated_at = now()
    WHERE id = ${teamId}
  `;

  if (tenant.status === "active") {
    c.executionCtx.waitUntil(
      pushCredentials(c.env, teamId).catch((err) =>
        console.error(`pushCredentials failed after telemetry toggle for ${teamId}:`, err),
      ),
    );
  }

  return c.json({ success: true, telemetry_enabled: body.enabled });
});

export default apiOnboarding;
