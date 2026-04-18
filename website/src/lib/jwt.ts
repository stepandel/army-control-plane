/**
 * JWT verification for the website (verify-only — signing happens on control-plane).
 * Mirrors workers/control-plane/src/lib/jwt.ts.
 */

export interface SessionPayload {
  sub: string;
  team_id?: string;
  slack_uid?: string;
  email?: string;
  name?: string;
  iat: number;
  exp: number;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function base64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function verifyJwt(token: string, secret: string): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const signingInput = `${header}.${body}`;

  try {
    const key = await importKey(secret);
    const sigBytes = base64UrlDecode(signature);
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, ENCODER.encode(signingInput));
    if (!valid) return null;

    const payload: SessionPayload = JSON.parse(DECODER.decode(base64UrlDecode(body)));

    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}
