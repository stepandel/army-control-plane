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

  const [tenant] = await sql`SELECT id, name, status, anthropic_api_key, tracing_provider FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "not_found" }, 404);

  const tokens =
    await sql`SELECT platform FROM integration_tokens WHERE tenant_id = ${teamId}`;

  return c.json({
    tenant: {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      has_anthropic_key: !!tenant.anthropic_api_key,
      tracing_provider: tenant.tracing_provider,
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

// ─── Tracing provider ────────────────────────────────────────

apiOnboarding.patch("/:team_id/tracing-provider", async (c) => {
  const teamId = c.req.param("team_id");
  const body = await c.req.json<{ provider: string }>();

  const validProviders = ["langfuse", "langsmith", "none"];
  if (!validProviders.includes(body.provider)) {
    return c.json({ error: `provider must be one of: ${validProviders.join(", ")}` }, 400);
  }

  const sql = getDb(c.env);
  const [tenant] = await sql`SELECT id, status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  await sql`
    UPDATE tenants SET tracing_provider = ${body.provider}, updated_at = now()
    WHERE id = ${teamId}
  `;

  if (tenant.status === "active") {
    c.executionCtx.waitUntil(
      pushCredentials(c.env, teamId).catch((err) =>
        console.error(`pushCredentials failed after tracing provider change for ${teamId}:`, err),
      ),
    );
  }

  return c.json({ success: true, tracing_provider: body.provider });
});

export default apiOnboarding;
