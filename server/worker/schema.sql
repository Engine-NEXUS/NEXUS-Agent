-- NEXUS D1 Database Schema
-- Cloudflare D1 (free: 5GB storage, 5M reads/day, 100K writes/day)
--
-- Stores OAuth tokens and API keys for all NEXUS users.
-- The Worker reads/writes this database. No server needed.

-- OAuth tokens (Google, GitHub)
CREATE TABLE IF NOT EXISTS oauth_tokens (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at REAL,          -- unix timestamp, 0 = no expiry
  scopes TEXT,
  account_id TEXT,          -- GitHub login or Google email
  created_at REAL NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- API keys (Claude, Devin, etc.) — encrypted at rest
CREATE TABLE IF NOT EXISTS api_keys (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  key_encrypted TEXT NOT NULL,
  created_at REAL NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- Device registration
CREATE TABLE IF NOT EXISTS user_devices (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT,
  os TEXT,
  device_token TEXT,
  created_at REAL NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_user ON user_devices(user_id);
