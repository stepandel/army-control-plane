/**
 * Standalone-account OAuth profile fetchers.
 *
 * Each function takes the provider's access token, calls the provider's
 * userinfo/profile endpoint, and normalizes the response into an
 * `IdentityProfile`. Pure functions in the sense that they only depend on
 * `fetch` — no env bindings, no DB — so they can be unit-tested with a
 * mocked `fetch`.
 */

export type StandaloneProvider = "google" | "github" | "discord";

export interface IdentityProfile {
  provider: StandaloneProvider;
  providerUserId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export async function fetchGoogleProfile(accessToken: string): Promise<IdentityProfile> {
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

export async function fetchGitHubProfile(accessToken: string): Promise<IdentityProfile> {
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

export async function fetchDiscordProfile(accessToken: string): Promise<IdentityProfile> {
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
