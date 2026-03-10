import type { RouterEnv, WebhookSource } from "@army/shared";
import { verifyWebhook } from "./verify";
import { extractTeamId, resolveRoute, forwardToInstance } from "./forward";

/** Map exact URL path → webhook source (Slack uses Socket Mode, not webhooks) */
function parseRoute(pathname: string): WebhookSource | null {
  switch (pathname) {
    case "/webhooks/linear":
      return "linear";
    case "/webhooks/github":
      return "github";
    default:
      return null;
  }
}

export default {
  async fetch(request: Request, env: RouterEnv, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const source = parseRoute(url.pathname);
    if (!source) {
      return new Response("Not found", { status: 404 });
    }

    const rawBody = await request.text();

    // ── 1. Verify HMAC ──────────────────────────────────────────
    const valid = await verifyWebhook(source, rawBody, request.headers, {
      linear: env.LINEAR_WEBHOOK_SECRET,
      github: env.GITHUB_WEBHOOK_SECRET,
    });
    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }

    // ── 2. Extract team identifier ──────────────────────────────
    const teamId = extractTeamId(source, rawBody);
    if (!teamId) {
      return new Response("Missing team identifier", { status: 400 });
    }

    // ── 3. KV lookup ────────────────────────────────────────────
    const tenantRoute = await resolveRoute(env, source, teamId);
    if (!tenantRoute) {
      return new Response("Tenant not found", { status: 404 });
    }

    // ── 4. ACK + async forward ──────────────────────────────────
    forwardToInstance(ctx, tenantRoute, source, rawBody, request.headers);
    return new Response("OK", { status: 200 });
  },
} satisfies ExportedHandler<RouterEnv>;
