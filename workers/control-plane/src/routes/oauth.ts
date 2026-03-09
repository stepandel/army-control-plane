import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { createState, verifyState } from "../lib/oauth-state";

const oauth = new Hono<{ Bindings: ControlPlaneEnv }>();

// ─── Slack ───────────────────────────────────────────────────────

/** Redirect to Slack OAuth consent screen. This is the primary install flow. */
oauth.get("/slack/install", async (c) => {
  const state = await createState(c.env.ROUTING_TABLE);
  const params = new URLSearchParams({
    client_id: c.env.SLACK_CLIENT_ID,
    scope: c.env.SLACK_SCOPES,
    redirect_uri: `${c.env.BASE_URL}/oauth/slack/callback`,
    state,
  });
  return c.redirect(`https://slack.com/oauth/v2/authorize?${params}`);
});

/** Exchange Slack code, upsert tenant, store token, trigger provisioning. */
oauth.get("/slack/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing code or state", 400);

  const statePayload = await verifyState(c.env.ROUTING_TABLE, state);
  if (!statePayload) return c.text("Invalid or expired state", 403);

  // Exchange code for token
  const resp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.SLACK_CLIENT_ID,
      client_secret: c.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: `${c.env.BASE_URL}/oauth/slack/callback`,
    }),
  });

  const data = (await resp.json()) as Record<string, unknown>;
  if (!data.ok) return c.json({ error: "Slack OAuth failed", detail: data }, 400);

  const teamId = (data.team as Record<string, string>).id;
  const teamName = (data.team as Record<string, string>).name;
  const botToken = data.access_token as string;
  const scopes = (data.scope as string) ?? "";

  const sql = getDb(c.env);

  // Upsert tenant — Slack is the primary platform
  await sql`
    INSERT INTO tenants (id, name, platform, status)
    VALUES (${teamId}, ${teamName}, 'slack', 'pending')
    ON CONFLICT (id) DO UPDATE SET name = ${teamName}, updated_at = now()
  `;

  // Store bot token
  await sql`
    INSERT INTO integration_tokens (tenant_id, platform, token_type, access_token, scopes)
    VALUES (${teamId}, 'slack', 'bot', ${botToken}, ${scopes})
  `;

  // Trigger provisioning (fire-and-forget to our own /provision endpoint)
  c.executionCtx.waitUntil(
    fetch(`${c.env.BASE_URL}/provision/${teamId}`, { method: "POST" }),
  );

  return c.text(`Slack workspace "${teamName}" connected. Provisioning started.`);
});

// ─── Linear ──────────────────────────────────────────────────────

/** Redirect to Linear OAuth consent screen. Requires ?tenant_id= for linking. */
oauth.get("/linear/install", async (c) => {
  const tenantId = c.req.query("tenant_id");
  if (!tenantId) return c.text("Missing tenant_id", 400);

  const state = await createState(c.env.ROUTING_TABLE, tenantId);
  const params = new URLSearchParams({
    client_id: c.env.LINEAR_CLIENT_ID,
    redirect_uri: `${c.env.BASE_URL}/oauth/linear/callback`,
    response_type: "code",
    scope: "read,write,issues:create,comments:create",
    state,
    actor: "application",
    prompt: "consent",
  });
  return c.redirect(`https://linear.app/oauth/authorize?${params}`);
});

/** Exchange Linear code, store token, push credentials to Fly instance. */
oauth.get("/linear/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing code or state", 400);

  const statePayload = await verifyState(c.env.ROUTING_TABLE, state);
  if (!statePayload?.tenantId) return c.text("Invalid or expired state", 403);
  const tenantId = statePayload.tenantId;

  const sql = getDb(c.env);

  // Verify tenant exists and is active
  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) return c.text("Tenant not found", 404);
  if (tenant.status !== "active") return c.text("Tenant not yet provisioned", 400);

  // Exchange code for token
  const resp = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.LINEAR_CLIENT_ID,
      client_secret: c.env.LINEAR_CLIENT_SECRET,
      code,
      redirect_uri: `${c.env.BASE_URL}/oauth/linear/callback`,
      grant_type: "authorization_code",
    }),
  });

  const data = (await resp.json()) as Record<string, unknown>;
  if (!data.access_token) return c.json({ error: "Linear OAuth failed", detail: data }, 400);

  const accessToken = data.access_token as string;
  const scopes = (data.scope as string) ?? "";

  // Store token
  await sql`
    INSERT INTO integration_tokens (tenant_id, platform, token_type, access_token, scopes)
    VALUES (${tenantId}, 'linear', 'bot', ${accessToken}, ${scopes})
  `;

  // Write KV route for linear:<tenantId>
  const existingRoute = await c.env.ROUTING_TABLE.get(`slack:${tenantId}`, "json");
  if (existingRoute) {
    await c.env.ROUTING_TABLE.put(`linear:${tenantId}`, JSON.stringify(existingRoute));
  }

  // Push credentials to the running instance
  c.executionCtx.waitUntil(
    fetch(`${c.env.BASE_URL}/credentials/${tenantId}/push`, { method: "POST" }),
  );

  return c.text("Linear connected. Credentials are being pushed to your instance.");
});

// ─── GitHub ──────────────────────────────────────────────────────

/** Redirect to GitHub App installation page. Requires ?tenant_id= for linking. */
oauth.get("/github/install", async (c) => {
  const tenantId = c.req.query("tenant_id");
  if (!tenantId) return c.text("Missing tenant_id", 400);

  const state = await createState(c.env.ROUTING_TABLE, tenantId);
  return c.redirect(
    `https://github.com/apps/${c.env.GITHUB_APP_SLUG}/installations/new?state=${state}`,
  );
});

/** Handle GitHub App installation callback, store installation ID, push credentials. */
oauth.get("/github/callback", async (c) => {
  const installationId = c.req.query("installation_id");
  const setupAction = c.req.query("setup_action");
  const state = c.req.query("state");
  if (!installationId || !state) return c.text("Missing installation_id or state", 400);

  const statePayload = await verifyState(c.env.ROUTING_TABLE, state);
  if (!statePayload?.tenantId) return c.text("Invalid or expired state", 403);
  const tenantId = statePayload.tenantId;

  if (setupAction === "request") {
    return c.text("Installation request sent to the org owner. Complete approval on GitHub.", 202);
  }

  const sql = getDb(c.env);

  // Verify tenant exists and is active
  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) return c.text("Tenant not found", 404);
  if (tenant.status !== "active") return c.text("Tenant not yet provisioned", 400);

  // Store the installation ID — access tokens are generated on-demand from the app's private key
  await sql`
    INSERT INTO integration_tokens (tenant_id, platform, token_type, access_token, scopes)
    VALUES (${tenantId}, 'github', 'installation', ${installationId}, ${setupAction ?? "install"})
  `;

  // Write KV route for github:<tenantId>
  const existingRoute = await c.env.ROUTING_TABLE.get(`slack:${tenantId}`, "json");
  if (existingRoute) {
    await c.env.ROUTING_TABLE.put(`github:${tenantId}`, JSON.stringify(existingRoute));
  }

  // Push credentials to the running instance
  c.executionCtx.waitUntil(
    fetch(`${c.env.BASE_URL}/credentials/${tenantId}/push`, { method: "POST" }),
  );

  return c.text("GitHub App installed. Credentials are being pushed to your instance.");
});

export default oauth;
