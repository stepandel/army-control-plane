// ── KV routing record stored per tenant ──────────────────────────
export interface TenantRoute {
  /** Fly machine URL, e.g. "https://pi-agent-images.fly.dev" */
  instance_url: string;
  /** Shared secret for Worker ↔ Fly HMAC verification */
  internal_secret: string;
  /** Fly machine ID — used with fly-force-instance-id header to pin requests to the correct machine */
  fly_machine_id: string;
}

// ── Webhook source discriminator ─────────────────────────────────
export type WebhookSource = "slack" | "linear" | "github";

// ── Router Worker environment bindings ───────────────────────────
// Slack uses Socket Mode (WebSocket from tenant machines), not webhooks.
export interface RouterEnv {
  ROUTING_TABLE: KVNamespace;
  LINEAR_WEBHOOK_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
}

// ── Control Plane Worker environment bindings ────────────────────
export interface ControlPlaneEnv {
  ROUTING_TABLE: KVNamespace;
  OAUTH_STATE: KVNamespace;
  DB: Hyperdrive;
  BASE_URL: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  SLACK_APP_TOKEN: string;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_ID: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_PRIVATE_KEY: string;
  FLY_API_TOKEN: string;
  FLY_APP: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  ANTHROPIC_API_KEY: string;
}
