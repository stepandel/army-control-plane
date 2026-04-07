/**
 * Langfuse polling worker — LLM-layer error and cost alerts.
 *
 * Fly-level metrics from ARM-113/114 catch infrastructure problems (machine
 * down, OOM, volume full). They can't see LLM-layer failures — tool calls
 * throwing, models refusing, cost runaway, stuck agent sessions. Those live in
 * Langfuse's observation store, which we poll here.
 *
 * We poll rather than use webhooks because Langfuse webhooks today only fire
 * on prompt-version events, not trace/error-level events. See:
 * - https://github.com/orgs/langfuse/discussions/10147
 * - https://github.com/orgs/langfuse/discussions/3997
 * Trace-level webhooks are on Langfuse's roadmap; when they ship, replace this
 * polling loop with a webhook receiver and keep `sendAlert()` as-is.
 *
 * Runs every 5 min from the `scheduled` handler in `src/index.ts`, dispatched
 * by the 5-minute cron. Shares the trigger with `runHealthChecks` — the
 * handler invokes both jobs on each tick.
 *
 * The tenant discriminator inside Langfuse is `userId`: the tracer on tenant
 * machines sets it to the tenant `team_id` (confirmed in `docs/tracing.md`).
 */

import type { ControlPlaneEnv } from "@army/shared";
import { sendAlert } from "./alerts";

// ── Tunables ─────────────────────────────────────────────────────
//
// Edit these to tighten/loosen the alert thresholds. Defaults picked to cover
// the 80/20 of incidents without paging operators for normal usage spikes.

/** Rolling window for ERROR-observation scans. Matches the cron cadence. */
const WINDOW_MIN = 5;

/** Rolling window for cost-breach scans. Longer window = slower reaction but
 * fewer false positives from a single burst of calls. */
const COST_WINDOW_MIN = 60;

/** Warning threshold: totalCost > this (USD) per tenant in the 1h window. */
const COST_WARNING_USD = 5;

/** Critical threshold: totalCost > this (USD) per tenant in the 1h window. */
const COST_CRITICAL_USD = 20;

/** Langfuse observations endpoint page size. */
const OBSERVATIONS_LIMIT = 1000;

/** Default dedupe TTL for Langfuse alerts — same as lib/alerts.ts default. */
const ALERT_DEDUPE_TTL_SEC = 3600;

/** How many sample error messages to include in the alert body (for triage). */
const ERROR_SAMPLE_COUNT = 3;

// ── Langfuse response shapes ─────────────────────────────────────
//
// We intentionally type only the fields we read. Langfuse's API occasionally
// adds fields but never removes the core ones, so this is forward-compatible.

interface LangfuseObservation {
  id?: string;
  traceId?: string;
  name?: string;
  level?: string;
  statusMessage?: string | null;
  userId?: string | null;
  startTime?: string;
}

interface LangfuseObservationsResponse {
  data?: LangfuseObservation[];
  meta?: { totalItems?: number; totalPages?: number; page?: number; limit?: number };
}

/** Metrics API v1 response — `data` is an array of objects keyed by the
 *  dimensions + metrics you requested. We request `userId` + `sum_totalCost`
 *  so every row has both. */
interface LangfuseMetricsRow {
  userId?: string | null;
  /** `sum_totalCost` is the default name for sum(measure=totalCost) in
   *  Langfuse's metrics API response. */
  sum_totalCost?: number | null;
}

interface LangfuseMetricsResponse {
  data?: LangfuseMetricsRow[];
}

// ── Public entry point ──────────────────────────────────────────

export interface LangfuseAlertCheckOptions {
  /** Override the cost-warning threshold (USD) — used by the admin one-shot. */
  costWarningUsd?: number;
  /** Override the cost-critical threshold (USD) — used by the admin one-shot. */
  costCriticalUsd?: number;
}

export interface LangfuseAlertCheckSummary {
  errorTenants: number;
  costBreaches: number;
  alertsFired: number;
  skippedReason?: string;
}

/**
 * Poll Langfuse for ERROR observations and cost breaches, then fire deduped
 * alerts through `lib/alerts.ts`. Never throws — on Langfuse outage we log,
 * skip, and return a summary with `skippedReason` set.
 */
export async function runLangfuseAlertChecks(
  env: ControlPlaneEnv,
  opts: LangfuseAlertCheckOptions = {},
): Promise<LangfuseAlertCheckSummary> {
  const summary: LangfuseAlertCheckSummary = { errorTenants: 0, costBreaches: 0, alertsFired: 0 };

  // Basic config guard — if Langfuse creds are missing, no-op loudly.
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY || !env.LANGFUSE_BASE_URL) {
    console.warn(
      "langfuse-alerts: LANGFUSE_{PUBLIC_KEY,SECRET_KEY,BASE_URL} not all set — skipping run",
    );
    return { ...summary, skippedReason: "langfuse_not_configured" };
  }

  const authHeader = buildBasicAuth(env.LANGFUSE_PUBLIC_KEY, env.LANGFUSE_SECRET_KEY);
  const baseUrl = env.LANGFUSE_BASE_URL.replace(/\/+$/, ""); // strip trailing slash

  // ── 1. ERROR observations in the last WINDOW_MIN ─────────────
  try {
    const fromStartTime = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();
    const observations = await fetchErrorObservations(baseUrl, authHeader, fromStartTime);

    // Group by userId (= tenant team_id). A single tenant with many errors
    // should still only emit one alert per dedupe window.
    const byTenant = new Map<string, LangfuseObservation[]>();
    for (const obs of observations) {
      const tenantId = obs.userId ?? undefined;
      if (!tenantId) continue; // ignore unattributed errors — nothing to page on
      const list = byTenant.get(tenantId) ?? [];
      list.push(obs);
      byTenant.set(tenantId, list);
    }

    summary.errorTenants = byTenant.size;

    for (const [tenantId, errors] of byTenant) {
      try {
        const samples = errors
          .slice(0, ERROR_SAMPLE_COUNT)
          .map(
            (e) => `• \`${e.name ?? "?"}\`: ${(e.statusMessage ?? "(no message)").slice(0, 200)}`,
          )
          .join("\n");
        const result = await sendAlert(env, {
          severity: "warning",
          title: `Langfuse errors on tenant ${tenantId}`,
          body:
            `Langfuse recorded *${errors.length}* ERROR-level observation(s) for tenant ` +
            `\`${tenantId}\` in the last ${WINDOW_MIN} min.\n\n` +
            `Top ${Math.min(ERROR_SAMPLE_COUNT, errors.length)} error(s):\n${samples || "(none captured)"}\n\n` +
            `Inspect in Langfuse: ${baseUrl}/project — filter by userId = \`${tenantId}\`.`,
          dedupeKey: `langfuse_errors:${tenantId}`,
          dedupeTtlSec: ALERT_DEDUPE_TTL_SEC,
        });
        if (result.delivered) summary.alertsFired += 1;
      } catch (err) {
        console.error(
          `langfuse-alerts: failed to fire error alert for ${tenantId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    // Langfuse down / network hiccup — log and continue. Fly infra alerts
    // from ARM-113 / ARM-114 would catch a total outage; flaky Langfuse
    // shouldn't page us.
    console.error(
      "langfuse-alerts: error observations query failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // ── 2. Cost breaches in the last COST_WINDOW_MIN ────────────
  try {
    const fromTimestamp = new Date(Date.now() - COST_WINDOW_MIN * 60_000).toISOString();
    const toTimestamp = new Date().toISOString();
    const rows = await fetchCostByTenant(baseUrl, authHeader, fromTimestamp, toTimestamp);

    const warnThreshold = opts.costWarningUsd ?? COST_WARNING_USD;
    const critThreshold = opts.costCriticalUsd ?? COST_CRITICAL_USD;

    for (const row of rows) {
      const tenantId = row.userId;
      const cost = row.sum_totalCost;
      if (!tenantId || typeof cost !== "number" || !Number.isFinite(cost)) continue;
      if (cost <= warnThreshold) continue;

      const severity = cost > critThreshold ? "critical" : "warning";
      summary.costBreaches += 1;

      try {
        const result = await sendAlert(env, {
          severity,
          title: `Langfuse cost breach on tenant ${tenantId}`,
          body:
            `Tenant \`${tenantId}\` has burned *$${cost.toFixed(2)}* in LLM cost over the last ` +
            `${COST_WINDOW_MIN} min — crossing the ${severity} threshold of ` +
            `*$${severity === "critical" ? critThreshold : warnThreshold}/h*.\n\n` +
            `Inspect in Langfuse: ${baseUrl}/project — filter by userId = \`${tenantId}\`.\n` +
            `If this is runaway behavior, suspend the tenant via ` +
            `\`DELETE /admin/tenants/${tenantId}\` or rate-limit their agent.`,
          // Include severity in the dedupe key so a warning→critical escalation
          // still pages once for each level, not silently at the warning.
          dedupeKey: `langfuse_cost:${tenantId}:${severity}`,
          dedupeTtlSec: ALERT_DEDUPE_TTL_SEC,
        });
        if (result.delivered) summary.alertsFired += 1;
      } catch (err) {
        console.error(
          `langfuse-alerts: failed to fire cost alert for ${tenantId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    console.error(
      "langfuse-alerts: cost metrics query failed:",
      err instanceof Error ? err.message : err,
    );
  }

  console.log(
    `langfuse check: ${summary.errorTenants} error tenants, ${summary.costBreaches} cost breaches, ${summary.alertsFired} alerts fired`,
  );
  return summary;
}

// ── Helpers ─────────────────────────────────────────────────────

/** Build an HTTP Basic auth header for Langfuse's public API. */
function buildBasicAuth(publicKey: string, secretKey: string): string {
  return `Basic ${btoa(`${publicKey}:${secretKey}`)}`;
}

/**
 * GET /api/public/v2/observations?level=ERROR&fromStartTime=<iso>&limit=1000.
 * We only need one page — if we're seeing >1000 errors in a 5-min window,
 * something is catastrophically wrong and one paged alert is plenty.
 */
async function fetchErrorObservations(
  baseUrl: string,
  authHeader: string,
  fromStartTime: string,
): Promise<LangfuseObservation[]> {
  const url = new URL(`${baseUrl}/api/public/v2/observations`);
  url.searchParams.set("level", "ERROR");
  url.searchParams.set("fromStartTime", fromStartTime);
  url.searchParams.set("limit", String(OBSERVATIONS_LIMIT));

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: authHeader, Accept: "application/json" },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Langfuse observations API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const body = (await resp.json()) as LangfuseObservationsResponse;
  return body.data ?? [];
}

/**
 * GET /api/public/metrics?query=... where the query JSON requests
 * `sum(totalCost)` grouped by `userId`, view=observations.
 */
async function fetchCostByTenant(
  baseUrl: string,
  authHeader: string,
  fromTimestamp: string,
  toTimestamp: string,
): Promise<LangfuseMetricsRow[]> {
  const query = {
    view: "observations",
    dimensions: [{ field: "userId" }],
    metrics: [{ measure: "totalCost", aggregation: "sum" }],
    fromTimestamp,
    toTimestamp,
  };

  const url = new URL(`${baseUrl}/api/public/metrics`);
  url.searchParams.set("query", JSON.stringify(query));

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: authHeader, Accept: "application/json" },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Langfuse metrics API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const body = (await resp.json()) as LangfuseMetricsResponse;
  return body.data ?? [];
}
