import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * Two-project Vitest setup:
 *
 * 1. **pure** — plain Node + Vite transforms. Covers pure-function / isolated
 *    code that only needs Web Crypto and standard ESM. Fast, no Workers runtime.
 *
 * 2. **workers** — `@cloudflare/vitest-pool-workers` running inside a
 *    Miniflare-backed Workers runtime. Used for code that touches KV
 *    (or other Workers bindings). Isolated from the full control-plane
 *    wrangler.toml — we only declare the bindings the tests actually need.
 *
 * Run both: `pnpm test`.
 * Run one: `pnpm vitest --project pure` or `--project workers`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "pure",
          include: [
            "workers/router/src/**/*.test.ts",
            "workers/control-plane/src/lib/machine-env.test.ts",
            "workers/control-plane/src/lib/jwt.test.ts",
          ],
        },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: "2026-02-17",
              compatibilityFlags: ["nodejs_compat"],
              kvNamespaces: ["OAUTH_STATE"],
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["workers/control-plane/src/lib/oauth-state.test.ts"],
        },
      },
    ],
  },
});
