import { Hono } from "hono";
import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";

const oauth = new Hono<{ Bindings: ControlPlaneEnv }>();

// ── Slack OAuth callback ─────────────────────────────────────────
oauth.get("/slack/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.text("Missing code", 400);

  const resp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.SLACK_CLIENT_ID,
      client_secret: c.env.SLACK_CLIENT_SECRET,
      code,
    }),
  });

  const data = (await resp.json()) as Record<string, unknown>;
  if (!data.ok) return c.json({ error: "OAuth failed", detail: data }, 400);

  const teamId = (data.team as Record<string, string>).id;
  const teamName = (data.team as Record<string, string>).name;
  const accessToken = (data.access_token as string) ?? "";

  const sql = getDb(c.env);

  // Upsert tenant
  await sql`
    INSERT INTO tenants (id, name, platform, status)
    VALUES (${teamId}, ${teamName}, 'slack', 'pending')
    ON CONFLICT (id) DO UPDATE SET name = ${teamName}, updated_at = now()
  `;

  // Store token
  await sql`
    INSERT INTO integration_tokens (tenant_id, platform, access_token)
    VALUES (${teamId}, 'slack', ${accessToken})
  `;

  return c.text(`Slack workspace "${teamName}" connected. Provisioning will begin shortly.`);
});

// TODO: Linear and GitHub OAuth callbacks

export default oauth;
