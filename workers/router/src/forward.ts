import type { TenantRoute, WebhookSource, RouterEnv } from "@vera/shared";

/**
 * Extract the team/org identifier from the webhook payload.
 * Each source embeds the tenant ID differently.
 */
export function extractTeamId(source: WebhookSource, payload: Record<string, unknown>): string | null {
  switch (source) {
    case "slack":
      return (payload.team_id as string) ?? null;
    case "linear":
      return (payload.organizationId as string) ?? null;
    case "github": {
      const installation = payload.installation as Record<string, unknown> | undefined;
      return installation?.id != null ? String(installation.id) : null;
    }
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
 * Uses waitUntil so the response to the webhook source is not delayed.
 */
export function forwardToInstance(
  ctx: ExecutionContext,
  route: TenantRoute,
  source: WebhookSource,
  rawBody: string,
  incomingHeaders: Headers,
) {
  const work = fetch(`${route.instance_url}/webhooks/${source}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vera-source": source,
      "x-vera-signature": route.internal_secret,
      ...Object.fromEntries(
        [...incomingHeaders.entries()].filter(([k]) =>
          k.startsWith("x-") || k === "content-type",
        ),
      ),
    },
    body: rawBody,
  }).catch((err) => {
    console.error(`Forward failed for ${source}:`, err);
  });

  ctx.waitUntil(work);
}
