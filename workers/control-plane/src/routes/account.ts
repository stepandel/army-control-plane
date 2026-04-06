import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { sessionGuard } from "../middleware/session";
import { createCheckoutSession, createBillingPortalSession } from "../lib/stripe";
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
           subscription_status, trial_ends_at
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

/** POST /checkout — create Stripe Checkout session */
account.post("/checkout", async (c) => {
  const { team_id: teamId } = c.get("session");
  const sql = getDb(c.env);

  const [tenant] = await sql`
    SELECT id, stripe_customer_id, subscription_status
    FROM tenants WHERE id = ${teamId}
  `;
  if (!tenant) return c.json({ error: "not_found" }, 404);
  if (!tenant.stripe_customer_id) return c.json({ error: "No billing account — contact support" }, 400);
  if (tenant.subscription_status === "active") return c.json({ error: "Already subscribed" }, 400);

  const successUrl = `${c.env.WEBSITE_URL}/account/billing?billing=success`;
  const cancelUrl = `${c.env.WEBSITE_URL}/account/billing?billing=canceled`;

  const checkoutUrl = await createCheckoutSession(
    c.env.STRIPE_SECRET_KEY,
    tenant.stripe_customer_id,
    c.env.STRIPE_PRICE_ID,
    successUrl,
    cancelUrl,
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
