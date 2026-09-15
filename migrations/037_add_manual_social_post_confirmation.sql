ALTER TABLE social_prep_sessions
  ADD COLUMN manual_confirmation_expires_at TEXT;

CREATE TABLE release_social_platforms_new (
  release_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'starting', 'preparing', 'uploading', 'auth_required', 'prepared', 'staging', 'ready', 'posted', 'failed', 'cancelled')),
  detail_code TEXT,
  message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  prepared_at TEXT,
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((status = 'posted' AND posted_at IS NOT NULL)
    OR (status <> 'posted' AND posted_at IS NULL)),
  PRIMARY KEY (release_id, platform),
  FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES social_prep_sessions(id) ON DELETE SET NULL
);

INSERT INTO release_social_platforms_new (
  release_id, platform, session_id, status, detail_code, message, attempts,
  prepared_at, posted_at, created_at, updated_at
)
SELECT
  release_id, platform, session_id, status, detail_code, message, attempts,
  prepared_at, NULL, created_at, updated_at
FROM release_social_platforms;

DROP TABLE release_social_platforms;
ALTER TABLE release_social_platforms_new RENAME TO release_social_platforms;

CREATE INDEX idx_release_social_platforms_session_status
  ON release_social_platforms(session_id, status);
