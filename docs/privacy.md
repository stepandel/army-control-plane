# Privacy

This document describes how the Army control plane handles personal data on behalf of Vera AI, mapped to the SOC 2 Privacy Trust Services Criteria (P1–P8). It is the engineering-level companion to the public-facing privacy notice at [`/privacy`](../website/src/pages/privacy.astro) and the subprocessor list at [`/subprocessors`](../website/src/pages/subprocessors.astro), and a sibling to [`security.md`](security.md), which covers authentication, authorization, and request verification.

> **Scope.** This document covers data processed by the control-plane infrastructure in this repository: the Router Worker, the Control Plane Worker, Cloudflare KV, Neon Postgres, and the per-tenant Fly.io machines provisioned by this control plane. "Vera" refers to the product end-users interact with; "Army" refers to this control plane that powers it. The document does not cover data processed inside customer-owned integrations (Slack workspaces, Linear orgs, GitHub repos) except insofar as we receive and store it.
>
> Items still marked **TBD** require organization-specific input that is not derivable from the codebase and must be filled in by the data protection owner before this document is treated as authoritative for audit.

## 1. Roles and responsibilities (P1 — Management)

| Role | Responsibility | Owner |
|---|---|---|
| Data protection owner | Maintains this document, responds to data subject requests at `privacy@agent-army.ai`, approves new subprocessors | Vera AI engineering team — named owner **TBD** |
| Security incident commander | Leads breach response, coordinates customer notifications, owns the `security@agent-army.ai` inbox | Vera AI engineering team — named owner **TBD** |
| Engineering on-call | First-line response to data-handling incidents surfaced via monitoring | Routed through `#ops-alerts` per [`monitoring.md`](monitoring.md) |

Privacy controls are reviewed at least annually, and whenever a new subprocessor, data category, or integration is added.

## 2. Data inventory (P4 — Collection)

Only data necessary to deliver the service is collected. There is no ad tracking, no analytics on end-user content, and no use of customer data to train or fine-tune models.

### 2.1 Personal data stored in Neon Postgres

Source of truth: `workers/control-plane/src/db/schema.sql` and the migrations in `workers/control-plane/db/migrations/`.

| Table | Field | Category | Purpose |
|---|---|---|---|
| `tenants` | `id` (Slack `team_id`) | Workspace identifier | Tenant lookup, KV routing keys |
| `tenants` | `name` | Workspace metadata | Display in admin UI |
| `tenants` | `stripe_customer_id`, `stripe_subscription_id` | Billing identifiers | Subscription management |
| `tenants` | `anthropic_api_key` | Secret (BYOK, encrypted) | Optional customer-owned LLM credential |
| `users` | `slack_user_id`, `slack_team_id` | Workspace identifier | Per-user identity within a tenant |
| `users` | `email` | Direct identifier (PII) | Account linking, admin contact |
| `users` | `name` | Direct identifier (PII) | Display in UI |
| `users` | `avatar_url` | Direct identifier (PII) | Display in UI |
| `users` | `last_login_at` | Activity metadata | Session tracking |
| `integration_tokens` | `access_token`, `refresh_token` | Credential (encrypted at rest) | Authenticated API calls to Slack / Linear / GitHub on the tenant's behalf |
| `integration_tokens` | `external_id`, `scopes`, `expires_at` | Credential metadata | Routing, scope audits, refresh scheduling |
| `deployments` | `tenant_id`, `fly_machine_id`, `image_ref`, `status` | Operational metadata | Deployment history, debugging |
| `promo_redemptions` | `tenant_id`, `code` | Commercial metadata | Fraud prevention, single-redemption enforcement |

**Token encryption.** OAuth `access_token`, `refresh_token`, the Slack bot token, and the optional BYOK `anthropic_api_key` are all encrypted with AES-256-GCM via `workers/control-plane/src/lib/crypto.ts` using the `ENCRYPTION_KEY` Worker secret (256-bit hex key, 96-bit IV, GCM auth tag) before being written. Encryption call sites: `routes/oauth.ts`, `routes/admin.ts`, `routes/api-onboarding.ts`, `lib/token-refresh.ts`.

### 2.2 Data stored in Cloudflare KV

| Namespace | Key shape | Value | Contents |
|---|---|---|---|
| `ROUTING_TABLE` | `{platform}:{externalId}` | `TenantRoute` | Fly instance URL, `fly_machine_id`, per-tenant `internal_secret` |
| `OAUTH_STATE` | `{uuid}` | `StateData` | Ephemeral CSRF state with optional `tenantId` (10-minute TTL, single-use) |
| `ALERT_STATE` | `{dedupeKey}` | counter / sentinel | Alert dedupe state for `lib/alerts.ts` (1-hour default TTL) |

KV values contain **no end-user PII** — only workspace identifiers, Fly metadata, and ephemeral OAuth / alert state.

### 2.3 Data in transit to tenant Fly machines

Each tenant's Fly machine receives its own credentials via the Fly Machines API (`lib/credentials.ts`). Credentials never co-mingle across tenants. Once pushed, the machine processes Slack / Linear / GitHub events inside the customer's isolated instance — the control plane does **not** read, log, or retain the content of those events.

### 2.4 Data we explicitly do *not* collect

- End-user message content from Slack, Linear, or GitHub (processed only inside the tenant's isolated Fly machine)
- Payment card data (handled entirely by Stripe; only `stripe_customer_id` / `stripe_subscription_id` references are stored)
- Cookies, device IDs, browser fingerprints, biometric or location data
- Analytics events tied to identifiable end users
- Anything used to train or fine-tune AI models

## 3. Notice and consent (P2, P3)

- **Notice.** The public-facing privacy notice at <https://agent-army.ai/privacy> (source: `website/src/pages/privacy.astro`) informs data subjects of processing purposes, categories, subprocessors, retention, and their rights. This document is the engineering-level counterpart and must stay consistent with it.
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
| `OAUTH_STATE` (CSRF tokens) | **10 minutes** | Cloudflare KV TTL (`workers/control-plane/src/lib/oauth-state.ts`) |
| `ALERT_STATE` dedupe entries | **1 hour** (default) | Cloudflare KV TTL (`workers/control-plane/src/lib/alerts.ts`) |
| `ROUTING_TABLE` (webhook routes) | Until tenant destroy | Deleted during `DELETE /admin/tenants/{team_id}` |
| OAuth tokens (`integration_tokens`) | Lifetime of the tenant; cascaded on tenant row delete; old refresh tokens overwritten on rotation | `ON DELETE CASCADE`; `lib/token-refresh.ts` overwrites in place |
| `tenants` rows after `status = destroyed` | **Retained indefinitely** today (status flag only — no scheduled cleanup job exists in this repo). A retention window + purge job is **TBD** and should be added before audit. | n/a |
| Conversation snapshots and execution logs (tenant Fly volume + Tigris S3) | **7 days** | Tenant runtime — not the control plane. See public privacy notice §4. |
| Active session registry | Pruned after 24 hours of inactivity | Tenant runtime |
| Langfuse traces | **Up to 30 days** (Langfuse Cloud Hobby plan) | Langfuse Cloud — re-pin if the plan changes |
| Cloudflare Worker request logs | Provider default — **TBD** if Logpush is configured |
| Neon Postgres PITR window | Per Neon plan — **TBD** |
| Fly.io machine logs | Provider default — **TBD** |
| Billing records (Stripe) | Per Stripe + applicable financial regulation (typically 7 years) | Stripe |

> **Audit gap.** The lack of a scheduled cleanup job for `status = destroyed` tenants is the most material privacy gap visible in the codebase today. Before claiming SOC 2 compliance with this document, either (a) add a cron that hard-deletes destroyed tenant rows after a defined window, or (b) document a manual purge procedure with a periodic review.

### 4.3 Disposal

Tenant destruction (`DELETE /admin/tenants/{team_id}`, `workers/control-plane/src/routes/admin.ts`) performs, in order:

1. Fly Machines API: destroy the tenant's machine
2. Mark all deployments as stopped
3. Delete KV routes for webhook platforms (`linear:`, `github:`)
4. `UPDATE tenants SET status = 'destroyed', fly_machine_id = NULL, fly_volume_id = NULL, fly_app_name = NULL, instance_url = NULL`

The `ON DELETE CASCADE` constraints on `integration_tokens`, `users`, `deployments`, and `promo_redemptions` mean that when (and only when) a `tenants` row is physically deleted, dependent rows go with it. The current `DELETE /admin/tenants/:team_id` route does not perform a physical delete — see the audit gap above.

## 5. Access, integrity, and security (carried from `security.md`)

All privacy controls rely on the security controls documented in [`security.md`](security.md). In particular:

- **Encryption in transit** — all control-plane endpoints are HTTPS-only; webhook bodies are HMAC-verified (`workers/router/src/verify.ts`).
- **Encryption at rest** —
  - Application-level: OAuth tokens, the Slack bot token, and the BYOK Anthropic API key are encrypted with AES-256-GCM (`lib/crypto.ts`) before being written to Postgres.
  - Provider-level: Neon Postgres, Cloudflare KV, Cloudflare Worker secrets, Fly.io volumes, and Tigris buckets are encrypted at rest by their respective providers.
- **Access control** — admin routes are protected by Cloudflare Access + JWT validation (`src/middleware/cf-access.ts`). Internal routes use per-tenant `INTERNAL_SECRET` bearer tokens. Admin actions record the Cloudflare Access `email` claim via the `accessEmail` Hono context value for audit logging.
- **Tenant isolation** — one Fly machine per tenant, per-tenant `INTERNAL_SECRET`, no shared secrets.
- **Secret scrubbing** — every conversation snapshot and log line passes through a central scrubber before storage. Provider API keys, JWTs, connection strings, `Bearer` / `Basic` headers, long hex strings, email addresses, credit-card-shaped numbers, and US SSN patterns are redacted. Large tool outputs are summarized to byte counts. (See public privacy notice §5 — note that this scrubber is best-effort and pattern-based.)

Production database access by Vera AI engineers is governed by an internal access policy and used only for incident response, debugging at customer request, and security investigations. The list of named individuals with production access and the break-glass procedure are **TBD** for inclusion here.

## 6. Data subject rights (P6)

We honor the following rights for data subjects. Requests are received at `privacy@agent-army.ai` and completed within **30 days** (matches the public privacy notice §7 commitment, GDPR / CCPA compliant).

| Right | How it is fulfilled |
|---|---|
| **Access** | Export of all rows in `tenants`, `users`, `integration_tokens` (token values redacted), and `deployments` for the requesting tenant / user |
| **Rectification** | Direct update via admin tooling; self-service correction via the source platform (Slack / Linear / GitHub) for fields sourced from OAuth |
| **Erasure** | Tenant destroy flow (§4.3) plus explicit row deletion for affected `users` rows; propagation to subprocessors where applicable. **Note:** today this requires a manual hard-delete of the `tenants` row to trigger cascade cleanup — see the §4.2 audit gap. |
| **Portability** | JSON export of the rows listed under "Access" |
| **Objection / restriction** | Tenant suspension (`status = suspended`) halts all processing without deletion |
| **Withdraw consent** | Uninstall the integration in Slack / Linear / GitHub; OAuth tokens become invalid and any refresh attempt fails |

We can only delete data we still hold. Conversation snapshots and execution logs older than 7 days have already been removed automatically by the tenant runtime. Data held by Slack, Linear, or GitHub is governed by those platforms' own policies.

## 7. Subprocessors and disclosure (P7)

The control plane relies on the following subprocessors. Each handles a defined slice of data under a data processing agreement (DPA). This list mirrors the public subprocessor page at <https://agent-army.ai/subprocessors> (source: `website/src/pages/subprocessors.astro`) and must be kept in sync with it.

| Subprocessor | Purpose | Data categories | Region |
|---|---|---|---|
| Anthropic | LLM inference for tenant workloads | User prompts, code context | US |
| Fly.io | Per-tenant compute, secrets, volumes | Tenant credentials, application runtime, encrypted secrets | US East (`iad`/`ewr`/`ord`, see `lib/fly.ts`) |
| Neon | Managed Postgres | All application data listed in §2.1 | US East |
| Cloudflare | Workers runtime, KV, Hyperdrive, DNS, Access (admin auth) | Routing table, OAuth state, request processing | Global edge, US origin |
| Tigris | Object storage for tenant conversation snapshots and execution logs | Scrubbed snapshots and logs (7-day retention) | US East (`iad`) |
| Stripe | Billing and payments | Customer / subscription identifiers; card data is held by Stripe, not us | US / global |
| Slack | OAuth provider, Socket Mode integration | Workspace identifiers, messages and bot tokens in transit | US |
| Linear | OAuth provider, webhook source | Workspace identifiers, issue / comment payloads, OAuth tokens | US / EU |
| GitHub | OAuth provider, webhook source | Repositories, PRs, installation tokens | US |
| Langfuse | LLM tracing — production default | LLM call traces (scrubbed) | US |
| LangSmith | LLM tracing — opt-in / non-prod (`ENABLE_LANGSMITH=true`) | LLM call traces (scrubbed) | US |
| Brave Search | Web search tool for tenant workloads | Search queries issued by tenant machines | US (global) |

We notify customers at least **30 days** before adding a new subprocessor, and update both this document and the public subprocessor page in the same change. A DPA is available on request via `privacy@agent-army.ai`.

No personal data is disclosed to any party other than the subprocessors above, except when required by law. Such legal disclosures are recorded in the incident log and reviewed by the data protection owner.

## 8. Incident response and breach notification (P8)

Security incidents that may involve personal data follow the runbook in [`monitoring.md`](monitoring.md). All control-plane alerts fan out through `lib/alerts.ts` to a single `#ops-alerts` Slack channel, with KV-backed dedupe and three severity tiers (`info`, `warning`, `critical`). At a high level:

1. **Detect** — alerts from the fleet health-check cron, Langfuse polling worker, Grafana Cloud rules over Fly Prometheus, or customer report
2. **Contain** — suspend affected tenants, rotate compromised secrets (Worker secrets via `wrangler secret put`, app-level via `ENCRYPTION_KEY` rotation), revoke OAuth tokens
3. **Assess** — incident commander evaluates scope, data categories, and affected parties
4. **Notify** —
   - **Affected customers within 72 hours of confirmed breach**, by email, with the nature of the breach, what data was affected, remediation steps, and recommended customer-side actions (matches the public commitment on `/security`)
   - Supervisory authorities (where required by GDPR) within **72 hours**
   - Downstream data subjects as directed by customer contracts
5. **Remediate and record** — post-mortem, corrective actions, and incident log entry

Vulnerability reports received at `security@agent-army.ai` are acknowledged within **48 hours** (per the public commitment on `/security`).

A formal incident log location (e.g., a dedicated Linear project, Notion DB, or git-tracked file) is **TBD** and should be linked here once chosen.

## 9. International data transfers

Vera AI is operated from the United States and all data is stored and processed in the US (Fly.io US East, Neon US East, Tigris US East, Cloudflare US-origin). Where required, we rely on Standard Contractual Clauses with our subprocessors for transfers from the EEA, UK, and Switzerland.

## 10. Children's data

Vera is not directed to children under 16 and we do not knowingly collect personal data from children under 16. If you believe a child has used Vera, email `privacy@agent-army.ai` and we will delete the relevant data.

## 11. Change log

| Date | Change | Author |
|---|---|---|
| 2026-04-07 | Initial draft, grounded in `db/schema.sql`, `lib/crypto.ts`, `lib/fly.ts`, `monitoring.md`, and the website's `/privacy`, `/security`, `/subprocessors` pages | Vera AI engineering team |

---

**Review cadence:** this document is reviewed at least annually and whenever any of the following change: the schema in `workers/control-plane/src/db/schema.sql`, the subprocessor list in §7, the retention settings in §4.2, the secrets inventory in [`security.md`](security.md#5-secrets-management), or the public privacy / security / subprocessor pages under `website/src/pages/`. Drift between this document and the public pages is itself a finding.
