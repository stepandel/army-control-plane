import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { createCheckoutSession, createBillingPortalSession } from "../lib/stripe";

const billing = new Hono<{ Bindings: ControlPlaneEnv }>();

/** GET /:team_id/billing — return current subscription/trial status */
billing.get("/:team_id/billing", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`
    SELECT id, subscription_status, trial_ends_at, stripe_customer_id, stripe_subscription_id
    FROM tenants WHERE id = ${teamId}
  `;
  if (!tenant) return c.json({ error: "not_found" }, 404);

  const now = new Date();
  const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
  const trialDaysRemaining = trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
    : 0;

  return c.json({
    subscription_status: tenant.subscription_status,
    trial_ends_at: tenant.trial_ends_at,
    trial_days_remaining: trialDaysRemaining,
    has_payment_method: !!tenant.stripe_subscription_id,
  });
});

/** POST /:team_id/checkout — create Stripe Checkout session for $30/month plan */
billing.post("/:team_id/checkout", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`
    SELECT id, stripe_customer_id, subscription_status, trial_ends_at
    FROM tenants WHERE id = ${teamId}
  `;
  if (!tenant) return c.json({ error: "not_found" }, 404);
  if (!tenant.stripe_customer_id) return c.json({ error: "No billing account — contact support" }, 400);
  if (tenant.subscription_status === "active") return c.json({ error: "Already subscribed" }, 400);

  const successUrl = `${c.env.WEBSITE_URL}/onboarding/${teamId}?billing=success`;
  const cancelUrl = `${c.env.WEBSITE_URL}/onboarding/${teamId}?billing=canceled`;
  const trialEnd = tenant.trial_ends_at
    ? Math.floor(new Date(tenant.trial_ends_at).getTime() / 1000)
    : undefined;

  const checkoutUrl = await createCheckoutSession(
    c.env.STRIPE_SECRET_KEY,
    tenant.stripe_customer_id,
    c.env.STRIPE_PRICE_ID,
    successUrl,
    cancelUrl,
    trialEnd,
  );

  return c.json({ url: checkoutUrl });
});

/** POST /:team_id/billing/portal — create Stripe Billing Portal session */
billing.post("/:team_id/billing/portal", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`
    SELECT id, stripe_customer_id FROM tenants WHERE id = ${teamId}
  `;
  if (!tenant) return c.json({ error: "not_found" }, 404);
  if (!tenant.stripe_customer_id) return c.json({ error: "No billing account" }, 400);

  const returnUrl = `${c.env.WEBSITE_URL}/onboarding/${teamId}`;
  const portalUrl = await createBillingPortalSession(
    c.env.STRIPE_SECRET_KEY,
    tenant.stripe_customer_id,
    returnUrl,
  );

  return c.json({ url: portalUrl });
});

export default billing;
