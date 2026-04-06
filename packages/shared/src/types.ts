// ── KV routing record stored per tenant ──────────────────────────
export interface TenantRoute {
  /** Fly machine URL, e.g. "https://army-t123-ab12.fly.dev" */
  instance_url: string;
  /** Shared secret for Worker ↔ Fly HMAC verification */
  internal_secret: string;
  /** Fly machine ID — stored for reference, no longer used for routing (app-per-tenant = auto-routing) */
  fly_machine_id?: string;
}

// ── Webhook source discriminator ─────────────────────────────────
export type WebhookSource = "slack" | "linear" | "github";

// ── Router Worker environment bindings ───────────────────────────
export interface RouterEnv {
  ROUTING_TABLE: KVNamespace;
  SLACK_SIGNING_SECRET: string;
  LINEAR_WEBHOOK_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
}

// ── Control Plane Worker environment bindings ────────────────────
export interface ControlPlaneEnv {
  ROUTING_TABLE: KVNamespace;
  OAUTH_STATE: KVNamespace;
  DB: Hyperdrive;
  BASE_URL: string;
  WEBSITE_URL: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;

  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_ID: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_PRIVATE_KEY: string;
  FLY_API_TOKEN_VERA: string;
  FLY_APP: string;
  FLY_ORG: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  DEPLOY_SECRET: string;
  ANTHROPIC_API_KEY: string;
  BRAVE_API_KEY: string;
  LANGSMITH_TRACING: string;
  LANGSMITH_PROJECT: string;
  LANGSMITH_API_KEY: string;
  LANGFUSE_SECRET_KEY: string;
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_BASE_URL: string;
  ENABLE_LANGSMITH: string;
  ENCRYPTION_KEY: string;
}
