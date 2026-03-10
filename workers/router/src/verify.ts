import type { WebhookSource } from "@army/shared";

const encoder = new TextEncoder();

async function hmacSha256(secret: string, payload: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, encoder.encode(payload));
}

function timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let result = 0;
  for (let i = 0; i < va.length; i++) {
    result |= va[i] ^ vb[i];
  }
  return result === 0;
}

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

// ── Linear ───────────────────────────────────────────────────────
async function verifyLinear(
  body: string,
  headers: Headers,
  secret: string,
): Promise<boolean> {
  const signature = headers.get("linear-signature");
  if (!signature) return false;

  const computed = await hmacSha256(secret, body);
  const expected = hexToBuffer(signature);
  return timingSafeEqual(computed, expected);
}

// ── GitHub ────────────────────────────────────────────────────────
async function verifyGitHub(
  body: string,
  headers: Headers,
  secret: string,
): Promise<boolean> {
  const signature = headers.get("x-hub-signature-256");
  if (!signature) return false;

  const computed = await hmacSha256(secret, body);
  const expected = hexToBuffer(signature.replace("sha256=", ""));
  return timingSafeEqual(computed, expected);
}

export async function verifyWebhook(
  source: WebhookSource,
  body: string,
  headers: Headers,
  secrets: { linear: string; github: string },
): Promise<boolean> {
  switch (source) {
    case "linear":
      return verifyLinear(body, headers, secrets.linear);
    case "github":
      return verifyGitHub(body, headers, secrets.github);
    default:
      return false;
  }
}
