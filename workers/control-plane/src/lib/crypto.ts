/**
 * Application-level encryption for sensitive DB columns (tokens, API keys).
 * Uses AES-256-GCM via the Web Crypto API (available in Cloudflare Workers).
 *
 * Ciphertext format: base64(iv || ciphertext || authTag)
 * - iv: 12 bytes (96-bit, recommended for GCM)
 * - authTag: included automatically by GCM mode
 *
 * The encryption key is a 256-bit hex string stored as a Cloudflare Worker secret.
 */

const ALGO = "AES-GCM";
const IV_BYTES = 12;

/** Import the hex-encoded 256-bit key as a CryptoKey. */
async function importKey(hexKey: string): Promise<CryptoKey> {
  const raw = hexToBytes(hexKey);
  return crypto.subtle.importKey("raw", raw, ALGO, false, ["encrypt", "decrypt"]);
}

/** Encrypt a plaintext string. Returns a base64-encoded ciphertext. */
export async function encrypt(plaintext: string, hexKey: string): Promise<string> {
  const key = await importKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded));

  // Prepend IV to ciphertext: iv || ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);

  return bytesToBase64(combined);
}

/** Decrypt a base64-encoded ciphertext. Returns the original plaintext string. */
export async function decrypt(encoded: string, hexKey: string): Promise<string> {
  const key = await importKey(hexKey);
  const combined = base64ToBytes(encoded);

  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);

  const decrypted = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

/**
 * Decrypt a value that may or may not be encrypted.
 * During migration, existing rows contain plaintext while new rows are encrypted.
 * Encrypted values are base64 and will not look like typical tokens/keys.
 */
export async function decryptIfEncrypted(value: string, hexKey: string): Promise<string> {
  // Plaintext tokens have recognizable prefixes — skip decryption
  if (looksLikePlaintext(value)) return value;

  try {
    return await decrypt(value, hexKey);
  } catch {
    // Decryption failed — assume it's still plaintext from before encryption was enabled
    return value;
  }
}

/** Heuristic: does this value look like a plaintext token rather than base64 ciphertext? */
function looksLikePlaintext(value: string): boolean {
  return (
    value.startsWith("xoxb-") ||    // Slack bot token
    value.startsWith("xoxp-") ||    // Slack user token
    value.startsWith("lin_api_") || // Linear API token
    value.startsWith("sk-ant-") ||  // Anthropic API key
    /^\d+$/.test(value)             // GitHub installation ID (numeric)
  );
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
