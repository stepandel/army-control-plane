import type { TenantRoute } from "@army/shared";

/**
 * Check whether a tenant's webhooks should be blocked due to billing status.
 * Returns true if the tenant is blocked (no forwarding should happen).
 *
 * Rules:
 *   active                → always allowed
 *   trialing              → allowed until trial_ends_at
 *   past_due              → allowed during 7-day grace period (grace_deadline)
 *   canceled / suspended  → blocked
 *   unknown status        → blocked (fail closed)
 *   missing field         → allowed (backward compat for old KV entries)
 */
export function isBillingBlocked(route: TenantRoute): boolean {
  const status = route.subscription_status;

  // Backward compat: KV entries written before billing fields → allowed
  if (!status) return false;

  if (status === "active") return false;

  if (status === "trialing") {
    if (!route.trial_ends_at) return false;
    return Date.now() > Date.parse(route.trial_ends_at);
  }

  if (status === "past_due") {
    if (!route.grace_deadline) return false;
    return Date.now() > Date.parse(route.grace_deadline);
  }

  // canceled, suspended, unpaid, or any other status → blocked
  return true;
}
