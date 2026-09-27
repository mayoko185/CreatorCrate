-- Normalized generated-image publication state (schema only).
--
-- These tables are the future SQLite representation of the per-asset preview
-- cache publication that is currently witnessed by current.json and the
-- revision-local meta.json. This migration creates empty tables: it performs
-- no filesystem traversal and no backfill. Nothing reads or writes them yet.
--
-- No absolute path, URL, ETag, or freshness result is stored; paths are
-- derived from configured roots, project/asset IDs, and directory basenames.

-- One committed publication per asset. Nullable columns preserve the absence
-- of optional legacy meta.json fields rather than inventing defaults.
CREATE TABLE generated_image_publications (
    asset_id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    directory_name TEXT NOT NULL,
    revision TEXT NOT NULL,
    generated_at TEXT NOT NULL CHECK (length(generated_at) > 0),
    cache_schema_version INTEGER NOT NULL CHECK (cache_schema_version >= 1),
    derivative_config_version INTEGER NOT NULL CHECK (derivative_config_version >= 1),
    source_relative_path TEXT NOT NULL CHECK (length(source_relative_path) > 0),
    source_size_bytes INTEGER NOT NULL CHECK (source_size_bytes >= 0),
    source_mtime TEXT NOT NULL CHECK (length(source_mtime) > 0),
    source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
    policy_fingerprint TEXT CHECK (
        policy_fingerprint IS NULL
        OR (length(policy_fingerprint) = 16 AND policy_fingerprint NOT GLOB '*[^0-9a-f]*')
    ),
    animated INTEGER CHECK (animated IS NULL OR animated IN (0, 1)),
    frame_count INTEGER CHECK (frame_count IS NULL OR frame_count >= 1),
    source_preview_quality TEXT CHECK (
        source_preview_quality IS NULL OR source_preview_quality IN ('merged', 'thumbnail')
    ),
    generation_identity_version INTEGER CHECK (
        generation_identity_version IS NULL OR generation_identity_version >= 1
    ),
    CONSTRAINT generated_image_publications_revision CHECK (
        length(revision) = 16 AND revision NOT GLOB '*[^0-9a-f]*'
    ),
    CONSTRAINT generated_image_publications_directory CHECK (
        substr(directory_name, 1, 19) = 'r-' || revision || '-'
        AND length(directory_name) > 19
        AND substr(directory_name, 20) NOT GLOB '*[^0-9a-f]*'
    ),
    FOREIGN KEY (project_id, asset_id)
        REFERENCES assets(project_id, id)
        ON DELETE CASCADE
);

-- The derivative pair of the committed publication, one row per kind.
-- Completeness of the pair is enforced by the repository, not by the schema.
CREATE TABLE generated_image_derivatives (
    asset_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('thumbnail', 'preview')),
    format TEXT NOT NULL CHECK (format IN ('webp', 'png')),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    generation_identity TEXT CHECK (
        generation_identity IS NULL
        OR (length(generation_identity) = 16 AND generation_identity NOT GLOB '*[^0-9a-f]*')
    ),
    PRIMARY KEY (asset_id, kind),
    FOREIGN KEY (asset_id)
        REFERENCES generated_image_publications(asset_id)
        ON DELETE CASCADE
);

-- At most one unresolved candidate publication per asset. Writer/recovery
-- coordination state only: an intent never hides the committed publication.
CREATE TABLE generated_image_publication_intents (
    asset_id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    intent_id TEXT NOT NULL UNIQUE CHECK (length(intent_id) > 0),
    candidate_directory_name TEXT NOT NULL,
    staging_directory_name TEXT NOT NULL CHECK (
        length(staging_directory_name) > 4
        AND substr(staging_directory_name, 1, 4) = 'tmp-'
        AND substr(staging_directory_name, 5) NOT GLOB '*[^0-9a-f]*'
    ),
    expected_revision TEXT NOT NULL,
    previous_directory_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT generated_image_publication_intents_revision CHECK (
        length(expected_revision) = 16 AND expected_revision NOT GLOB '*[^0-9a-f]*'
    ),
    CONSTRAINT generated_image_publication_intents_candidate CHECK (
        substr(candidate_directory_name, 1, 19) = 'r-' || expected_revision || '-'
        AND length(candidate_directory_name) > 19
        AND substr(candidate_directory_name, 20) NOT GLOB '*[^0-9a-f]*'
    ),
    CONSTRAINT generated_image_publication_intents_previous CHECK (
        previous_directory_name IS NULL
        OR (
            previous_directory_name <> candidate_directory_name
            AND length(previous_directory_name) > 2
            AND substr(previous_directory_name, 1, 2) = 'r-'
            AND previous_directory_name NOT GLOB '*[^0-9a-fr-]*'
        )
    ),
    FOREIGN KEY (project_id, asset_id)
        REFERENCES assets(project_id, id)
        ON DELETE CASCADE
);
