import type { RouterEnv, WebhookSource } from "@army/shared";
import { verifyWebhook } from "./verify";
import { extractTeamId, resolveRoute, forwardToInstance } from "./forward";

/** Map URL path prefix → webhook source */
function identifySource(pathname: string): WebhookSource | null {
  if (pathname.startsWith("/slack")) return "slack";
  if (pathname.startsWith("/linear")) return "linear";
  if (pathname.startsWith("/github")) return "github";
  return null;
}

export default {
  async fetch(request: Request, env: RouterEnv, ctx: ExecutionContext): Promise<Response> {
    // Only accept POST
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const source = identifySource(url.pathname);
    if (!source) {
      return new Response("Unknown webhook source", { status: 404 });
    }

    // Read body once for verification + forwarding
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

    // ── 2. Slack challenge handshake ─────────────────────────────
    if (source === "slack") {
      const payload = JSON.parse(rawBody);
      if (payload.type === "url_verification") {
        return new Response(JSON.stringify({ challenge: payload.challenge }), {
          headers: { "content-type": "application/json" },
        });
      }
    }

    // ── 3. ACK immediately (200) ─────────────────────────────────
    // Parse payload to extract team ID
    const payload = JSON.parse(rawBody);
    const teamId = extractTeamId(source, payload);
    if (!teamId) {
      console.error(`Could not extract team ID from ${source} payload`);
      return new Response("OK", { status: 200 });
    }

    // ── 4. KV lookup + async forward ────────────────────────────
    const route = await resolveRoute(env, source, teamId);
    if (!route) {
      console.error(`No route found for ${source}:${teamId}`);
      return new Response("OK", { status: 200 });
    }

    forwardToInstance(ctx, route, source, rawBody, request.headers);

    return new Response("OK", { status: 200 });
  },
} satisfies ExportedHandler<RouterEnv>;
