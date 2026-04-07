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
