-- Durable recovery opportunities for Page deletion Undo.
--
-- A row commits in the same transaction as the Page deletion it describes and
-- lets the owner restore that Page, with its original identity, until
-- expires_at. Timestamps are UTC epoch milliseconds from the application clock.
--
-- States: active (snapshot_json present, restored_at NULL), restored
-- (restored_at set, snapshot_json NULL), expired (both NULL). Restored and
-- expired rows are minimal receipts removed by opportunistic cleanup.
--
-- There are deliberately no foreign keys to live records: the Page is gone by
-- definition, and its Book or Chapter may be removed before the opportunity
-- expires. Restoration re-validates every live dependency instead.
--
-- id and owner_key are server-generated lowercase hex SHA-256-sized values.
-- The Undo token is derived on demand and is never stored here.
CREATE TABLE note_deletion_snapshots (
    id TEXT PRIMARY KEY
        CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
    owner_key TEXT NOT NULL
        CHECK (length(owner_key) = 64 AND owner_key NOT GLOB '*[^0-9a-f]*'),
    note_id INTEGER NOT NULL CHECK (typeof(note_id) = 'integer' AND note_id > 0),
    book_id INTEGER NOT NULL CHECK (typeof(book_id) = 'integer' AND book_id > 0),
    chapter_id INTEGER
        CHECK (chapter_id IS NULL OR (typeof(chapter_id) = 'integer' AND chapter_id > 0)),
    created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
    expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer'),
    restored_at INTEGER
        CHECK (restored_at IS NULL OR (typeof(restored_at) = 'integer' AND restored_at >= 0)),
    snapshot_version INTEGER NOT NULL
        CHECK (typeof(snapshot_version) = 'integer' AND snapshot_version >= 1),
    snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
    CHECK (expires_at > created_at),
    CHECK (restored_at IS NULL OR snapshot_json IS NULL)
);

CREATE INDEX note_deletion_snapshots_expires_at_idx
    ON note_deletion_snapshots (expires_at);

CREATE INDEX note_deletion_snapshots_owner_note_created_idx
    ON note_deletion_snapshots (owner_key, note_id, created_at);
