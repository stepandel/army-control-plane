// ── KV routing record stored per tenant ──────────────────────────
export interface TenantRoute {
  /** Fly machine URL, e.g. "https://army-t123-ab12.fly.dev" */
  instance_url: string;
  /** Shared secret for Worker ↔ Fly HMAC verification */
  internal_secret: string;
  /** Fly machine ID — stored for reference, no longer used for routing (app-per-tenant = auto-routing) */
  fly_machine_id?: string;
  /** Billing gate — checked by the router before forwarding (optional for backward compat) */
  subscription_status?: string;
  /** ISO 8601 — when the free trial ends (only set when subscription_status === "trialing") */
  trial_ends_at?: string;
  /** ISO 8601 — past_due grace period deadline (7 days from first failure) */
  grace_deadline?: string;
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
  /** Ephemeral alert bookkeeping — dedupe keys (1h TTL) and health-check bad-state counters. */
  // Optional: when unbound, alert dedupe and health-check bad-state tracking
  // are no-ops (alerts still fire, just without suppression). See the TODO in
  // workers/control-plane/wrangler.toml for how to provision the namespace.
  ALERT_STATE?: KVNamespace;
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
  ENCRYPTION_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID_MONTHLY: string;
  STRIPE_PRICE_ID_YEARLY: string;
  SESSION_SECRET: string;

  /** Slack incoming-webhook URL for ops alerts (set via `wrangler secret put ALERT_SLACK_WEBHOOK_URL`). */
  ALERT_SLACK_WEBHOOK_URL: string;
}
