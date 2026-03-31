import type { TenantRoute, WebhookSource, RouterEnv } from "@army/shared";

/**
 * Extract the team/org identifier from the webhook payload.
 *
 * - Slack:   JSON body → `team_id`
 * - Linear:  JSON body → `organizationId`
 * - GitHub:  JSON body → `installation.id`
 */
export function extractTeamId(
  source: WebhookSource,
  rawBody: string,
): string | null {
  try {
    const payload = JSON.parse(rawBody);
    switch (source) {
      case "slack":
        return (payload.team_id as string) ?? null;
      case "linear":
        return (payload.organizationId as string) ?? null;
      case "github": {
        const installation = payload.installation as
          | Record<string, unknown>
          | undefined;
        return installation?.id != null ? String(installation.id) : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Look up the tenant route from KV by composing a key like "linear:ORG123".
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
 * Extract team_id from a URL-encoded Slack slash command body.
 */
export function extractTeamIdFromForm(rawBody: string): string | null {
  const params = new URLSearchParams(rawBody);
  return params.get("team_id");
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
  /** Override the default /webhooks/{source} path */
  pathOverride?: string,
) {
  const url = `${route.instance_url}${pathOverride ?? `/webhooks/${source}`}`;

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
