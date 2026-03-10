import type { RouterEnv, WebhookSource } from "@army/shared";
import { verifyWebhook } from "./verify";
import type { SlackSubRoute } from "./forward";
import { extractTeamId, resolveRoute, forwardToInstance } from "./forward";

interface ParsedRoute {
  source: WebhookSource;
  slackSubRoute?: SlackSubRoute;
}

/** Map exact URL path → webhook source + optional Slack sub-route */
function parseRoute(pathname: string): ParsedRoute | null {
  switch (pathname) {
    case "/webhooks/slack/events":
      return { source: "slack", slackSubRoute: "events" };
    case "/webhooks/slack/interactions":
      return { source: "slack", slackSubRoute: "interactions" };
    case "/webhooks/slack/commands":
      return { source: "slack", slackSubRoute: "commands" };
    case "/webhooks/linear":
      return { source: "linear" };
    case "/webhooks/github":
      return { source: "github" };
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
    const route = parseRoute(url.pathname);
    if (!route) {
      return new Response("Not found", { status: 404 });
    }

    const { source, slackSubRoute } = route;
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

    // ── 2. Slack challenge handshake (events endpoint only) ─────
    if (source === "slack" && slackSubRoute === "events") {
      try {
        const payload = JSON.parse(rawBody);
        if (payload.type === "url_verification") {
          return new Response(JSON.stringify({ challenge: payload.challenge }), {
            headers: { "content-type": "application/json" },
          });
        }
      } catch {
        // Not valid JSON — fall through to team_id extraction which will return 400
      }
    }

    // ── 3. Extract team identifier ──────────────────────────────
    const teamId = extractTeamId(source, rawBody, slackSubRoute);
    if (!teamId) {
      return new Response("Missing team identifier", { status: 400 });
    }

    // ── 4. KV lookup ────────────────────────────────────────────
    const tenantRoute = await resolveRoute(env, source, teamId);
    if (!tenantRoute) {
      return new Response("Tenant not found", { status: 404 });
    }

    // ── 5. ACK + async forward ──────────────────────────────────
    forwardToInstance(ctx, tenantRoute, source, rawBody, request.headers);
    return new Response("OK", { status: 200 });
  },
} satisfies ExportedHandler<RouterEnv>;
