-- Application-controlled source generation: distinguishes logically different
-- source-file instances when the persisted path/size/mtime tuple alone cannot.
-- Existing and newly inserted assets start at 0; it only ever increments.
ALTER TABLE assets
  ADD COLUMN source_generation INTEGER NOT NULL DEFAULT 0 CHECK (source_generation >= 0);
