const SESSION_COLUMNS = [
  'id', 'release_id', 'kind', 'state', 'intent_hash', 'media_token_hash', 'redeemed_at',
  'attempt_deadline_at', 'expires_at', 'created_at', 'updated_at',
];

const PLATFORM_COLUMNS = [
  'release_id', 'platform', 'session_id', 'status', 'detail_code', 'message',
  'attempts', 'prepared_at', 'created_at', 'updated_at',
];

const SNAPSHOT_COLUMNS = [
  'session_id', 'asset_id', 'project_id', 'role', 'sort_order', 'relative_path',
  'nested_path', 'filename', 'extension', 'mime_type', 'size_bytes', 'is_present',
];

const SESSION_SELECT = SESSION_COLUMNS.join(', ');
const PLATFORM_SELECT = PLATFORM_COLUMNS.join(', ');
const SNAPSHOT_SELECT = SNAPSHOT_COLUMNS.join(', ');
const NON_TERMINAL_PLATFORM_STATUSES = ['pending', 'starting', 'preparing', 'uploading'];

export class SocialPrepRepositoryError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'SocialPrepRepositoryError';
    this.code = code;
  }
}

/** Converts a Date-compatible value to the repository's UTC SQLite format. */
export function formatSocialPrepTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SocialPrepRepositoryError('Social Preparation timestamp must be Date-compatible.', {
      code: 'INVALID_TIMESTAMP',
    });
  }
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SocialPrepRepositoryError(`Social Preparation ${field} must be a non-empty string.`, {
      code: 'INVALID_ARGUMENT',
    });
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== 'string') {
    throw new SocialPrepRepositoryError(`Social Preparation ${field} must be a string.`, {
      code: 'INVALID_ARGUMENT',
    });
  }
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SocialPrepRepositoryError(`Social Preparation ${field} must be a positive safe integer.`, {
      code: 'INVALID_ARGUMENT',
    });
  }
  return value;
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SocialPrepRepositoryError(`Social Preparation ${field} must be a non-negative safe integer.`, {
      code: 'INVALID_ARGUMENT',
    });
  }
  return value;
}

function uniquePlatforms(platforms) {
  if (!Array.isArray(platforms)) {
    throw new SocialPrepRepositoryError('Social Preparation platforms must be an array.', { code: 'INVALID_ARGUMENT' });
  }
  return [...new Set(platforms.map((platform) => requireText(platform, 'platform')))];
}

/** @param {import('better-sqlite3').Database} db */
export function createSocialPrepRepository(db) {
  const findSessionById = db.prepare(`SELECT ${SESSION_SELECT} FROM social_prep_sessions WHERE id = ?`);
  const findLiveSessionByReleaseId = db.prepare(`
    SELECT ${SESSION_SELECT}
    FROM social_prep_sessions
    WHERE release_id = ? AND state IN ('issued', 'redeemed')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  const insertSession = db.prepare(`
    INSERT INTO social_prep_sessions (id, release_id, kind, state, intent_hash, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING ${SESSION_SELECT}
  `);
  const updateSessionState = db.prepare(`
    UPDATE social_prep_sessions
    SET state = ?, updated_at = ?
    WHERE id = ? AND state IN ('issued', 'redeemed')
    RETURNING ${SESSION_SELECT}
  `);
  const redeemSession = db.prepare(`
    UPDATE social_prep_sessions
    SET state = 'redeemed', updated_at = ?
    WHERE id = ? AND state = 'issued'
    RETURNING ${SESSION_SELECT}
  `);
  const redeemSessionWithTokens = db.prepare(`
    UPDATE social_prep_sessions
    SET state = 'redeemed', media_token_hash = ?, redeemed_at = ?, attempt_deadline_at = ?, updated_at = ?
    WHERE id = ? AND state = 'issued' AND intent_hash = ? AND expires_at > ?
    RETURNING ${SESSION_SELECT}
  `);
  const redeemSessionWithTokensByIntentHash = db.prepare(`
    UPDATE social_prep_sessions
    SET state = 'redeemed', media_token_hash = ?, redeemed_at = ?, attempt_deadline_at = ?, updated_at = ?
    WHERE state = 'issued' AND intent_hash = ? AND expires_at > ?
    RETURNING ${SESSION_SELECT}
  `);
  const finishSession = db.prepare(`
    UPDATE social_prep_sessions
    SET state = 'finished', updated_at = ?
    WHERE id = ? AND state = 'redeemed'
    RETURNING ${SESSION_SELECT}
  `);
  const listPlatformsByReleaseId = db.prepare(`
    SELECT ${PLATFORM_SELECT}
    FROM release_social_platforms
    WHERE release_id = ?
    ORDER BY platform ASC
  `);
  const insertPlatform = db.prepare(`
    INSERT INTO release_social_platforms (release_id, platform, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(release_id, platform) DO NOTHING
  `);
  const reassignPlatforms = (placeholders) => db.prepare(`
    UPDATE release_social_platforms
    SET session_id = ?, status = 'pending', detail_code = NULL, message = NULL,
        attempts = attempts + 1, updated_at = ?
    WHERE release_id = (SELECT release_id FROM social_prep_sessions WHERE id = ?)
      AND platform IN (${placeholders})
  `);
  const updateOwnedPlatform = db.prepare(`
    UPDATE release_social_platforms
    SET status = ?, detail_code = ?, message = ?, prepared_at = COALESCE(prepared_at, ?), updated_at = ?
    WHERE release_id = ? AND platform = ? AND session_id = ?
    RETURNING ${PLATFORM_SELECT}
  `);
  const countSessionNonTerminalPlatforms = db.prepare(`
    SELECT COUNT(*) AS count
    FROM release_social_platforms
    WHERE session_id = ? AND status IN (${NON_TERMINAL_PLATFORM_STATUSES.map(() => '?').join(', ')})
  `);
  const insertSnapshot = db.prepare(`
    INSERT INTO social_prep_session_assets (${SNAPSHOT_COLUMNS.join(', ')})
    VALUES (${SNAPSHOT_COLUMNS.map(() => '?').join(', ')})
    RETURNING ${SNAPSHOT_SELECT}
  `);
  const listSnapshots = db.prepare(`
    SELECT ${SNAPSHOT_SELECT}
    FROM social_prep_session_assets
    WHERE session_id = ?
    ORDER BY sort_order ASC, asset_id ASC
  `);
  const findSnapshot = db.prepare(`
    SELECT ${SNAPSHOT_SELECT}
    FROM social_prep_session_assets
    WHERE session_id = ? AND asset_id = ?
  `);
  const countSnapshots = db.prepare(`SELECT COUNT(*) AS count FROM social_prep_session_assets WHERE session_id = ?`);
  const findSessionLastActivityAt = db.prepare(`
    SELECT MAX(activity_at) AS last_activity_at
    FROM (
      SELECT updated_at AS activity_at FROM social_prep_sessions WHERE id = ?
      UNION ALL
      SELECT updated_at AS activity_at FROM release_social_platforms WHERE session_id = ?
    )
  `);

  return {
    findSessionById(sessionId) {
      return findSessionById.get(requireText(sessionId, 'session ID'));
    },

    findLiveSessionByReleaseId(releaseId) {
      return findLiveSessionByReleaseId.get(requirePositiveInteger(releaseId, 'release ID'));
    },

    insertSession({ id, releaseId, kind, state = 'issued', intentHash = null, expiresAt, now = new Date() }) {
      const timestamp = formatSocialPrepTimestamp(now);
      return insertSession.get(
        requireText(id, 'session ID'),
        requirePositiveInteger(releaseId, 'release ID'),
        requireText(kind, 'session kind'),
        requireText(state, 'session state'),
        intentHash,
        formatSocialPrepTimestamp(expiresAt),
        timestamp,
        timestamp,
      );
    },

    expireSession(sessionId, { now = new Date() } = {}) {
      return updateSessionState.get('expired', formatSocialPrepTimestamp(now), requireText(sessionId, 'session ID'));
    },

    supersedeSession(sessionId, { now = new Date() } = {}) {
      return updateSessionState.get('superseded', formatSocialPrepTimestamp(now), requireText(sessionId, 'session ID'));
    },

    finishSession(sessionId, { now = new Date() } = {}) {
      return finishSession.get(formatSocialPrepTimestamp(now), requireText(sessionId, 'session ID'));
    },

    redeemSession(sessionId, { now = new Date() } = {}) {
      return redeemSession.get(formatSocialPrepTimestamp(now), requireText(sessionId, 'session ID'));
    },

    redeemSessionWithTokens({ sessionId, intentHash, mediaTokenHash, attemptDeadlineAt, now = new Date() }) {
      const timestamp = formatSocialPrepTimestamp(now);
      return redeemSessionWithTokens.get(
        requireText(mediaTokenHash, 'media token hash'),
        timestamp,
        formatSocialPrepTimestamp(attemptDeadlineAt),
        timestamp,
        requireText(sessionId, 'session ID'),
        requireText(intentHash, 'intent hash'),
        timestamp,
      );
    },

    redeemSessionWithTokensByIntentHash({ intentHash, mediaTokenHash, attemptDeadlineAt, now = new Date() }) {
      const timestamp = formatSocialPrepTimestamp(now);
      return redeemSessionWithTokensByIntentHash.get(
        requireText(mediaTokenHash, 'media token hash'),
        timestamp,
        formatSocialPrepTimestamp(attemptDeadlineAt),
        timestamp,
        requireText(intentHash, 'intent hash'),
        timestamp,
      );
    },

    findSessionLastActivityAt(sessionId) {
      const id = requireText(sessionId, 'session ID');
      return findSessionLastActivityAt.get(id, id).last_activity_at;
    },

    ensurePlatforms(releaseId, platforms, { now = new Date() } = {}) {
      const timestamp = formatSocialPrepTimestamp(now);
      const unique = uniquePlatforms(platforms);
      const insertAll = db.transaction(() => {
        for (const platform of unique) insertPlatform.run(requirePositiveInteger(releaseId, 'release ID'), platform, timestamp, timestamp);
        return listPlatformsByReleaseId.all(releaseId);
      });
      return insertAll();
    },

    listPlatformsByReleaseId(releaseId) {
      return listPlatformsByReleaseId.all(requirePositiveInteger(releaseId, 'release ID'));
    },

    /** Read saved targets only; never initialize rows or consult Settings. */
    listPlatformsByReleaseIds(releaseIds) {
      if (!Array.isArray(releaseIds)) {
        throw new SocialPrepRepositoryError('Social Preparation release IDs must be an array.', { code: 'INVALID_ARGUMENT' });
      }
      const ids = [...new Set(releaseIds.map((id) => requirePositiveInteger(id, 'release ID')))];
      if (ids.length === 0) return [];
      return db.prepare(`
        SELECT ${PLATFORM_SELECT}
        FROM release_social_platforms
        WHERE release_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY release_id ASC,
          CASE platform WHEN 'patreon' THEN 0 WHEN 'x' THEN 1 WHEN 'bluesky' THEN 2 ELSE 3 END,
          platform ASC
      `).all(...ids);
    },

    reassignPlatformsToSession(sessionId, platforms, { now = new Date() } = {}) {
      const unique = uniquePlatforms(platforms);
      if (unique.length === 0) return 0;
      const timestamp = formatSocialPrepTimestamp(now);
      return db.transaction(() => reassignPlatforms(unique.map(() => '?').join(', ')).run(
        requireText(sessionId, 'session ID'), timestamp, sessionId, ...unique,
      ).changes)();
    },

    updatePlatformIfOwned({ releaseId, platform, sessionId, status, detailCode = null, message = null, preparedAt = null, now = new Date() }) {
      return updateOwnedPlatform.get(
        requireText(status, 'platform status'),
        detailCode,
        message,
        preparedAt === null ? null : formatSocialPrepTimestamp(preparedAt),
        formatSocialPrepTimestamp(now),
        requirePositiveInteger(releaseId, 'release ID'),
        requireText(platform, 'platform'),
        requireText(sessionId, 'session ID'),
      );
    },

    countSessionNonTerminalPlatforms(sessionId) {
      return countSessionNonTerminalPlatforms.get(requireText(sessionId, 'session ID'), ...NON_TERMINAL_PLATFORM_STATUSES).count;
    },

    insertSessionAsset({ sessionId, assetId, projectId, role, sortOrder, relativePath, nestedPath = '', filename, extension = '', mimeType, sizeBytes, isPresent }) {
      return insertSnapshot.get(
        requireText(sessionId, 'session ID'),
        requirePositiveInteger(assetId, 'asset ID'),
        requirePositiveInteger(projectId, 'project ID'),
        requireText(role, 'snapshot role'),
        requireNonNegativeInteger(sortOrder, 'snapshot sort order'),
        requireText(relativePath, 'snapshot relative path'),
        requireString(nestedPath, 'snapshot nested path'),
        requireText(filename, 'snapshot filename'),
        requireText(extension, 'snapshot extension'),
        requireText(mimeType, 'snapshot MIME type'),
        requireNonNegativeInteger(sizeBytes, 'snapshot size'),
        isPresent ? 1 : 0,
      );
    },

    listSessionAssets(sessionId) {
      return listSnapshots.all(requireText(sessionId, 'session ID'));
    },

    findSessionAsset(sessionId, assetId) {
      return findSnapshot.get(requireText(sessionId, 'session ID'), requirePositiveInteger(assetId, 'asset ID'));
    },

    countSessionAssets(sessionId) {
      return countSnapshots.get(requireText(sessionId, 'session ID')).count;
    },
  };
}
