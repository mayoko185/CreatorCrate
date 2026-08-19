DROP INDEX IF EXISTS idx_assets_generated_watermark_asset;
DROP INDEX IF EXISTS idx_generated_artifacts_generated_watermark_asset;

ALTER TABLE assets DROP COLUMN generated_watermark_asset_id;
ALTER TABLE generated_artifacts DROP COLUMN generated_watermark_asset_id;
