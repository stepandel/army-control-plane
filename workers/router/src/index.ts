import type { RouterEnv, WebhookSource } from "@army/shared";
import { verifyWebhook } from "./verify";
import { extractTeamId, extractTeamIdFromForm, resolveRoute, forwardToInstance } from "./forward";
import { isBillingBlocked } from "./billing";

/** Map exact URL path → webhook source */
function parseRoute(pathname: string): WebhookSource | null {
  switch (pathname) {
    case "/webhooks/slack":
      return "slack";
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

    // ── Slack slash commands (form-encoded, separate from Events API) ──
    if (url.pathname === "/slack/commands") {
      const rawBody = await request.text();

      const valid = await verifyWebhook("slack", rawBody, request.headers, {
        slack: env.SLACK_SIGNING_SECRET,
        linear: env.LINEAR_WEBHOOK_SECRET,
        github: env.GITHUB_WEBHOOK_SECRET,
      });
      if (!valid) return new Response("Invalid signature", { status: 401 });

      const teamId = extractTeamIdFromForm(rawBody);
      if (!teamId) return new Response("Missing team_id", { status: 400 });

      const tenantRoute = await resolveRoute(env, "slack", teamId);
      if (!tenantRoute) return new Response("Tenant not found", { status: 404 });

      if (isBillingBlocked(tenantRoute)) {
        console.log("[billing-blocked]", { source: "slack-command", teamId });
        return new Response("", { status: 200 });
      }

      forwardToInstance(ctx, tenantRoute, "slack", rawBody, request.headers, "/slack/commands");
      return new Response("", { status: 200 });
    }

    const source = parseRoute(url.pathname);
    if (!source) {
      return new Response("Not found", { status: 404 });
    }

    const rawBody = await request.text();

    // ── 1. Verify HMAC ──────────────────────────────────────────
    const valid = await verifyWebhook(source, rawBody, request.headers, {
      slack: env.SLACK_SIGNING_SECRET,
      linear: env.LINEAR_WEBHOOK_SECRET,
      github: env.GITHUB_WEBHOOK_SECRET,
    });
    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }

    // ── 1b. Slack URL verification challenge (one-time setup) ──
    if (source === "slack") {
      try {
        const payload = JSON.parse(rawBody);
        if (payload.type === "url_verification") {
          return new Response(JSON.stringify({ challenge: payload.challenge }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      } catch {
        /* not JSON — continue to normal flow */
      }
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

    // ── 3b. Billing gate ────────────────────────────────────────
    if (isBillingBlocked(tenantRoute)) {
      console.log("[billing-blocked]", { source, teamId });
      return new Response("OK", { status: 200 });
    }

    // ── 4. ACK + async forward ──────────────────────────────────
    forwardToInstance(ctx, tenantRoute, source, rawBody, request.headers);
    return new Response("OK", { status: 200 });
  },
} satisfies ExportedHandler<RouterEnv>;
