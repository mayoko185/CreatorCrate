ALTER TABLE generated_image_publications ADD COLUMN source_input_fingerprint TEXT
  CHECK (source_input_fingerprint IS NULL OR
    (typeof(source_input_fingerprint) = 'text' AND length(source_input_fingerprint) = 64
      AND source_input_fingerprint NOT GLOB '*[^0-9a-f]*'));
