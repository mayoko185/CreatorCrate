-- Phase 12.2: CSRF protection requires a per-session secret stored alongside
-- the session row. The secret is used to derive CSRF tokens (HMAC-SHA256),
-- so revoking the session (which deletes the row) also invalidates all tokens.
ALTER TABLE sessions ADD COLUMN csrf_secret TEXT NOT NULL DEFAULT '';