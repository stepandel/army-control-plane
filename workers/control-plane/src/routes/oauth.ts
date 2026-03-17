import { Hono } from "hono";
import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import { getDb } from "../db/client";
import { createState, verifyState } from "../lib/oauth-state";
import { provisionTenant } from "../lib/provision";
import { pushCredentials } from "../lib/credentials";
import { provisionLinearLabels } from "../lib/linear-labels";

const oauth = new Hono<{ Bindings: ControlPlaneEnv }>();

const SLACK_BOT_SCOPES = [
  "chat:write",
  "chat:write.customize",
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "users:read",
  "app_mentions:read",
  "reactions:read",
  "reactions:write",
  "pins:read",
  "pins:write",
  "emoji:read",
  "commands",
  "files:read",
  "files:write",
].join(",");

const SLACK_USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
  "reactions:read",
  "pins:read",
  "emoji:read",
  "search:read",
].join(",");

// ─── Slack ───────────────────────────────────────────────────────

/** Redirect to Slack OAuth consent screen. This is the primary install flow. */
oauth.get("/slack/install", async (c) => {
  const state = await createState(c.env.OAUTH_STATE);
  const params = new URLSearchParams({
    client_id: c.env.SLACK_CLIENT_ID,
    scope: SLACK_BOT_SCOPES,
    user_scope: SLACK_USER_SCOPES,
    redirect_uri: `${c.env.BASE_URL}/oauth/slack/callback`,
    state,
  });
  return c.redirect(`https://slack.com/oauth/v2/authorize?${params}`);
});

/** Exchange Slack code, upsert tenant, store token, provision machine. */
oauth.get("/slack/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing code or state", 400);

  const statePayload = await verifyState(c.env.OAUTH_STATE, state);
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

  // Upsert bot token
  await sql`
    INSERT INTO integration_tokens (tenant_id, platform, token_type, access_token, scopes)
    VALUES (${teamId}, 'slack', 'bot', ${botToken}, ${scopes})
    ON CONFLICT (tenant_id, platform) DO UPDATE
      SET access_token = ${botToken}, scopes = ${scopes}
  `;

  // Provision machine (fire-and-forget)
  c.executionCtx.waitUntil(
    provisionTenant(c.env, teamId).catch((err) =>
      console.error(`Provisioning failed for ${teamId}:`, err),
    ),
  );

  return c.text(`Slack workspace "${teamName}" connected. Provisioning started.`);
});

// ─── Linear ──────────────────────────────────────────────────────

/** Redirect to Linear OAuth consent screen. Requires ?tenant_id= for linking. */
oauth.get("/linear/install", async (c) => {
  const tenantId = c.req.query("tenant_id");
  if (!tenantId) return c.text("Missing tenant_id", 400);

  const state = await createState(c.env.OAUTH_STATE, tenantId);
  const params = new URLSearchParams({
    client_id: c.env.LINEAR_CLIENT_ID,
    redirect_uri: `${c.env.BASE_URL}/oauth/linear/callback`,
    response_type: "code",
    scope: "read,write,issues:create,comments:create,app:assignable,app:mentionable,customer:read,initiative:read",
    state,
    actor: "app",
    prompt: "consent",
  });
  return c.redirect(`https://linear.app/oauth/authorize?${params}`);
});

/** Exchange Linear code, store token, push credentials to Fly instance. */
oauth.get("/linear/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing code or state", 400);

  const statePayload = await verifyState(c.env.OAUTH_STATE, state);
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
  const refreshToken = (data.refresh_token as string) ?? null;
  const expiresIn = data.expires_in as number | undefined;
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
  const scopes = (data.scope as string) ?? "";

  // Fetch the Linear organization ID — webhooks use this, not our tenant ID
  const orgResp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query: "{ organization { id } }" }),
  });
  const orgData = (await orgResp.json()) as { data?: { organization?: { id?: string } } };
  const linearOrgId = orgData.data?.organization?.id;
  if (!linearOrgId) return c.json({ error: "Failed to fetch Linear organization ID" }, 500);

  // Upsert token with Linear org ID for KV routing
  await sql`
    INSERT INTO integration_tokens (tenant_id, platform, token_type, access_token, refresh_token, scopes, external_id, expires_at)
    VALUES (${tenantId}, 'linear', 'bot', ${accessToken}, ${refreshToken}, ${scopes}, ${linearOrgId}, ${expiresAt}::timestamptz)
    ON CONFLICT (tenant_id, platform) DO UPDATE
      SET access_token = ${accessToken}, refresh_token = ${refreshToken}, scopes = ${scopes}, external_id = ${linearOrgId}, expires_at = ${expiresAt}::timestamptz
  `;

  // Write KV route for linear:<linearOrgId> — the router extracts organizationId from webhooks
  // internal_secret is temporary; pushCredentials() below regenerates it for all KV entries
  const linearRoute: TenantRoute = {
    instance_url: tenant.instance_url,
    internal_secret: crypto.randomUUID(),
    fly_machine_id: tenant.fly_machine_id,
  };
  await c.env.ROUTING_TABLE.put(`linear:${linearOrgId}`, JSON.stringify(linearRoute));

  // Provision labels + push credentials (fire-and-forget, sequential)
  c.executionCtx.waitUntil(
    provisionLinearLabels(accessToken)
      .catch((err) => console.error(`Label provisioning failed for ${tenantId}:`, err))
      .then(() => pushCredentials(c.env, tenantId))
      .catch((err) => console.error(`Credential push failed for ${tenantId}:`, err)),
  );

  return c.text("Linear connected. Credentials are being pushed to your instance.");
});

// ─── GitHub ──────────────────────────────────────────────────────

/** Redirect to GitHub App installation page. Requires ?tenant_id= for linking. */
oauth.get("/github/install", async (c) => {
  const tenantId = c.req.query("tenant_id");
  if (!tenantId) return c.text("Missing tenant_id", 400);

  const state = await createState(c.env.OAUTH_STATE, tenantId);
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

  const statePayload = await verifyState(c.env.OAUTH_STATE, state);
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

  // Upsert installation ID — access tokens are generated on-demand from the app's private key
  await sql`
    INSERT INTO integration_tokens (tenant_id, platform, token_type, access_token, scopes, external_id)
    VALUES (${tenantId}, 'github', 'installation', ${installationId}, ${setupAction ?? "install"}, ${installationId})
    ON CONFLICT (tenant_id, platform) DO UPDATE
      SET access_token = ${installationId}, scopes = ${setupAction ?? "install"}, external_id = ${installationId}
  `;

  // Write KV route for github:<installationId> — the router extracts installation.id from webhooks
  // internal_secret is temporary; pushCredentials() below regenerates it for all KV entries
  const githubRoute: TenantRoute = {
    instance_url: tenant.instance_url,
    internal_secret: crypto.randomUUID(),
    fly_machine_id: tenant.fly_machine_id,
  };
  await c.env.ROUTING_TABLE.put(`github:${installationId}`, JSON.stringify(githubRoute));

  // Push credentials to the running instance (fire-and-forget)
  c.executionCtx.waitUntil(
    pushCredentials(c.env, tenantId).catch((err) =>
      console.error(`Credential push failed for ${tenantId}:`, err),
    ),
  );

  return c.text("GitHub App installed. Credentials are being pushed to your instance.");
});

export default oauth;
