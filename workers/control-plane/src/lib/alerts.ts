/**
 * Ops alert sink — Slack incoming webhook + KV-backed dedupe.
 *
 * Single entry point: `sendAlert(env, opts)`. Every caller in the control plane
 * (health checks, Langfuse polling, ad-hoc admin endpoints) funnels through this
 * helper so we have one channel, one severity convention, and one dedupe state.
 *
 * Design rules:
 * - **Fail-open.** Infra failures (KV down, Slack 5xx, missing webhook) must
 *   never throw out of `sendAlert` and never block the caller. The worst-case
 *   outcome is "alert is lost", logged loudly to Worker logs — never "the cron
 *   that detected the problem also crashed because of the alerter."
 * - **Dedupe is opportunistic.** If a `dedupeKey` is provided we suppress
 *   repeats within the TTL window. If KV read fails, we send anyway (better a
 *   duplicate alert than a silent one).
 * - **Severity → color** maps to Slack attachment colors so the channel is
 *   skimmable at a glance: critical=red, warning=yellow, info=gray.
 *
 * Extending later (PagerDuty, email, etc.):
 * - Add another sink function below and dispatch from `sendAlert` based on
 *   severity or env config. Keep the public signature stable so callers don't
 *   change.
 */

import type { ControlPlaneEnv } from "@army/shared";

export type AlertSeverity = "info" | "warning" | "critical";

export interface SendAlertOptions {
  severity: AlertSeverity;
  /** Short headline shown as the Slack message title. */
  title: string;
  /** Free-form body. Markdown-ish — Slack mrkdwn renders `*bold*`, `_italic_`, `<url|label>`. */
  body: string;
  /**
   * Optional dedupe key. If set, the same key fired again within `dedupeTtlSec`
   * is suppressed (one log line, no Slack message). Pick a key that uniquely
   * identifies the *condition* — e.g. `machine_down:<tenant_id>`, not the
   * timestamp.
   */
  dedupeKey?: string;
  /** Dedupe window in seconds. Default: 1 hour. */
  dedupeTtlSec?: number;
}

/** Default dedupe TTL — one hour. Long enough to avoid spam, short enough that
 * a problem persisting across restarts re-pages. */
const DEFAULT_DEDUPE_TTL_SEC = 3600;

/** Slack attachment colors per severity. */
const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  info: "#9aa0a6", // gray
  warning: "#f5a623", // yellow
  critical: "#d93025", // red
};

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: ":information_source:",
  warning: ":warning:",
  critical: ":rotating_light:",
};

/**
 * Fire an ops alert to Slack with KV-backed dedupe.
 *
 * Never throws. Returns a small status object useful for tests / admin endpoints.
 */
export async function sendAlert(
  env: ControlPlaneEnv,
  opts: SendAlertOptions,
): Promise<{ delivered: boolean; suppressed: boolean; reason?: string }> {
  const { severity, title, body, dedupeKey } = opts;
  const dedupeTtlSec = opts.dedupeTtlSec ?? DEFAULT_DEDUPE_TTL_SEC;

  // ── 1. Dedupe check (fail-open) ──────────────────────────────
  // ALERT_STATE may be unbound (see wrangler.toml). Without it, dedupe is
  // disabled and every call through proceeds — safer than silently dropping.
  if (dedupeKey && env.ALERT_STATE) {
    try {
      const seen = await env.ALERT_STATE.get(`dedupe:${dedupeKey}`);
      if (seen) {
        // Don't lose the signal — record the suppression in Worker logs so
        // operators can still see "alert X fired Y times today" via log search.
        console.log(
          `alert suppressed (dedupe): severity=${severity} key=${dedupeKey} title=${JSON.stringify(title)}`,
        );
        return { delivered: false, suppressed: true, reason: "dedupe" };
      }
    } catch (err) {
      // KV read errored — fail open and send the alert anyway.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`ALERT_STATE.get failed (dedupe key=${dedupeKey}), sending anyway: ${msg}`);
    }
  }

  // ── 2. Webhook config check (fail-open with a warn) ─────────
  const webhook = env.ALERT_SLACK_WEBHOOK_URL;
  if (!webhook) {
    console.warn(
      `ALERT_SLACK_WEBHOOK_URL not configured — alert dropped: severity=${severity} title=${JSON.stringify(title)}`,
    );
    return { delivered: false, suppressed: false, reason: "no_webhook" };
  }

  // ── 3. Build the Slack payload ───────────────────────────────
  // Use `attachments` (legacy) for the colored sidebar — Slack still supports
  // it and it's the simplest way to color-code by severity. Inside the
  // attachment, use Block Kit so we can future-proof formatting.
  const payload = {
    text: `${SEVERITY_EMOJI[severity]} *${title}*`, // fallback for notifications
    attachments: [
      {
        color: SEVERITY_COLOR[severity],
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `${SEVERITY_EMOJI[severity]} ${title}`.slice(0, 150),
              emoji: true,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: body.slice(0, 2900), // Slack's per-block text limit is 3000
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `severity: \`${severity}\` · source: \`army-control-plane\``,
              },
            ],
          },
        ],
      },
    ],
  };

  // ── 4. POST to Slack (fail-open on errors) ──────────────────
  try {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "<no body>");
      console.error(
        `Slack webhook returned ${resp.status}: ${text} — alert title=${JSON.stringify(title)}`,
      );
      return { delivered: false, suppressed: false, reason: `slack_${resp.status}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Slack webhook fetch failed: ${msg} — alert title=${JSON.stringify(title)}`);
    return { delivered: false, suppressed: false, reason: "slack_fetch_failed" };
  }

  // ── 5. Persist dedupe key (fail-open) ───────────────────────
  if (dedupeKey && env.ALERT_STATE) {
    try {
      await env.ALERT_STATE.put(`dedupe:${dedupeKey}`, "1", {
        expirationTtl: dedupeTtlSec,
      });
    } catch (err) {
      // We've already delivered the alert; logging is enough.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`ALERT_STATE.put failed (dedupe key=${dedupeKey}): ${msg}`);
    }
  }

  return { delivered: true, suppressed: false };
}
