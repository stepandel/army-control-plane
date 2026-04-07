import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ControlPlaneEnv } from "@army/shared";
import oauth from "./routes/oauth";
import auth from "./routes/auth";
import admin from "./routes/admin";
import deploy from "./routes/deploy";
import internal from "./routes/internal";
import apiOnboarding from "./routes/api-onboarding";
import billing from "./routes/billing";
import account from "./routes/account";
import stripeWebhook from "./routes/stripe-webhook";
import { cfAccessGuard } from "./middleware/cf-access";
import { refreshExpiringTokens } from "./lib/token-refresh";
import { enforceExpiredTrials } from "./lib/trial";
import { runHealthChecks } from "./lib/health-check";
import { runLangfuseAlertChecks } from "./lib/langfuse-alerts";

const app = new Hono<{ Bindings: ControlPlaneEnv }>();

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// CORS for website → API calls (public onboarding endpoints)
app.use(
  "/api/onboarding/*",
  cors({
    origin: (_, c) => c.env.WEBSITE_URL,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

// CORS for session-authenticated account endpoints — credentials: true is
// required so the browser sends the __Host-session cookie cross-origin
app.use(
  "/api/account/*",
  cors({
    origin: (_, c) => c.env.WEBSITE_URL,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    credentials: true,
  }),
);

// Public routes
app.route("/oauth", oauth);
app.route("/auth", auth);
app.route("/api/onboarding", apiOnboarding);
app.route("/api/onboarding", billing);
app.route("/stripe/webhook", stripeWebhook);
app.route("/internal", internal);
app.route("/deploy", deploy);

// Session-protected account routes
app.route("/api/account", account);

// Protected routes — require Cloudflare Access JWT
app.use("/admin/*", cfAccessGuard);
app.route("/admin", admin);

export default {
  fetch: app.fetch,
  /**
   * Cron dispatcher. Multiple schedules are declared in `wrangler.toml`
   * `[triggers] crons`; CF Workers delivers them all to this single handler,
   * so we route by `event.cron` to run the right job for each tick.
   *
   * Schedules:
   *   - every 30 minutes — Linear token refresh + expired-trial enforcement
   *   - every  5 minutes — fleet health checks (Fly state + token symptoms)
   */
  async scheduled(event: ScheduledEvent, env: ControlPlaneEnv, _ctx: ExecutionContext) {
    switch (event.cron) {
      case "*/30 * * * *": {
        await refreshExpiringTokens(env);
        await enforceExpiredTrials(env);
        return;
      }
      case "*/5 * * * *": {
        // Two independent jobs share this trigger. Run them sequentially —
        // each has its own try/catch inside, so one failing never blocks the
        // other.
        await runHealthChecks(env);
        await runLangfuseAlertChecks(env);
        return;
      }
      default: {
        // Unknown schedule — log and fall back to the legacy behavior so we
        // never silently drop a tick after someone edits wrangler.toml.
        console.warn(`scheduled: unknown cron "${event.cron}", running default job set`);
        await refreshExpiringTokens(env);
        await enforceExpiredTrials(env);
      }
    }
  },
};
