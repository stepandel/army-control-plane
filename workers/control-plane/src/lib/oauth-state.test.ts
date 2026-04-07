import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createState, verifyState } from "./oauth-state";

// The Workers pool (see vitest.config.mts) exposes `env` with the bindings
// declared in the test miniflare config. For these tests we only need
// OAUTH_STATE — a plain KV namespace backed by miniflare's in-memory store.
// Augment the global Cloudflare.Env interface so `env.OAUTH_STATE` is typed.
declare global {
  namespace Cloudflare {
    interface Env {
      OAUTH_STATE: KVNamespace;
    }
  }
}

describe("oauth-state", () => {
  it("verifies a newly-created state token exactly once (single use)", async () => {
    const token = await createState(env.OAUTH_STATE);
    expect(token).toMatch(/^[0-9a-f-]{36}$/); // UUID v4 shape

    // First consume: succeeds.
    const first = await verifyState(env.OAUTH_STATE, token);
    expect(first).not.toBeNull();

    // Second consume: token is already deleted — returns null.
    const second = await verifyState(env.OAUTH_STATE, token);
    expect(second).toBeNull();
  });

  it("round-trips tenantId through create → verify", async () => {
    const tenantId = "T-TENANT-123";
    const token = await createState(env.OAUTH_STATE, tenantId);

    const result = await verifyState(env.OAUTH_STATE, token);

    expect(result).toEqual({ tenantId });
  });

  it("returns null when verifying a token that was never created", async () => {
    const result = await verifyState(env.OAUTH_STATE, "never-existed");
    expect(result).toBeNull();
  });
});
