-- migrate:up
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  slack_user_id   TEXT NOT NULL,
  slack_team_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           TEXT,
  name            TEXT,
  avatar_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slack ON users(slack_team_id, slack_user_id);
CREATE INDEX IF NOT EXISTS idx_users_team ON users(slack_team_id);

-- migrate:down
DROP INDEX IF EXISTS idx_users_team;
DROP INDEX IF EXISTS idx_users_slack;
DROP TABLE IF EXISTS users;
