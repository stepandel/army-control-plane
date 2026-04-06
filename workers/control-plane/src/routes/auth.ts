import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { createState, verifyState } from "../lib/oauth-state";
import { signJwt } from "../lib/jwt";

const auth = new Hono<{ Bindings: ControlPlaneEnv }>();

const OIDC_SCOPES = "openid,email,profile";

/** GET /slack/authorize — redirect to Slack OIDC consent screen */
auth.get("/slack/authorize", async (c) => {
  const state = await createState(c.env.OAUTH_STATE);
  const nonce = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: c.env.SLACK_CLIENT_ID,
    scope: OIDC_SCOPES,
    response_type: "code",
    redirect_uri: `${c.env.BASE_URL}/auth/slack/callback`,
    state,
    nonce,
  });

  return c.redirect(`https://slack.com/openid/connect/authorize?${params}`);
});

/** GET /slack/callback — exchange OIDC code for id_token, look up user, create session */
auth.get("/slack/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing code or state", 400);

  const statePayload = await verifyState(c.env.OAUTH_STATE, state);
  if (!statePayload) return c.text("Invalid or expired state", 403);

  // Exchange code for tokens via Slack OIDC token endpoint
  const tokenResp = await fetch("https://slack.com/api/openid.connect.token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.SLACK_CLIENT_ID,
      client_secret: c.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: `${c.env.BASE_URL}/auth/slack/callback`,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = (await tokenResp.json()) as Record<string, unknown>;
  if (!tokenData.ok || !tokenData.id_token) {
    console.error("Slack OIDC token exchange failed:", tokenData);
    return c.redirect(`${c.env.WEBSITE_URL}/sign-in?error=oidc_failed`);
  }

  // Decode id_token payload (signature trusted — token came directly from Slack
  // over TLS in confidential client flow with our client_secret)
  const idToken = tokenData.id_token as string;
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    return c.redirect(`${c.env.WEBSITE_URL}/sign-in?error=oidc_failed`);
  }

  let idPayload: Record<string, unknown>;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    idPayload = JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return c.redirect(`${c.env.WEBSITE_URL}/sign-in?error=oidc_failed`);
  }

  const slackTeamId = idPayload["https://slack.com/team_id"] as string | undefined;
  const slackUserId = idPayload["https://slack.com/user_id"] as string | undefined;
  const email = (idPayload.email as string | undefined) ?? null;
  const name = (idPayload.name as string | undefined) ?? null;
  const avatar = (idPayload["https://slack.com/user_image_72"] as string | undefined) ?? null;

  if (!slackTeamId || !slackUserId) {
    return c.redirect(`${c.env.WEBSITE_URL}/sign-in?error=oidc_failed`);
  }

  const sql = getDb(c.env);

  // Verify the team has installed the app (tenant exists)
  const [tenant] = await sql`SELECT id FROM tenants WHERE id = ${slackTeamId}`;
  if (!tenant) {
    return c.redirect(`${c.env.WEBSITE_URL}/sign-in?error=team_not_found`);
  }

  // Upsert user — sign-in flow may be the first time we capture profile data
  // (the install flow only captures slack_user_id; OIDC gives us email/name/avatar)
  const [user] = await sql`
    INSERT INTO users (slack_user_id, slack_team_id, email, name, avatar_url)
    VALUES (${slackUserId}, ${slackTeamId}, ${email}, ${name}, ${avatar})
    ON CONFLICT (slack_team_id, slack_user_id)
    DO UPDATE SET
      email = COALESCE(${email}, users.email),
      name = COALESCE(${name}, users.name),
      avatar_url = COALESCE(${avatar}, users.avatar_url),
      last_login_at = now()
    RETURNING id
  `;

  // Sign session JWT and hand off to the website
  const jwt = await signJwt(
    {
      sub: user.id,
      team_id: slackTeamId,
      slack_uid: slackUserId,
      ...(email !== null && { email }),
      ...(name !== null && { name }),
    },
    c.env.SESSION_SECRET,
  );

  return c.redirect(`${c.env.WEBSITE_URL}/auth/complete?token=${jwt}&next=/account`);
});

export default auth;
