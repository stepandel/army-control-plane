/**
 * Thin Stripe REST API wrapper for Cloudflare Workers (no SDK, just fetch).
 * Covers customer creation, checkout sessions, billing portal, and webhook verification.
 */

// ── Helpers ──────────────────────────────────────────────────────

function stripeRequest(
  secretKey: string,
  method: string,
  path: string,
  body?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  return fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers,
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
}

// ── Subscriptions ────────────────────────────────────────────────

/** Fetch a subscription by ID. Returns the raw object so callers can pull
 * whatever fields they need (plan, current_period_end, cancel_at, etc). */
export async function getSubscription(
  secretKey: string,
  subscriptionId: string,
): Promise<Record<string, unknown>> {
  const resp = await stripeRequest(secretKey, "GET", `/subscriptions/${subscriptionId}`);
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Stripe getSubscription failed: ${resp.status} ${err}`);
  }
  return (await resp.json()) as Record<string, unknown>;
}

// ── Customers ────────────────────────────────────────────────────

export async function createCustomer(
  secretKey: string,
  tenantId: string,
  teamName: string,
): Promise<string> {
  const resp = await stripeRequest(secretKey, "POST", "/customers", {
    name: teamName,
    "metadata[tenant_id]": tenantId,
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Stripe createCustomer failed: ${resp.status} ${err}`);
  }
  const data = (await resp.json()) as { id: string };
  return data.id;
}

// ── Checkout Sessions ────────────────────────────────────────────

export async function createCheckoutSession(
  secretKey: string,
  customerId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
  trialEndUnixSeconds?: number,
): Promise<string> {
  const params: Record<string, string> = {
    customer: customerId,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    mode: "subscription",
    success_url: successUrl,
    cancel_url: cancelUrl,
  };
  // Honor an existing trial end date — Stripe will not charge until trial_end.
  // Only pass if comfortably in the future to avoid edge-case validation errors.
  if (trialEndUnixSeconds && trialEndUnixSeconds > Math.floor(Date.now() / 1000) + 60) {
    params["subscription_data[trial_end]"] = String(trialEndUnixSeconds);
  }
  const resp = await stripeRequest(secretKey, "POST", "/checkout/sessions", params);
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Stripe createCheckoutSession failed: ${resp.status} ${err}`);
  }
  const data = (await resp.json()) as { url: string };
  return data.url;
}

// ── Billing Portal ───────────────────────────────────────────────

export async function createBillingPortalSession(
  secretKey: string,
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const resp = await stripeRequest(secretKey, "POST", "/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Stripe createBillingPortalSession failed: ${resp.status} ${err}`);
  }
  const data = (await resp.json()) as { url: string };
  return data.url;
}

// ── Webhook Signature Verification ───────────────────────────────

/**
 * Verify Stripe webhook signature (v1 scheme) using Web Crypto API.
 * Returns the parsed event object if valid, throws if invalid.
 */
export async function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = 300,
): Promise<Record<string, unknown>> {
  // Parse the Stripe-Signature header
  const elements = signatureHeader.split(",").reduce(
    (acc, part) => {
      const [key, value] = part.split("=", 2);
      if (key && value) acc[key.trim()] = value.trim();
      return acc;
    },
    {} as Record<string, string>,
  );

  const timestamp = elements.t;
  const expectedSig = elements.v1;
  if (!timestamp || !expectedSig) {
    throw new Error("Invalid Stripe signature header: missing t or v1");
  }

  // Check timestamp tolerance
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) {
    throw new Error("Stripe webhook timestamp outside tolerance");
  }

  // Compute expected signature: HMAC-SHA256(secret, timestamp + "." + payload)
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Timing-safe comparison
  if (computedSig.length !== expectedSig.length) {
    throw new Error("Invalid Stripe webhook signature");
  }
  let mismatch = 0;
  for (let i = 0; i < computedSig.length; i++) {
    mismatch |= computedSig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  if (mismatch !== 0) {
    throw new Error("Invalid Stripe webhook signature");
  }

  return JSON.parse(payload) as Record<string, unknown>;
}
