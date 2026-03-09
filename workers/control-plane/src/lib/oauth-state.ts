/**
 * Stateless HMAC-signed OAuth state tokens.
 * Format: base64url(payload).base64url(signature)
 */

const encoder = new TextEncoder();

interface StatePayload {
  /** Random nonce for uniqueness */
  n: string;
  /** Unix timestamp (seconds) */
  ts: number;
  /** Optional tenant ID (for Linear/GitHub secondary installs) */
  tid?: string;
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function toBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded);
}

/** Create a signed state token, optionally embedding a tenant ID. */
export async function createState(secret: string, tenantId?: string): Promise<string> {
  const payload: StatePayload = {
    n: crypto.randomUUID(),
    ts: Math.floor(Date.now() / 1000),
    ...(tenantId && { tid: tenantId }),
  };
  const encoded = toBase64Url(JSON.stringify(payload));
  const signature = await sign(encoded, secret);
  return `${encoded}.${signature}`;
}

/** Verify a state token and return its payload. Returns null if invalid or expired (>10 min). */
export async function verifyState(
  state: string,
  secret: string,
): Promise<{ tenantId?: string } | null> {
  const [encoded, sig] = state.split(".");
  if (!encoded || !sig) return null;

  const expectedSig = await sign(encoded, secret);
  if (sig !== expectedSig) return null;

  try {
    const payload: StatePayload = JSON.parse(fromBase64Url(encoded));
    if (Math.abs(Date.now() / 1000 - payload.ts) > 600) return null;
    return { tenantId: payload.tid };
  } catch {
    return null;
  }
}
