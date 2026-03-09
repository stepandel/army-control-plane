# CLAUDE.md

This file provides context for AI assistants working on the Army control plane codebase.

## Project overview

Army is a multi-tenant control plane that routes webhooks from Slack, Linear, and GitHub to isolated per-tenant Fly.io machines. The infrastructure layer runs on Cloudflare (Workers, KV, Hyperdrive) with Neon Postgres for persistence.

## Repository structure

```
army-control-pane/
├── packages/shared/          # @army/shared — types and interfaces shared across workers
├── workers/router/           # @army/router — webhook ingress (router.army.ai)
├── workers/control-plane/    # @army/control-plane — tenant lifecycle API (api.army.ai)
└── docs/                     # Architecture and security documentation
```

This is a **pnpm workspaces** monorepo. Internal packages use `workspace:*` protocol.

## Key commands

```sh
pnpm install                  # install all dependencies
pnpm typecheck                # type-check entire project (tsc -b)
pnpm dev:router               # local dev for router worker
pnpm dev:control-plane        # local dev for control plane worker
pnpm deploy:router            # deploy router to Cloudflare
pnpm deploy:control-plane     # deploy control plane to Cloudflare
```

## Tech stack

- **Runtime:** Cloudflare Workers
- **Language:** TypeScript (strict mode, ESNext target, bundler resolution)
- **Router Worker:** Vanilla Workers API (no framework) — intentionally minimal
- **Control Plane Worker:** Hono framework for routing
- **Database:** Neon Postgres via Cloudflare Hyperdrive, accessed with `postgres` (postgresjs)
- **KV:** Cloudflare KV for routing table + OAuth state tokens
- **Package manager:** pnpm

## Architecture quick reference

- **Router Worker** receives webhooks, verifies HMAC, ACKs immediately, then forwards async to the correct Fly machine via KV lookup. It must stay fast and stateless.
- **Control Plane Worker** manages tenant lifecycle: OAuth flows, machine provisioning, credential management, and admin operations. Admin routes are protected by Cloudflare Access JWT validation.
- **KV keys** are namespaced as `{platform}:{teamId}` (e.g., `slack:T012345`). OAuth state tokens use the `oauth_state:` prefix.
- **Slack is the primary install** — it creates the tenant and triggers Fly provisioning. Linear and GitHub are secondary integrations attached to an existing tenant.

## Conventions

- Shared types live in `packages/shared/src/types.ts` — both workers import from `@army/shared`
- Environment bindings are typed as `RouterEnv` and `ControlPlaneEnv`
- Secrets are managed via `wrangler secret put`, never committed. Local dev uses `.dev.vars` (gitignored)
- SQL schema lives in `workers/control-plane/src/db/schema.sql` — run manually against Neon
- Fly.io provisioning is stubbed with TODO markers — not yet implemented

## Important files

| File | Purpose |
|---|---|
| `packages/shared/src/types.ts` | All shared types and env bindings |
| `workers/router/src/verify.ts` | Per-platform webhook HMAC verification |
| `workers/router/src/forward.ts` | KV lookup + async forwarding to Fly |
| `workers/control-plane/src/routes/oauth.ts` | OAuth install/callback for all 3 platforms |
| `workers/control-plane/src/routes/admin.ts` | Admin CRUD for tenants |
| `workers/control-plane/src/routes/internal.ts` | Machine self-registration + credential fetch |
| `workers/control-plane/src/middleware/cf-access.ts` | Cloudflare Access JWT validation |
| `workers/control-plane/src/lib/oauth-state.ts` | KV-backed single-use CSRF state tokens |
| `workers/control-plane/src/db/schema.sql` | Postgres schema |
| `docs/security.md` | Route protection model and secrets inventory |
| `docs/architecture.md` | System architecture and data flows |
