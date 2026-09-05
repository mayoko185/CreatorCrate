import { randomUUID } from 'node:crypto';
import { buildSocialContent } from './social-content-builder.js';
import { formatSocialPrepTimestamp } from '../data/social-prep-repository.js';

export const ATTEMPT_STALE_MINUTES = 15;
export const ATTEMPT_MAX_MINUTES = 30;

const SUPPORTED_STATUSES = new Set([
  'pending', 'starting', 'preparing', 'uploading', 'auth_required', 'prepared', 'failed', 'cancelled',
]);
const STALE_PROGRESS_STATUSES = new Set(['starting', 'preparing', 'uploading']);

export class SocialPrepServiceError extends Error {
  constructor(code, { issues = undefined, status = undefined } = {}) {
    super(`Social Preparation ${code.replaceAll('_', ' ')}`);
    this.name = 'SocialPrepServiceError';
    this.code = code;
    this.status = status ?? (code === 'attempt_in_progress' ? 409 : 422);
    if (issues) this.issues = issues;
  }
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Social Preparation time must be Date-compatible.');
  return date;
}

function addMinutes(value, minutes) {
  return new Date(asDate(value).getTime() + minutes * 60_000);
}

function timestampAtOrAfter(now, timestamp) {
  return asDate(now).getTime() >= asDate(`${timestamp.replace(' ', 'T')}Z`).getTime();
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((item) => typeof item === 'string'))];
}

function isBusyOrLiveConflict(error) {
  return error?.code === 'SQLITE_BUSY'
    || error?.code === 'SQLITE_BUSY_SNAPSHOT'
    || (error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      && /idx_social_prep_sessions_one_live_release|social_prep_sessions\.release_id/i.test(error.message));
}

/** Owns Social Preparation lifecycle policy; the repository remains persistence mechanics. */
export function createSocialPrepService({ db, socialPrepRepository, socialPrepSettingsService, releaseService, now = () => new Date(), staleMinutes = ATTEMPT_STALE_MINUTES, maxMinutes = ATTEMPT_MAX_MINUTES } = {}) {
  if (!db || !socialPrepRepository || !socialPrepSettingsService || !releaseService?.repository) {
    throw new Error('createSocialPrepService requires db, socialPrepRepository, socialPrepSettingsService, and releaseService.');
  }
  if (!Number.isFinite(staleMinutes) || !Number.isFinite(maxMinutes) || staleMinutes <= 0 || staleMinutes >= maxMinutes) {
    throw new RangeError('Social Preparation staleMinutes must be positive and less than maxMinutes.');
  }
  const releaseRepository = releaseService.repository;

  function currentNow() { return asDate(now()); }
  function computeRetryablePlatforms(rows, at = currentNow(), authoritativeSessionId = undefined) {
    return rows.filter((row) => row.status === 'pending'
      || ['failed', 'auth_required', 'cancelled'].includes(row.status)
      || (STALE_PROGRESS_STATUSES.has(row.status)
        && (row.session_id !== authoritativeSessionId
          || timestampAtOrAfter(at, formatSocialPrepTimestamp(addMinutes(`${row.updated_at.replace(' ', 'T')}Z`, staleMinutes))))))
      .map((row) => row.platform);
  }
  function isRedeemedSessionStale(session, at = currentNow()) {
    if (!session || session.state !== 'redeemed') return false;
    if (!session.attempt_deadline_at || timestampAtOrAfter(at, session.attempt_deadline_at)) return true;
    const lastActivity = socialPrepRepository.findSessionLastActivityAt(session.id) || session.redeemed_at;
    return timestampAtOrAfter(at, formatSocialPrepTimestamp(addMinutes(`${lastActivity.replace(' ', 'T')}Z`, staleMinutes)));
  }

  function initializePlatformState(releaseId, requestedPlatforms) {
    if (!socialPrepSettingsService.isEnabled()) return [];
    const configured = new Set(socialPrepSettingsService.getPlatforms());
    const requested = uniqueStrings(requestedPlatforms) ?? [...configured];
    const selected = requested.filter((platform) => configured.has(platform));
    if (selected.length === 0) return [];
    return socialPrepRepository.ensurePlatforms(releaseId, selected, { now: currentNow() })
      .filter((row) => selected.includes(row.platform));
  }

  function activate({ releaseId, platforms = undefined, reprepare = false, intentHash, expiresAt }) {
    const at = currentNow();
    if (reprepare && !Array.isArray(platforms)) throw new TypeError('Social Preparation platforms must be an array.');
    if (reprepare && platforms.length !== 1) throw new SocialPrepServiceError('reprepare_requires_single_platform');
    const requested = platforms === undefined ? undefined : uniqueStrings(platforms);
    if (platforms !== undefined && requested === null) throw new TypeError('Social Preparation platforms must be an array.');
    if (typeof intentHash !== 'string' || intentHash.length === 0) throw new TypeError('Social Preparation intentHash is required.');
    const expiry = asDate(expiresAt);
    const transaction = db.transaction(() => {
      // BEGIN IMMEDIATE serializes the authoritative reads; DEFERRED lets two callers inspect live/session/asset state before either owns the write lock.
      if (!socialPrepSettingsService.isEnabled()) throw new SocialPrepServiceError('social_prep_disabled');
      const configured = new Set(socialPrepSettingsService.getPlatforms());
      const release = releaseRepository.findById(releaseId);
      if (!release || release.published_date == null) {
        throw new SocialPrepServiceError('validation_failed', { issues: [{ code: 'release_not_published', severity: 'blocking' }] });
      }
      let live = socialPrepRepository.findLiveSessionByReleaseId(releaseId);
      if (live?.state === 'issued' && timestampAtOrAfter(at, live.expires_at)) {
        socialPrepRepository.expireSession(live.id, { now: at });
        live = undefined;
      }
      if (live?.state === 'issued') throw new SocialPrepServiceError('attempt_in_progress');
      if (live?.state === 'redeemed') {
        if (!isRedeemedSessionStale(live, at)) throw new SocialPrepServiceError('attempt_in_progress');
        socialPrepRepository.supersedeSession(live.id, { now: at });
        live = undefined;
      }
      const rows = socialPrepRepository.listPlatformsByReleaseId(releaseId);
      let targetedPlatforms;
      if (reprepare) {
        if (!requested || requested.length !== 1) throw new SocialPrepServiceError('reprepare_requires_single_platform');
        const platform = requested[0];
        const row = rows.find((item) => item.platform === platform);
        if (!configured.has(platform)) throw new SocialPrepServiceError('unknown_platform');
        if (!row) throw new SocialPrepServiceError('platform_not_in_release');
        if (row.status !== 'prepared') throw new SocialPrepServiceError('platform_not_prepared');
        targetedPlatforms = [platform];
      } else {
        if (requested?.some((platform) => !configured.has(platform))) throw new SocialPrepServiceError('unknown_platform');
        const authoritativeSessionId = live?.id;
        const freshWork = live && rows.some((row) => row.session_id === authoritativeSessionId
          && STALE_PROGRESS_STATUSES.has(row.status)
          && !computeRetryablePlatforms([row], at, authoritativeSessionId).includes(row.platform));
        if (freshWork) throw new SocialPrepServiceError('attempt_in_progress');
        const retryable = computeRetryablePlatforms(rows, at, authoritativeSessionId);
        if (requested?.some((platform) => rows.find((row) => row.platform === platform)?.status === 'prepared')) {
          throw new SocialPrepServiceError('reprepare_required');
        }
        targetedPlatforms = (requested === undefined ? retryable : retryable.filter((platform) => requested.includes(platform)))
          .filter((platform) => configured.has(platform));
        if (targetedPlatforms.length === 0) throw new SocialPrepServiceError('nothing_retryable');
      }
      const targetRows = targetedPlatforms.map((platform) => rows.find((row) => row.platform === platform));
      const kind = reprepare ? 'reprepare' : targetRows.every((row) => row.attempts === 0) ? 'initial' : 'retry';
      const releaseAssets = releaseRepository.listReleaseAssets(releaseId);
      const content = buildSocialContent({ release, releaseAssets, platforms: targetedPlatforms });
      const issues = Object.values(content).flatMap((platformContent) => platformContent.issues);
      const blockingIssues = issues.filter((issue) => issue.severity === 'blocking');
      if (blockingIssues.length > 0) throw new SocialPrepServiceError('validation_failed', { issues: blockingIssues });
      const session = socialPrepRepository.insertSession({ id: randomUUID(), releaseId, kind, intentHash, expiresAt: expiry, now: at });
      const snapshots = content[targetedPlatforms[0]].includedAssets;
      for (const asset of snapshots) {
        socialPrepRepository.insertSessionAsset({
          sessionId: session.id, assetId: asset.assetId, projectId: asset.projectId, role: asset.role,
          sortOrder: asset.sortOrder, relativePath: asset.relativePath ?? '', nestedPath: asset.nestedPath ?? '',
          filename: asset.filename ?? '', extension: asset.extension ?? '', mimeType: asset.mimeType ?? '',
          sizeBytes: asset.sizeBytes ?? 0, isPresent: asset.isPresent === 1,
        });
      }
      socialPrepRepository.reassignPlatformsToSession(session.id, targetedPlatforms, { now: at });
      return { session, platforms: targetedPlatforms, snapshotCount: snapshots.length, content, issues };
    }).immediate;
    try { return transaction(); } catch (error) { if (isBusyOrLiveConflict(error)) throw new SocialPrepServiceError('attempt_in_progress'); throw error; }
  }

  function redeem({ sessionId = undefined, intentHash, mediaTokenHash }) {
    const at = currentNow();
    if (typeof intentHash !== 'string' || typeof mediaTokenHash !== 'string') return undefined;
    return db.transaction(() => {
      const values = { intentHash, mediaTokenHash, attemptDeadlineAt: addMinutes(at, maxMinutes), now: at };
      return typeof sessionId === 'string'
        ? socialPrepRepository.redeemSessionWithTokens({ sessionId, ...values })
        : socialPrepRepository.redeemSessionWithTokensByIntentHash(values);
    }).immediate();
  }

  function recordPlatformStatus({ releaseId, platform, sessionId, status, detailCode = null, message = null }) {
    if (!SUPPORTED_STATUSES.has(status)) throw new TypeError('Unsupported Social Preparation platform status.');
    const at = currentNow();
    return db.transaction(() => {
      const session = socialPrepRepository.findSessionById(sessionId);
      if (session?.state !== 'redeemed') return undefined;
      const row = socialPrepRepository.updatePlatformIfOwned({
        releaseId, platform, sessionId, status, detailCode, message,
        preparedAt: status === 'prepared' ? at : null, now: at,
      });
      if (!row) return undefined;
      if (session?.state === 'redeemed' && socialPrepRepository.countSessionNonTerminalPlatforms(sessionId) === 0) {
        socialPrepRepository.finishSession(sessionId, { now: at });
      }
      return row;
    }).immediate();
  }

  return Object.freeze({
    initializePlatformState, activate, computeRetryablePlatforms, isRedeemedSessionStale, redeem, recordPlatformStatus,
    get intentTtlMinutes() { return staleMinutes; },
  });
}
