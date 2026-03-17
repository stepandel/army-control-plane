import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient } from "../lib/fly";
import { AnthropicAdminClient } from "../lib/anthropic-admin";
import { pushCredentials } from "../lib/credentials";
import { provisionTenant } from "../lib/provision";

const admin = new Hono<{ Bindings: ControlPlaneEnv }>();

const PLATFORMS = ["slack", "linear", "github", "anthropic"] as const;

/** GET /admin/tenants — list all tenants + status */
admin.get("/tenants", async (c) => {
  const sql = getDb(c.env);
  const tenants = await sql`
    SELECT id, name, platform, status, fly_app_name, instance_url, anthropic_workspace_id, created_at, updated_at
    FROM tenants ORDER BY created_at DESC
  `;
  return c.json(tenants);
});

/** GET /admin/tenants/:team_id — single tenant detail + integration status */
admin.get("/tenants/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);

  const tokens = await sql`
    SELECT id, platform, token_type, scopes, created_at
    FROM integration_tokens WHERE tenant_id = ${teamId}
  `;
  const deployments = await sql`
    SELECT * FROM deployments WHERE tenant_id = ${teamId} ORDER BY created_at DESC
  `;

  // Build integration status per platform
  const integrations = PLATFORMS.map((p) => ({
    platform: p,
    connected: tokens.some((t) => t.platform === p),
    token_count: tokens.filter((t) => t.platform === p).length,
  }));

  return c.json({ ...tenant, integrations, tokens, deployments });
});

/** DELETE /admin/tenants/:team_id — destroy machine, delete KV entries, mark destroyed */
admin.delete("/tenants/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);
  const fly = new FlyClient(c.env.FLY_API_TOKEN, c.env.FLY_APP);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);

  // Destroy Fly machine
  if (tenant.fly_machine_id) {
    try {
      await fly.destroyMachine(tenant.fly_machine_id);
    } catch (err) {
      console.error(`Fly cleanup failed for ${teamId}:`, err);
      // Continue with DB/KV cleanup even if Fly fails
    }
  }

  // Deactivate Anthropic workspace keys + archive workspace
  if (tenant.anthropic_workspace_id && c.env.ANTHROPIC_ADMIN_KEY) {
    try {
      const anthropic = new AnthropicAdminClient(c.env.ANTHROPIC_ADMIN_KEY);
      await anthropic.deactivateWorkspaceKeys(tenant.anthropic_workspace_id);
      await anthropic.archiveWorkspace(tenant.anthropic_workspace_id);
    } catch (err) {
      console.error(`Anthropic workspace cleanup failed for ${teamId}:`, err);
    }
  }

  // Mark any running deployment as stopped
  await sql`
    UPDATE deployments SET status = 'stopped', finished_at = now()
    WHERE tenant_id = ${teamId} AND status IN ('deploying', 'running')
  `;

  // Remove all KV routes
  for (const p of PLATFORMS) {
    await c.env.ROUTING_TABLE.delete(`${p}:${teamId}`);
  }

  // Mark tenant as destroyed
  await sql`
    UPDATE tenants
    SET status = 'destroyed', fly_machine_id = NULL, instance_url = NULL, updated_at = now()
    WHERE id = ${teamId}
  `;

  return c.json({ team_id: teamId, status: "destroyed" });
});

/** POST /admin/tenants/:team_id/reprovision — destroy + recreate machine */
admin.post("/tenants/:team_id/reprovision", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);
  const fly = new FlyClient(c.env.FLY_API_TOKEN, c.env.FLY_APP);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);
  if (tenant.status === "destroyed") return c.json({ error: "Tenant is destroyed, cannot reprovision" }, 400);

  // Destroy old Fly machine
  if (tenant.fly_machine_id) {
    try {
      await fly.destroyMachine(tenant.fly_machine_id);
    } catch (err) {
      console.error(`Fly cleanup failed for ${teamId}:`, err);
    }
  }

  // Mark old deployment as stopped
  await sql`
    UPDATE deployments SET status = 'stopped', finished_at = now()
    WHERE tenant_id = ${teamId} AND status IN ('deploying', 'running')
  `;

  // Reset tenant to pending so provision can run
  await sql`
    UPDATE tenants
    SET status = 'pending', fly_machine_id = NULL, fly_app_name = NULL, instance_url = NULL, updated_at = now()
    WHERE id = ${teamId}
  `;

  // Remove old KV routes
  for (const p of PLATFORMS) {
    await c.env.ROUTING_TABLE.delete(`${p}:${teamId}`);
  }

  // Trigger provisioning (fire-and-forget)
  c.executionCtx.waitUntil(
    provisionTenant(c.env, teamId).catch((err) =>
      console.error(`Reprovisioning failed for ${teamId}:`, err),
    ),
  );

  return c.json({ team_id: teamId, status: "reprovisioning" });
});

/** POST /admin/tenants/push-credentials — push credentials to all active tenants */
admin.post("/tenants/push-credentials", async (c) => {
  const sql = getDb(c.env);
  const tenants = await sql`
    SELECT id FROM tenants WHERE status = 'active' AND fly_machine_id IS NOT NULL
  `;

  const results: { tenant_id: string; status: "ok" | "error"; error?: string }[] = [];

  for (const tenant of tenants) {
    try {
      await pushCredentials(c.env, tenant.id);
      results.push({ tenant_id: tenant.id, status: "ok" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`pushCredentials failed for ${tenant.id}:`, message);
      results.push({ tenant_id: tenant.id, status: "error", error: message });
    }
  }

  const succeeded = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "error").length;

  return c.json({ total: results.length, succeeded, failed, results });
});

/** POST /admin/tenants/:team_id/push-credentials — push credentials to a single tenant */
admin.post("/tenants/:team_id/push-credentials", async (c) => {
  const teamId = c.req.param("team_id");
  try {
    const result = await pushCredentials(c.env, teamId);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

/** PUT /admin/tenants/:team_id/anthropic-key — set per-tenant Anthropic API key */
admin.put("/tenants/:team_id/anthropic-key", async (c) => {
  const teamId = c.req.param("team_id");
  const body = await c.req.json<{ api_key: string }>();
  if (!body.api_key) return c.json({ error: "Missing api_key in request body" }, 400);

  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT id, status, fly_machine_id FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);

  await sql`
    INSERT INTO integration_tokens (tenant_id, platform, token_type, access_token)
    VALUES (${teamId}, 'anthropic', 'api_key', ${body.api_key})
    ON CONFLICT (tenant_id, platform) DO UPDATE SET access_token = ${body.api_key}
  `;

  // If tenant is active, push updated credentials to the running machine
  if (tenant.status === "active" && tenant.fly_machine_id) {
    c.executionCtx.waitUntil(
      pushCredentials(c.env, teamId).catch((err) =>
        console.error(`Credential push failed for ${teamId}:`, err),
      ),
    );
  }

  return c.json({ team_id: teamId, anthropic_key_set: true });
});

/** DELETE /admin/tenants/:team_id/anthropic-key — remove per-tenant key (reverts to global fallback) */
admin.delete("/tenants/:team_id/anthropic-key", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT id, status, fly_machine_id FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);

  await sql`
    DELETE FROM integration_tokens
    WHERE tenant_id = ${teamId} AND platform = 'anthropic'
  `;

  // If tenant is active, push updated credentials (will use global fallback)
  if (tenant.status === "active" && tenant.fly_machine_id) {
    c.executionCtx.waitUntil(
      pushCredentials(c.env, teamId).catch((err) =>
        console.error(`Credential push failed for ${teamId}:`, err),
      ),
    );
  }

  return c.json({ team_id: teamId, anthropic_key_removed: true });
});

// ── Anthropic Workspace Management ──────────────────────────────────
// Workspaces provide per-tenant billing isolation and key lifecycle management.
// NOTE: Anthropic's Admin API does NOT support creating API keys programmatically.
//       Keys must be created in Claude Console after workspace provisioning.

/**
 * POST /admin/tenants/:team_id/anthropic-workspace — create an isolated Anthropic workspace
 * Returns the workspace ID and Console URL where an API key should be created.
 */
admin.post("/tenants/:team_id/anthropic-workspace", async (c) => {
  const teamId = c.req.param("team_id");
  if (!c.env.ANTHROPIC_ADMIN_KEY) {
    return c.json({ error: "ANTHROPIC_ADMIN_KEY not configured" }, 500);
  }

  const sql = getDb(c.env);
  const [tenant] = await sql`SELECT id, name, anthropic_workspace_id FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);

  if (tenant.anthropic_workspace_id) {
    return c.json({
      error: "Workspace already exists",
      workspace_id: tenant.anthropic_workspace_id,
    }, 409);
  }

  const anthropic = new AnthropicAdminClient(c.env.ANTHROPIC_ADMIN_KEY);
  const workspaceName = `army-${teamId}`;
  const workspace = await anthropic.createWorkspace(workspaceName);

  await sql`
    UPDATE tenants
    SET anthropic_workspace_id = ${workspace.id}, updated_at = now()
    WHERE id = ${teamId}
  `;

  return c.json({
    team_id: teamId,
    workspace_id: workspace.id,
    workspace_name: workspaceName,
    console_url: `https://console.anthropic.com/settings/workspaces/${workspace.id}`,
    next_step: "Create an API key in Claude Console for this workspace, then PUT /admin/tenants/:team_id/anthropic-key",
  }, 201);
});

/**
 * GET /admin/tenants/:team_id/anthropic-workspace — workspace info + API key inventory
 */
admin.get("/tenants/:team_id/anthropic-workspace", async (c) => {
  const teamId = c.req.param("team_id");
  if (!c.env.ANTHROPIC_ADMIN_KEY) {
    return c.json({ error: "ANTHROPIC_ADMIN_KEY not configured" }, 500);
  }

  const sql = getDb(c.env);
  const [tenant] = await sql`SELECT id, anthropic_workspace_id FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);
  if (!tenant.anthropic_workspace_id) {
    return c.json({ error: "No Anthropic workspace provisioned for this tenant" }, 404);
  }

  const anthropic = new AnthropicAdminClient(c.env.ANTHROPIC_ADMIN_KEY);

  const [workspace, keys] = await Promise.all([
    anthropic.getWorkspace(tenant.anthropic_workspace_id),
    anthropic.listAPIKeys({ workspaceId: tenant.anthropic_workspace_id }),
  ]);

  // Check if a per-tenant key is stored in our DB
  const [storedKey] = await sql`
    SELECT id, created_at FROM integration_tokens
    WHERE tenant_id = ${teamId} AND platform = 'anthropic'
  `;

  return c.json({
    team_id: teamId,
    workspace,
    api_keys: keys.data,
    stored_key: storedKey ? { id: storedKey.id, created_at: storedKey.created_at } : null,
    console_url: `https://console.anthropic.com/settings/workspaces/${tenant.anthropic_workspace_id}`,
  });
});

/**
 * DELETE /admin/tenants/:team_id/anthropic-workspace — deactivate keys + archive workspace
 */
admin.delete("/tenants/:team_id/anthropic-workspace", async (c) => {
  const teamId = c.req.param("team_id");
  if (!c.env.ANTHROPIC_ADMIN_KEY) {
    return c.json({ error: "ANTHROPIC_ADMIN_KEY not configured" }, 500);
  }

  const sql = getDb(c.env);
  const [tenant] = await sql`SELECT id, status, fly_machine_id, anthropic_workspace_id FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Not found" }, 404);
  if (!tenant.anthropic_workspace_id) {
    return c.json({ error: "No Anthropic workspace provisioned for this tenant" }, 404);
  }

  const anthropic = new AnthropicAdminClient(c.env.ANTHROPIC_ADMIN_KEY);

  // Deactivate all keys in the workspace, then archive it
  const deactivated = await anthropic.deactivateWorkspaceKeys(tenant.anthropic_workspace_id);
  const workspace = await anthropic.archiveWorkspace(tenant.anthropic_workspace_id);

  // Remove per-tenant key from our DB
  await sql`
    DELETE FROM integration_tokens
    WHERE tenant_id = ${teamId} AND platform = 'anthropic'
  `;

  // Clear workspace reference
  await sql`
    UPDATE tenants
    SET anthropic_workspace_id = NULL, updated_at = now()
    WHERE id = ${teamId}
  `;

  // If tenant is active, push updated credentials (will revert to global fallback)
  if (tenant.status === "active" && tenant.fly_machine_id) {
    c.executionCtx.waitUntil(
      pushCredentials(c.env, teamId).catch((err) =>
        console.error(`Credential push failed for ${teamId}:`, err),
      ),
    );
  }

  return c.json({
    team_id: teamId,
    workspace_archived: true,
    workspace_id: workspace.id,
    keys_deactivated: deactivated,
  });
});

export default admin;
