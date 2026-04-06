import { createMiddleware } from "hono/factory";
import type { ControlPlaneEnv } from "@army/shared";
import { verifyJwt, type SessionPayload } from "../lib/jwt";

/**
 * Hono middleware that validates the session JWT from the __Host-session cookie.
 * Rejects with 401 if the token is missing, invalid, or expired.
 * Sets `c.get("session")` on success for downstream handlers.
 */
export const sessionGuard = createMiddleware<{
  Bindings: ControlPlaneEnv;
  Variables: { session: SessionPayload };
}>(async (c, next) => {
  const cookie = c.req.header("cookie");
  const token = extractCookie(cookie, "__Host-session");

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const payload = await verifyJwt(token, c.env.SESSION_SECRET);
  if (!payload) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  c.set("session", payload);
  await next();
});

function extractCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}
