import type { TenantRoute, WebhookSource, RouterEnv } from "@army/shared";

export type SlackSubRoute = "events" | "interactions" | "commands";

/**
 * Extract the team/org identifier from the webhook payload.
 * Each source (and Slack sub-route) embeds the tenant ID differently.
 *
 * - Slack events:       JSON body → `team_id`
 * - Slack interactions:  URL-encoded `payload` param → parsed JSON → `team.id`
 * - Slack commands:      URL-encoded form → `team_id` param
 * - Linear:             JSON body → `organizationId`
 * - GitHub:             JSON body → `installation.id`
 */
export function extractTeamId(
  source: WebhookSource,
  rawBody: string,
  slackSubRoute?: SlackSubRoute,
): string | null {
  try {
    switch (source) {
      case "slack": {
        if (slackSubRoute === "interactions") {
          const params = new URLSearchParams(rawBody);
          const payloadStr = params.get("payload");
          if (!payloadStr) return null;
          const payload = JSON.parse(payloadStr);
          return payload.team?.id ?? payload.user?.team_id ?? null;
        }
        if (slackSubRoute === "commands") {
          const params = new URLSearchParams(rawBody);
          return params.get("team_id");
        }
        // events — JSON body
        const payload = JSON.parse(rawBody);
        return (payload.team_id as string) ?? null;
      }
      case "linear": {
        const payload = JSON.parse(rawBody);
        return (payload.organizationId as string) ?? null;
      }
      case "github": {
        const payload = JSON.parse(rawBody);
        const installation = payload.installation as
          | Record<string, unknown>
          | undefined;
        return installation?.id != null ? String(installation.id) : null;
      }
    }
  } catch {
    return null;
  }
}

/**
 * Look up the tenant route from KV by composing a key like "slack:T012345".
 */
export async function resolveRoute(
  env: RouterEnv,
  source: WebhookSource,
  teamId: string,
): Promise<TenantRoute | null> {
  const key = `${source}:${teamId}`;
  return env.ROUTING_TABLE.get<TenantRoute>(key, "json");
}

/**
 * Fire-and-forget forward: POST the original body to the Fly instance.
 * Uses waitUntil so the 200 ACK is not delayed.
 * Logs a dead-letter entry on failure (non-2xx or network error).
 */
export function forwardToInstance(
  ctx: ExecutionContext,
  route: TenantRoute,
  source: WebhookSource,
  rawBody: string,
  incomingHeaders: Headers,
) {
  const url = `${route.instance_url}/webhooks/${source}`;

  const work = fetch(url, {
    method: "POST",
    headers: {
      // Preserve original x-* and content-type headers
      ...Object.fromEntries(
        [...incomingHeaders.entries()].filter(
          ([k]) => k.startsWith("x-") || k === "content-type",
        ),
      ),
      // Army headers last — cannot be spoofed by incoming request
      "x-army-source": source,
      "x-army-signature": route.internal_secret,
    },
    body: rawBody,
  })
    .then((res) => {
      if (!res.ok) {
        console.error("[dead-letter] Forward returned non-2xx", {
          url,
          source,
          status: res.status,
        });
      }
    })
    .catch((err) => {
      console.error("[dead-letter] Forward failed", {
        url,
        source,
        error: String(err),
      });
    });

  ctx.waitUntil(work);
}
