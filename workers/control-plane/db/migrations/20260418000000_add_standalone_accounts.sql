-- migrate:up
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email         TEXT,
  name          TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_identities (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  provider_user_id    TEXT NOT NULL,
  provider_email      TEXT,
  provider_name       TEXT,
  provider_avatar_url TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_identities_provider_subject
  ON account_identities(provider, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_account_identities_account
  ON account_identities(account_id);

-- migrate:down
DROP INDEX IF EXISTS idx_account_identities_account;
DROP INDEX IF EXISTS idx_account_identities_provider_subject;
DROP TABLE IF EXISTS account_identities;
DROP TABLE IF EXISTS accounts;
