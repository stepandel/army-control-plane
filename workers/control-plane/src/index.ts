import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import oauth from "./routes/oauth";
import provision from "./routes/provision";
import credentials from "./routes/credentials";
import admin from "./routes/admin";
import internal from "./routes/internal";

const app = new Hono<{ Bindings: ControlPlaneEnv }>();

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Mount route groups
app.route("/oauth", oauth);
app.route("/provision", provision);
app.route("/credentials", credentials);
app.route("/admin", admin);
app.route("/internal", internal);

export default app;
