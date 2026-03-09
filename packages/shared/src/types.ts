// ── KV routing record stored per tenant ──────────────────────────
export interface TenantRoute {
  /** Fly machine URL, e.g. "https://vera-t012345.fly.dev" */
  instance_url: string;
  /** Shared secret for Worker ↔ Fly HMAC verification */
  internal_secret: string;
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
  DB: Hyperdrive;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  FLY_API_TOKEN: string;
  INTERNAL_SECRET_KEY: string;
}
