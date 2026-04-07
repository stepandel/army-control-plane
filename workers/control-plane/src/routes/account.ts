import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { sessionGuard } from "../middleware/session";
import { createCheckoutSession, createBillingPortalSession } from "../lib/stripe";
import { syncBillingToKv } from "../lib/billing-sync";
import { reactivateTenant } from "../lib/tenant-reactivate";
import { getYearlyPlanEnabled } from "../lib/feature-flags";
import type { SessionPayload } from "../lib/jwt";

const account = new Hono<{
  Bindings: ControlPlaneEnv;
  Variables: { session: SessionPayload };
}>();

// All routes require a valid session cookie
account.use("/*", sessionGuard);

// ── Tenant info ──────────────────────────────────────────────────

/** GET /tenant — return tenant info + integration status (session-derived) */
account.get("/tenant", async (c) => {
  const { team_id: teamId } = c.get("session");
  const sql = getDb(c.env);

  const [tenant] = await sql`
    SELECT id, name, status, anthropic_api_key, tracing_provider,
           subscription_status, trial_ends_at, cancel_at, current_period_end,
           plan_interval, plan_amount_cents
    FROM tenants WHERE id = ${teamId}
  `;
  if (!tenant) return c.json({ error: "not_found" }, 404);

  const tokens = await sql`
    SELECT platform FROM integration_tokens WHERE tenant_id = ${teamId}
  `;

  const now = new Date();
  const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
  const trialDaysRemaining = trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
    : 0;

  return c.json({
    tenant: {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      has_anthropic_key: !!tenant.anthropic_api_key,
      tracing_provider: tenant.tracing_provider,
      subscription_status: tenant.subscription_status,
      trial_ends_at: tenant.trial_ends_at,
      trial_days_remaining: trialDaysRemaining,
      cancel_at: tenant.cancel_at,
      current_period_end: tenant.current_period_end,
      plan_interval: tenant.plan_interval,
      plan_amount_cents: tenant.plan_amount_cents,
    },
    integrations: tokens.map((t) => (t as Record<string, string>).platform),
  });
});

// ── Billing ──────────────────────────────────────────────────────

/** GET /billing — return billing status for the signed-in tenant */
account.get("/billing", async (c) => {
  const { team_id: teamId } = c.get("session");
  const sql = getDb(c.env);

  const [tenant] = await sql`
    SELECT id, subscription_status, trial_ends_at, cancel_at, current_period_end,
           plan_interval, plan_amount_cents,
           stripe_customer_id, stripe_subscription_id
    FROM tenants WHERE id = ${teamId}
  `;
  if (!tenant) return c.json({ error: "not_found" }, 404);

  const now = new Date();
  const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
  const trialDaysRemaining = trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
    : 0;

  const yearlyPlanEnabled = await getYearlyPlanEnabled(sql);

  return c.json({
    subscription_status: tenant.subscription_status,
    trial_ends_at: tenant.trial_ends_at,
    trial_days_remaining: trialDaysRemaining,
    cancel_at: tenant.cancel_at,
    current_period_end: tenant.current_period_end,
    plan_interval: tenant.plan_interval,
    plan_amount_cents: tenant.plan_amount_cents,
    has_payment_method: !!tenant.stripe_subscription_id,
    yearly_plan_enabled: yearlyPlanEnabled,
  });
});

/** POST /checkout — create Stripe Checkout session */
account.post("/checkout", async (c) => {
  const { team_id: teamId } = c.get("session");
  const sql = getDb(c.env);

  // Body is optional; default to monthly when omitted or invalid.
  let plan: "monthly" | "yearly" = "monthly";
  try {
    const body = (await c.req.json()) as { plan?: unknown };
    if (body.plan === "yearly") plan = "yearly";
  } catch {
    /* empty body — keep default */
  }

  // Reject yearly when the feature flag is off (defense in depth — prevents
  // direct API calls from bypassing the toggle).
  if (plan === "yearly" && !(await getYearlyPlanEnabled(sql))) {
    return c.json({ error: "Yearly plan is not available" }, 400);
  }

  const [tenant] = await sql`
    SELECT id, stripe_customer_id, subscription_status, trial_ends_at
    FROM tenants WHERE id = ${teamId}
  `;
  if (!tenant) return c.json({ error: "not_found" }, 404);
  if (!tenant.stripe_customer_id) return c.json({ error: "No billing account — contact support" }, 400);
  if (tenant.subscription_status === "active") return c.json({ error: "Already subscribed" }, 400);

  const successUrl = `${c.env.WEBSITE_URL}/account/billing?billing=success`;
  const cancelUrl = `${c.env.WEBSITE_URL}/account/billing?billing=canceled`;
  const trialEnd = tenant.trial_ends_at
    ? Math.floor(new Date(tenant.trial_ends_at).getTime() / 1000)
    : undefined;
  const priceId =
    plan === "yearly" ? c.env.STRIPE_PRICE_ID_YEARLY : c.env.STRIPE_PRICE_ID_MONTHLY;

  const checkoutUrl = await createCheckoutSession(
    c.env.STRIPE_SECRET_KEY,
    tenant.stripe_customer_id,
    priceId,
    successUrl,
    cancelUrl,
    trialEnd,
  );

  return c.json({ url: checkoutUrl });
});

/** POST /billing/portal — create Stripe Billing Portal session */
account.post("/billing/portal", async (c) => {
  const { team_id: teamId } = c.get("session");
  const sql = getDb(c.env);

  const [tenant] = await sql`
    SELECT id, stripe_customer_id FROM tenants WHERE id = ${teamId}
  `;
  if (!tenant) return c.json({ error: "not_found" }, 404);
  if (!tenant.stripe_customer_id) return c.json({ error: "No billing account" }, 400);

  const returnUrl = `${c.env.WEBSITE_URL}/account/billing`;
  const portalUrl = await createBillingPortalSession(
    c.env.STRIPE_SECRET_KEY,
    tenant.stripe_customer_id,
    returnUrl,
  );

  return c.json({ url: portalUrl });
});

// ── Promo codes ──────────────────────────────────────────────────

/**
 * POST /promo-code — redeem a promo code against the signed-in tenant.
 *
 * Body: { code: string }
 *
 * Currently only supports `kind = 'extend_trial'`, which sets
 * `trial_ends_at = now() + extend_days` and flips the tenant back to
 * `subscription_status = 'trialing'`. Suspended tenants are reactivated
 * (Fly machine started) as a side effect.
 */
account.post("/promo-code", async (c) => {
  const { team_id: teamId } = c.get("session");

  let body: { code?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const rawCode = typeof body.code === "string" ? body.code.trim() : "";
  if (!rawCode) return c.json({ error: "Missing code" }, 400);
  const code = rawCode.toUpperCase();

  const sql = getDb(c.env);

  // 1. Look up the promo code
  const [promo] = await sql`
    SELECT code, kind, extend_days, valid_until, max_redemptions
    FROM promo_codes WHERE code = ${code}
  `;
  if (!promo) return c.json({ error: "Unknown code" }, 404);

  if (promo.valid_until && new Date(promo.valid_until) < new Date()) {
    return c.json({ error: "Code has expired" }, 400);
  }

  // 2. Check global redemption cap
  if (promo.max_redemptions !== null && promo.max_redemptions !== undefined) {
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM promo_redemptions WHERE code = ${code}
    `;
    if (count >= promo.max_redemptions) {
      return c.json({ error: "Code has reached its redemption limit" }, 400);
    }
  }

  // 3. Load tenant — refuse to downgrade an active paying customer to a trial
  const [tenant] = await sql`
    SELECT id, subscription_status, status, fly_app_name, fly_machine_id
    FROM tenants WHERE id = ${teamId}
  `;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);
  if (tenant.subscription_status === "active") {
    return c.json({ error: "Already on a paid plan" }, 400);
  }

  // 4. Insert the redemption ledger row first — the unique (tenant_id, code)
  //    index is the source of truth for "already redeemed" so concurrent
  //    double-redeems can't both succeed.
  try {
    await sql`
      INSERT INTO promo_redemptions (code, tenant_id) VALUES (${code}, ${teamId})
    `;
  } catch (err) {
    // 23505 = unique_violation
    if ((err as { code?: string })?.code === "23505") {
      return c.json({ error: "Code already redeemed" }, 400);
    }
    throw err;
  }

  // 5. Apply the effect. Only `extend_trial` is supported today.
  if (promo.kind !== "extend_trial") {
    return c.json({ error: "Unsupported code kind" }, 400);
  }

  // "Starting from the day it was entered" — count from now, NOT on top of
  // any remaining trial.
  const newTrialEndsAt = new Date(Date.now() + promo.extend_days * 24 * 60 * 60 * 1000);
  const newTrialEndsAtIso = newTrialEndsAt.toISOString();

  await sql`
    UPDATE tenants
    SET subscription_status = 'trialing',
        trial_ends_at       = ${newTrialEndsAtIso}::timestamptz,
        grace_deadline      = NULL,
        updated_at          = now()
    WHERE id = ${teamId}
  `;

  // 6. If suspended with a Fly machine, reactivate it (fire-and-forget so
  //    Fly latency doesn't block the response).
  if (
    tenant.status === "suspended" &&
    tenant.fly_app_name &&
    tenant.fly_machine_id
  ) {
    c.executionCtx.waitUntil(
      reactivateTenant(
        c.env,
        tenant.id,
        tenant.fly_app_name,
        tenant.fly_machine_id,
      ).catch((err) =>
        console.error(`Reactivation failed for ${tenant.id}:`, err),
      ),
    );
  }

  // 7. Update the router billing gate so the next webhook is immediately
  //    forwarded without waiting for a refresh.
  await syncBillingToKv(c.env, teamId, "trialing", newTrialEndsAtIso, null);

  return c.json({
    success: true,
    kind: promo.kind,
    extend_days: promo.extend_days,
    trial_ends_at: newTrialEndsAtIso,
  });
});

// ── Sign out ─────────────────────────────────────────────────────

/** POST /sign-out — clear the session cookie */
account.post("/sign-out", (c) => {
  c.header(
    "set-cookie",
    "__Host-session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
  );
  return c.json({ success: true });
});

export default account;
