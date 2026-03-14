import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { pushCredentials } from "./credentials";

/**
 * Refresh a single Linear token using the stored refresh_token.
 * Updates the DB with the new access_token, refresh_token, and expires_at.
 * Returns true if the refresh succeeded.
 */
export async function refreshLinearToken(
  env: ControlPlaneEnv,
  tenantId: string,
): Promise<boolean> {
  const sql = getDb(env);

  const [token] = await sql`
    SELECT refresh_token FROM integration_tokens
    WHERE tenant_id = ${tenantId} AND platform = 'linear'
  `;

  if (!token?.refresh_token) {
    console.error(`No Linear refresh token for tenant ${tenantId}`);
    return false;
  }

  const resp = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.LINEAR_CLIENT_ID,
      client_secret: env.LINEAR_CLIENT_SECRET,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    console.error(`Linear token refresh failed for ${tenantId}: ${resp.status} ${await resp.text()}`);
    return false;
  }

  const data = (await resp.json()) as Record<string, unknown>;
  if (!data.access_token) {
    console.error(`Linear token refresh returned no access_token for ${tenantId}`);
    return false;
  }

  const accessToken = data.access_token as string;
  const refreshToken = (data.refresh_token as string) ?? token.refresh_token;
  const expiresIn = data.expires_in as number | undefined;
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  await sql`
    UPDATE integration_tokens
    SET access_token = ${accessToken},
        refresh_token = ${refreshToken},
        expires_at = ${expiresAt}::timestamptz
    WHERE tenant_id = ${tenantId} AND platform = 'linear'
  `;

  console.log(`Refreshed Linear token for tenant ${tenantId}, expires_at=${expiresAt}`);
  return true;
}

/**
 * Cron handler: refresh all Linear tokens expiring within the next hour,
 * then push updated credentials to each tenant's Fly machine.
 */
export async function refreshExpiringTokens(env: ControlPlaneEnv): Promise<void> {
  const sql = getDb(env);

  // Find Linear tokens that expire within the next hour
  const expiring = await sql`
    SELECT it.tenant_id
    FROM integration_tokens it
    JOIN tenants t ON t.id = it.tenant_id
    WHERE it.platform = 'linear'
      AND it.refresh_token IS NOT NULL
      AND it.expires_at IS NOT NULL
      AND it.expires_at < now() + interval '1 hour'
      AND t.status = 'active'
  `;

  if (expiring.length === 0) return;

  console.log(`Refreshing ${expiring.length} expiring Linear token(s)`);

  for (const { tenant_id } of expiring) {
    try {
      const refreshed = await refreshLinearToken(env, tenant_id);
      if (refreshed) {
        await pushCredentials(env, tenant_id);
      }
    } catch (err) {
      console.error(`Token refresh cycle failed for ${tenant_id}:`, err);
    }
  }
}
