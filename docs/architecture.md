# Architecture

## System overview

Army is a multi-tenant webhook routing and orchestration platform. It connects Slack, Linear, and GitHub to isolated per-tenant compute instances running on Fly.io, with Cloudflare handling all ingress, routing, and tenant management.

```
┌─────────────────────────────────────────────────────────────┐
│                       CLOUDFLARE                            │
│                                                             │
│  ┌──────────────────┐         ┌──────────────────────────┐  │
│  │  Router Worker   │         │  Control Plane Worker    │  │
│  │  router.army.ai  │         │  api.army.ai             │  │
│  │                  │         │                          │  │
│  │  1. Verify HMAC  │         │  /oauth/*    (public)    │  │
│  │  2. Return 200   │         │  /admin/*    (CF Access) │  │
│  │  3. KV lookup    │         │  /internal/* (secret)    │  │
│  │  4. Forward async│         │  /health     (public)    │  │
│  └────────┬─────────┘         └────────────┬─────────────┘  │
│           │                                │                │
│  ┌────────▼────────────────────────────────▼─────────────┐  │
│  │                   Cloudflare KV                       │  │
│  │  ROUTING_TABLE: {platform}:{team_id} → TenantRoute     │  │
│  │  OAUTH_STATE:   {uuid} → StateData  (CP only)         │  │
│  └───────────────────────────────────────────────────────┘  │
│                                │                            │
│  ┌─────────────────────────────▼─────────────────────────┐  │
│  │            Hyperdrive → Neon Postgres                 │  │
│  │    tenants · integration_tokens · deployments         │  │
│  └───────────────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
            ┌──────────────────────┐
            │  Fly.io              │
            │  App: ${FLY_APP}     │
            │                      │
            │  army-t012345  (m/c) │
            │  army-t067890  (m/c) │
            │  army-t099911  (m/c) │
            │      ...             │
            └──────────────────────┘
```

## Components

### Router Worker (`workers/router/`)

The Router Worker is the single ingress point for all webhooks. It is intentionally minimal — no framework, no database access, no heavy dependencies.

**Request lifecycle:**

```
Slack/Linear/GitHub
        │
        ▼
  POST /{slack|linear|github}
        │
        ├─ 1. Identify source from URL path
        ├─ 2. Read body once (used for both verify + forward)
        ├─ 3. Verify HMAC signature (per-platform, timing-safe)
        │     └─ 401 if invalid
        ├─ 4. Handle Slack url_verification challenge
        ├─ 5. Return 200 OK immediately (ACK)
        ├─ 6. Extract team ID from payload
        ├─ 7. KV lookup: {platform}:{team_id} → TenantRoute
        └─ 8. Forward body to instance_url via waitUntil (fire-and-forget)
```

**Design constraints:**
- No database calls — only KV reads at request time
- Must respond within Slack's 3-second timeout
- `waitUntil` for async forwarding so the response is not delayed
- Stateless — all routing state lives in KV

### Control Plane Worker (`workers/control-plane/`)

The Control Plane manages the full tenant lifecycle. Built with Hono.

**Route groups:**

| Group | Path | Auth | Purpose |
|---|---|---|---|
| OAuth | `/oauth/{slack,linear,github}/{install,callback}` | Public (CSRF via state tokens) | OAuth consent + token exchange |
| Internal | `/internal/register`, `/internal/credentials/:team_id` | Per-tenant `INTERNAL_SECRET` | Machine self-registration + credential fetch |
| Admin | `/admin/tenants`, `/admin/tenants/:team_id`, etc. | Cloudflare Access JWT | Tenant CRUD |
| Health | `/health` | Public | Liveness check |

**Internal functions** (not routes — called directly via `waitUntil`):

| Function | Source | Called by |
|---|---|---|
| `provisionTenant(env, tenantId)` | `lib/provision.ts` | Slack OAuth callback, admin reprovision |
| `pushCredentials(env, tenantId)` | `lib/credentials.ts` | Linear/GitHub OAuth callbacks |

### Cloudflare KV

Two separate KV namespaces:

**1. `ROUTING_TABLE`** — maps platform + team ID to Fly instance URL (shared by both workers)
```
Key:   slack:T012345
Value: { "instance_url": "https://${FLY_APP}.fly.dev", "internal_secret": "uuid" }
```

A tenant with all three integrations has three KV entries (`slack:T012345`, `linear:T012345`, `github:T012345`), all pointing to the same instance. The `internal_secret` is also used to authenticate machine-to-control-plane calls.

**2. `OAUTH_STATE`** — ephemeral CSRF tokens for OAuth flows (control plane only)
```
Key:   550e8400-e29b-41d4-a716-446655440000
Value: { "tenantId": "T012345" }
TTL:   600 seconds
```

Separated from the routing table so the Router Worker never has access to OAuth state.

### Neon Postgres (via Hyperdrive)

Three tables, accessed only by the Control Plane Worker:

**`tenants`** — one row per Slack workspace
- `id` (PK): Slack team_id (e.g., `T012345`)
- `status`: `pending` → `provisioning` → `active` → `suspended` | `destroyed`
- Tracks Fly app name, machine ID, and instance URL

**`integration_tokens`** — OAuth tokens for each connected platform
- Links to tenant via `tenant_id`
- Stores `access_token`, `refresh_token`, `scopes`, `expires_at`
- GitHub stores the `installation_id` as `access_token` with `token_type: 'installation'`

**`deployments`** — deployment history per tenant
- Links to tenant via `tenant_id`
- Tracks Fly machine ID, image ref, status, timestamps

Schema: `workers/control-plane/src/db/schema.sql`

## Data flows

### 1. New tenant onboarding (Slack install)

```
User clicks "Add to Slack"
  │
  ▼
GET /oauth/slack/install
  ├─ Generate state token → store in KV (10-min TTL)
  └─ Redirect to Slack OAuth consent screen
        │
        ▼ (user approves)
GET /oauth/slack/callback?code=...&state=...
  ├─ Verify + consume state token from KV (single-use)
  ├─ Exchange code for bot token via Slack API
  ├─ Upsert tenant record in Postgres (status: pending)
  ├─ Store bot token in integration_tokens
  └─ waitUntil → provisionTenant(env, teamId)
        │
        ▼
provisionTenant()
  ├─ Mark tenant as provisioning
  ├─ Gather tokens → build machine env vars
  ├─ Fly Machines API: create machine in FLY_APP
  ├─ Update tenant with fly_machine_id + instance_url
  ├─ Record deployment in deployments table
  ├─ Write KV route: slack:{team_id} → TenantRoute
  └─ Mark tenant as active (rollback to pending on failure)
        │
        ▼
Fly machine boots (with INTERNAL_SECRET env var)
  ├─ POST /internal/register { team_id, instance_url, machine_id }
  │     Auth: Bearer <INTERNAL_SECRET>
  │     └─ Updates tenant record + refreshes all KV routes
  └─ GET /internal/credentials/{team_id}
        Auth: Bearer <INTERNAL_SECRET>
        └─ Returns all tokens grouped by platform
```

### 2. Adding a secondary integration (Linear/GitHub)

```
Admin visits /oauth/linear/install?tenant_id=T012345
  ├─ Generate state token with embedded tenant_id → KV
  └─ Redirect to Linear OAuth consent screen
        │
        ▼ (user approves)
GET /oauth/linear/callback?code=...&state=...
  ├─ Verify + consume state token, extract tenant_id
  ├─ Confirm tenant exists and is active
  ├─ Exchange code for access token
  ├─ Store token in integration_tokens
  ├─ Copy KV route: slack:{team_id} → linear:{team_id}
  └─ waitUntil → pushCredentials(env, tenantId)
        └─ Fly Machines API: update machine env vars (triggers reboot)
```

### 3. Webhook delivery (steady state)

```
Slack/Linear/GitHub sends POST to router.army.ai
  │
  ▼
Router Worker
  ├─ Verify HMAC → 401 if bad
  ├─ Return 200 to webhook source
  ├─ Extract team_id from payload
  ├─ KV.get("{platform}:{team_id}") → TenantRoute
  └─ waitUntil → POST {instance_url}/webhooks/{platform}
        │
        ▼
Fly machine processes event
```

### 4. Tenant destruction

```
DELETE /admin/tenants/{team_id}   (requires Cloudflare Access)
  ├─ Fly Machines API: destroy machine
  ├─ Stop all running deployments in DB
  ├─ Delete all KV routes (slack:, linear:, github:)
  └─ Mark tenant as destroyed
```

### 5. Reprovisioning

```
POST /admin/tenants/{team_id}/reprovision   (requires Cloudflare Access)
  ├─ Fly Machines API: destroy old machine
  ├─ Stop old deployments in DB
  ├─ Delete all KV routes
  ├─ Reset tenant status to pending
  └─ waitUntil → provisionTenant(env, teamId)
```

## Tenant lifecycle states

```
pending ──▶ provisioning ──▶ active ──▶ destroyed
                                │
                                ├──▶ suspended
                                │
                                └──▶ (reprovision) ──▶ pending
```

## Key design decisions

| Decision | Rationale |
|---|---|
| Router has no DB access | KV-only keeps it under Slack's 3s timeout; no cold-start penalty from DB connections |
| Separate KV namespaces for routing vs state | Router Worker only binds routing table; OAuth state is isolated to control plane |
| Slack is the primary install | Tenant identity is the Slack team_id; other integrations attach to it |
| OAuth state in KV (not signed tokens) | Single-use guarantees prevent replay; KV TTL handles expiry |
| Hono for control plane, vanilla for router | Control plane needs routing/middleware; router needs raw speed |
| `waitUntil` for forwarding + provisioning | Non-blocking — webhook sources get their 200 immediately |
| One Fly machine per tenant | Isolation — tenant data and credentials never co-mingle |
| Single Fly app, many machines | All tenant machines live in one Fly app (`FLY_APP` config) — no per-tenant app overhead |
| Provision/credentials are functions, not routes | No self-calling through the external API — eliminates auth and latency overhead |
| Per-tenant INTERNAL_SECRET | Each machine gets a unique secret; compromise of one doesn't affect others |

## Not yet implemented

- **Token refresh** — Linear tokens may expire; refresh flow not yet built
