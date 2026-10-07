-- Durable filesystem provenance for generated outputs (Watermark assets and
-- generated artifacts).
--
-- A generated row plus a matching content hash proves only that the bytes at
-- a path equal a prior CreatorCrate result; it never proves that the current
-- filesystem object is the one CreatorCrate published. This column records
-- the exact identity of the object CreatorCrate itself published, captured at
-- the publication boundary under strict (exact bigint dev/ino) proof:
--
--     v1:<dev>:<ino>:<birthtimeNs>   (unsigned decimal, exact bigint values)
--
-- Only a destination whose current exact identity equals this value may be
-- unlinked or replaced by a later run. NULL means ownership is unproven: a
-- content-verified (e.g. CIFS alias) publication records NULL, and existing
-- rows are deliberately NOT backfilled from their current path, because that
-- would trust whatever file happens to be there now.
ALTER TABLE assets ADD COLUMN generated_output_provenance TEXT CHECK (
  generated_output_provenance IS NULL
  OR (
    substr(generated_output_provenance, 1, 3) = 'v1:'
    AND length(generated_output_provenance) BETWEEN 8 AND 80
    AND substr(generated_output_provenance, 4) NOT GLOB '*[^0-9:]*'
  )
);

ALTER TABLE generated_artifacts ADD COLUMN output_provenance TEXT CHECK (
  output_provenance IS NULL
  OR (
    substr(output_provenance, 1, 3) = 'v1:'
    AND length(output_provenance) BETWEEN 8 AND 80
    AND substr(output_provenance, 4) NOT GLOB '*[^0-9:]*'
  )
);
