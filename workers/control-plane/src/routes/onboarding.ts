import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { pushCredentials } from "../lib/credentials";

const onboarding = new Hono<{ Bindings: ControlPlaneEnv }>();

// ─── Shared layout ──────────────────────────────────────────────

function layout(title: string, body: string) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          *,
          *::before,
          *::after {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
              sans-serif;
            background: #0a0a0a;
            color: #e5e5e5;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            padding: 48px 16px;
          }
          .container {
            max-width: 520px;
            width: 100%;
          }
          h1 {
            font-size: 28px;
            font-weight: 600;
            color: #fff;
            margin-bottom: 8px;
          }
          .subtitle {
            color: #888;
            font-size: 15px;
            margin-bottom: 40px;
            line-height: 1.5;
          }
          .steps {
            display: flex;
            flex-direction: column;
            gap: 16px;
          }
          .step {
            border: 1px solid #262626;
            border-radius: 12px;
            padding: 20px 24px;
            display: flex;
            align-items: center;
            gap: 16px;
            transition: border-color 0.15s;
          }
          .step.active {
            border-color: #404040;
          }
          .step.connected {
            border-color: #166534;
            background: rgba(22, 101, 52, 0.08);
          }
          .step.disabled {
            opacity: 0.45;
          }
          .step-number {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: #1a1a1a;
            border: 1px solid #333;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: 600;
            flex-shrink: 0;
          }
          .step.connected .step-number {
            background: #166534;
            border-color: #166534;
            color: #4ade80;
          }
          .step-body {
            flex: 1;
            min-width: 0;
          }
          .step-title {
            font-size: 15px;
            font-weight: 500;
            color: #fff;
            margin-bottom: 2px;
          }
          .step-desc {
            font-size: 13px;
            color: #666;
          }
          .step.connected .step-desc {
            color: #4ade80;
          }
          .btn {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            text-decoration: none;
            transition: background 0.15s;
            flex-shrink: 0;
            cursor: pointer;
            border: none;
          }
          .btn-primary {
            background: #fff;
            color: #0a0a0a;
          }
          .btn-primary:hover {
            background: #e0e0e0;
          }
          .btn-secondary {
            background: #1a1a1a;
            color: #e5e5e5;
            border: 1px solid #333;
          }
          .btn-secondary:hover {
            background: #262626;
          }
          .btn:disabled,
          .btn.disabled {
            pointer-events: none;
            opacity: 0.4;
          }
          .badge {
            font-size: 12px;
            padding: 2px 8px;
            border-radius: 99px;
            font-weight: 500;
          }
          .badge-ok {
            background: rgba(74, 222, 128, 0.12);
            color: #4ade80;
          }
          .badge-pending {
            background: rgba(250, 204, 21, 0.12);
            color: #facc15;
          }
          .logo {
            font-size: 20px;
            font-weight: 700;
            color: #fff;
            letter-spacing: -0.5px;
            margin-bottom: 32px;
          }
          .done-banner {
            margin-top: 24px;
            padding: 16px 20px;
            border-radius: 12px;
            background: rgba(74, 222, 128, 0.08);
            border: 1px solid #166534;
            text-align: center;
            color: #4ade80;
            font-size: 14px;
            font-weight: 500;
          }
          .provisioning {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            color: #facc15;
          }
          @keyframes spin {
            to {
              transform: rotate(360deg);
            }
          }
          .spinner {
            width: 14px;
            height: 14px;
            border: 2px solid #333;
            border-top-color: #facc15;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
          }
          .key-form {
            display: flex;
            gap: 8px;
            margin-top: 8px;
          }
          .key-input {
            flex: 1;
            padding: 8px 12px;
            border-radius: 8px;
            border: 1px solid #333;
            background: #1a1a1a;
            color: #e5e5e5;
            font-size: 13px;
            font-family: inherit;
            outline: none;
          }
          .key-input:focus {
            border-color: #555;
          }
          .btn-danger {
            background: rgba(239, 68, 68, 0.1);
            color: #ef4444;
            border: 1px solid rgba(239, 68, 68, 0.25);
          }
          .btn-danger:hover {
            background: rgba(239, 68, 68, 0.2);
          }
          .step-optional {
            font-size: 11px;
            color: #666;
            font-weight: 400;
            margin-left: 6px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="logo">Army</div>
          ${raw(body)}
        </div>
      </body>
    </html>`;
}

// ─── Landing page ───────────────────────────────────────────────

onboarding.get("/", (c) => {
  const slackUrl = `${c.env.BASE_URL}/oauth/slack/install`;
  const body = `
    <h1>Set up your workspace</h1>
    <p class="subtitle">
      Connect Slack, Linear, and GitHub to get Vera running in your workspace.
      Slack is required first — it creates your tenant.
    </p>
    <div class="steps">
      <div class="step active">
        <div class="step-number">1</div>
        <div class="step-body">
          <div class="step-title">Connect Slack</div>
          <div class="step-desc">Required — creates your workspace</div>
        </div>
        <a href="${slackUrl}" class="btn btn-primary">Install</a>
      </div>
      <div class="step disabled">
        <div class="step-number">2</div>
        <div class="step-body">
          <div class="step-title">Connect Linear</div>
          <div class="step-desc">Issue tracking and project management</div>
        </div>
      </div>
      <div class="step disabled">
        <div class="step-number">3</div>
        <div class="step-body">
          <div class="step-title">Connect GitHub</div>
          <div class="step-desc">Code repositories and pull requests</div>
        </div>
      </div>
    </div>`;
  return c.html(layout("Army — Setup", body));
});

// ─── Tenant dashboard ───────────────────────────────────────────

onboarding.get("/:team_id", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT * FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.html(layout("Not Found", `<h1>Tenant not found</h1>`), 404);

  const tokens =
    await sql`SELECT platform, external_id FROM integration_tokens WHERE tenant_id = ${teamId}`;
  const connected = new Set(tokens.map((t) => (t as Record<string, string>).platform));

  const isActive = tenant.status === "active";
  const isProvisioning = tenant.status === "pending" || tenant.status === "provisioning";
  const hasCustomKey = !!tenant.anthropic_api_key;
  const hasAgentmailKey = !!tenant.agentmail_api_key;
  const allDone = connected.has("slack") && connected.has("linear") && connected.has("github");

  const linearUrl = `${c.env.BASE_URL}/oauth/linear/install?tenant_id=${teamId}`;
  const githubUrl = `${c.env.BASE_URL}/oauth/github/install?tenant_id=${teamId}`;

  const body = `
    <h1>Welcome, ${escapeHtml(tenant.name)}</h1>
    <p class="subtitle">
      Connect your tools to finish setting up Vera.
    </p>
    <div class="steps">
      <div class="step connected">
        <div class="step-number">✓</div>
        <div class="step-body">
          <div class="step-title">Slack</div>
          <div class="step-desc">Connected</div>
        </div>
        <span class="badge badge-ok">Done</span>
      </div>

      ${
        isProvisioning
          ? `<div class="step active">
              <div class="step-number">⏳</div>
              <div class="step-body">
                <div class="step-title">Provisioning your instance</div>
                <div class="provisioning">
                  <div class="spinner"></div>
                  Setting up your Fly machine…
                </div>
              </div>
            </div>`
          : ""
      }

      <div class="step ${connected.has("linear") ? "connected" : isActive ? "active" : "disabled"}">
        <div class="step-number">${connected.has("linear") ? "✓" : "2"}</div>
        <div class="step-body">
          <div class="step-title">Linear</div>
          <div class="step-desc">${connected.has("linear") ? "Connected" : "Issue tracking and project management"}</div>
        </div>
        ${
          connected.has("linear")
            ? `<span class="badge badge-ok">Done</span>`
            : isActive
              ? `<a href="${linearUrl}" class="btn btn-primary">Connect</a>`
              : ""
        }
      </div>

      <div class="step ${connected.has("github") ? "connected" : isActive ? "active" : "disabled"}">
        <div class="step-number">${connected.has("github") ? "✓" : "3"}</div>
        <div class="step-body">
          <div class="step-title">GitHub</div>
          <div class="step-desc">${connected.has("github") ? "Connected" : "Code repositories and pull requests"}</div>
        </div>
        ${
          connected.has("github")
            ? `<span class="badge badge-ok">Done</span>`
            : isActive
              ? `<a href="${githubUrl}" class="btn btn-primary">Connect</a>`
              : ""
        }
      </div>

      <div class="step ${hasCustomKey ? "connected" : isActive ? "active" : "disabled"}">
        <div class="step-number">${hasCustomKey ? "✓" : "⚙"}</div>
        <div class="step-body">
          <div class="step-title">Anthropic API Key <span class="step-optional">Optional</span></div>
          <div class="step-desc">${hasCustomKey ? "Custom key configured" : `Using shared key — <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener" style="color:#888;text-decoration:underline">get your key from the Anthropic Console</a> or run <code style="background:#1a1a1a;padding:2px 6px;border-radius:4px;font-size:12px">claude auth</code> in your terminal`}</div>
          ${
            isActive && !hasCustomKey
              ? `<form class="key-form" onsubmit="saveKey(event)">
                  <input type="password" class="key-input" id="anthropic-key" placeholder="sk-ant-..." required />
                  <button type="submit" class="btn btn-primary">Save</button>
                </form>`
              : ""
          }
        </div>
        ${hasCustomKey ? `<button class="btn btn-danger" onclick="removeKey()">Reset</button>` : ""}
      </div>

      <div class="step ${hasAgentmailKey ? "connected" : isActive ? "active" : "disabled"}">
        <div class="step-number">${hasAgentmailKey ? "✓" : "⚙"}</div>
        <div class="step-body">
          <div class="step-title">AgentMail API Key <span class="step-optional">Optional</span></div>
          <div class="step-desc">${hasAgentmailKey ? "Custom key configured" : "Enable AgentMail integration for this tenant"}</div>
          ${
            isActive && !hasAgentmailKey
              ? `<form class="key-form" onsubmit="saveAgentmailKey(event)">
                  <input type="password" class="key-input" id="agentmail-key" placeholder="am_..." required />
                  <button type="submit" class="btn btn-primary">Save</button>
                </form>`
              : ""
          }
        </div>
        ${hasAgentmailKey ? `<button class="btn btn-danger" onclick="removeAgentmailKey()">Reset</button>` : ""}
      </div>
    </div>

    ${allDone ? `<div class="done-banner">All integrations connected — Vera is ready to go.</div>` : ""}

    ${
      isProvisioning
        ? `<script>
            (async function poll() {
              while (true) {
                await new Promise(r => setTimeout(r, 3000));
                try {
                  const res = await fetch(location.pathname + "/status");
                  const data = await res.json();
                  if (data.status === "active") { location.reload(); return; }
                } catch {}
              }
            })();
          </script>`
        : ""
    }

    ${
      isActive
        ? `<script>
            async function saveKey(e) {
              e.preventDefault();
              const key = document.getElementById('anthropic-key').value;
              const res = await fetch(location.pathname + '/anthropic-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: key }),
              });
              if (res.ok) { location.reload(); }
              else { const d = await res.json(); alert(d.error || 'Failed to save key'); }
            }
            async function removeKey() {
              if (!confirm('Reset to shared key?')) return;
              const res = await fetch(location.pathname + '/anthropic-key', { method: 'DELETE' });
              if (res.ok) { location.reload(); }
              else { alert('Failed to remove key'); }
            }
            async function saveAgentmailKey(e) {
              e.preventDefault();
              const key = document.getElementById('agentmail-key').value;
              const res = await fetch(location.pathname + '/agentmail-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: key }),
              });
              if (res.ok) { location.reload(); }
              else { const d = await res.json(); alert(d.error || 'Failed to save key'); }
            }
            async function removeAgentmailKey() {
              if (!confirm('Remove AgentMail key?')) return;
              const res = await fetch(location.pathname + '/agentmail-key', { method: 'DELETE' });
              if (res.ok) { location.reload(); }
              else { alert('Failed to remove key'); }
            }
          </script>`
        : ""
    }`;
  return c.html(layout("Army — Setup", body));
});

// ─── Status polling endpoint ────────────────────────────────────

onboarding.get("/:team_id/status", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);
  const [tenant] = await sql`SELECT status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "not_found" }, 404);
  return c.json({ status: tenant.status });
});

// ─── Anthropic API key BYOK ─────────────────────────────────────

onboarding.post("/:team_id/anthropic-key", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const body = await c.req.json<{ api_key?: string }>();
  if (!body.api_key || typeof body.api_key !== "string" || !body.api_key.startsWith("sk-ant-")) {
    return c.json({ error: "Invalid API key — must start with sk-ant-" }, 400);
  }

  const [tenant] = await sql`SELECT id, status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  await sql`UPDATE tenants SET anthropic_api_key = ${body.api_key}, updated_at = now() WHERE id = ${teamId}`;

  if (tenant.status === "active") {
    c.executionCtx.waitUntil(
      pushCredentials(c.env, teamId).catch((err) =>
        console.error(`pushCredentials failed after BYOK set for ${teamId}:`, err),
      ),
    );
  }

  return c.json({ success: true, status: "custom_key_set" });
});

onboarding.delete("/:team_id/anthropic-key", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT id, status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  await sql`UPDATE tenants SET anthropic_api_key = NULL, updated_at = now() WHERE id = ${teamId}`;

  if (tenant.status === "active") {
    c.executionCtx.waitUntil(
      pushCredentials(c.env, teamId).catch((err) =>
        console.error(`pushCredentials failed after BYOK reset for ${teamId}:`, err),
      ),
    );
  }

  return c.json({ success: true, status: "using_default" });
});

// ─── AgentMail API key BYOK ─────────────────────────────────────

onboarding.post("/:team_id/agentmail-key", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const body = await c.req.json<{ api_key?: string }>();
  if (!body.api_key || typeof body.api_key !== "string" || body.api_key.trim().length === 0) {
    return c.json({ error: "Invalid API key" }, 400);
  }

  const [tenant] = await sql`SELECT id, status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  await sql`UPDATE tenants SET agentmail_api_key = ${body.api_key}, updated_at = now() WHERE id = ${teamId}`;

  if (tenant.status === "active") {
    c.executionCtx.waitUntil(
      pushCredentials(c.env, teamId).catch((err) =>
        console.error(`pushCredentials failed after AgentMail key set for ${teamId}:`, err),
      ),
    );
  }

  return c.json({ success: true, status: "agentmail_key_set" });
});

onboarding.delete("/:team_id/agentmail-key", async (c) => {
  const teamId = c.req.param("team_id");
  const sql = getDb(c.env);

  const [tenant] = await sql`SELECT id, status FROM tenants WHERE id = ${teamId}`;
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  await sql`UPDATE tenants SET agentmail_api_key = NULL, updated_at = now() WHERE id = ${teamId}`;

  if (tenant.status === "active") {
    c.executionCtx.waitUntil(
      pushCredentials(c.env, teamId).catch((err) =>
        console.error(`pushCredentials failed after AgentMail key reset for ${teamId}:`, err),
      ),
    );
  }

  return c.json({ success: true, status: "agentmail_key_removed" });
});

// ─── Helper ─────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default onboarding;
