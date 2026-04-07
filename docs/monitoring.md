# Monitoring & Alerting

This document covers the ops monitoring and alerting stack for the Vera control plane and tenant Fly machines. It is the operator's guide for **what fires alerts**, **where they go**, **how to test them**, and **how to silence them**.

## Architecture at a glance

```
                  ┌──────────────────┐
                  │  Tenant machines │
                  │  (per Fly app)   │
                  │  /metrics:3000   │
                  └─────────┬────────┘
                            │ scraped automatically
                            ▼
                  ┌──────────────────┐    queries     ┌────────────────┐
                  │  Fly managed     │◄──────────────│ Grafana Cloud  │
                  │  Prometheus      │    PromQL     │ (dashboards +  │
                  │  (VictoriaMetrics)│               │  alert rules)  │
                  └─────────┬────────┘               └───────┬────────┘
                            │                                │
                            │                                │
        ┌───────────────────┴────────┐                       │
        │                            │                       │
        ▼                            ▼                       ▼
┌─────────────────┐         ┌─────────────────┐    ┌──────────────────┐
│ Health-check    │         │ Langfuse        │    │ Slack            │
│ cron            │         │ poll cron       │    │ #ops-alerts      │
│ (every 5 min,   │         │ (every 5 min,   │    │ (one channel,    │
│  in CF Worker)  │         │  in CF Worker)  │    │  all sources)    │
└────────┬────────┘         └────────┬────────┘    └─────────▲────────┘
         │                           │                       │
         └─────────┬─────────────────┘                       │
                   │ sendAlert()                             │
                   ▼                                         │
         ┌─────────────────┐                                 │
         │  lib/alerts.ts  │─────────────────────────────────┘
         │  KV dedupe      │
         └─────────────────┘
```

Three sources of alerts, one Slack channel, one dedupe layer.

## Alert sink — `lib/alerts.ts`

All control-plane alerts go through `sendAlert(env, { severity, title, body, dedupeKey?, dedupeTtlSec? })`. It:

- POSTs a Slack Block Kit message to `ALERT_SLACK_WEBHOOK_URL`
- Color-codes the attachment by severity (`info` gray · `warning` yellow · `critical` red)
- Suppresses repeats of the same `dedupeKey` within the TTL window (default 1 hour) using the `ALERT_STATE` KV namespace
- **Fails open** on every infra failure path: missing webhook, KV error, Slack 5xx, fetch failure — alerts may be lost (and logged loudly) but `sendAlert` itself never throws

### Severity meanings

| Severity | When to use | Channel behavior |
|----------|-------------|------------------|
| `info` | Notable but expected — e.g., trial extended, manual reprovision finished | Posted, no expectation of action |
| `warning` | Something is wrong but not yet user-visible — e.g., volume at 85%, cost trending up | Investigate within business hours |
| `critical` | User impact or imminent — e.g., machine down, OOM, token refresh failing | Investigate immediately |

### Dedupe keys

Pick a key that uniquely identifies the **condition**, not the moment. Examples:

- `machine_down:<tenant_id>` — same machine still down, same key, suppressed
- `crash_loop:<tenant_id>` — same restart loop, same key
- `langfuse_cost:<tenant_id>:critical` — same tenant, same severity tier

The default 1h TTL is short enough that an unresolved problem will re-page after an hour, long enough to avoid spam during a single incident.

## Setup — first-time install

### 1. Create the Slack incoming webhook

1. Open <https://api.slack.com/apps> and create a new app (or pick the existing one for your workspace).
2. Enable **Incoming Webhooks** → **Add New Webhook to Workspace**.
3. Pick the channel that should receive ops alerts (recommended: `#ops-alerts`, dedicated, no chatter).
4. Copy the webhook URL — it looks like `https://hooks.slack.com/services/T.../B.../xxx`.

### 2. Set the webhook secret on the control plane

```sh
cd workers/control-plane
wrangler secret put ALERT_SLACK_WEBHOOK_URL
# paste the URL when prompted
```

### 3. Create the `ALERT_STATE` KV namespace

```sh
cd workers/control-plane
wrangler kv namespace create ALERT_STATE
wrangler kv namespace create ALERT_STATE --preview
```

Take the two IDs printed and replace `REPLACE_ME_ALERT_STATE_ID` and `REPLACE_ME_ALERT_STATE_PREVIEW_ID` in `wrangler.toml` under the `[[kv_namespaces]]` block for `ALERT_STATE`.

### 4. Deploy and smoke-test

```sh
cd workers/control-plane
wrangler deploy
```

Then fire a test alert via the admin endpoint (gated by Cloudflare Access):

```sh
curl -X POST https://army-control-plane.stepandel.workers.dev/admin/alerts/test \
  -H 'cf-access-client-id: ...' \
  -H 'cf-access-client-secret: ...' \
  -H 'content-type: application/json' \
  -d '{
    "severity": "critical",
    "title": "alerts.ts smoke test",
    "body": "If you can read this, the Slack hookup works. :tada:"
  }'
```

Expected: a red-bordered Slack message in the channel within ~1 second. Response: `{"delivered":true,"suppressed":false}`.

## Testing dedupe locally

Send the same alert twice with a `dedupeKey`:

```sh
curl -X POST .../admin/alerts/test -d '{
  "severity":"warning","title":"dedupe test","body":"first call",
  "dedupeKey":"manual-test-1","dedupeTtlSec":60
}'
# → {"delivered":true,"suppressed":false}

curl -X POST .../admin/alerts/test -d '{
  "severity":"warning","title":"dedupe test","body":"second call",
  "dedupeKey":"manual-test-1","dedupeTtlSec":60
}'
# → {"delivered":false,"suppressed":true,"reason":"dedupe"}
```

Wait 60s and the next call delivers again.

## Fleet health-check cron

`workers/control-plane/src/lib/health-check.ts` runs every **5 minutes** via the `*/5 * * * *` trigger in `wrangler.toml`. It scans every `active` tenant with a Fly app+machine and the `integration_tokens` table, and fires the following alerts through `sendAlert()`.

### Alert types

| Alert | Severity | Trigger condition | Dedupe key |
|-------|----------|-------------------|------------|
| `machine_down` | critical | Machine state ≠ `started` for **≥2 consecutive checks** (≈10 min) | `machine_down:<tenant_id>` |
| `crash_loop` | critical | **≥3** lifecycle events (`start` / `restart` / `exit`) in the last **15 min** | `crash_loop:<tenant_id>` |
| `token_refresh_failed` | critical | Linear token `expires_at < now()` while tenant `status = 'active'` | `token_refresh_failed:<tenant_id>` |

All three use the default **1-hour dedupe TTL** — the same persistent condition only pages once per hour, re-firing if it remains unresolved.

### Consecutive-bad-checks state

The unreachable detector uses a simple counter stored in `ALERT_STATE` KV under `fly_state:<tenant_id>`:

- On each non-`started` observation, increment the counter (TTL 1 day).
- When the counter reaches 2, fire the alert.
- On the first `started` observation, delete the counter.

This guards against transient flaps (e.g. a machine briefly in `replacing` during a deploy) without requiring cross-run state.

### Triggering a one-shot run

```sh
curl -X POST https://army-control-plane.stepandel.workers.dev/admin/health-checks/run \
  -H 'cf-access-client-id: ...' \
  -H 'cf-access-client-secret: ...'
# → {"tenantsChecked":N,"alertsFired":0,"errorsSkipped":0}
```

### Smoke-test procedure

Each alert type has a manual reproduction. **Use a non-prod tenant only.**

1. **`machine_down`** — stop a non-prod tenant's machine via the Fly dashboard (or `flyctl machine stop -a <app>`). Wait ~10 min. One `machine_down` alert should fire. Start the machine; subsequent runs are deduped for 1h but the counter resets immediately.

2. **`crash_loop`** — temporarily deploy a known-broken image to a non-prod tenant so it restart-loops (set `restart: always` is already the default). Within ~15 min, one `crash_loop` alert fires. Roll back.

3. **`token_refresh_failed`** — directly backdate a test tenant's Linear token in the DB:
   ```sql
   UPDATE integration_tokens
   SET expires_at = now() - interval '1 hour'
   WHERE tenant_id = '<test-tenant-id>' AND platform = 'linear';
   ```
   Next health check fires the alert. Restore the real `expires_at` or run `POST /admin/tenants/<id>/refresh-token` to clear it.

### Rate limiting against Fly's API

Fly's Machines API handles ~1 req/sec per token. With the current `*/5` cadence and one `GET /machines/:id` per active tenant, we make `N` requests every 5 min — well under the limit at 100+ tenants. If we hit limits later, swap the per-tenant loop for a single `listMachines()` call per distinct app.

## Langfuse polling worker

`workers/control-plane/src/lib/langfuse-alerts.ts` runs on the same `*/5` cron as the Fly health-check job. It catches LLM-layer failure modes that infrastructure metrics can't see — tool calls throwing, models refusing, cost runaway.

We poll rather than use webhooks because Langfuse webhooks today only fire on prompt-version events, not trace/error-level events. Refs: [discussion #10147](https://github.com/orgs/langfuse/discussions/10147), [discussion #3997](https://github.com/orgs/langfuse/discussions/3997). When trace-level webhooks ship on Langfuse's roadmap, this poller can be swapped for a webhook receiver without changing `sendAlert`.

### Alert types

| Alert | Severity | Trigger condition | Dedupe key |
|-------|----------|-------------------|------------|
| `langfuse_errors` | warning | ≥1 ERROR-level observation for a tenant in the last **5 min** | `langfuse_errors:<tenant_id>` |
| `langfuse_cost` (warning) | warning | tenant `sum(totalCost) > $5` in the last **60 min** | `langfuse_cost:<tenant_id>:warning` |
| `langfuse_cost` (critical) | critical | tenant `sum(totalCost) > $20` in the last **60 min** | `langfuse_cost:<tenant_id>:critical` |

The tenant discriminator inside Langfuse is the `userId` field — the tracer on tenant machines sets it to the tenant `team_id` (see `docs/tracing.md`). Observations without a `userId` are skipped (nothing to page on).

### Tuning the thresholds

Thresholds are constants at the top of `lib/langfuse-alerts.ts`:

```ts
const WINDOW_MIN = 5;          // error scan window
const COST_WINDOW_MIN = 60;    // cost scan window
const COST_WARNING_USD = 5;    // warning at $5/h per tenant
const COST_CRITICAL_USD = 20;  // critical at $20/h per tenant
```

Edit and redeploy. The separate-dedupe-key-per-severity design means a tenant crossing warning then critical still pages once for each level (not silently at the warning).

### Triggering a one-shot run

```sh
# Default thresholds from the source
curl -X POST https://army-control-plane.stepandel.workers.dev/admin/langfuse-alerts/run \
  -H 'cf-access-client-id: ...' -H 'cf-access-client-secret: ...' \
  -H 'content-type: application/json' \
  -d '{}'
# → {"errorTenants":0,"costBreaches":0,"alertsFired":0}

# Force a cost alert by lowering the threshold (smoke test)
curl -X POST https://army-control-plane.stepandel.workers.dev/admin/langfuse-alerts/run \
  -H 'cf-access-client-id: ...' -H 'cf-access-client-secret: ...' \
  -H 'content-type: application/json' \
  -d '{"costWarningUsd": 0.001, "costCriticalUsd": 100}'
```

### Smoke-test procedure

1. **No errors / no cost** — call the one-shot admin endpoint with default thresholds on a healthy fleet. Response should be all zeros; no Slack messages. One summary log line: `langfuse check: 0 error tenants, 0 cost breaches, 0 alerts fired`.
2. **Errors present** — in a non-prod tenant, force a failing tool execution (e.g. set an invalid Linear token via `UPDATE integration_tokens SET access_token = 'bad' WHERE tenant_id = '<test>' AND platform = 'linear'`). Trigger an agent run; the next agent action will emit ERROR observations. Within 1 cron cycle (≤5 min), one `langfuse_errors` alert fires with the tenant ID and up to 3 sample status messages.
3. **Cost threshold** — call the admin endpoint with a low `costWarningUsd` override (e.g. `0.001`) against a tenant with any recent Langfuse activity. The `langfuse_cost` alert fires at severity `warning`.
4. **Dedupe** — call the admin endpoint twice in a row with the same thresholds. The second call logs `alert suppressed (dedupe)` and no duplicate Slack message arrives.
5. **Langfuse API down** — if the Langfuse HTTP API returns 5xx or the fetch errors out, the poller logs the failure and returns a summary with `skippedReason` set. It does **not** fire any alert on its own — infra outages get caught by the Fly health-check job instead.

## Grafana Cloud — dashboards & Fly Prometheus alerts

Fly scrapes every tenant machine's `/metrics` on port 3000 automatically (we wire `metrics: { port: 3000, path: "/metrics" }` in `FlyClient.createMachine`) and stores the data in its managed Prometheus (VictoriaMetrics under the hood). Grafana Cloud queries that Prometheus on demand — there's no `remote_read` so Grafana can't continuously sync the metrics into its own TSDB, but that's fine for dashboards and 5-min-evaluation alert rules.

The visualization + threshold-alert layer lives under `workers/control-plane/grafana/` (see that folder's README for the exact file list).

### Alert rule inventory

| Rule | Severity | Expression | For | File |
|------|----------|------------|-----|------|
| OOM pressure | critical | `fly_instance_memory_mem_available_percent{app=~"army-t.*"} < 10` | 5m | `grafana/alerts/oom-pressure.yaml` |
| Memory spike | warning | `fly_instance_memory_mem_used_percent{app=~"army-t.*"} > 90` | 10m | `grafana/alerts/memory-spike.yaml` |
| Volume nearing cap | warning | `fly_volume_used_percent{app=~"army-t.*"} > 85` | 10m | `grafana/alerts/volume-nearing-cap.yaml` |

All three label the alert `severity: {critical,warning}` and `source: fly-prometheus`. A single Grafana contact point routes any alert with these labels to the same Slack incoming webhook that `lib/alerts.ts` uses (from ARM-112), so every ops signal lands in one channel.

### Fly Prometheus query API — key facts

- Endpoint: `https://api.fly.io/prometheus/vera-ai/api/v1/query` (org slug is `FLY_ORG` from `wrangler.toml` — `vera-ai`)
- Auth: `Authorization: Bearer <token>` where `<token>` is a **read-only** Fly access token. Create with `flyctl tokens create readonly --org vera-ai --expiry 8760h`. **Do not** reuse `FLY_API_TOKEN_VERA` — that token can create / destroy machines and should never live inside a dashboard data source.
- Supports all standard Prometheus HTTP query endpoints except `/api/v1/read` (no `remote_read`).
- Per-tenant label is `app` — every tenant gets their own Fly app whose name follows the pattern `army-t<teamId>-<rand>`, so `{app=~"army-t.*"}` scopes any query to tenant apps and excludes the control plane / builder apps.

### Setup — first-time install (human operator, one-time)

1. **Create a Grafana Cloud account** at <https://grafana.com/auth/sign-up/create-user>. The free tier (10k series, 14 days retention) handles our load at current tenant counts. Stack name: `vera`.
2. **Create a read-only Fly access token:**
   ```sh
   flyctl tokens create readonly --org vera-ai --expiry 8760h
   ```
   Copy the output. This is the only place it's ever shown.
3. **Add the Prometheus data source in Grafana:**
   - Navigate: Grafana → Connections → Data sources → Add new data source → Prometheus.
   - **Name:** `Fly Prometheus`
   - **UID:** `fly-prometheus` ← must match exactly; committed dashboards and alert rules reference this UID.
   - **URL:** `https://api.fly.io/prometheus/vera-ai`
   - **Authentication:** No authentication.
   - **Custom HTTP Headers:** add one header `Authorization` with value `Bearer <your-read-only-token>`.
   - Click *Save & test*. You should see "Successfully queried the Prometheus API."
4. **Import the dashboards:**
   - For each of `fleet-overview.json`, `tenant-detail.json`, `deployments.json`:
     - Grafana → Dashboards → New → Import → Upload JSON file.
     - When prompted for the data source, pick "Fly Prometheus" (UID `fly-prometheus`).
     - Click *Import*.
   - All three dashboards should render live data within seconds. If panels show "No data", double-check the data source UID.
5. **Create the Slack contact point:**
   - Grafana → Alerting → Contact points → Add contact point.
   - **Name:** `slack-ops-alerts`
   - **Type:** Slack (or "Webhook" if you'd rather re-use the exact same URL from ARM-112 with no Slack-specific formatting).
   - **URL:** the same `ALERT_SLACK_WEBHOOK_URL` you set via `wrangler secret put` in ARM-112. This is the only way to guarantee all alerts land in one channel.
   - Save, then click "Test" — a sample message should arrive in Slack.
6. **Import the alert rules:**
   - For each `grafana/alerts/*.yaml`, import via *Alerting → Alert rules → New alert rule → Import YAML* (or use `grafana-cli admin import` if you have CLI access).
   - After import, open each rule and set its **notification policy** to route the `source=fly-prometheus` label to the `slack-ops-alerts` contact point you just created. (Alternatively, add a global notification policy that matches `source=fly-prometheus` at the top level.)
   - The rules should evaluate every 1 min and show "Normal" state initially.

### Smoke-test procedure

1. **Dashboard load** — open `Army — Fleet Overview`. Panels should populate within ~10s of the default 1m refresh. If every panel is empty, the data source UID is wrong or the Fly token has expired.
2. **Per-tenant drilldown** — open `Army — Tenant Detail`. Use the `$app` variable dropdown at the top to pick any tenant's app. All panels should re-render scoped to that app.
3. **Slack contact point** — in Grafana Alerting → Contact points, click "Test" on `slack-ops-alerts`. A Grafana test message should appear in the same Slack channel as `POST /admin/alerts/test` from ARM-112.
4. **Trip an alert intentionally** — temporarily edit the OOM rule's threshold from `< 10` to `< 99`, save, wait 5 min. You should see:
   - The rule's state transition to Firing in Grafana → Alerting → Alert rules
   - A Slack message arriving in the ops channel with the color/severity from the rule labels
   - Revert the threshold to `< 10` and wait for the rule to return to Normal.
5. **Same for the volume rule** — set `> 85` to `> 0.1`, wait, observe, revert.

## Silencing an alert

There's no UI silencing today. Two options:

1. **Pick a longer dedupe TTL** at the call site for known-noisy conditions (edit the source).
2. **Mute the Slack channel** during planned maintenance.

Per-alert acknowledgment / snooze is on the roadmap if alert volume warrants it.

## Extending the alert sink

To add another destination (PagerDuty, email, OpsGenie):

1. Add a new `postToPagerDuty(...)` function alongside the Slack POST in `lib/alerts.ts`.
2. Branch on `severity` (or a new `routes` option) inside `sendAlert` to dispatch.
3. Add the new secret to `ControlPlaneEnv` in `packages/shared/src/types.ts`.
4. Update this doc.

The public `sendAlert` signature is intentionally narrow so callers don't change.
