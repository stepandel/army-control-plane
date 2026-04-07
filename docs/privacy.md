# Privacy

This document describes how the Army control plane handles personal data, mapped to the SOC 2 Privacy Trust Services Criteria (P1–P8). It is a companion to [`security.md`](security.md), which covers authentication, authorization, and request verification.

> **Scope.** This document covers data processed by the control-plane infrastructure in this repository: the Router Worker, the Control Plane Worker, Cloudflare KV, Neon Postgres, and the per-tenant Fly.io machines provisioned by this control plane. It does not cover data processed inside customer-owned integrations (Slack workspaces, Linear orgs, GitHub repos) except insofar as we receive and store it.
>
> Items marked **TBD** require organization-specific input and must be reviewed and filled in by the data protection owner before this document is treated as authoritative for audit.

## 1. Roles and responsibilities (P1 — Management)

| Role | Responsibility | Owner |
|---|---|---|
| Data protection owner | Maintains this document, responds to data subject requests, approves subprocessors | **TBD** |
| Security incident commander | Leads breach response, coordinates notifications | **TBD** |
| Engineering on-call | First-line response to data-handling incidents surfaced via monitoring | See [`monitoring.md`](monitoring.md) |

Privacy controls are reviewed at least annually, and whenever a new subprocessor, data category, or integration is added.

## 2. Data inventory (P4 — Collection)

Only data necessary to deliver the service is collected. There is no ad tracking, no analytics on end-user content, and no sale of personal data.

### 2.1 Personal data stored in Neon Postgres

Source of truth: `workers/control-plane/src/db/schema.sql` and the migrations in `workers/control-plane/db/migrations/`.

| Table | Field | Category | Purpose |
|---|---|---|---|
| `tenants` | `id` (Slack `team_id`) | Workspace identifier | Tenant lookup, KV routing keys |
| `tenants` | `name` | Workspace metadata | Display in admin UI |
| `tenants` | `stripe_customer_id`, `stripe_subscription_id` | Billing identifiers | Subscription management |
| `tenants` | `anthropic_api_key` | Secret (BYOK) | Optional customer-owned LLM credential |
| `users` | `slack_user_id`, `slack_team_id` | Workspace identifier | Per-user identity within a tenant |
| `users` | `email` | Direct identifier (PII) | Account linking, admin contact |
| `users` | `name` | Direct identifier (PII) | Display in UI |
| `users` | `avatar_url` | Direct identifier (PII) | Display in UI |
| `users` | `last_login_at` | Activity metadata | Session tracking, inactivity cleanup |
| `integration_tokens` | `access_token`, `refresh_token` | Credential (sensitive) | Authenticated API calls to Slack / Linear / GitHub on the tenant's behalf |
| `integration_tokens` | `external_id`, `scopes`, `expires_at` | Credential metadata | Routing, scope audits, refresh scheduling |
| `deployments` | `tenant_id`, `fly_machine_id`, `image_ref`, `status` | Operational metadata | Deployment history, debugging |
| `promo_redemptions` | `tenant_id`, `code` | Commercial metadata | Fraud prevention, single-redemption enforcement |

### 2.2 Data stored in Cloudflare KV

| Namespace | Key shape | Value | Contents |
|---|---|---|---|
| `ROUTING_TABLE` | `{platform}:{externalId}` | `TenantRoute` | Fly instance URL, `fly_machine_id`, per-tenant `internal_secret` |
| `OAUTH_STATE` | `{uuid}` | `StateData` | Ephemeral CSRF state with optional `tenantId` (10-minute TTL, single-use) |

KV values contain **no end-user PII** — only workspace identifiers, Fly metadata, and ephemeral OAuth state.

### 2.3 Data in transit to tenant Fly machines

Each tenant's Fly machine receives its own credentials via the Fly Machines API (`lib/credentials.ts`). Credentials never co-mingle across tenants. Once pushed, the machine processes Slack / Linear / GitHub events inside the customer's isolated instance — the control plane does **not** read, log, or retain the content of those events.

### 2.4 Data we explicitly do *not* collect

- End-user message content from Slack, Linear, or GitHub (processed only inside the tenant's isolated Fly machine)
- Payment card data (handled entirely by Stripe; only `stripe_customer_id` / `stripe_subscription_id` references are stored)
- IP addresses and device fingerprints beyond what Cloudflare retains for edge security
- Analytics events tied to identifiable end users

## 3. Notice and consent (P2, P3)

- **Notice.** The public-facing privacy policy (TBD link: `https://army.ai/privacy`) informs data subjects of processing purposes, categories, subprocessors, retention, and their rights. This document is the engineering-level counterpart.
- **Lawful basis.** Processing is based on (a) performance of the customer contract for tenant workspace data, and (b) legitimate interest for operational telemetry (see [`monitoring.md`](monitoring.md)).
- **Consent.** OAuth consent is obtained from an authorized workspace administrator at install time for each of Slack, Linear, and GitHub. Scopes requested are the minimum needed to operate; the current set is defined in `workers/control-plane/src/routes/oauth.ts`.
- **Withdrawal.** Consent can be withdrawn at any time by uninstalling the integration in the source platform or by requesting tenant deletion (see §6).

## 4. Use, retention, and disposal (P5)

### 4.1 Use limitation

Personal data is used **only** for:

1. Authenticating and routing webhook traffic to the correct tenant's isolated machine
2. Managing the tenant lifecycle (provisioning, credential rotation, billing)
3. Operational monitoring, alerting, and incident response
4. Responding to data subject requests and legal obligations

It is **not** used for training models, analytics on identifiable users, marketing, or any purpose outside the customer contract.

### 4.2 Retention

| Data | Retention | Mechanism |
|---|---|---|
| `tenants`, `users`, `integration_tokens`, `deployments` | Lifetime of the tenant + **TBD** days after `status = destroyed` | Admin tenant destroy flow + scheduled cleanup job (**TBD**) |
| `OAUTH_STATE` (CSRF tokens) | 10 minutes | Cloudflare KV TTL (`workers/control-plane/src/lib/oauth-state.ts`) |
| `ROUTING_TABLE` (webhook routes) | Until tenant destroy | Deleted during `DELETE /admin/tenants/{team_id}` |
| Cloudflare Worker logs | **TBD** days | Cloudflare Logpush / default retention |
| Neon Postgres PITR backups | **TBD** days | Neon branch / PITR window |
| Fly.io machine logs | **TBD** days | Fly platform retention |
| Billing records (Stripe) | As required by financial regulation (typically 7 years) | Stripe |

### 4.3 Disposal

Tenant destruction (`DELETE /admin/tenants/{team_id}`) performs, in order:

1. Fly Machines API: destroy the tenant's machine
2. Mark all deployments as stopped
3. Delete KV routes for webhook platforms (`linear:`, `github:`)
4. Mark the tenant row as `destroyed`

The `ON DELETE CASCADE` constraints on `integration_tokens`, `users`, `deployments`, and `promo_redemptions` ensure dependent rows are removed when the tenant row is deleted. Row-level deletion (vs. the default "mark as destroyed") is performed on request under §6.

## 5. Access, integrity, and security (carried from `security.md`)

All privacy controls rely on the security controls documented in [`security.md`](security.md). In particular:

- **Encryption in transit** — all control-plane endpoints are HTTPS-only; webhook bodies are HMAC-verified (`workers/router/src/verify.ts`).
- **Encryption at rest** — Neon Postgres, Cloudflare KV, and Cloudflare Worker secrets are encrypted at rest by the respective providers.
- **Access control** — admin routes are protected by Cloudflare Access + JWT validation (`src/middleware/cf-access.ts`). Internal routes use per-tenant `INTERNAL_SECRET` bearer tokens.
- **Tenant isolation** — one Fly machine per tenant, per-tenant `INTERNAL_SECRET`, no shared secrets.
- **Audit logging** — admin actions record the Cloudflare Access `email` claim via the `accessEmail` Hono context value.

Production database access by engineers is restricted to **TBD** named individuals and gated through **TBD** (e.g., Neon SSO, break-glass procedure).

## 6. Data subject rights (P6)

We support the following rights for data subjects. Requests are handled by the data protection owner (§1) within **TBD** days (target: 30 days for GDPR / CCPA compliance).

| Right | How it is fulfilled |
|---|---|
| **Access** | Export of all rows in `tenants`, `users`, `integration_tokens` (redacted), and `deployments` for the requesting tenant / user |
| **Rectification** | Direct update via admin tooling; self-service correction via the source platform (Slack / Linear / GitHub) for fields sourced from OAuth |
| **Erasure** | Tenant destroy flow (§4.3) plus explicit row deletion for affected `users` rows; propagation to subprocessors where applicable |
| **Portability** | JSON export of the rows listed under "Access" |
| **Objection / restriction** | Tenant suspension (`status = suspended`) halts all processing without deletion |
| **Withdraw consent** | Uninstall the integration in Slack / Linear / GitHub; OAuth tokens become invalid and any refresh attempt fails |

Intake channel for requests: **TBD** (e.g., `privacy@army.ai`).

## 7. Subprocessors and disclosure (P7)

The control plane relies on the following subprocessors. Each handles a defined slice of data under a data processing agreement (DPA). The canonical list must be kept in sync with the public subprocessor page at **TBD** (`https://army.ai/subprocessors`).

| Subprocessor | Purpose | Data categories | Region |
|---|---|---|---|
| Cloudflare | Workers runtime, KV, Hyperdrive, Access (admin auth) | Workspace identifiers, routing metadata, OAuth state, request logs | Global edge |
| Neon | Managed Postgres | All application data listed in §2.1 | **TBD** |
| Fly.io | Per-tenant compute isolation | Tenant credentials, workspace event payloads | **TBD** |
| Stripe | Billing and payments | Customer / subscription identifiers, card data (held by Stripe, not us) | US / global |
| Anthropic | LLM inference for tenant workloads | Whatever tenants send to Claude via their machine | US |
| Langfuse | LLM tracing (default tracing provider) | LLM request / response traces | US |
| LangSmith | LLM tracing (opt-in alternative, `ENABLE_LANGSMITH=true`) | LLM request / response traces | US |
| Brave Search | Web search tool for tenant workloads | Search queries issued by tenant machines | Global |
| Slack, Linear, GitHub | OAuth providers / webhook sources | Workspace identifiers, event payloads in transit | Per provider |

No personal data is disclosed to any party other than the subprocessors above, except when required by law. Such legal disclosures are recorded in the incident log and reviewed by the data protection owner.

## 8. Incident response and breach notification (P8)

Security incidents that may involve personal data follow the runbook in [`monitoring.md`](monitoring.md). In summary:

1. **Detect** — alerts from Langfuse polling, Cloudflare analytics, Fly machine health, or customer report
2. **Contain** — suspend affected tenants, rotate compromised secrets, revoke OAuth tokens
3. **Assess** — data protection owner evaluates scope, data categories, and affected parties
4. **Notify** —
   - Affected customers within **TBD** hours of confirmed breach
   - Supervisory authorities (where required by GDPR) within **72 hours**
   - Downstream data subjects as directed by customer contracts
5. **Remediate and record** — post-mortem, corrective actions, and incident log entry

Incident log location: **TBD**.

## 9. Change log

| Date | Change | Author |
|---|---|---|
| 2026-04-07 | Initial draft | **TBD** |

---

**Review cadence:** this document is reviewed at least annually and whenever any of the following change: the schema in `workers/control-plane/src/db/schema.sql`, the subprocessor list in §7, the retention settings in §4.2, or the secrets inventory in [`security.md`](security.md#5-secrets-management).
