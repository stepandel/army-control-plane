# Security Model

This document covers authentication, authorization, and request verification across the Army control plane and router infrastructure.

## Route Protection Matrix

| Route group | Worker | Auth mechanism | Who calls it |
|---|---|---|---|
| `POST /webhooks/{linear,github}` | Router | Webhook HMAC signature | Linear, GitHub (Slack uses Socket Mode, not webhooks) |
| `GET /auth/{google,github,discord,slack}/*` | Control Plane | KV-backed single-use state token | End users via browser |
| `GET /oauth/*/install` | Control Plane | None (public) | End users via browser |
| `GET /oauth/*/callback` | Control Plane | KV-backed single-use state token | OAuth provider redirect |
| `GET /health` | Control Plane | None (public) | Monitoring / load balancers |
| `POST /internal/register` | Control Plane | Per-tenant `INTERNAL_SECRET` via Bearer token | Fly machines on boot |
| `GET /internal/credentials/:team_id` | Control Plane | Per-tenant `INTERNAL_SECRET` via Bearer token | Fly machines on boot |
| `/admin/*` | Control Plane | Cloudflare Access JWT | Human operators |

## 1. Webhook HMAC Verification (Router Worker)

Every inbound webhook is verified before processing. The Router Worker rejects any request with an invalid or missing signature with `401`. Only Linear and GitHub use webhooks — Slack connects via Socket Mode (outbound WebSocket from each tenant's Fly machine) and does not pass through the router.

### Per-platform verification

**Linear** — `linear-signature` header
- HMAC-SHA256 of raw body with `LINEAR_WEBHOOK_SECRET`
- Signature format: raw hex

**GitHub** — `x-hub-signature-256` header
- HMAC-SHA256 of raw body with `GITHUB_WEBHOOK_SECRET`
- Signature format: `sha256=<hex>`

### Implementation details

- All comparisons use constant-time comparison (`timingSafeEqual`) to prevent timing attacks
- Secrets are stored as Worker secrets (`wrangler secret put`), never in code or config
- Source: `workers/router/src/verify.ts`

## 2. OAuth State Tokens (CSRF Protection)

The OAuth install/callback flow uses **KV-backed single-use state tokens** to prevent CSRF and replay attacks. These live in a dedicated `OAUTH_STATE` KV namespace, separate from the routing table.

### Flow

```
/install                              /callback
   │                                      │
   ├─ Generate random UUID                ├─ Read token from KV
   ├─ Store in KV with 10-min TTL         ├─ If missing → 403 (expired or replayed)
   ├─ Pass as ?state= to OAuth provider   ├─ Delete from KV immediately (single-use)
   └─ Redirect user                       └─ Proceed with code exchange
```

### Properties

| Property | How it's enforced |
|---|---|
| Unpredictable | `crypto.randomUUID()` — 122 bits of entropy |
| Single-use | Deleted from KV on first read |
| Time-limited | KV TTL of 600 seconds (10 minutes) |
| No replay | Deletion happens before processing — a second callback with the same state gets `null` from KV |

### Tenant ID embedding

For secondary installs (Linear, GitHub), the state token carries a `tenantId` in its KV payload. This links the OAuth callback back to the correct tenant without exposing the tenant ID in the URL where it could be tampered with.

- Source: `workers/control-plane/src/lib/oauth-state.ts`

## 3. Cloudflare Access (Admin Routes)

All `/admin/*` routes are protected by Cloudflare Access, which provides zero-trust identity verification.

### Two-layer protection

**Layer 1: Cloudflare Access Policy (network level)**
Configured in the Cloudflare Zero Trust dashboard. When a request hits `army-control-plane.stepandel.workers.dev/admin/*`, Cloudflare intercepts it and redirects to your identity provider (Google, GitHub SSO, etc.) before the request ever reaches the Worker. Authenticated users get a signed JWT cookie.

**Layer 2: JWT Validation Middleware (application level)**
The Worker independently verifies the JWT to defend against bypass scenarios (e.g., someone hitting the `*.workers.dev` URL directly, which doesn't go through Access).

### JWT validation steps

1. Extract token from `Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie
2. Parse the JWT header and extract `kid` (key ID)
3. Fetch Cloudflare's public keys from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached 1 hour)
4. Match `kid` to a public key and verify RS256 signature via Web Crypto
5. Validate claims:
   - `aud` must include the configured `CF_ACCESS_AUD` (your Access Application's audience tag)
   - `exp` must be in the future
   - `iss` must be `https://<CF_ACCESS_TEAM_DOMAIN>`
6. On success, set `accessEmail` in the Hono context for audit logging

### Required environment variables

| Variable | Description | Example |
|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | Your Zero Trust team domain | `myteam.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Audience tag from the Access Application | `a1b2c3d4e5f6...` |

### Setup

1. Cloudflare Zero Trust dashboard → Access → Applications → **Add an application**
2. Type: Self-hosted
3. Application domain: `army-control-plane.stepandel.workers.dev`, path: `/admin/*`
4. Add an Allow policy (e.g., emails ending in `@yourcompany.com`)
5. Copy the **Application Audience (AUD) tag** from the overview page
6. Set the env vars:
   ```sh
   wrangler secret put CF_ACCESS_TEAM_DOMAIN  # e.g. myteam.cloudflareaccess.com
   wrangler secret put CF_ACCESS_AUD          # the AUD tag you copied
   ```

- Source: `workers/control-plane/src/middleware/cf-access.ts`

## 4. Internal Routes

Routes under `/internal/*` are called by Fly machines on boot.

**Provisioning and credential push are not HTTP routes** — they are internal functions (`lib/provision.ts`, `lib/credentials.ts`) called directly via `waitUntil` from OAuth callbacks and admin routes. They never touch the network.

### Per-tenant INTERNAL_SECRET

Each Fly machine receives an `INTERNAL_SECRET` env var during provisioning. The same secret is stored in the KV `TenantRoute` record. When a machine calls `/internal/*`:

1. Machine sends `Authorization: Bearer <INTERNAL_SECRET>` header
2. Worker extracts the `team_id` from the request (body or URL param)
3. Worker looks up the tenant's KV route (`{platform}:{team_id}`)
4. Compares `route.internal_secret` against the bearer token
5. Returns 401 if missing, mismatched, or no KV route exists

### Properties

| Property | How it's enforced |
|---|---|
| Per-tenant isolation | Each tenant gets a unique `INTERNAL_SECRET` (UUID) |
| No shared secrets | There is no global internal API key — compromise of one tenant's secret doesn't affect others |
| Stored in KV | Lookup is fast and doesn't require a database call |
| Rotated on reprovision | A new `INTERNAL_SECRET` is generated each time a machine is provisioned |

- Source: `workers/control-plane/src/routes/internal.ts`

## 5. Secrets Management

All sensitive values are stored as **Cloudflare Worker secrets** (encrypted at rest, injected at runtime) — never in `wrangler.toml` or source code.

### Router Worker secrets

| Secret | Purpose |
|---|---|
| `LINEAR_WEBHOOK_SECRET` | Verify inbound Linear webhooks |
| `GITHUB_WEBHOOK_SECRET` | Verify inbound GitHub webhooks |

### Control Plane Worker secrets

| Secret | Purpose |
|---|---|
| `SLACK_CLIENT_ID` | Slack OAuth app credentials |
| `SLACK_CLIENT_SECRET` | Slack OAuth app credentials |
| `GOOGLE_CLIENT_ID` | Google OAuth sign-in credentials |
| `GOOGLE_CLIENT_SECRET` | Google OAuth sign-in credentials |
| `DISCORD_CLIENT_ID` | Discord OAuth sign-in credentials |
| `DISCORD_CLIENT_SECRET` | Discord OAuth sign-in credentials |
| `SLACK_APP_TOKEN` | Slack app-level token (pushed to tenant machines for Socket Mode) |
| `LINEAR_CLIENT_ID` | Linear OAuth app credentials |
| `LINEAR_CLIENT_SECRET` | Linear OAuth app credentials |
| `GITHUB_APP_SLUG` | GitHub App slug (used for install URLs) |
| `GITHUB_APP_ID` | GitHub App ID (pushed to tenant machines for installation token generation) |
| `GITHUB_CLIENT_ID` | GitHub App OAuth credentials |
| `GITHUB_CLIENT_SECRET` | GitHub App OAuth credentials |
| `GITHUB_OAUTH_CLIENT_ID` | Dedicated GitHub OAuth sign-in app credentials |
| `GITHUB_OAUTH_CLIENT_SECRET` | Dedicated GitHub OAuth sign-in app credentials |
| `GITHUB_PRIVATE_KEY` | GitHub App private key (pushed to tenant machines for installation token generation) |
| `FLY_API_TOKEN` | Fly Machines API (provisioning, destroy, update) |
| `ANTHROPIC_API_KEY` | Anthropic API key (pushed to tenant machines) |
| `BRAVE_API_KEY` | Brave Search API key (pushed to tenant machines) |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key for LLM tracing (pushed to tenant machines) |
| `LANGSMITH_API_KEY` | LangSmith API key — opt-in only when `ENABLE_LANGSMITH=true` (pushed to tenant machines) |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access JWT validation |
| `CF_ACCESS_AUD` | Cloudflare Access audience check |

### Setting secrets

```sh
# Router
cd workers/router
wrangler secret put LINEAR_WEBHOOK_SECRET
wrangler secret put GITHUB_WEBHOOK_SECRET

# Control Plane
cd workers/control-plane
wrangler secret put SLACK_CLIENT_ID
wrangler secret put SLACK_CLIENT_SECRET
# ... etc
```

Secrets are **never** committed to the repository. Local development uses `.dev.vars` files (gitignored).
