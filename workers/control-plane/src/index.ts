import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ControlPlaneEnv } from "@army/shared";
import oauth from "./routes/oauth";
import admin from "./routes/admin";
import deploy from "./routes/deploy";
import internal from "./routes/internal";
import apiOnboarding from "./routes/api-onboarding";
import billing from "./routes/billing";
import { cfAccessGuard } from "./middleware/cf-access";
import { refreshExpiringTokens } from "./lib/token-refresh";

const app = new Hono<{ Bindings: ControlPlaneEnv }>();

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// CORS for website → API calls
app.use(
  "/api/onboarding/*",
  cors({
    origin: (_, c) => c.env.WEBSITE_URL,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

// Public routes
app.route("/oauth", oauth);
app.route("/api/onboarding", apiOnboarding);
app.route("/api/onboarding", billing);
app.route("/internal", internal);
app.route("/deploy", deploy);

// Protected routes — require Cloudflare Access JWT
app.use("/admin/*", cfAccessGuard);
app.route("/admin", admin);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: ControlPlaneEnv, _ctx: ExecutionContext) {
    await refreshExpiringTokens(env);
  },
};
