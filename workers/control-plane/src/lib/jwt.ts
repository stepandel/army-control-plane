/**
 * Minimal JWT (HS256) implementation using Web Crypto API.
 * No external dependencies — works in Cloudflare Workers.
 */

export interface SessionPayload {
  /** users.id (our UUID) */
  sub: string;
  /** slack_team_id (tenant FK) */
  team_id: string;
  /** slack_user_id */
  slack_uid: string;
  email?: string;
  name?: string;
  iat: number;
  exp: number;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

// ── Base64url helpers ────────────────────────────────────────────

function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── HMAC key import ──────────────────────────────────────────────

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// ── Sign ─────────────────────────────────────────────────────────

export async function signJwt(
  payload: Omit<SessionPayload, "iat" | "exp">,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: SessionPayload = {
    ...payload,
    iat: now,
    exp: now + SESSION_TTL,
  };

  const header = base64UrlEncode(ENCODER.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64UrlEncode(ENCODER.encode(JSON.stringify(fullPayload)));
  const signingInput = `${header}.${body}`;

  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, ENCODER.encode(signingInput));
  const signature = base64UrlEncode(new Uint8Array(sig));

  return `${signingInput}.${signature}`;
}

// ── Verify ───────────────────────────────────────────────────────

export async function verifyJwt(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const signingInput = `${header}.${body}`;

  try {
    const key = await importKey(secret);
    const sigBytes = base64UrlDecode(signature);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      ENCODER.encode(signingInput),
    );
    if (!valid) return null;

    const payload: SessionPayload = JSON.parse(DECODER.decode(base64UrlDecode(body)));

    // Check expiration
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}
