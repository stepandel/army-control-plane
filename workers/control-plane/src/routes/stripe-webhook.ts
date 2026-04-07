import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { verifyWebhookSignature } from "../lib/stripe";
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

      // Track scheduled cancel-at-period-end. Stripe leaves status="active" while
      // a cancellation is pending, so the only signal is cancel_at_period_end.
      const cancelAtPeriodEnd = obj.cancel_at_period_end === true;
      const cancelAtUnix = typeof obj.cancel_at === "number" ? obj.cancel_at : null;
      if (cancelAtPeriodEnd && cancelAtUnix) {
        const cancelAtIso = new Date(cancelAtUnix * 1000).toISOString();
        await sql`
          UPDATE tenants SET cancel_at = ${cancelAtIso}::timestamptz WHERE id = ${tenant.id}
        `;
      } else {
        // User undid the cancellation, or there was never one — make sure cancel_at is clear.
        await sql`UPDATE tenants SET cancel_at = NULL WHERE id = ${tenant.id}`;
      }

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
