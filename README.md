# Army Control Plane

Army is a multi-tenant control plane that connects Slack, Linear, and GitHub to isolated per-tenant [Fly.io](https://fly.io) machines. The infrastructure layer runs on Cloudflare (Workers, KV, Hyperdrive) with Neon Postgres for persistence.

- **Linear and GitHub** deliver events via webhooks routed through the Router Worker.
- **Slack** uses Socket Mode — outbound WebSocket connections initiated from each tenant's Fly machine.
- **Each tenant** gets a dedicated Fly machine, isolated from every other tenant.

## Repository layout

```
army-control-plane/
├── packages/shared/          # @army/shared       — types shared across workers
├── workers/router/           # @army/router       — webhook ingress (army-router.stepandel.workers.dev)
├── workers/control-plane/    # @army/control-plane — tenant lifecycle API (army-control-plane.stepandel.workers.dev)
├── website/                  # @army/website      — marketing site (agent-vera.com)
├── docs/                     # architecture, security, ops docs
└── scripts/                  # one-off operational scripts
```

This is a [pnpm workspaces](https://pnpm.io/workspaces) monorepo. Internal packages use the `workspace:*` protocol.

## Getting started

```sh
pnpm install                  # install all dependencies
pnpm typecheck                # type-check the entire project (tsc -b)
pnpm lint                     # biome check
pnpm test                     # vitest run
pnpm check                    # typecheck + lint + website check + tests
```

### Local development

```sh
pnpm dev:router               # wrangler dev for the router worker
pnpm dev:control-plane        # wrangler dev for the control plane worker
pnpm dev:website              # astro dev for the marketing site
```

Local secrets live in each worker's `.dev.vars` file (gitignored). Production secrets are managed with `wrangler secret put` — never commit them.

### Deployment

```sh
pnpm deploy:router
pnpm deploy:control-plane
pnpm deploy:website
```

CI (`.github/workflows/ci.yml`) runs `pnpm check` plus `wrangler deploy --dry-run` for each worker on every PR. Database migrations are applied automatically on merge to `main` by `.github/workflows/migrate.yml`.

## Architecture at a glance

- **Router Worker** — verifies webhook HMACs, ACKs immediately, then forwards async to the correct Fly machine via a KV lookup. Stateless, no DB access, intentionally minimal.
- **Control Plane Worker** — tenant lifecycle (OAuth, machine provisioning via the Fly Machines API, credential management, admin operations). Built with [Hono](https://hono.dev).
- **Cloudflare KV** — `ROUTING_TABLE` (shared) maps `{platform}:{externalId}` → Fly instance; `OAUTH_STATE` (control-plane only) holds single-use OAuth CSRF tokens.
- **Neon Postgres** (via Hyperdrive) — `tenants`, `integration_tokens`, `deployments`. Schema is managed with [dbmate](https://github.com/amacneil/dbmate) migrations.

For the full picture, see [`docs/architecture.md`](docs/architecture.md).

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | System design, data flows, key decisions |
| [`docs/security.md`](docs/security.md) | Route protection model, secrets inventory |
| [`docs/privacy.md`](docs/privacy.md) | Privacy controls mapped to SOC 2 (P1–P8) |
| [`docs/migrations.md`](docs/migrations.md) | Authoring and running database migrations |
| [`docs/monitoring.md`](docs/monitoring.md) | Alerts, dashboards, on-call hooks |
| [`docs/tracing.md`](docs/tracing.md) | Distributed tracing setup |
| [`docs/testing.md`](docs/testing.md) | Test strategy and harnesses |
| [`AGENTS.md`](AGENTS.md) | Conventions and workflow for AI agents (and humans) working in this repo |
| [`CLAUDE.md`](CLAUDE.md) | Project context for Claude Code |

## Tech stack

- **Runtime:** Cloudflare Workers
- **Language:** TypeScript (strict, ESNext, bundler resolution)
- **Router Worker:** vanilla Workers API — no framework
- **Control Plane Worker:** Hono
- **Database:** Neon Postgres via Cloudflare Hyperdrive (`postgres` / postgresjs)
- **KV:** Cloudflare KV for routing + OAuth state
- **Compute:** Fly.io (one machine per tenant, single shared Fly app)
- **Tooling:** pnpm, Biome, Vitest, Wrangler, dbmate
