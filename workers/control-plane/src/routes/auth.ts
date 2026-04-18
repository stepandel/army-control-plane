import { Hono, type Context } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { createState, verifyState } from "../lib/oauth-state";
import { signJwt } from "../lib/jwt";
import { createCustomer } from "../lib/stripe";

const auth = new Hono<{ Bindings: ControlPlaneEnv }>();
type AuthContext = Context<{ Bindings: ControlPlaneEnv }>;

const SLACK_OIDC_SCOPES = "openid,email,profile";
const GOOGLE_SCOPES = "openid email profile";
const GITHUB_SCOPES = "read:user user:email";
const DISCORD_SCOPES = "identify email";

type StandaloneProvider = "google" | "github" | "discord";

interface IdentityProfile {
  provider: StandaloneProvider;
  providerUserId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

const STANDALONE_PROVIDERS: Record<
  StandaloneProvider,
  {
    authorizationUrl: string;
    tokenUrl: string;
    clientId: (env: ControlPlaneEnv) => string;
    clientSecret: (env: ControlPlaneEnv) => string;
    redirectPath: string;
    scope: string;
  }
> = {
  google: {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    redirectPath: "/auth/google/callback",
    scope: GOOGLE_SCOPES,
  },
  github: {
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientId: (env) => env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: (env) => env.GITHUB_OAUTH_CLIENT_SECRET,
    redirectPath: "/auth/github/callback",
    scope: GITHUB_SCOPES,
  },
  discord: {
    authorizationUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    clientId: (env) => env.DISCORD_CLIENT_ID,
    clientSecret: (env) => env.DISCORD_CLIENT_SECRET,
    redirectPath: "/auth/discord/callback",
    scope: DISCORD_SCOPES,
  },
};

/** GET /slack/authorize — redirect to Slack OIDC consent screen */
auth.get("/slack/authorize", async (c) => {
  const state = await createState(c.env.OAUTH_STATE);
  const nonce = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: c.env.SLACK_CLIENT_ID,
    scope: SLACK_OIDC_SCOPES,
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
    return c.redirect(`${c.env.WEBSITE_URL}/sign-in?error=oauth_failed`);
  }

  const idToken = tokenData.id_token as string;
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    return c.redirect(`${c.env.WEBSITE_URL}/sign-in?error=oauth_failed`);
  }

  let idPayload: Record<string, unknown>;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    idPayload = JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return c.redirect(`${c.env.WEBSITE_URL}/sign-in?error=oauth_failed`);
  }

  const slackTeamId = idPayload["https://slack.com/team_id"] as string | undefined;
  const slackUserId = idPayload["https://slack.com/user_id"] as string | undefined;
  const email = (idPayload.email as string | undefined) ?? null;
  const name = (idPayload.name as string | undefined) ?? null;
  const avatar = (idPayload["https://slack.com/user_image_72"] as string | undefined) ?? null;

  if (!slackTeamId || !slackUserId) {
    return c.redirect(`${c.env.WEBSITE_URL}/sign-in?error=oauth_failed`);
  }

  const sql = getDb(c.env);

  const [tenant] = await sql`
    SELECT id, name, stripe_customer_id FROM tenants WHERE id = ${slackTeamId}
  `;
  if (!tenant) {
    return c.redirect(`${c.env.WEBSITE_URL}/sign-in?error=team_not_found`);
  }

  if (!tenant.stripe_customer_id) {
    try {
      const stripeCustomerId = await createCustomer(
        c.env.STRIPE_SECRET_KEY,
        tenant.id,
        tenant.name,
      );
      await sql`
        UPDATE tenants
        SET stripe_customer_id = ${stripeCustomerId}, updated_at = now()
        WHERE id = ${tenant.id} AND stripe_customer_id IS NULL
      `;
    } catch (err) {
      console.error(`Stripe customer backfill failed for ${tenant.id}:`, err);
    }
  }

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

auth.get("/google/authorize", (c) => beginStandaloneAuth(c, "google"));
auth.get("/github/authorize", (c) => beginStandaloneAuth(c, "github"));
auth.get("/discord/authorize", (c) => beginStandaloneAuth(c, "discord"));

auth.get("/google/callback", (c) => finishStandaloneAuth(c, "google"));
auth.get("/github/callback", (c) => finishStandaloneAuth(c, "github"));
auth.get("/discord/callback", (c) => finishStandaloneAuth(c, "discord"));

async function beginStandaloneAuth(c: AuthContext, provider: StandaloneProvider) {
  const config = STANDALONE_PROVIDERS[provider];
  const state = await createState(c.env.OAUTH_STATE);

  const params = new URLSearchParams({
    client_id: config.clientId(c.env),
    redirect_uri: `${c.env.BASE_URL}${config.redirectPath}`,
    response_type: "code",
    scope: config.scope,
    state,
  });

  if (provider === "google") {
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  }

  return c.redirect(`${config.authorizationUrl}?${params}`);
}

async function finishStandaloneAuth(c: AuthContext, provider: StandaloneProvider) {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.text("Missing code or state", 400);

  const statePayload = await verifyState(c.env.OAUTH_STATE, state);
  if (!statePayload) return c.text("Invalid or expired state", 403);

  try {
    const profile = await fetchStandaloneProfile(c.env, provider, code);
    const account = await upsertStandaloneAccount(getDb(c.env), profile);
    const jwt = await signJwt(
      {
        sub: account.id,
        ...(account.email !== null && { email: account.email }),
        ...(account.name !== null && { name: account.name }),
      },
      c.env.SESSION_SECRET,
    );

    return c.redirect(`${c.env.WEBSITE_URL}/auth/complete?token=${jwt}&next=/account`);
  } catch (err) {
    console.error(`${provider} auth failed:`, err);
    return c.redirect(`${c.env.WEBSITE_URL}/sign-in?error=oauth_failed`);
  }
}

async function fetchStandaloneProfile(
  env: ControlPlaneEnv,
  provider: StandaloneProvider,
  code: string,
): Promise<IdentityProfile> {
  const config = STANDALONE_PROVIDERS[provider];
  const tokenResp = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId(env),
      client_secret: config.clientSecret(env),
      code,
      redirect_uri: `${env.BASE_URL}${config.redirectPath}`,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = (await tokenResp.json()) as Record<string, unknown>;
  const accessToken = tokenData.access_token;
  if (!tokenResp.ok || typeof accessToken !== "string") {
    throw new Error(`token_exchange_failed:${provider}`);
  }

  switch (provider) {
    case "google":
      return fetchGoogleProfile(accessToken);
    case "github":
      return fetchGitHubProfile(accessToken);
    case "discord":
      return fetchDiscordProfile(accessToken);
  }
}

async function fetchGoogleProfile(accessToken: string): Promise<IdentityProfile> {
  const resp = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = (await resp.json()) as Record<string, unknown>;
  const sub = data.sub;
  if (!resp.ok || typeof sub !== "string") {
    throw new Error("google_profile_failed");
  }

  return {
    provider: "google",
    providerUserId: sub,
    email: typeof data.email === "string" ? data.email : null,
    name: typeof data.name === "string" ? data.name : null,
    avatarUrl: typeof data.picture === "string" ? data.picture : null,
  };
}

async function fetchGitHubProfile(accessToken: string): Promise<IdentityProfile> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "army-control-plane",
    "x-github-api-version": "2022-11-28",
  };

  const userResp = await fetch("https://api.github.com/user", { headers });
  const userData = (await userResp.json()) as Record<string, unknown>;
  const id = userData.id;
  if (!userResp.ok || (typeof id !== "number" && typeof id !== "string")) {
    throw new Error("github_profile_failed");
  }

  let email = typeof userData.email === "string" ? userData.email : null;
  if (!email) {
    const emailResp = await fetch("https://api.github.com/user/emails", { headers });
    if (emailResp.ok) {
      const emails = (await emailResp.json()) as Array<Record<string, unknown>>;
      const chosen =
        emails.find((entry) => entry.primary === true && entry.verified === true) ??
        emails.find((entry) => entry.verified === true) ??
        emails[0];
      email = typeof chosen?.email === "string" ? chosen.email : null;
    }
  }

  return {
    provider: "github",
    providerUserId: String(id),
    email,
    name:
      typeof userData.name === "string"
        ? userData.name
        : typeof userData.login === "string"
          ? userData.login
          : null,
    avatarUrl: typeof userData.avatar_url === "string" ? userData.avatar_url : null,
  };
}

async function fetchDiscordProfile(accessToken: string): Promise<IdentityProfile> {
  const resp = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = (await resp.json()) as Record<string, unknown>;
  const id = data.id;
  if (!resp.ok || typeof id !== "string") {
    throw new Error("discord_profile_failed");
  }

  const avatar = typeof data.avatar === "string" ? data.avatar : null;
  const avatarExt = avatar?.startsWith("a_") ? "gif" : "png";
  const avatarUrl = avatar
    ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.${avatarExt}`
    : null;

  return {
    provider: "discord",
    providerUserId: id,
    email: typeof data.email === "string" ? data.email : null,
    name:
      typeof data.global_name === "string"
        ? data.global_name
        : typeof data.username === "string"
          ? data.username
          : null,
    avatarUrl,
  };
}

async function upsertStandaloneAccount(
  sql: ReturnType<typeof getDb>,
  profile: IdentityProfile,
): Promise<{ id: string; email: string | null; name: string | null }> {
  const existing = await findAccountByIdentity(sql, profile);
  if (existing) {
    return updateStandaloneAccount(sql, existing.id, profile);
  }

  const [created] = await sql`
    INSERT INTO accounts (email, name, avatar_url, updated_at, last_login_at)
    VALUES (${profile.email}, ${profile.name}, ${profile.avatarUrl}, now(), now())
    RETURNING id
  `;

  await sql`
    INSERT INTO account_identities (
      account_id,
      provider,
      provider_user_id,
      provider_email,
      provider_name,
      provider_avatar_url,
      updated_at,
      last_login_at
    )
    VALUES (
      ${created.id},
      ${profile.provider},
      ${profile.providerUserId},
      ${profile.email},
      ${profile.name},
      ${profile.avatarUrl},
      now(),
      now()
    )
    ON CONFLICT (provider, provider_user_id) DO NOTHING
  `;

  const linked = await findAccountByIdentity(sql, profile);
  if (!linked) {
    throw new Error("account_identity_upsert_failed");
  }

  if (linked.id !== created.id) {
    await sql`DELETE FROM accounts WHERE id = ${created.id}`;
  }

  return updateStandaloneAccount(sql, linked.id, profile);
}

async function findAccountByIdentity(
  sql: ReturnType<typeof getDb>,
  profile: IdentityProfile,
): Promise<{ id: string } | null> {
  const [account] = await sql`
    SELECT a.id
    FROM account_identities ai
    JOIN accounts a ON a.id = ai.account_id
    WHERE ai.provider = ${profile.provider}
      AND ai.provider_user_id = ${profile.providerUserId}
  `;

  return account ? { id: String(account.id) } : null;
}

async function updateStandaloneAccount(
  sql: ReturnType<typeof getDb>,
  accountId: string,
  profile: IdentityProfile,
): Promise<{ id: string; email: string | null; name: string | null }> {
  await sql`
    UPDATE account_identities
    SET provider_email = ${profile.email},
        provider_name = ${profile.name},
        provider_avatar_url = ${profile.avatarUrl},
        updated_at = now(),
        last_login_at = now()
    WHERE provider = ${profile.provider}
      AND provider_user_id = ${profile.providerUserId}
  `;

  const [account] = await sql`
    UPDATE accounts
    SET email = COALESCE(${profile.email}, accounts.email),
        name = COALESCE(${profile.name}, accounts.name),
        avatar_url = COALESCE(${profile.avatarUrl}, accounts.avatar_url),
        updated_at = now(),
        last_login_at = now()
    WHERE id = ${accountId}
    RETURNING id, email, name
  `;

  return {
    id: String(account.id),
    email: (account.email as string | null) ?? null,
    name: (account.name as string | null) ?? null,
  };
}

export default auth;
