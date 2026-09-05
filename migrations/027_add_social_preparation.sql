CREATE TABLE social_prep_sessions (
  id TEXT PRIMARY KEY,
  release_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'retry', 'reprepare')),
  state TEXT NOT NULL CHECK (state IN ('issued', 'redeemed', 'finished', 'expired', 'superseded')),
  intent_hash TEXT,
  media_token_hash TEXT,
  redeemed_at TEXT,
  attempt_deadline_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
);

-- A release may have at most one invitation that is still capable of being
-- redeemed. Terminal session rows remain as its audit trail.
CREATE UNIQUE INDEX idx_social_prep_sessions_one_live_release
  ON social_prep_sessions(release_id)
  WHERE state IN ('issued', 'redeemed');

CREATE INDEX idx_social_prep_sessions_release_id
  ON social_prep_sessions(release_id);

CREATE TABLE release_social_platforms (
  release_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'starting', 'preparing', 'uploading', 'auth_required', 'prepared', 'failed', 'cancelled')),
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

CREATE INDEX idx_release_social_platforms_session_status
  ON release_social_platforms(session_id, status);

-- These records are immutable session snapshots. asset_id and project_id
-- deliberately have no foreign keys: snapshots must outlive source-asset or
-- project deletion. Safety relies on assets.id INTEGER PRIMARY KEY
-- AUTOINCREMENT, whose IDs are never reused after deletion.
CREATE TABLE social_prep_session_assets (
  session_id TEXT NOT NULL,
  asset_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'preview', 'attachment')),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  relative_path TEXT NOT NULL,
  nested_path TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL,
  extension TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  is_present INTEGER NOT NULL CHECK (is_present IN (0, 1)),
  PRIMARY KEY (session_id, asset_id),
  FOREIGN KEY (session_id) REFERENCES social_prep_sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_social_prep_session_assets_session_sort
  ON social_prep_session_assets(session_id, sort_order, asset_id);
