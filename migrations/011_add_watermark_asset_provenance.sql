ALTER TABLE assets ADD COLUMN generated_by TEXT;
ALTER TABLE assets ADD COLUMN generated_source_asset_id INTEGER;
ALTER TABLE assets ADD COLUMN generated_mode TEXT;
ALTER TABLE assets ADD COLUMN generated_source_relative_path TEXT;
ALTER TABLE assets ADD COLUMN generated_output_sha256 TEXT;
