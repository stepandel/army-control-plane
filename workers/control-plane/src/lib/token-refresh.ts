import type { ControlPlaneEnv } from "@army/shared";
import type postgres from "postgres";
import { getDb } from "../db/client";
import { pushCredentials } from "./credentials";
import { encrypt, decryptIfEncrypted } from "./crypto";

/**
 * Refresh a single Linear token using the stored refresh_token.
 * Updates the DB with the new access_token, refresh_token, and expires_at.
 *
 * Uses optimistic locking (WHERE refresh_token = old) to handle concurrent
 * refreshes, and retries the DB write since the Linear token exchange is
 * irreversible (the old refresh token is revoked on success).
 *
 * Returns true if the refresh succeeded (or another process already refreshed).
 */
export async function refreshLinearToken(
  env: ControlPlaneEnv,
  tenantId: string,
  sql?: postgres.Sql,
): Promise<boolean> {
  const db = sql ?? getDb(env);

  const [token] = await db`
    SELECT refresh_token FROM integration_tokens
    WHERE tenant_id = ${tenantId} AND platform = 'linear'
  `;

  if (!token?.refresh_token) {
    console.error(`No Linear refresh token for tenant ${tenantId}`);
    return false;
  }

  // DB stores encrypted value — keep it for optimistic locking, decrypt for the API call
  const oldRefreshTokenEncrypted = token.refresh_token;
  const oldRefreshToken = await decryptIfEncrypted(token.refresh_token, env.ENCRYPTION_KEY);

  const resp = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.LINEAR_CLIENT_ID,
      client_secret: env.LINEAR_CLIENT_SECRET,
      refresh_token: oldRefreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Linear token refresh failed for ${tenantId}: ${resp.status}`);
    // If the refresh token was revoked, another process may have already refreshed it.
    // Check if the DB token has changed — if so, the refresh already happened.
    if (resp.status === 400 && body.includes("invalid_grant")) {
      const [current] = await db`
        SELECT refresh_token FROM integration_tokens
        WHERE tenant_id = ${tenantId} AND platform = 'linear'
      `;
      if (current?.refresh_token && current.refresh_token !== oldRefreshTokenEncrypted) {
        console.log(`Linear token for ${tenantId} was already refreshed by another process`);
        return true;
      }
    }
    return false;
  }

  const data = (await resp.json()) as Record<string, unknown>;
  if (!data.access_token) {
    console.error(`Linear token refresh returned no access_token for ${tenantId}`);
    return false;
  }

  const accessToken = data.access_token as string;
  const refreshToken = (data.refresh_token as string) ?? oldRefreshToken;
  const expiresIn = data.expires_in as number | undefined;
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  // Encrypt before persisting
  const encAccessToken = await encrypt(accessToken, env.ENCRYPTION_KEY);
  const encRefreshToken = await encrypt(refreshToken, env.ENCRYPTION_KEY);

  // Retry DB write — the Linear exchange is irreversible (old refresh token is revoked),
  // so failing to persist the new tokens would lock the tenant out.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Optimistic lock: compare against the encrypted value we read from the DB
      const result = await db`
        UPDATE integration_tokens
        SET access_token = ${encAccessToken},
            refresh_token = ${encRefreshToken},
            expires_at = ${expiresAt}::timestamptz
        WHERE tenant_id = ${tenantId} AND platform = 'linear'
          AND refresh_token = ${oldRefreshTokenEncrypted}
      `;
      if (result.count === 0) {
        console.log(`Linear token for ${tenantId} was already refreshed by another process`);
        return true;
      }
      console.log(`Refreshed Linear token for tenant ${tenantId}, expires_at=${expiresAt}`);
      return true;
    } catch (err) {
      console.error(`DB write failed for ${tenantId} (attempt ${attempt}/3):`, err);
      if (attempt < 3) continue;
      console.error(
        `CRITICAL: Linear issued new tokens for ${tenantId} but DB write failed after 3 attempts. ` +
          `Old refresh token is revoked — tenant needs to re-authenticate.`,
      );
      return false;
    }
  }

  return false;
}

/**
 * Cron handler: refresh all Linear tokens expiring within the next hour,
 * then push updated credentials to each tenant's Fly machine.
 */
export async function refreshExpiringTokens(env: ControlPlaneEnv): Promise<void> {
  const sql = getDb(env);

  try {
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
        const refreshed = await refreshLinearToken(env, tenant_id, sql);
        if (refreshed) {
          await pushCredentials(env, tenant_id, sql);
        }
      } catch (err) {
        console.error(`Token refresh cycle failed for ${tenant_id}:`, err);
      }
    }
  } finally {
    await sql.end();
  }
}
