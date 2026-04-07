/**
 * KV-backed single-use OAuth state tokens.
 * Stored with a 10-minute TTL and deleted on verification (one-time use).
 */

interface StateData {
  /** Optional tenant ID (for Linear/GitHub secondary installs) */
  tenantId?: string;
}

const STATE_TTL_SECONDS = 600; // 10 minutes

/** Create a random state token, store it in KV with a 10-minute TTL. */
export async function createState(kv: KVNamespace, tenantId?: string): Promise<string> {
  const token = crypto.randomUUID();
  const data: StateData = { ...(tenantId && { tenantId }) };

  await kv.put(token, JSON.stringify(data), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  return token;
}

/**
 * Verify and consume a state token. Returns payload if valid, null otherwise.
 * The token is deleted from KV on read — it cannot be reused.
 */
export async function verifyState(
  kv: KVNamespace,
  token: string,
): Promise<{ tenantId?: string } | null> {
  const raw = await kv.get(token);
  if (!raw) return null;

  // Delete immediately — single use
  await kv.delete(token);

  try {
    const data: StateData = JSON.parse(raw);
    return { tenantId: data.tenantId };
  } catch {
    return null;
  }
}
