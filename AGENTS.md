# AGENTS.md

Instructions for AI agents working on this codebase.

## Before you start

1. Read `CLAUDE.md` for project overview and key commands
2. Read `docs/architecture.md` for system design and data flows
3. Read `docs/security.md` for route protection model

## Workspace layout

```
packages/shared/      → @army/shared    (types, shared across workers)
workers/router/       → @army/router    (webhook ingress, vanilla Workers)
workers/control-plane → @army/control-plane (tenant lifecycle, Hono)
docs/                 → architecture + security docs
```

## Development workflow

```sh
pnpm install           # install deps
pnpm typecheck         # tsc -b (whole project) — run after every change
pnpm dev:router        # wrangler dev for router
pnpm dev:control-plane # wrangler dev for control plane
```

Always run `pnpm typecheck` after making changes. The project uses TypeScript project references — all three packages must compile together.

## Code style and patterns

- **Strict TypeScript** — no `any`, no `@ts-ignore`
- **Environment bindings** are typed in `packages/shared/src/types.ts` as `RouterEnv` and `ControlPlaneEnv`. If you add a new secret or binding, update these types first.
- **Router Worker** is intentionally vanilla (no Hono, no framework). Keep it minimal — it must respond within 3 seconds.
- **Control Plane Worker** uses Hono. Routes are organized in `src/routes/` and mounted in `src/index.ts`.
- **Database access** uses `postgres` (postgresjs) via Hyperdrive. Always call `getDb(c.env)` per-request — connection pooling is handled by Hyperdrive. Always use `prepare: false`.
- **KV namespaces**: `ROUTING_TABLE` for routing (`{platform}:{team_id}` keys), `OAUTH_STATE` for ephemeral OAuth CSRF tokens (UUID keys, 10-min TTL). Router Worker only binds `ROUTING_TABLE`.
- **Async work** uses `ctx.waitUntil()` (router) or `c.executionCtx.waitUntil()` (control plane) for fire-and-forget operations.

## Adding a new route

1. Create or edit the route file in `workers/control-plane/src/routes/`
2. If it's a new file, mount it in `workers/control-plane/src/index.ts`
3. If it needs auth, apply middleware before the route (see `cfAccessGuard` pattern)
4. Run `pnpm typecheck`

## Adding a new environment variable or secret

1. Add the type to `ControlPlaneEnv` or `RouterEnv` in `packages/shared/src/types.ts`
2. Add the binding in the relevant `wrangler.toml` (if it's a KV/Hyperdrive binding)
3. Document it in `docs/security.md` under "Secrets Management"
4. For local dev, add it to `.dev.vars` (gitignored)

## Adding a new platform integration

1. Add the platform to the `WebhookSource` union type in `packages/shared/src/types.ts`
2. Add HMAC verification in `workers/router/src/verify.ts`
3. Add team ID extraction in `workers/router/src/forward.ts`
4. Add OAuth install/callback routes in `workers/control-plane/src/routes/oauth.ts`
5. Add the webhook signing secret to `RouterEnv`
6. Add OAuth credentials to `ControlPlaneEnv`
7. Update `docs/security.md`

## Key implementation files

| File | Purpose |
|---|---|
| `workers/control-plane/src/lib/fly.ts` | `FlyClient` — Fly Machines API (create, update, stop, destroy) |
| `workers/control-plane/src/lib/provision.ts` | `provisionTenant()` — creates Fly machine, writes KV routes, records deployment |
| `workers/control-plane/src/lib/credentials.ts` | `pushCredentials()` — updates machine env vars via Fly API (triggers reboot) |
| `workers/control-plane/src/lib/oauth-state.ts` | KV-backed single-use OAuth state tokens |
| `workers/control-plane/src/middleware/cf-access.ts` | Cloudflare Access JWT validation middleware |

**Important:** `provisionTenant()` and `pushCredentials()` are internal functions called directly via `waitUntil` — they are NOT HTTP routes. Don't add route wrappers around them.

## What's stubbed / not yet done

- **Token refresh** — Linear tokens can expire; refresh flow not yet built

## Common mistakes to avoid

- Don't add database calls to the Router Worker — it only uses KV
- Don't forget `prepare: false` when creating postgres clients (Hyperdrive requirement)
- Don't store secrets in `wrangler.toml` — use `wrangler secret put`
- Don't use HMAC-signed state tokens for OAuth — we use KV-backed single-use tokens (see `docs/security.md` for rationale)
- Don't add middleware to the router worker — it uses the raw `ExportedHandler` interface, not Hono
