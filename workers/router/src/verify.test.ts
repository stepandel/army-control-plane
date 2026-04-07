import { describe, expect, it } from "vitest";
import { verifyWebhook } from "./verify";
import linearFixture from "./fixtures/linear-webhook.json";
import githubFixture from "./fixtures/github-webhook.json";

// ── Helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const SLACK_SECRET = "slack-secret";
const LINEAR_SECRET = "linear-test-secret";
const GITHUB_SECRET = "github-test-secret";
const SECRETS = { slack: SLACK_SECRET, linear: LINEAR_SECRET, github: GITHUB_SECRET };

// ── Linear ─────────────────────────────────────────────────────

describe("verifyWebhook — Linear", () => {
  const body = JSON.stringify(linearFixture);

  it("accepts a body signed with the correct secret", async () => {
    const signature = await hmacHex(LINEAR_SECRET, body);
    const headers = new Headers({ "linear-signature": signature });

    const ok = await verifyWebhook("linear", body, headers, SECRETS);

    expect(ok).toBe(true);
  });

  it("rejects a tampered body with an otherwise-valid signature", async () => {
    // Sign the untampered body…
    const signature = await hmacHex(LINEAR_SECRET, body);
    const headers = new Headers({ "linear-signature": signature });

    // …then verify against a different body (tamper).
    const tamperedBody = body.replace("org-abc-123", "org-evil-999");
    const ok = await verifyWebhook("linear", tamperedBody, headers, SECRETS);

    expect(ok).toBe(false);
  });

  it("rejects a request with no linear-signature header", async () => {
    const ok = await verifyWebhook("linear", body, new Headers(), SECRETS);
    expect(ok).toBe(false);
  });
});

// ── GitHub ─────────────────────────────────────────────────────

describe("verifyWebhook — GitHub", () => {
  const body = JSON.stringify(githubFixture);

  it("accepts a valid x-hub-signature-256 with the sha256= prefix", async () => {
    const signature = `sha256=${await hmacHex(GITHUB_SECRET, body)}`;
    const headers = new Headers({ "x-hub-signature-256": signature });

    const ok = await verifyWebhook("github", body, headers, SECRETS);

    expect(ok).toBe(true);
  });

  it("rejects a signature without the sha256= prefix", async () => {
    // Raw hex HMAC — valid bytes but missing the protocol prefix.
    const rawHex = await hmacHex(GITHUB_SECRET, body);
    const headers = new Headers({ "x-hub-signature-256": rawHex });

    const ok = await verifyWebhook("github", body, headers, SECRETS);

    expect(ok).toBe(false);
  });

  it("rejects a request with no x-hub-signature-256 header", async () => {
    const ok = await verifyWebhook("github", body, new Headers(), SECRETS);
    expect(ok).toBe(false);
  });
});
