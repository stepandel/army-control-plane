import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient } from "./fly";

/**
 * Reactivate a suspended tenant: flip `tenants.status` back to 'active'
 * and start the Fly machine. Used by the Stripe webhook (on payment) and
 * by the promo-code redemption flow (on trial extension).
 *
 * Caller is responsible for ensuring the tenant is actually suspended and
 * for invoking this from `executionCtx.waitUntil` if Fly latency must not
 * block the response.
 */
export async function reactivateTenant(
  env: ControlPlaneEnv,
  tenantId: string,
  flyAppName: string,
  flyMachineId: string,
): Promise<void> {
  const sql = getDb(env);
  // Update tenant status back to active
  await sql`
    UPDATE tenants SET status = 'active', updated_at = now()
    WHERE id = ${tenantId}
  `;
  // Start the Fly machine
  const fly = new FlyClient(env.FLY_API_TOKEN_VERA, flyAppName);
  await fly.startMachine(flyMachineId);
}
