import type { ControlPlaneEnv } from "@army/shared";

export interface MachineEnvResult {
  /** Sensitive values — set via Fly app secrets (encrypted, never exposed by API). */
  secrets: Record<string, string>;
  /** Non-sensitive values — set via machine config.env (visible in API responses). */
  config: Record<string, string>;
}

/**
 * Build the complete env var map for a tenant's Fly machine.
 * Single source of truth — used by both provisionTenant and pushCredentials.
 *
 * Returns secrets and config separately so callers can route sensitive values
 * through Fly app secrets (encrypted at rest) and non-sensitive values through
 * machine config.env.
 */
export function buildMachineEnv(
  env: ControlPlaneEnv,
  tenantId: string,
  internalSecret: string,
  tokens: readonly Record<string, string>[],
  tenantAnthropicKey?: string | null,
  veraProduction?: boolean,
  tracingProvider?: string,
  subscriptionStatus?: string,
): MachineEnvResult {
  const tracing = tracingProvider ?? "langfuse";

  const secrets: Record<string, string> = {
    INTERNAL_SECRET: internalSecret,
    ANTHROPIC_API_KEY: (tenantAnthropicKey && tenantAnthropicKey !== "null") ? tenantAnthropicKey : env.ANTHROPIC_API_KEY,
    BRAVE_API_KEY: env.BRAVE_API_KEY,
    GITHUB_PRIVATE_KEY: env.GITHUB_PRIVATE_KEY,
    LINEAR_CLIENT_SECRET: env.LINEAR_CLIENT_SECRET,
  };

  if (tracing === "langfuse") {
    secrets.LANGFUSE_SECRET_KEY = env.LANGFUSE_SECRET_KEY;
  } else if (tracing === "langsmith") {
    secrets.LANGSMITH_API_KEY = env.LANGSMITH_API_KEY;
  }

  for (const t of tokens) {
    const suffix = t.platform === "github" && t.token_type === "installation" ? "ID" : "TOKEN";
    const key = `${t.platform.toUpperCase()}_${t.token_type.toUpperCase()}_${suffix}`;
    secrets[key] = t.access_token;
  }

  const config: Record<string, string> = {
    TEAM_ID: tenantId,
    CONTROL_PLANE_URL: env.BASE_URL,
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    LINEAR_CLIENT_ID: env.LINEAR_CLIENT_ID,
    VERA_PRODUCTION: (veraProduction ?? true) ? "true" : "false",
    SUBSCRIPTION_STATUS: subscriptionStatus ?? "trialing",
  };

  if (tracing === "langfuse") {
    config.LANGFUSE_PUBLIC_KEY = env.LANGFUSE_PUBLIC_KEY;
    config.LANGFUSE_BASE_URL = env.LANGFUSE_BASE_URL;
  } else if (tracing === "langsmith") {
    config.LANGSMITH_TRACING = env.LANGSMITH_TRACING;
    config.LANGSMITH_PROJECT = env.LANGSMITH_PROJECT;
  }

  return { secrets, config };
}

/**
 * Flatten secrets + config into a single env map.
 * Useful for testing or any context where a single map is needed.
 */
export function flattenMachineEnv(result: MachineEnvResult): Record<string, string> {
  return { ...result.config, ...result.secrets };
}
