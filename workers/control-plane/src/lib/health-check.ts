/**
 * Tenant fleet health-check cron — runs every 5 minutes.
 *
 * For each active tenant:
 * 1. Fetch the machine from Fly's Machines API. Alert on:
 *    - **Machine unreachable** — state ≠ "started" for ≥2 consecutive checks
 *    - **Crash loop** — ≥3 `start` or `exit` events within the last 15 min
 * 2. Check `integration_tokens` for expired Linear tokens on still-active
 *    tenants. Alert on:
 *    - **Token refresh failed** — token expired but tenant is still active
 *      (symptom of a silently failing `refreshExpiringTokens` cron)
 *
 * All alerts go through `lib/alerts.ts` with dedupe keys so a persistent
 * condition only pages once per hour.
 *
 * Pattern mirrors `lib/token-refresh.ts`: per-tenant try/catch inside a loop,
 * never throw out — a single broken tenant must not take down the whole run.
 *
 * State kept in KV (namespace `ALERT_STATE`):
 *   `fly_state:<tenant_id>` — small int counter, "consecutive bad checks",
 *                              TTL 1 day. Reset on first healthy check.
 */

import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient, type MachineResponse, type FlyMachineEvent } from "./fly";
import { sendAlert } from "./alerts";

/** Alert if machine is non-"started" for this many consecutive checks. */
const UNREACHABLE_CONSECUTIVE_CHECKS = 2;

/** Sliding window for crash-loop detection. */
const CRASH_LOOP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** Minimum lifecycle events in the window to count as a crash loop. */
const CRASH_LOOP_EVENT_THRESHOLD = 3;

/** Fly event types that count as "machine restarted from a stopped state". */
const CRASH_LOOP_EVENT_TYPES = new Set(["start", "restart", "exit"]);

/** TTL for the consecutive-bad-checks counter. Long enough to survive a cron
 * outage, short enough to reset if the machine is manually fixed. */
const BAD_STATE_COUNTER_TTL_SEC = 24 * 60 * 60;

/** Default dedupe TTL for health-check alerts. */
const ALERT_DEDUPE_TTL_SEC = 3600;

interface HealthCheckSummary {
  tenantsChecked: number;
  alertsFired: number;
  errorsSkipped: number;
}

/**
 * Main entry point — called from the `scheduled` handler in `index.ts`.
 * Never throws; logs a summary line at the end so the cron output is greppable.
 */
export async function runHealthChecks(env: ControlPlaneEnv): Promise<HealthCheckSummary> {
  const sql = getDb(env);
  const summary: HealthCheckSummary = { tenantsChecked: 0, alertsFired: 0, errorsSkipped: 0 };

  try {
    // ── 1. Fly machine health ────────────────────────────────────────
    const tenants = await sql<
      {
        id: string;
        fly_app_name: string;
        fly_machine_id: string;
      }[]
    >`
      SELECT id, fly_app_name, fly_machine_id
      FROM tenants
      WHERE status = 'active'
        AND fly_app_name IS NOT NULL
        AND fly_machine_id IS NOT NULL
    `;

    summary.tenantsChecked = tenants.length;

    for (const tenant of tenants) {
      try {
        const fly = new FlyClient(env.FLY_API_TOKEN_VERA, tenant.fly_app_name);
        const machine = await fly.getMachine(tenant.fly_machine_id);

        const machineAlerts = await checkMachineHealth(env, tenant.id, machine);
        summary.alertsFired += machineAlerts;
      } catch (err) {
        summary.errorsSkipped += 1;
        console.error(
          `health-check: failed to check tenant ${tenant.id} (app=${tenant.fly_app_name}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // ── 2. Linear token refresh failures (symptom-based) ─────────────
    try {
      const expired = await sql<{ tenant_id: string; expires_at: string }[]>`
        SELECT it.tenant_id, it.expires_at
        FROM integration_tokens it
        JOIN tenants t ON t.id = it.tenant_id
        WHERE t.status = 'active'
          AND it.platform = 'linear'
          AND it.expires_at IS NOT NULL
          AND it.expires_at < now()
      `;

      for (const { tenant_id, expires_at } of expired) {
        try {
          const expiredFor = formatDurationSince(new Date(expires_at));
          const result = await sendAlert(env, {
            severity: "critical",
            title: `Linear token refresh failing for tenant ${tenant_id}`,
            body:
              `Tenant is still \`active\` but its Linear token expired *${expiredFor}* ago ` +
              `(\`expires_at=${expires_at}\`).\n\n` +
              `This means the \`refreshExpiringTokens\` cron silently failed — ` +
              `either the refresh token was revoked, or Linear returned a non-\`invalid_grant\` error. ` +
              `Manually inspect \`integration_tokens\` for \`tenant_id='${tenant_id}'\` and ` +
              `run \`POST /admin/tenants/${tenant_id}/refresh-token\` to retry.`,
            dedupeKey: `token_refresh_failed:${tenant_id}`,
            dedupeTtlSec: ALERT_DEDUPE_TTL_SEC,
          });
          if (result.delivered) summary.alertsFired += 1;
        } catch (err) {
          summary.errorsSkipped += 1;
          console.error(
            `health-check: failed to raise token-refresh alert for ${tenant_id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      // Don't let a DB hiccup in this section break the overall summary.
      summary.errorsSkipped += 1;
      console.error(
        "health-check: token-refresh query failed:",
        err instanceof Error ? err.message : err,
      );
    }
  } finally {
    await sql.end();
  }

  console.log(
    `health check: ${summary.tenantsChecked} tenants, ${summary.alertsFired} alerts, ${summary.errorsSkipped} errors`,
  );
  return summary;
}

/**
 * Per-tenant machine check. Returns the number of alerts fired (0–2).
 * Consumes / updates `fly_state:<tenant_id>` counter in KV for the
 * consecutive-bad-checks heuristic.
 */
async function checkMachineHealth(
  env: ControlPlaneEnv,
  tenantId: string,
  machine: MachineResponse,
): Promise<number> {
  let alerts = 0;
  const badStateKey = `fly_state:${tenantId}`;

  // ── Unreachable detection ──────────────────────────────────────
  if (machine.state !== "started") {
    // Without ALERT_STATE we can't count consecutive checks, so fall back to
    // "alert immediately on any bad state" — noisier but visible. Once the KV
    // namespace is provisioned (see workers/control-plane/wrangler.toml), the
    // proper N-consecutive-check gating kicks back in automatically.
    let current: number;
    if (env.ALERT_STATE) {
      const prev = parseInt((await env.ALERT_STATE.get(badStateKey)) ?? "0", 10);
      current = Number.isFinite(prev) ? prev + 1 : 1;
      try {
        await env.ALERT_STATE.put(badStateKey, String(current), {
          expirationTtl: BAD_STATE_COUNTER_TTL_SEC,
        });
      } catch (err) {
        console.warn(`health-check: ALERT_STATE.put failed for ${badStateKey}:`, err);
      }
    } else {
      current = UNREACHABLE_CONSECUTIVE_CHECKS;
    }

    if (current >= UNREACHABLE_CONSECUTIVE_CHECKS) {
      const result = await sendAlert(env, {
        severity: "critical",
        title: `Tenant machine unreachable: ${tenantId}`,
        body:
          `Machine \`${machine.id}\` (region \`${machine.region}\`) has been in state ` +
          `\`${machine.state}\` for ${current} consecutive checks.\n\n` +
          `App: \`${machine.name}\`\n` +
          `Last healthy state expected: \`started\`.\n\n` +
          `Run \`POST /admin/tenants/${tenantId}/reprovision\` to recreate, or inspect the ` +
          `machine in the Fly dashboard.`,
        dedupeKey: `machine_down:${tenantId}`,
        dedupeTtlSec: ALERT_DEDUPE_TTL_SEC,
      });
      if (result.delivered) alerts += 1;
    }
  } else if (env.ALERT_STATE) {
    // Healthy — clear the counter if any. Check presence first so we don't
    // burn a KV delete op (strictly rate-limited on the daily quota) on every
    // healthy tenant every 5 minutes.
    try {
      const existing = await env.ALERT_STATE.get(badStateKey);
      if (existing !== null) {
        await env.ALERT_STATE.delete(badStateKey);
      }
    } catch (err) {
      console.warn(`health-check: ALERT_STATE clear failed for ${badStateKey}:`, err);
    }
  }

  // ── Crash-loop detection ───────────────────────────────────────
  const events = machine.events ?? [];
  if (events.length > 0) {
    const cutoff = Date.now() - CRASH_LOOP_WINDOW_MS;
    const recentRestarts = events.filter(
      (ev: FlyMachineEvent) =>
        CRASH_LOOP_EVENT_TYPES.has(ev.type) &&
        typeof ev.timestamp === "number" &&
        ev.timestamp >= cutoff,
    );

    if (recentRestarts.length >= CRASH_LOOP_EVENT_THRESHOLD) {
      const byType = summarizeEventTypes(recentRestarts);
      const result = await sendAlert(env, {
        severity: "critical",
        title: `Tenant machine crash loop: ${tenantId}`,
        body:
          `Machine \`${machine.id}\` has fired *${recentRestarts.length}* lifecycle events ` +
          `in the last ${CRASH_LOOP_WINDOW_MS / 60000} min: ${byType}.\n\n` +
          `App: \`${machine.name}\`\n` +
          `Current state: \`${machine.state}\`.\n\n` +
          `Check tenant logs (\`fly logs -a ${machine.name}\`) and the most recent deploy.`,
        dedupeKey: `crash_loop:${tenantId}`,
        dedupeTtlSec: ALERT_DEDUPE_TTL_SEC,
      });
      if (result.delivered) alerts += 1;
    }
  }

  return alerts;
}

/** Build a compact summary like `start=2, exit=1` for alert bodies. */
function summarizeEventTypes(events: FlyMachineEvent[]): string {
  const counts = new Map<string, number>();
  for (const ev of events) {
    counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([t, n]) => `${t}=${n}`)
    .join(", ");
}

/** Render a duration like `3h 12m` given a past date. */
function formatDurationSince(past: Date): string {
  const ms = Math.max(0, Date.now() - past.getTime());
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours}h ${remMins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}
