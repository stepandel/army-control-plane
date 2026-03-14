import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import oauth from "./routes/oauth";
import admin from "./routes/admin";
import internal from "./routes/internal";
import { cfAccessGuard } from "./middleware/cf-access";
import { refreshExpiringTokens } from "./lib/token-refresh";

const app = new Hono<{ Bindings: ControlPlaneEnv }>();

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Public routes
app.route("/oauth", oauth);
app.route("/internal", internal);

// Protected routes — require Cloudflare Access JWT
app.use("/admin/*", cfAccessGuard);
app.route("/admin", admin);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: ControlPlaneEnv, _ctx: ExecutionContext) {
    await refreshExpiringTokens(env);
  },
};
