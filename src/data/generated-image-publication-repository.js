import crypto from 'node:crypto';
import { isValidRevisionDirName, isValidStagingDirName } from '../storage/preview-cache.js';

/**
 * Generated-image publication repository — normalized SQLite state for the
 * committed thumbnail/preview publication of an asset and for unresolved
 * candidate publication intents.
 *
 * A committed publication is always read and written as one complete
 * snapshot: the parent row plus exactly one `thumbnail` and one `preview`
 * derivative. A publication intent is writer/recovery coordination state; it
 * never hides the committed snapshot from readers.
 *
 * No filesystem work happens here. Paths are derived elsewhere from
 * configured roots, IDs, and the stored directory basenames.
 */

export const GENERATED_IMAGE_DERIVATIVE_KINDS = Object.freeze(['thumbnail', 'preview']);
const DERIVATIVE_FORMATS = new Set(['webp', 'png']);
const SOURCE_PREVIEW_QUALITIES = new Set(['merged', 'thumbnail']);
const HEX16_RE = /^[0-9a-f]{16}$/;

export class InvalidGeneratedImagePublicationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidGeneratedImagePublicationError';
  }
}

function invalid(message) {
  throw new InvalidGeneratedImagePublicationError(message);
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${name} must be a positive integer.`);
  return value;
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${name} must be a nonnegative integer.`);
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) invalid(`${name} must be a non-empty string.`);
  return value;
}

function nullable(value, validate) {
  return value === undefined || value === null ? null : validate(value);
}

function requireRevision(value, name) {
  if (typeof value !== 'string' || !HEX16_RE.test(value)) invalid(`${name} is invalid.`);
  return value;
}

function requireRevisionDirectory(value, revision, name) {
  if (!isValidRevisionDirName(value) || !value.startsWith(`r-${revision}-`)) {
    invalid(`${name} is invalid.`);
  }
  return value;
}

function normalizeDerivative(input, kind) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid(`${kind} derivative is missing.`);
  }
  if (!DERIVATIVE_FORMATS.has(input.format)) invalid(`${kind} derivative format is unsupported.`);
  return Object.freeze({
    format: input.format,
    width: requirePositiveInteger(input.width, `${kind} width`),
    height: requirePositiveInteger(input.height, `${kind} height`),
    sizeBytes: requireNonNegativeInteger(input.sizeBytes, `${kind} sizeBytes`),
    generationIdentity: nullable(input.generationIdentity, (value) => {
      if (typeof value !== 'string' || !HEX16_RE.test(value)) invalid(`${kind} generation identity is invalid.`);
      return value;
    }),
  });
}

/**
 * Validate and normalize a complete committed-publication snapshot. This is
 * the one canonical representation used for writes and returned by reads.
 * Optional legacy fields normalize `undefined` to `null`; they are never
 * replaced with invented defaults.
 *
 * @returns {Readonly<{
 *   projectId: number, assetId: number, directoryName: string, revision: string,
 *   generatedAt: string, cacheSchemaVersion: number, derivativeConfigVersion: number,
 *   sourceRelativePath: string, sourceSizeBytes: number, sourceMtime: string,
 *   sourceGeneration: number, policyFingerprint: string|null, animated: boolean|null,
 *   frameCount: number|null, sourcePreviewQuality: 'merged'|'thumbnail'|null,
 *   generationIdentityVersion: number|null,
 *   derivatives: Readonly<{ thumbnail: object, preview: object }>,
 * }>}
 * @throws {InvalidGeneratedImagePublicationError}
 */
export function normalizeGeneratedImagePublication(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid('Publication must be an object.');
  }
  const revision = requireRevision(input.revision, 'revision');
  const derivativesInput = input.derivatives;
  if (typeof derivativesInput !== 'object' || derivativesInput === null || Array.isArray(derivativesInput)) {
    invalid('Publication derivatives are missing.');
  }
  const kinds = Object.keys(derivativesInput);
  if (kinds.length !== GENERATED_IMAGE_DERIVATIVE_KINDS.length
    || !GENERATED_IMAGE_DERIVATIVE_KINDS.every((kind) => kinds.includes(kind))) {
    invalid('Publication must contain exactly the thumbnail and preview derivatives.');
  }
  const derivatives = Object.freeze({
    thumbnail: normalizeDerivative(derivativesInput.thumbnail, 'thumbnail'),
    preview: normalizeDerivative(derivativesInput.preview, 'preview'),
  });

  const generationIdentityVersion = nullable(
    input.generationIdentityVersion,
    (value) => requirePositiveInteger(value, 'generationIdentityVersion'),
  );
  // Identities are all-or-none, as in meta.json: a partial set is never proof.
  const identityCount = GENERATED_IMAGE_DERIVATIVE_KINDS
    .filter((kind) => derivatives[kind].generationIdentity !== null).length;
  if (generationIdentityVersion === null ? identityCount !== 0 : identityCount !== 2) {
    invalid('Generation identities must be all present or all absent.');
  }

  return Object.freeze({
    projectId: requirePositiveInteger(input.projectId, 'projectId'),
    assetId: requirePositiveInteger(input.assetId, 'assetId'),
    directoryName: requireRevisionDirectory(input.directoryName, revision, 'directoryName'),
    revision,
    generatedAt: requireNonEmptyString(input.generatedAt, 'generatedAt'),
    cacheSchemaVersion: requirePositiveInteger(input.cacheSchemaVersion, 'cacheSchemaVersion'),
    derivativeConfigVersion: requirePositiveInteger(input.derivativeConfigVersion, 'derivativeConfigVersion'),
    sourceRelativePath: requireNonEmptyString(input.sourceRelativePath, 'sourceRelativePath'),
    sourceSizeBytes: requireNonNegativeInteger(input.sourceSizeBytes, 'sourceSizeBytes'),
    sourceMtime: requireNonEmptyString(input.sourceMtime, 'sourceMtime'),
    sourceGeneration: requireNonNegativeInteger(input.sourceGeneration, 'sourceGeneration'),
    policyFingerprint: nullable(input.policyFingerprint, (value) => {
      if (typeof value !== 'string' || !HEX16_RE.test(value)) invalid('policyFingerprint is invalid.');
      return value;
    }),
    animated: nullable(input.animated, (value) => {
      if (typeof value !== 'boolean') invalid('animated must be a boolean.');
      return value;
    }),
    frameCount: nullable(input.frameCount, (value) => requirePositiveInteger(value, 'frameCount')),
    sourcePreviewQuality: nullable(input.sourcePreviewQuality, (value) => {
      if (!SOURCE_PREVIEW_QUALITIES.has(value)) invalid('sourcePreviewQuality is invalid.');
      return value;
    }),
    generationIdentityVersion,
    derivatives,
  });
}

function normalizeIntentInput(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid('Publication intent must be an object.');
  }
  const expectedRevision = requireRevision(input.expectedRevision, 'expectedRevision');
  const candidateDirectoryName = requireRevisionDirectory(
    input.candidateDirectoryName, expectedRevision, 'candidateDirectoryName',
  );
  const previousDirectoryName = nullable(input.previousDirectoryName, (value) => {
    if (!isValidRevisionDirName(value) || value === candidateDirectoryName) {
      invalid('previousDirectoryName is invalid.');
    }
    return value;
  });
  if (!isValidStagingDirName(input.stagingDirectoryName)) invalid('stagingDirectoryName is invalid.');
  return {
    projectId: requirePositiveInteger(input.projectId, 'projectId'),
    assetId: requirePositiveInteger(input.assetId, 'assetId'),
    candidateDirectoryName,
    stagingDirectoryName: input.stagingDirectoryName,
    expectedRevision,
    previousDirectoryName,
  };
}

const PUBLICATION_COLUMNS = [
  'asset_id', 'project_id', 'directory_name', 'revision', 'generated_at',
  'cache_schema_version', 'derivative_config_version', 'source_relative_path',
  'source_size_bytes', 'source_mtime', 'source_generation', 'policy_fingerprint',
  'animated', 'frame_count', 'source_preview_quality', 'generation_identity_version',
];
const DERIVATIVE_COLUMNS = ['format', 'width', 'height', 'size_bytes', 'generation_identity'];
const INTENT_COLUMNS = [
  'asset_id', 'project_id', 'intent_id', 'candidate_directory_name',
  'staging_directory_name', 'expected_revision', 'previous_directory_name', 'created_at',
];
const SELECT_INTENTS = `SELECT ${INTENT_COLUMNS.join(', ')} FROM generated_image_publication_intents`;

function mapSnapshotRow(row) {
  const derivative = (prefix) => ({
    format: row[`${prefix}_format`],
    width: row[`${prefix}_width`],
    height: row[`${prefix}_height`],
    sizeBytes: row[`${prefix}_size_bytes`],
    generationIdentity: row[`${prefix}_generation_identity`],
  });
  return normalizeGeneratedImagePublication({
    projectId: row.project_id,
    assetId: row.asset_id,
    directoryName: row.directory_name,
    revision: row.revision,
    generatedAt: row.generated_at,
    cacheSchemaVersion: row.cache_schema_version,
    derivativeConfigVersion: row.derivative_config_version,
    sourceRelativePath: row.source_relative_path,
    sourceSizeBytes: row.source_size_bytes,
    sourceMtime: row.source_mtime,
    sourceGeneration: row.source_generation,
    policyFingerprint: row.policy_fingerprint,
    animated: row.animated === null ? null : row.animated === 1,
    frameCount: row.frame_count,
    sourcePreviewQuality: row.source_preview_quality,
    generationIdentityVersion: row.generation_identity_version,
    derivatives: { thumbnail: derivative('thumbnail'), preview: derivative('preview') },
  });
}

function mapIntentRow(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    assetId: row.asset_id,
    intentId: row.intent_id,
    candidateDirectoryName: row.candidate_directory_name,
    stagingDirectoryName: row.staging_directory_name,
    expectedRevision: row.expected_revision,
    previousDirectoryName: row.previous_directory_name,
    createdAt: row.created_at,
  };
}

/**
 * Create a generated-image publication repository bound to an existing
 * database handle. Only `finalizePublication` and `installPublication` open
 * their own transaction (a savepoint when already inside one); no method
 * performs async work.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function createGeneratedImagePublicationRepository(db) {
  const derivativeSelect = (alias) => DERIVATIVE_COLUMNS
    .map((column) => `${alias}.${column} AS ${alias === 't' ? 'thumbnail' : 'preview'}_${column}`)
    .join(', ');
  // One statement, so the parent and both children come from one read
  // snapshot. Inner joins mean an incomplete pair is never returned, and the
  // query deliberately ignores publication intents.
  const findSnapshotStmt = db.prepare(`
    SELECT ${PUBLICATION_COLUMNS.map((column) => `p.${column}`).join(', ')},
      ${derivativeSelect('t')}, ${derivativeSelect('v')}
    FROM generated_image_publications p
    JOIN generated_image_derivatives t ON t.asset_id = p.asset_id AND t.kind = 'thumbnail'
    JOIN generated_image_derivatives v ON v.asset_id = p.asset_id AND v.kind = 'preview'
    WHERE p.project_id = ? AND p.asset_id = ?
  `);
  const upsertPublicationStmt = db.prepare(`
    INSERT INTO generated_image_publications (${PUBLICATION_COLUMNS.join(', ')})
    VALUES (${PUBLICATION_COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT(asset_id) DO UPDATE SET
      ${PUBLICATION_COLUMNS.filter((column) => column !== 'asset_id')
        .map((column) => `${column} = excluded.${column}`).join(',\n      ')}
  `);
  const deleteDerivativesStmt = db.prepare('DELETE FROM generated_image_derivatives WHERE asset_id = ?');
  const insertDerivativeStmt = db.prepare(`
    INSERT INTO generated_image_derivatives (asset_id, kind, ${DERIVATIVE_COLUMNS.join(', ')})
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIntentStmt = db.prepare(`
    INSERT INTO generated_image_publication_intents (
      asset_id, project_id, intent_id, candidate_directory_name,
      staging_directory_name, expected_revision, previous_directory_name
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(asset_id) DO NOTHING
    RETURNING ${INTENT_COLUMNS.join(', ')}
  `);
  const findIntentStmt = db.prepare(`${SELECT_INTENTS} WHERE project_id = ? AND asset_id = ?`);
  const findOwnedIntentStmt = db.prepare(`${SELECT_INTENTS}
    WHERE project_id = ? AND asset_id = ? AND intent_id = ?`);
  const listIntentsStmt = db.prepare(`${SELECT_INTENTS} ORDER BY created_at ASC, asset_id ASC`);
  const deleteIntentStmt = db.prepare(`
    DELETE FROM generated_image_publication_intents
    WHERE project_id = ? AND asset_id = ? AND intent_id = ?
  `);

  const findPublicationRowStmt = db.prepare('SELECT 1 FROM generated_image_publications WHERE asset_id = ?');
  const findAssetOwnerStmt = db.prepare('SELECT 1 FROM assets WHERE project_id = ? AND id = ?');

  function writeSnapshot(publication) {
    const { projectId, assetId } = publication;
    upsertPublicationStmt.run(
      assetId, projectId, publication.directoryName, publication.revision,
      publication.generatedAt, publication.cacheSchemaVersion,
      publication.derivativeConfigVersion, publication.sourceRelativePath,
      publication.sourceSizeBytes, publication.sourceMtime, publication.sourceGeneration,
      publication.policyFingerprint,
      publication.animated === null ? null : Number(publication.animated),
      publication.frameCount, publication.sourcePreviewQuality,
      publication.generationIdentityVersion,
    );
    deleteDerivativesStmt.run(assetId);
    for (const kind of GENERATED_IMAGE_DERIVATIVE_KINDS) {
      const derivative = publication.derivatives[kind];
      insertDerivativeStmt.run(
        assetId, kind, derivative.format, derivative.width, derivative.height,
        derivative.sizeBytes, derivative.generationIdentity,
      );
    }
  }

  const finalizeTx = db.transaction((publication, intentId) => {
    const { projectId, assetId } = publication;
    const intent = findOwnedIntentStmt.get(projectId, assetId, intentId);
    if (!intent) return false;
    if (intent.candidate_directory_name !== publication.directoryName
      || intent.expected_revision !== publication.revision) {
      invalid('Publication does not match the candidate recorded by its intent.');
    }

    writeSnapshot(publication);
    if (deleteIntentStmt.run(projectId, assetId, intentId).changes !== 1) {
      throw new Error('Publication intent disappeared during finalization.');
    }
    return true;
  });

  // Maintenance import: only an asset with neither a committed publication
  // nor an unresolved intent may receive one, so a writer's (or recovery's)
  // snapshot is never replaced by an older imported one.
  const installTx = db.transaction((publication) => {
    const { projectId, assetId } = publication;
    if (!findAssetOwnerStmt.get(projectId, assetId)) return 'gone';
    if (findPublicationRowStmt.get(assetId)) return 'already-published';
    if (findIntentStmt.get(projectId, assetId)) return 'intent-pending';
    writeSnapshot(publication);
    return 'installed';
  });

  return {
    /**
     * Read the complete committed publication snapshot for an asset. Pending
     * intents do not affect the result.
     * @returns {ReturnType<typeof normalizeGeneratedImagePublication>|null}
     */
    findPublication(projectId, assetId) {
      const row = findSnapshotStmt.get(projectId, assetId);
      return row ? mapSnapshotRow(row) : null;
    },

    /**
     * Record the one unresolved candidate publication for an asset. Returns
     * null, leaving the existing intent untouched, when another intent already
     * owns the asset. Asset/project ownership is enforced by foreign key.
     * @returns {object|null} the created intent, including its new `intentId`
     */
    acquireIntent(input) {
      const intent = normalizeIntentInput(input);
      return mapIntentRow(insertIntentStmt.get(
        intent.assetId, intent.projectId, crypto.randomUUID(),
        intent.candidateDirectoryName, intent.stagingDirectoryName,
        intent.expectedRevision, intent.previousDirectoryName,
      ));
    },

    /** @returns {object|null} the asset's unresolved intent */
    findIntent(projectId, assetId) {
      return mapIntentRow(findIntentStmt.get(projectId, assetId));
    },

    /** @returns {object[]} every unresolved intent, oldest first */
    listIntents() {
      return listIntentsStmt.all().map(mapIntentRow);
    },

    /**
     * Remove an intent only when it is still owned by `intentId`.
     * @returns {boolean} whether the matching intent was removed
     */
    clearIntent(projectId, assetId, intentId) {
      return deleteIntentStmt.run(projectId, assetId, intentId).changes === 1;
    },

    /**
     * Atomically commit `publication` as the asset's complete snapshot and
     * resolve the owning intent. Returns false without writing when
     * `intentId` no longer owns the asset (a stale finalizer). Any failure
     * rolls back, leaving the previous snapshot and the intent intact.
     * @returns {boolean}
     * @throws {InvalidGeneratedImagePublicationError}
     */
    finalizePublication(intentId, publication) {
      requireNonEmptyString(intentId, 'intentId');
      return finalizeTx(normalizeGeneratedImagePublication(publication), intentId);
    },

    /**
     * Install `publication` as the complete committed snapshot of an asset
     * that has no committed publication and no unresolved intent. Used only
     * by explicit maintenance (the one-time legacy-cache backfill), never by
     * the writer. Runs in one transaction (a savepoint when nested).
     * @returns {'installed'|'already-published'|'intent-pending'|'gone'}
     * @throws {InvalidGeneratedImagePublicationError}
     */
    installPublication(publication) {
      return installTx(normalizeGeneratedImagePublication(publication));
    },
  };
}
