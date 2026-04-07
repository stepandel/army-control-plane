import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { verifyWebhookSignature, getSubscription } from "../lib/stripe";
import { FlyClient } from "../lib/fly";
import { syncBillingToKv } from "../lib/billing-sync";
import { reactivateTenant } from "../lib/tenant-reactivate";

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

const stripeWebhook = new Hono<{ Bindings: ControlPlaneEnv }>();

// ── Helpers ──────────────────────────────────────────────────────

async function findTenantByStripeCustomer(
  sql: ReturnType<typeof getDb>,
  customerId: string,
) {
  const [tenant] = await sql`
    SELECT id, status, fly_app_name, fly_machine_id, subscription_status
    FROM tenants WHERE stripe_customer_id = ${customerId}
  `;
  return tenant ?? null;
}

async function updateSubscriptionStatus(
  sql: ReturnType<typeof getDb>,
  tenantId: string,
  subscriptionStatus: string,
  stripeSubscriptionId?: string,
) {
  if (stripeSubscriptionId) {
    await sql`
      UPDATE tenants
      SET subscription_status = ${subscriptionStatus},
          stripe_subscription_id = ${stripeSubscriptionId},
          updated_at = now()
      WHERE id = ${tenantId}
    `;
  } else {
    await sql`
      UPDATE tenants
      SET subscription_status = ${subscriptionStatus},
          updated_at = now()
      WHERE id = ${tenantId}
    `;
  }
}

/** Pull plan info, current period end, and cancel_at off a Stripe subscription
 * object and persist them onto the tenant row. Used by both `subscription.updated`
 * and `checkout.session.completed` (the latter fetches the sub via API to avoid
 * the race between checkout completion and the first subscription.updated). */
async function persistSubscriptionFields(
  sql: ReturnType<typeof getDb>,
  tenantId: string,
  sub: Record<string, unknown>,
) {
  // current_period_end may live at the top level (legacy) or on the first
  // subscription item (flexible billing mode).
  let cpeUnix: number | null = null;
  if (typeof sub.current_period_end === "number") {
    cpeUnix = sub.current_period_end;
  } else {
    const items = sub.items as { data?: Array<Record<string, unknown>> } | undefined;
    const first = items?.data?.[0];
    if (first && typeof first.current_period_end === "number") {
      cpeUnix = first.current_period_end;
    }
  }

  const plan = sub.plan as { interval?: unknown; amount?: unknown } | undefined;
  const planInterval = plan && typeof plan.interval === "string" ? plan.interval : null;
  const planAmount = plan && typeof plan.amount === "number" ? plan.amount : null;

  const cancelAtUnix = typeof sub.cancel_at === "number" ? sub.cancel_at : null;
  const cancelAtIso =
    cancelAtUnix && cancelAtUnix > Math.floor(Date.now() / 1000)
      ? new Date(cancelAtUnix * 1000).toISOString()
      : null;

  const cpeIso = cpeUnix ? new Date(cpeUnix * 1000).toISOString() : null;

  await sql`
    UPDATE tenants
    SET current_period_end = ${cpeIso}::timestamptz,
        plan_interval = ${planInterval},
        plan_amount_cents = ${planAmount},
        cancel_at = ${cancelAtIso}::timestamptz,
        updated_at = now()
    WHERE id = ${tenantId}
  `;
}

async function suspendTenant(env: ControlPlaneEnv, tenantId: string, flyAppName: string, flyMachineId: string) {
  const sql = getDb(env);
  // Stop the Fly machine
  const fly = new FlyClient(env.FLY_API_TOKEN_VERA, flyAppName);
  try {
    await fly.stopMachine(flyMachineId);
  } catch (err) {
    console.error(`Failed to stop machine for ${tenantId}:`, err);
  }
  // Update tenant status to suspended
  await sql`
    UPDATE tenants SET status = 'suspended', updated_at = now()
    WHERE id = ${tenantId}
  `;
}

// ── Webhook endpoint ─────────────────────────────────────────────

stripeWebhook.post("/", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature) return c.text("Missing signature", 400);

  const body = await c.req.text();
  let event: Record<string, unknown>;

  try {
    event = await verifyWebhookSignature(body, signature, c.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Stripe webhook verification failed:", message);
    return c.text("Invalid signature", 401);
  }

  const eventType = event.type as string;
  const data = event.data as { object: Record<string, unknown> };
  const obj = data.object;

  const sql = getDb(c.env);

  switch (eventType) {
    // ── Checkout completed ──
    case "checkout.session.completed": {
      const customerId = obj.customer as string;
      const subscriptionId = obj.subscription as string;
      if (!customerId || !subscriptionId) break;

      const tenant = await findTenantByStripeCustomer(sql, customerId);
      if (!tenant) {
        console.error(`No tenant found for Stripe customer ${customerId}`);
        break;
      }

      await updateSubscriptionStatus(sql, tenant.id, "active", subscriptionId);
      // Clear past_due grace deadline + any prior scheduled cancellation
      await sql`
        UPDATE tenants SET grace_deadline = NULL, cancel_at = NULL WHERE id = ${tenant.id}
      `;
      await syncBillingToKv(c.env, tenant.id, "active", null, null);

      // Hydrate plan + period fields immediately by fetching the subscription.
      // The corresponding customer.subscription.updated event arrives shortly
      // after, but Stripe redirects the user to our success URL the moment
      // checkout closes — so the dashboard would otherwise show "Active" with
      // no plan label or next billing date until that race resolves.
      try {
        const sub = await getSubscription(c.env.STRIPE_SECRET_KEY, subscriptionId);
        await persistSubscriptionFields(sql, tenant.id, sub);
      } catch (err) {
        console.error(`Failed to hydrate subscription fields for ${tenant.id}:`, err);
        // Non-fatal — the next subscription.updated webhook will fill them in.
      }

      // If tenant was suspended, reactivate
      if (tenant.status === "suspended" && tenant.fly_app_name && tenant.fly_machine_id) {
        c.executionCtx.waitUntil(
          reactivateTenant(c.env, tenant.id, tenant.fly_app_name, tenant.fly_machine_id).catch((err) =>
            console.error(`Reactivation failed for ${tenant.id}:`, err),
          ),
        );
      }
      break;
    }

    // ── Subscription updated ──
    case "customer.subscription.updated": {
      const customerId = obj.customer as string;
      const stripeStatus = obj.status as string;
      const subscriptionId = obj.id as string;
      if (!customerId) break;

      const tenant = await findTenantByStripeCustomer(sql, customerId);
      if (!tenant) break;

      // Map Stripe status to our status
      let newStatus: string;
      switch (stripeStatus) {
        case "active":
        case "trialing":
          newStatus = stripeStatus;
          break;
        case "past_due":
          newStatus = "past_due";
          break;
        case "canceled":
        case "unpaid":
          newStatus = "canceled";
          break;
        default:
          newStatus = stripeStatus;
      }

      await updateSubscriptionStatus(sql, tenant.id, newStatus, subscriptionId);

      // Persist plan, current_period_end, and cancel_at directly from the
      // subscription payload. (Stripe leaves status="active" when a cancel
      // is scheduled, so cancel_at is the only signal we get.)
      await persistSubscriptionFields(sql, tenant.id, obj);

      // Manage grace_deadline alongside status
      let graceDeadline: string | null = null;
      if (newStatus === "past_due") {
        graceDeadline = new Date(Date.now() + GRACE_PERIOD_MS).toISOString();
        await sql`UPDATE tenants SET grace_deadline = ${graceDeadline}::timestamptz WHERE id = ${tenant.id}`;
      } else if (newStatus === "active") {
        await sql`UPDATE tenants SET grace_deadline = NULL WHERE id = ${tenant.id}`;
      }
      await syncBillingToKv(c.env, tenant.id, newStatus, undefined, graceDeadline);

      // Reactivate if going from suspended → active
      if (newStatus === "active" && tenant.status === "suspended" && tenant.fly_app_name && tenant.fly_machine_id) {
        c.executionCtx.waitUntil(
          reactivateTenant(c.env, tenant.id, tenant.fly_app_name, tenant.fly_machine_id).catch((err) =>
            console.error(`Reactivation failed for ${tenant.id}:`, err),
          ),
        );
      }
      break;
    }

    // ── Subscription deleted ──
    case "customer.subscription.deleted": {
      const customerId = obj.customer as string;
      if (!customerId) break;

      const tenant = await findTenantByStripeCustomer(sql, customerId);
      if (!tenant) break;

      await updateSubscriptionStatus(sql, tenant.id, "canceled");
      await sql`
        UPDATE tenants
        SET stripe_subscription_id = NULL,
            grace_deadline = NULL,
            cancel_at = NULL,
            current_period_end = NULL,
            plan_interval = NULL,
            plan_amount_cents = NULL,
            updated_at = now()
        WHERE id = ${tenant.id}
      `;
      await syncBillingToKv(c.env, tenant.id, "canceled", null, null);

      // Suspend the tenant — stop their machine
      if (tenant.fly_app_name && tenant.fly_machine_id && tenant.status === "active") {
        c.executionCtx.waitUntil(
          suspendTenant(c.env, tenant.id, tenant.fly_app_name, tenant.fly_machine_id).catch((err) =>
            console.error(`Suspension failed for ${tenant.id}:`, err),
          ),
        );
      }
      break;
    }

    // ── Payment failed ──
    case "invoice.payment_failed": {
      const customerId = obj.customer as string;
      if (!customerId) break;

      const tenant = await findTenantByStripeCustomer(sql, customerId);
      if (!tenant) break;

      await updateSubscriptionStatus(sql, tenant.id, "past_due");

      // Set 7-day grace deadline (only if one isn't already set)
      const [existing] = await sql`
        SELECT grace_deadline FROM tenants WHERE id = ${tenant.id}
      `;
      let graceDeadline: string;
      if (existing?.grace_deadline) {
        graceDeadline = new Date(existing.grace_deadline).toISOString();
      } else {
        graceDeadline = new Date(Date.now() + GRACE_PERIOD_MS).toISOString();
        await sql`
          UPDATE tenants SET grace_deadline = ${graceDeadline}::timestamptz WHERE id = ${tenant.id}
        `;
      }
      await syncBillingToKv(c.env, tenant.id, "past_due", undefined, graceDeadline);
      break;
    }

    default:
      // Ignore unhandled event types
      break;
  }

  return c.json({ received: true });
});

export default stripeWebhook;
