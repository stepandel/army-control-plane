# CLAUDE.md

This file provides context for AI assistants working on the Army control plane codebase.

## Project overview

Army is a multi-tenant control plane that connects Slack, Linear, and GitHub to isolated per-tenant Fly.io machines. Linear and GitHub deliver events via webhooks routed through the Router Worker; Slack uses Socket Mode (outbound WebSocket connections from each tenant's Fly machine). The infrastructure layer runs on Cloudflare (Workers, KV, Hyperdrive) with Neon Postgres for persistence.

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

- **Router Worker** receives Linear and GitHub webhooks, verifies HMAC, ACKs immediately, then forwards async to the correct Fly machine via KV lookup. Slack does not use the router — it connects via Socket Mode directly from each tenant's Fly machine. The router must stay fast and stateless.
- **Control Plane Worker** manages tenant lifecycle: OAuth flows, machine provisioning (via Fly Machines API), credential management, and admin operations. Admin routes are protected by Cloudflare Access JWT; internal routes by per-tenant `INTERNAL_SECRET`.
- **KV namespaces**: `ROUTING_TABLE` holds routing entries keyed by `{platform}:{externalId}` (e.g., `linear:{orgId}`, `github:{installationId}`), shared by both workers. Slack has no KV routing entry. `OAUTH_STATE` holds ephemeral OAuth CSRF tokens, control-plane only.
- **Slack is the primary install** — it creates the tenant and triggers Fly provisioning. Linear and GitHub are secondary integrations attached to an existing tenant.

## Conventions

- Shared types live in `packages/shared/src/types.ts` — both workers import from `@army/shared`
- Environment bindings are typed as `RouterEnv` and `ControlPlaneEnv`
- Secrets are managed via `wrangler secret put`, never committed. Local dev uses `.dev.vars` (gitignored)
- SQL schema lives in `workers/control-plane/src/db/schema.sql` — run manually against Neon
- Each tenant gets a dedicated Fly app (app-per-tenant model). `FLY_APP` in `wrangler.toml` is used only as the shared image source: `registry.fly.io/${FLY_APP}:latest`
- Provisioning and credential push are internal functions (`lib/provision.ts`, `lib/credentials.ts`), not HTTP routes

## Important files

| File | Purpose |
|---|---|
| `packages/shared/src/types.ts` | All shared types and env bindings |
| `workers/router/src/verify.ts` | Per-platform webhook HMAC verification |
| `workers/router/src/forward.ts` | KV lookup + async forwarding to Fly |
| `workers/control-plane/src/routes/oauth.ts` | OAuth install/callback for all 3 platforms |
| `workers/control-plane/src/routes/admin.ts` | Admin CRUD for tenants |
| `workers/control-plane/src/routes/internal.ts` | Machine self-registration + credential fetch (INTERNAL_SECRET auth) |
| `workers/control-plane/src/middleware/cf-access.ts` | Cloudflare Access JWT validation |
| `workers/control-plane/src/lib/oauth-state.ts` | KV-backed single-use CSRF state tokens |
| `workers/control-plane/src/lib/fly.ts` | Fly Machines API client |
| `workers/control-plane/src/lib/machine-env.ts` | buildMachineEnv() — single source of truth for machine env vars |
| `workers/control-plane/src/lib/provision.ts` | provisionTenant() — creates machine, updates DB + KV |
| `workers/control-plane/src/lib/credentials.ts` | pushCredentials() — updates machine env vars |
| `workers/control-plane/src/db/client.ts` | Database client factory (Hyperdrive) |
| `workers/control-plane/src/db/schema.sql` | Postgres schema |
| `docs/security.md` | Route protection model and secrets inventory |
| `docs/architecture.md` | System architecture and data flows |
