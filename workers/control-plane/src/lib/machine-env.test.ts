import { describe, expect, it } from "vitest";
import type { ControlPlaneEnv } from "@army/shared";
import { buildMachineEnv } from "./machine-env";

// ── Helpers ────────────────────────────────────────────────────

/**
 * Build a minimal `ControlPlaneEnv` where every value is a deterministic
 * string derived from the field name. We don't need real KV / Hyperdrive
 * bindings because `buildMachineEnv` only reads string fields.
 */
function makeEnv(): ControlPlaneEnv {
  const env = {
    BASE_URL: "https://cp.test",
    WEBSITE_URL: "https://www.test",
    SLACK_CLIENT_ID: "slack-client-id",
    SLACK_CLIENT_SECRET: "slack-client-secret",
    LINEAR_CLIENT_ID: "linear-client-id",
    LINEAR_CLIENT_SECRET: "linear-client-secret",
    GITHUB_APP_SLUG: "test-app",
    GITHUB_APP_ID: "12345",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    GITHUB_PRIVATE_KEY: "github-private-key",
    FLY_API_TOKEN_VERA: "fly-token",
    FLY_APP: "test-app",
    FLY_ORG: "test-org",
    CF_ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
    CF_ACCESS_AUD: "aud-xyz",
    DEPLOY_SECRET: "deploy-secret",
    ANTHROPIC_API_KEY: "global-anthropic-key",
    BRAVE_API_KEY: "brave-key",
    LANGSMITH_TRACING: "true",
    LANGSMITH_PROJECT: "ls-project",
    LANGSMITH_API_KEY: "ls-api-key",
    LANGFUSE_SECRET_KEY: "lf-secret-key",
    LANGFUSE_PUBLIC_KEY: "lf-public-key",
    LANGFUSE_BASE_URL: "https://lf.test",
    ENCRYPTION_KEY: "encryption-key",
    STRIPE_SECRET_KEY: "stripe-secret",
    STRIPE_WEBHOOK_SECRET: "stripe-webhook-secret",
    STRIPE_PRICE_ID_MONTHLY: "price_monthly",
    STRIPE_PRICE_ID_YEARLY: "price_yearly",
    SESSION_SECRET: "session-secret",
    // These three are KV / Hyperdrive bindings that `buildMachineEnv` never
    // touches; casting satisfies the type without mocking the runtime.
  } as unknown as ControlPlaneEnv;
  return env;
}

// ── Tests ──────────────────────────────────────────────────────

describe("buildMachineEnv", () => {
  it("produces the expected env shape for a Slack + Linear + GitHub tenant", () => {
    const env = makeEnv();
    const tokens = [
      { platform: "slack", token_type: "bot", access_token: "xoxb-slack-token" },
      { platform: "linear", token_type: "oauth", access_token: "lin_oauth_token" },
      { platform: "github", token_type: "installation", access_token: "98765" },
    ];

    const result = buildMachineEnv(env, "T-TENANT-1", "internal-secret-1", tokens);

    // ── Secrets (sensitive, go through Fly app secrets) ──
    expect(result.secrets).toMatchObject({
      INTERNAL_SECRET: "internal-secret-1",
      ANTHROPIC_API_KEY: "global-anthropic-key",
      BRAVE_API_KEY: "brave-key",
      GITHUB_PRIVATE_KEY: "github-private-key",
      LINEAR_CLIENT_SECRET: "linear-client-secret",
      // Default tracing = langfuse
      LANGFUSE_SECRET_KEY: "lf-secret-key",
      // Token-derived secrets (platform_type_{TOKEN,ID}) ──
      SLACK_BOT_TOKEN: "xoxb-slack-token",
      LINEAR_OAUTH_TOKEN: "lin_oauth_token",
      GITHUB_INSTALLATION_ID: "98765",
    });

    // ── Config (non-sensitive, go through machine config.env) ──
    expect(result.config).toMatchObject({
      TEAM_ID: "T-TENANT-1",
      CONTROL_PLANE_URL: "https://cp.test",
      GITHUB_APP_ID: "12345",
      LINEAR_CLIENT_ID: "linear-client-id",
      VERA_PRODUCTION: "true",
      SUBSCRIPTION_STATUS: "trialing",
      LANGFUSE_PUBLIC_KEY: "lf-public-key",
      LANGFUSE_BASE_URL: "https://lf.test",
    });

    // ── Cross-tenant isolation: no leakage of other tenants' tokens ──
    // Only the exact token secrets for the 3 platforms passed in should exist.
    // An empty or wrong-tenant token list should NOT produce any *_TOKEN / *_ID
    // secrets for other platforms.
    const platformSecretKeys = Object.keys(result.secrets).filter(
      (k) => k.startsWith("SLACK_") || k.startsWith("LINEAR_") || k.startsWith("GITHUB_"),
    );
    expect(platformSecretKeys.sort()).toEqual(
      [
        // Static secrets sourced from env:
        "GITHUB_PRIVATE_KEY",
        "LINEAR_CLIENT_SECRET",
        // Token-derived secrets from the three platforms in `tokens`:
        "GITHUB_INSTALLATION_ID",
        "LINEAR_OAUTH_TOKEN",
        "SLACK_BOT_TOKEN",
      ].sort(),
    );
  });

  it("uses the tenant-specific Anthropic key when provided", () => {
    const env = makeEnv();
    const result = buildMachineEnv(env, "T-1", "s", [], "tenant-specific-key");
    expect(result.secrets.ANTHROPIC_API_KEY).toBe("tenant-specific-key");
  });

  it("falls back to the global Anthropic key when tenant key is 'null' or missing", () => {
    const env = makeEnv();
    const nullLiteral = buildMachineEnv(env, "T-1", "s", [], "null");
    expect(nullLiteral.secrets.ANTHROPIC_API_KEY).toBe("global-anthropic-key");

    const missing = buildMachineEnv(env, "T-1", "s", [], null);
    expect(missing.secrets.ANTHROPIC_API_KEY).toBe("global-anthropic-key");
  });

  it("switches tracing secrets when provider is langsmith", () => {
    const env = makeEnv();
    const result = buildMachineEnv(env, "T-1", "s", [], null, true, "langsmith");
    expect(result.secrets.LANGSMITH_API_KEY).toBe("ls-api-key");
    expect(result.secrets.LANGFUSE_SECRET_KEY).toBeUndefined();
    expect(result.config.LANGSMITH_PROJECT).toBe("ls-project");
    expect(result.config.LANGFUSE_PUBLIC_KEY).toBeUndefined();
  });
});
