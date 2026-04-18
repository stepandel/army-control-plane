import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDiscordProfile, fetchGitHubProfile, fetchGoogleProfile } from "./oauth-profile";

function mockFetch(responses: Array<{ url: RegExp; ok?: boolean; body: unknown }>) {
  const fn = vi.fn(async (input: Request | string | URL) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
    const match = responses.find((r) => r.url.test(url));
    if (!match) throw new Error(`unexpected fetch to ${url}`);
    return new Response(JSON.stringify(match.body), {
      status: match.ok === false ? 500 : 200,
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGoogleProfile", () => {
  it("normalizes a Google userinfo response", async () => {
    mockFetch([
      {
        url: /openidconnect\.googleapis\.com\/v1\/userinfo/,
        body: {
          sub: "1234567890",
          email: "alice@example.com",
          name: "Alice",
          picture: "https://lh3.googleusercontent.com/a/default",
        },
      },
    ]);

    const profile = await fetchGoogleProfile("gha-token");

    expect(profile).toEqual({
      provider: "google",
      providerUserId: "1234567890",
      email: "alice@example.com",
      name: "Alice",
      avatarUrl: "https://lh3.googleusercontent.com/a/default",
    });
  });

  it("tolerates missing optional fields", async () => {
    mockFetch([
      {
        url: /openidconnect\.googleapis\.com/,
        body: { sub: "only-sub" },
      },
    ]);

    const profile = await fetchGoogleProfile("token");

    expect(profile).toEqual({
      provider: "google",
      providerUserId: "only-sub",
      email: null,
      name: null,
      avatarUrl: null,
    });
  });

  it("throws when the userinfo response is missing sub", async () => {
    mockFetch([{ url: /openidconnect\.googleapis\.com/, body: { email: "x@y" } }]);

    await expect(fetchGoogleProfile("token")).rejects.toThrow("google_profile_failed");
  });
});

describe("fetchGitHubProfile", () => {
  it("coerces numeric ids to string and uses primary verified email from /user/emails", async () => {
    mockFetch([
      {
        url: /api\.github\.com\/user$/,
        body: {
          id: 42,
          login: "octocat",
          name: "The Octocat",
          email: null,
          avatar_url: "https://avatars.githubusercontent.com/u/42",
        },
      },
      {
        url: /api\.github\.com\/user\/emails/,
        body: [
          { email: "secondary@example.com", primary: false, verified: true },
          { email: "primary@example.com", primary: true, verified: true },
        ],
      },
    ]);

    const profile = await fetchGitHubProfile("gh-token");

    expect(profile).toEqual({
      provider: "github",
      providerUserId: "42",
      email: "primary@example.com",
      name: "The Octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/42",
    });
  });

  it("falls back to login when name is missing", async () => {
    mockFetch([
      {
        url: /api\.github\.com\/user$/,
        body: { id: "7", login: "octocat", email: "octo@example.com" },
      },
    ]);

    const profile = await fetchGitHubProfile("token");

    expect(profile.name).toBe("octocat");
    expect(profile.providerUserId).toBe("7");
    expect(profile.email).toBe("octo@example.com");
  });

  it("throws when the user endpoint has no id", async () => {
    mockFetch([{ url: /api\.github\.com\/user$/, body: { login: "x" } }]);

    await expect(fetchGitHubProfile("token")).rejects.toThrow("github_profile_failed");
  });
});

describe("fetchDiscordProfile", () => {
  it("builds a gif avatar URL for animated avatars", async () => {
    mockFetch([
      {
        url: /discord\.com\/api\/users\/@me/,
        body: {
          id: "111111111111111111",
          username: "legacy_name",
          global_name: "Shiny Display",
          email: "shiny@example.com",
          avatar: "a_abcdef",
        },
      },
    ]);

    const profile = await fetchDiscordProfile("token");

    expect(profile).toEqual({
      provider: "discord",
      providerUserId: "111111111111111111",
      email: "shiny@example.com",
      name: "Shiny Display",
      avatarUrl: "https://cdn.discordapp.com/avatars/111111111111111111/a_abcdef.gif",
    });
  });

  it("builds a png avatar URL for static avatars and falls back to username", async () => {
    mockFetch([
      {
        url: /discord\.com\/api\/users\/@me/,
        body: {
          id: "222",
          username: "legacy_user",
          avatar: "hash123",
        },
      },
    ]);

    const profile = await fetchDiscordProfile("token");

    expect(profile.name).toBe("legacy_user");
    expect(profile.avatarUrl).toBe("https://cdn.discordapp.com/avatars/222/hash123.png");
    expect(profile.email).toBeNull();
  });

  it("returns null avatar URL when no avatar hash is provided", async () => {
    mockFetch([
      {
        url: /discord\.com\/api\/users\/@me/,
        body: { id: "333", username: "noavatar" },
      },
    ]);

    const profile = await fetchDiscordProfile("token");
    expect(profile.avatarUrl).toBeNull();
  });

  it("throws when the response lacks id", async () => {
    mockFetch([{ url: /discord\.com\/api\/users\/@me/, body: { username: "x" } }]);

    await expect(fetchDiscordProfile("token")).rejects.toThrow("discord_profile_failed");
  });
});
