-- Phase 12.1: server-side session storage for single-operator authentication.
-- `id` stores an HMAC(session_secret, token) hex digest, never the raw
-- session token, so a database leak alone never yields a usable cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
