import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient } from "../lib/fly";

const deploy = new Hono<{ Bindings: ControlPlaneEnv }>();

/** Bearer token auth — validates DEPLOY_SECRET */
deploy.use("*", async (c, next) => {
  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ") || authHeader !== `Bearer ${c.env.DEPLOY_SECRET}`) {
    return c.json({ error: "Invalid or missing deploy token" }, 403);
  }
  await next();
});

/** POST /deploy — deploy latest image to all active per-tenant machines */
deploy.post("/", async (c) => {
  const image = `registry.fly.io/${c.env.FLY_APP}:latest`;
  const sql = getDb(c.env);

  const tenants = await sql`
    SELECT id, name, fly_app_name, fly_machine_id
    FROM tenants
    WHERE status = 'active' AND fly_machine_id IS NOT NULL AND fly_app_name IS NOT NULL
  `;

  const results: { tenant_id: string; name: string; status: "deployed" | "failed"; error?: string }[] = [];

  for (const tenant of tenants) {
    try {
      const tenantFly = new FlyClient(c.env.FLY_API_TOKEN_VERA, tenant.fly_app_name);
      await tenantFly.deployImage(tenant.fly_machine_id, image);
      await sql`
        INSERT INTO deployments (tenant_id, fly_machine_id, image_ref, status)
        VALUES (${tenant.id}, ${tenant.fly_machine_id}, ${image}, 'running')
      `;
      results.push({ tenant_id: tenant.id, name: tenant.name, status: "deployed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Deploy failed for ${tenant.id}:`, message);
      results.push({ tenant_id: tenant.id, name: tenant.name, status: "failed", error: message });
    }
  }

  const deployed = results.filter((r) => r.status === "deployed").length;
  const failed = results.filter((r) => r.status === "failed").length;

  return c.json({ image, total: results.length, deployed, failed, results });
});

export default deploy;
