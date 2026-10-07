-- Processing recovery evidence (schema only).
--
-- SQLite is the serving authority for what CreatorCrate believes about the
-- private evidence a processing run created or retained. It is NEVER deletion
-- authority: a row only names what a later, targeted exact-identity check of
-- the filesystem may prove. No row is created, backfilled, or pruned here, and
-- this migration performs no filesystem access.
--
-- A mutation group is one unit of processing work (one item of one run) that
-- may own several evidence artifacts. Its checkpoint is written durably before
-- a public create/replace/unlink/restore begins, independently of whether any
-- artifact has an established identity yet, so a crash after the checkpoint
-- is visible as "mutation may have begun".
--
-- Evidence rows exist only while unresolved: a positively cleaned artifact's
-- row is deleted, so there is no history or tombstone state. Paths are
-- project-relative (resolved only inside the already-trusted project root).
-- Exact filesystem identity (dev, ino, birth time in ns) is unsigned decimal
-- TEXT because the values can exceed the exact range of INTEGER/REAL as seen
-- by JavaScript. Timestamps are ISO-8601 UTC text from the application clock.
--
-- Evidence lives inside the project directory, so project deletion cascades
-- like other project-owned rows. Asset deletion never erases evidence: the
-- asset link becomes NULL and the row survives.

CREATE TABLE processing_recovery_mutation_groups (
    group_id TEXT PRIMARY KEY CHECK (length(group_id) BETWEEN 1 AND 128),
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    operation TEXT NOT NULL
        CHECK (operation IN ('workflow-prompt', 'watermark', 'archive', 'convert')),
    run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128),
    item_key TEXT CHECK (item_key IS NULL OR length(item_key) BETWEEN 1 AND 256),
    checkpoint TEXT
        CHECK (checkpoint IS NULL OR checkpoint IN ('public-create', 'replace', 'unlink', 'restore')),
    checkpoint_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((checkpoint IS NULL) = (checkpoint_at IS NULL)),
    -- Target of the evidence table's composite key, which pins every evidence
    -- row to its group's project.
    UNIQUE (group_id, project_id)
);

CREATE INDEX idx_processing_recovery_mutation_groups_run
    ON processing_recovery_mutation_groups(project_id, run_id);

CREATE TABLE processing_recovery_evidence (
    evidence_id TEXT PRIMARY KEY CHECK (length(evidence_id) BETWEEN 1 AND 128),
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    mutation_group_id TEXT NOT NULL,
    asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
    artifact_role TEXT NOT NULL CHECK (length(artifact_role) BETWEEN 1 AND 64),
    retention_reason TEXT NOT NULL CHECK (length(retention_reason) BETWEEN 1 AND 64),
    artifact_path TEXT NOT NULL CHECK (length(artifact_path) BETWEEN 1 AND 1024),
    source_path TEXT CHECK (source_path IS NULL OR length(source_path) BETWEEN 1 AND 1024),
    destination_path TEXT CHECK (destination_path IS NULL OR length(destination_path) BETWEEN 1 AND 1024),
    identity_dev TEXT CHECK (identity_dev IS NULL OR (
        length(identity_dev) BETWEEN 1 AND 20 AND identity_dev NOT GLOB '*[^0-9]*'
    )),
    identity_ino TEXT CHECK (identity_ino IS NULL OR (
        length(identity_ino) BETWEEN 1 AND 20 AND identity_ino NOT GLOB '*[^0-9]*'
    )),
    identity_birthtime_ns TEXT CHECK (identity_birthtime_ns IS NULL OR (
        length(identity_birthtime_ns) BETWEEN 1 AND 30 AND identity_birthtime_ns NOT GLOB '*[^0-9]*'
    )),
    expected_size INTEGER CHECK (expected_size IS NULL OR expected_size >= 0),
    expected_sha256 TEXT CHECK (expected_sha256 IS NULL OR (
        length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
    )),
    lifecycle TEXT NOT NULL
        CHECK (lifecycle IN ('intent', 'recovery-critical', 'dispensable')),
    observation TEXT NOT NULL DEFAULT 'unchecked' CHECK (observation IN (
        'unchecked', 'present', 'missing', 'replaced', 'changed', 'unavailable', 'ownership-unknown'
    )),
    observed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- dev and ino are one identity: both known or both unknown. A birth time
    -- only qualifies an established identity.
    CHECK ((identity_dev IS NULL) = (identity_ino IS NULL)),
    CHECK (identity_birthtime_ns IS NULL OR identity_dev IS NOT NULL),
    CHECK ((observation = 'unchecked') = (observed_at IS NULL)),
    FOREIGN KEY (mutation_group_id, project_id)
        REFERENCES processing_recovery_mutation_groups(group_id, project_id)
);

CREATE INDEX idx_processing_recovery_evidence_project
    ON processing_recovery_evidence(project_id, lifecycle);

CREATE INDEX idx_processing_recovery_evidence_group
    ON processing_recovery_evidence(mutation_group_id);

CREATE INDEX idx_processing_recovery_evidence_asset
    ON processing_recovery_evidence(asset_id)
    WHERE asset_id IS NOT NULL;
