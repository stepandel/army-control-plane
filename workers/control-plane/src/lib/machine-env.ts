import type { ControlPlaneEnv } from "@army/shared";

/**
 * Build the complete env var map for a tenant's Fly machine.
 * Single source of truth — used by both provisionTenant and pushCredentials.
 */
export function buildMachineEnv(
  env: ControlPlaneEnv,
  tenantId: string,
  internalSecret: string,
  tokens: readonly Record<string, string>[],
  tenantAnthropicKey?: string | null,
): Record<string, string> {
  const machineEnv: Record<string, string> = {
    TEAM_ID: tenantId,
    CONTROL_PLANE_URL: env.BASE_URL,
    INTERNAL_SECRET: internalSecret,
    SLACK_APP_TOKEN: env.SLACK_APP_TOKEN,
    ANTHROPIC_API_KEY: tenantAnthropicKey || env.ANTHROPIC_API_KEY,
    BRAVE_API_KEY: env.BRAVE_API_KEY,
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_PRIVATE_KEY: env.GITHUB_PRIVATE_KEY,
    LINEAR_CLIENT_ID: env.LINEAR_CLIENT_ID,
    LINEAR_CLIENT_SECRET: env.LINEAR_CLIENT_SECRET,
    LANGSMITH_TRACING: env.LANGSMITH_TRACING,
    LANGSMITH_PROJECT: env.LANGSMITH_PROJECT,
    LANGSMITH_API_KEY: env.LANGSMITH_API_KEY,
    ANTON_CONFIG_DIR: "/opt/anton/.anton",
    ANTON_STATE_DIR: "/workspace/.anton",
  };

  for (const t of tokens) {
    // GitHub stores the installation ID (not a token) — name the env var accordingly
    const suffix = t.platform === "github" && t.token_type === "installation" ? "ID" : "TOKEN";
    const key = `${t.platform.toUpperCase()}_${t.token_type.toUpperCase()}_${suffix}`;
    machineEnv[key] = t.access_token;
  }

  return machineEnv;
}
