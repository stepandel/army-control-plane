import { createMiddleware } from "hono/factory";
import type { ControlPlaneEnv } from "@army/shared";

interface AccessJwtPayload {
  aud: string[];
  email?: string;
  exp: number;
  iat: number;
  iss: string;
  sub: string;
}

interface JwksKey {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}

interface JwksResponse {
  keys: JwksKey[];
}

/** Decode a base64url string to Uint8Array. */
function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Import a JWK RSA public key for RS256 verification. */
async function importPublicKey(jwk: JwksKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/** Fetch and cache Cloudflare Access public keys. */
async function getPublicKeys(teamDomain: string): Promise<Map<string, JwksKey>> {
  const resp = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    cf: { cacheTtl: 3600, cacheEverything: true },
  } as RequestInit);
  const { keys } = (await resp.json()) as JwksResponse;
  return new Map(keys.map((k) => [k.kid, k]));
}

/** Verify a Cloudflare Access JWT and return its payload. */
async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  expectedAud: string,
): Promise<AccessJwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64)));

  if (header.alg !== "RS256") return null;

  // Fetch public keys and find matching kid
  const keys = await getPublicKeys(teamDomain);
  const jwk = keys.get(header.kid);
  if (!jwk) return null;

  // Verify signature
  const key = await importPublicKey(jwk);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);

  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
  if (!valid) return null;

  // Parse and validate claims
  const payload: AccessJwtPayload = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(payloadB64)),
  );

  // Check audience
  if (!payload.aud.includes(expectedAud)) return null;

  // Check expiry
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  // Check issuer
  if (payload.iss !== `https://${teamDomain}`) return null;

  return payload;
}

/**
 * Hono middleware that validates the Cloudflare Access JWT.
 * Rejects with 403 if the token is missing, invalid, or expired.
 * Sets `c.set("accessEmail", ...)` on success for downstream handlers.
 */
export const cfAccessGuard = createMiddleware<{
  Bindings: ControlPlaneEnv;
  Variables: { accessEmail: string };
}>(
  async (c, next) => {
    // Skip auth in local dev when CF Access is not configured
    if (!c.env.CF_ACCESS_TEAM_DOMAIN || !c.env.CF_ACCESS_AUD) {
      c.set("accessEmail", "local-dev");
      await next();
      return;
    }

    const token =
      c.req.header("cf-access-jwt-assertion") ??
      getCookie(c.req.raw, "CF_Authorization");

    if (!token) {
      return c.json({ error: "Missing Cloudflare Access token" }, 403);
    }

    const payload = await verifyAccessJwt(
      token,
      c.env.CF_ACCESS_TEAM_DOMAIN,
      c.env.CF_ACCESS_AUD,
    );

    if (!payload) {
      return c.json({ error: "Invalid or expired Cloudflare Access token" }, 403);
    }

    c.set("accessEmail", payload.email ?? payload.sub);
    await next();
  },
);

/** Extract a cookie value from a raw Request. */
function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}
