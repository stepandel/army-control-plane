# Testing

`army-control-plane` uses [Vitest](https://vitest.dev) with two distinct
project layouts. The split is intentional: most code is pure-function
TypeScript that doesn't need a Workers runtime, and the few tests that *do*
need bindings (KV, Hyperdrive, etc.) pay a real startup cost we don't want
inflicting on the rest of the suite.

## Running tests

```sh
pnpm test          # run all projects once
pnpm test:watch    # watch mode (re-runs on file save)

# Run a single project
pnpm vitest --project pure
pnpm vitest --project workers

# Run a single file
pnpm vitest workers/router/src/verify.test.ts
```

CI runs `pnpm test` after lint/typecheck — see `.github/workflows/ci.yml`.

## The two projects

The configuration lives in [`vitest.config.mts`](../vitest.config.mts) and
defines two named projects:

| Project | Pool | What it covers | Why |
|---|---|---|---|
| `pure` | Default Node | `workers/router/src/**/*.test.ts`, `workers/control-plane/src/lib/machine-env.test.ts` | Pure functions / Web Crypto / standard ESM. Fast cold start (~0.2s). |
| `workers` | `@cloudflare/vitest-pool-workers` (Miniflare) | `workers/control-plane/src/lib/oauth-state.test.ts` | Code that needs real Workers bindings — KV, R2, D1, queues, etc. Slower cold start (~2–10s). |

The `workers` project is wired up via the `cloudflareTest()` Vite plugin and
spins up an isolated Miniflare runtime *only* with the bindings the tests
actually need (currently a single `OAUTH_STATE` KV namespace). It deliberately
does **not** load `workers/control-plane/wrangler.toml` — that file references
Hyperdrive, secrets, and external services we don't want pulled into local
test runs.

## Decision guide: pure vs workers

Use the **pure** pool for:

- Pure functions, parsers, validators, formatters
- Anything that only depends on `globalThis.crypto` (Web Crypto), `fetch`,
  `URL`, `Headers`, `TextEncoder`, etc. — Node 22 implements all of these
- Type-level assertions and config-shape tests

Use the **workers** pool for:

- Code that calls `env.SOMETHING_KV.get()` / `.put()` / `.list()`
- Code that uses Durable Object stubs
- Code that needs `caches.default`, `R2Bucket`, `D1Database`, `Queue`, etc.
- Anything that depends on `cloudflare:workers` runtime APIs

When in doubt, **start with `pure`** — it's faster and the failure modes
are easier to read. Move a test to `workers` only when you actually need a
binding.

## Adding a new test

### Pure test

1. Create `workers/<package>/src/<thing>.test.ts` next to the source file.
2. Add the file (or its parent glob) to the `pure` project's `include`
   array in `vitest.config.mts` if it's not already covered by an existing
   pattern.
3. Run `pnpm vitest --project pure <thing>` to iterate.

### Workers-pool test

1. Create the test file under `workers/control-plane/src/...`.
2. Add the file path to the `workers` project's `include` array in
   `vitest.config.mts`.
3. If your test needs a new binding (e.g. an additional KV namespace, an
   R2 bucket, a service binding), add it to the `miniflare` config in the
   same file. Example:
   ```ts
   cloudflareTest({
     miniflare: {
       compatibilityDate: "2026-02-17",
       compatibilityFlags: ["nodejs_compat"],
       kvNamespaces: ["OAUTH_STATE", "MY_NEW_KV"],
       r2Buckets: ["MY_BUCKET"],
     },
   })
   ```
4. Augment the global `Cloudflare.Env` interface in your test file so the
   typechecker can see your bindings:
   ```ts
   declare global {
     namespace Cloudflare {
       interface Env {
         MY_NEW_KV: KVNamespace;
       }
     }
   }
   ```
5. Import `env` from `cloudflare:workers` (not `cloudflare:test` — that's
   deprecated) and use it as you would in production code.
6. Run `pnpm vitest --project workers <thing>` to iterate.

## What's tested today

These are the security-critical paths that have regression coverage:

| File under test | Tests | Why |
|---|---|---|
| `workers/router/src/verify.ts` | Linear / GitHub HMAC verification, prefix enforcement, missing-header rejection | Wrong HMAC = accept forged webhooks → tenant takeover |
| `workers/router/src/forward.ts` | External-ID extraction for Linear / GitHub / Slack, malformed JSON, slash-command form parsing | Wrong external-ID = traffic mis-routed to wrong tenant |
| `workers/control-plane/src/lib/oauth-state.ts` | Single-use semantics, tenantId round-trip, unknown-token rejection | Wrong state handling = CSRF / replay vulnerability |
| `workers/control-plane/src/lib/machine-env.ts` | Env shape, tenant Anthropic key fallback, langfuse/langsmith tracing switch, no cross-tenant secret leakage | Wrong env builder = tenant credential corruption |

This is intentionally a **smoke-level** suite — it covers the highest-blast-
radius paths and exists to make the test infrastructure itself trustworthy.
Add more tests as you touch new code; new files don't need to wait for an
"add tests" ticket.

## Conventions

- Co-locate tests with source files (`foo.ts` ↔ `foo.test.ts`).
- Don't put fixtures inline if they're large or shared — drop JSON files
  under `workers/<package>/src/fixtures/`.
- Don't hit external APIs (Fly, Slack, Linear, GitHub, Stripe). Mock at
  the `fetch` level if you need to. The test suite must run offline.
- Use `expect(value).toBe(...)` for primitives and `toEqual` for objects.
- Prefer multiple small `it(...)` blocks over one giant test — failure
  messages are far easier to read.
