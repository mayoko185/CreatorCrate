-- Project-local Watermark provenance is separate from the transitional
-- managed-watermark registry identity. Source deletion must not delete the
-- generated output, so both references use SET NULL semantics.
ALTER TABLE assets ADD COLUMN generated_watermark_asset_id
  INTEGER REFERENCES assets(id) ON DELETE SET NULL;

ALTER TABLE generated_artifacts ADD COLUMN generated_watermark_asset_id
  INTEGER REFERENCES assets(id) ON DELETE SET NULL;

CREATE INDEX idx_assets_generated_watermark_asset
  ON assets(generated_watermark_asset_id)
  WHERE generated_watermark_asset_id IS NOT NULL;

CREATE INDEX idx_generated_artifacts_generated_watermark_asset
  ON generated_artifacts(generated_watermark_asset_id)
  WHERE generated_watermark_asset_id IS NOT NULL;
