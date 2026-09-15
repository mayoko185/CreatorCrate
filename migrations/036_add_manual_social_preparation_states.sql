-- Extend the Social Preparation platform vocabulary for the native manual
-- companion. Legacy status values and prepared_at retain their original
-- browser-preparation meaning.
CREATE TABLE release_social_platforms_new (
  release_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'starting', 'preparing', 'uploading', 'auth_required', 'prepared', 'staging', 'ready', 'failed', 'cancelled')),
  detail_code TEXT,
  message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  prepared_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (release_id, platform),
  FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES social_prep_sessions(id) ON DELETE SET NULL
);

INSERT INTO release_social_platforms_new (
  release_id, platform, session_id, status, detail_code, message, attempts,
  prepared_at, created_at, updated_at
)
SELECT
  release_id, platform, session_id, status, detail_code, message, attempts,
  prepared_at, created_at, updated_at
FROM release_social_platforms;

DROP TABLE release_social_platforms;
ALTER TABLE release_social_platforms_new RENAME TO release_social_platforms;

CREATE INDEX idx_release_social_platforms_session_status
  ON release_social_platforms(session_id, status);
