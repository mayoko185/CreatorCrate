import { randomUUID } from 'node:crypto';
import { buildSocialContent } from './social-content-builder.js';
import { formatSocialPrepTimestamp } from '../data/social-prep-repository.js';

export const ATTEMPT_STALE_MINUTES = 15;
export const ATTEMPT_MAX_MINUTES = 30;
export const MANUAL_CONFIRMATION_HOURS = 24;

const SUPPORTED_STATUSES = new Set([
  'pending', 'starting', 'preparing', 'uploading', 'auth_required', 'prepared', 'staging', 'ready', 'failed', 'cancelled',
]);
const STALE_PROGRESS_STATUSES = new Set(['starting', 'preparing', 'uploading', 'staging']);
const COMPLETED_PREPARATION_STATUSES = new Set(['prepared', 'ready']);
const EXPLICIT_REPREPARE_STATUSES = new Set(['prepared', 'ready', 'posted']);
const ALLOWED_STATUS_TRANSITIONS = new Map([
  ['pending', new Set(['pending', 'starting', 'staging', 'failed', 'cancelled'])],
  ['starting', new Set(['starting', 'preparing', 'uploading', 'auth_required', 'prepared', 'failed', 'cancelled'])],
  ['preparing', new Set(['preparing', 'uploading', 'auth_required', 'prepared', 'failed', 'cancelled'])],
  ['uploading', new Set(['uploading', 'auth_required', 'prepared', 'failed', 'cancelled'])],
  ['staging', new Set(['staging', 'ready', 'failed', 'cancelled'])],
  ['auth_required', new Set(['auth_required'])],
  ['prepared', new Set(['prepared'])],
  ['ready', new Set(['ready'])],
  ['posted', new Set(['posted'])],
  ['failed', new Set(['failed'])],
  ['cancelled', new Set(['cancelled'])],
]);

export class SocialPrepServiceError extends Error {
  constructor(code, { issues = undefined, status = undefined } = {}) {
    super(`Social Preparation ${code.replaceAll('_', ' ')}`);
    this.name = 'SocialPrepServiceError';
    this.code = code;
    this.status = status ?? (['attempt_in_progress', 'attempt_not_reissuable'].includes(code) ? 409 : 422);
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

  function getCompanionAction(releaseId) {
    const at = currentNow();
    if (!socialPrepSettingsService.isEnabled()) return null;
    const release = releaseRepository.findById(releaseId);
    if (!release || release.published_date == null) return null;

    const configured = new Set(socialPrepSettingsService.getPlatforms());
    const rows = socialPrepRepository.listPlatformsByReleaseId(releaseId);
    const live = socialPrepRepository.findLiveSessionByReleaseId(releaseId);

    if (live?.state === 'issued') {
      const owned = rows.filter((row) => row.session_id === live.id);
      return owned.length > 0 && owned.every((row) => row.status === 'pending' && configured.has(row.platform))
        ? { mode: 'reissue', sessionId: live.id }
        : null;
    }

    if (live?.state === 'redeemed' && !isRedeemedSessionStale(live, at)) return null;

    const retryable = computeRetryablePlatforms(rows, at)
      .filter((platform) => configured.has(platform));
    if (retryable.length > 0) return { mode: 'activate' };

    const completed = rows.filter((row) => configured.has(row.platform)
      && COMPLETED_PREPARATION_STATUSES.has(row.status));
    return completed.length > 0 ? { mode: 'reprepare' } : null;
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

  function validateActivationContext(releaseId) {
    if (!socialPrepSettingsService.isEnabled()) throw new SocialPrepServiceError('social_prep_disabled');
    const configured = new Set(socialPrepSettingsService.getPlatforms());
    const release = releaseRepository.findById(releaseId);
    if (!release || release.published_date == null) {
      throw new SocialPrepServiceError('validation_failed', { issues: [{ code: 'release_not_published', severity: 'blocking' }] });
    }
    return { configured, release };
  }

  function issueAttempt({ release, releaseId, targetedPlatforms, kind, intentHash, expiry, at }) {
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
  }

  function activate({ releaseId, platforms = undefined, reprepare = false, intentHash, expiresAt }) {
    const at = currentNow();
    const requested = platforms === undefined ? undefined : uniqueStrings(platforms);
    if (platforms !== undefined && requested === null) throw new TypeError('Social Preparation platforms must be an array.');
    if (typeof intentHash !== 'string' || intentHash.length === 0) throw new TypeError('Social Preparation intentHash is required.');
    const expiry = asDate(expiresAt);
    const transaction = db.transaction(() => {
      // BEGIN IMMEDIATE serializes the authoritative reads; DEFERRED lets two callers inspect live/session/asset state before either owns the write lock.
      const { configured, release } = validateActivationContext(releaseId);
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
        if (requested?.some((platform) => !configured.has(platform))) throw new SocialPrepServiceError('unknown_platform');
        const allowedStatuses = requested === undefined ? COMPLETED_PREPARATION_STATUSES : EXPLICIT_REPREPARE_STATUSES;
        targetedPlatforms = rows.filter((row) => configured.has(row.platform)
          && allowedStatuses.has(row.status)
          && (requested === undefined || requested.includes(row.platform)))
          .map((row) => row.platform);
        if (requested?.some((platform) => !targetedPlatforms.includes(platform))) {
          throw new SocialPrepServiceError('platform_not_prepared');
        }
        if (targetedPlatforms.length === 0) throw new SocialPrepServiceError('platform_not_prepared');
      } else {
        if (requested?.some((platform) => !configured.has(platform))) throw new SocialPrepServiceError('unknown_platform');
        const authoritativeSessionId = live?.id;
        const freshWork = live && rows.some((row) => row.session_id === authoritativeSessionId
          && STALE_PROGRESS_STATUSES.has(row.status)
          && !computeRetryablePlatforms([row], at, authoritativeSessionId).includes(row.platform));
        if (freshWork) throw new SocialPrepServiceError('attempt_in_progress');
        const retryable = computeRetryablePlatforms(rows, at, authoritativeSessionId);
        if (requested?.some((platform) => COMPLETED_PREPARATION_STATUSES.has(rows.find((row) => row.platform === platform)?.status))) {
          throw new SocialPrepServiceError('reprepare_required');
        }
        targetedPlatforms = (requested === undefined ? retryable : retryable.filter((platform) => requested.includes(platform)))
          .filter((platform) => configured.has(platform));
        if (targetedPlatforms.length === 0) throw new SocialPrepServiceError('nothing_retryable');
      }
      const targetRows = targetedPlatforms.map((platform) => rows.find((row) => row.platform === platform));
      const kind = reprepare ? 'reprepare' : targetRows.every((row) => row.attempts === 0) ? 'initial' : 'retry';
      return issueAttempt({ release, releaseId, targetedPlatforms, kind, intentHash, expiry, at });
    }).immediate;
    try { return transaction(); } catch (error) { if (isBusyOrLiveConflict(error)) throw new SocialPrepServiceError('attempt_in_progress'); throw error; }
  }

  function reissue({ releaseId, sessionId, intentHash, expiresAt }) {
    const at = currentNow();
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('Social Preparation sessionId is required.');
    if (typeof intentHash !== 'string' || intentHash.length === 0) throw new TypeError('Social Preparation intentHash is required.');
    const expiry = asDate(expiresAt);
    const transaction = db.transaction(() => {
      const { configured, release } = validateActivationContext(releaseId);
      const live = socialPrepRepository.findLiveSessionByReleaseId(releaseId);
      if (!live || live.id !== sessionId || live.state !== 'issued') throw new SocialPrepServiceError('attempt_not_reissuable');
      const ownedPlatforms = socialPrepRepository.listPlatformsByReleaseId(releaseId)
        .filter((row) => row.session_id === sessionId);
      if (ownedPlatforms.length === 0 || ownedPlatforms.some((row) => row.status !== 'pending' || !configured.has(row.platform))) {
        throw new SocialPrepServiceError('attempt_not_reissuable');
      }
      const targetedPlatforms = ownedPlatforms.map((row) => row.platform);
      const expired = socialPrepRepository.expireIssuedSession(sessionId, releaseId, { now: at });
      if (!expired) throw new SocialPrepServiceError('attempt_not_reissuable');
      const kind = live.kind === 'reprepare' ? 'reprepare' : 'retry';
      return issueAttempt({ release, releaseId, targetedPlatforms, kind, intentHash, expiry, at });
    }).immediate;
    try { return transaction(); } catch (error) { if (isBusyOrLiveConflict(error)) throw new SocialPrepServiceError('attempt_in_progress'); throw error; }
  }

  function redeem({ sessionId = undefined, intentHash, mediaTokenHash }) {
    const at = currentNow();
    if (typeof intentHash !== 'string' || typeof mediaTokenHash !== 'string') return undefined;
    return db.transaction(() => {
      const values = {
        intentHash,
        mediaTokenHash,
        attemptDeadlineAt: addMinutes(at, maxMinutes),
        manualConfirmationExpiresAt: addMinutes(at, MANUAL_CONFIRMATION_HOURS * 60),
        now: at,
      };
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
      const current = socialPrepRepository.listPlatformsByReleaseId(releaseId)
        .find((row) => row.platform === platform && row.session_id === sessionId);
      if (!current) return undefined;
      if (!ALLOWED_STATUS_TRANSITIONS.get(current.status)?.has(status)) {
        throw new SocialPrepServiceError('invalid_status_transition');
      }
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

  function getPostingCompletion(releaseId) {
    const configuredPlatforms = socialPrepSettingsService.getPlatforms();
    const rowsByPlatform = new Map(socialPrepRepository.listPlatformsByReleaseId(releaseId)
      .map((row) => [row.platform, row]));
    const postedCount = configuredPlatforms.filter((platform) => rowsByPlatform.get(platform)?.status === 'posted').length;
    const totalCount = configuredPlatforms.length;
    return { postedCount, totalCount, isComplete: totalCount > 0 && postedCount === totalCount };
  }

  function readPostingConfirmation({ sessionId, platform, authenticate }) {
    const session = authenticate();
    const target = socialPrepRepository.listPlatformsByReleaseId(session.release_id)
      .find((row) => row.platform === platform && row.session_id === sessionId);
    if (!target) throw new SocialPrepServiceError('confirmation_target_not_owned', { status: 409 });
    return { target, completion: getPostingCompletion(session.release_id) };
  }

  function confirmPlatformPosted({ sessionId, platform, authenticate }) {
    const at = currentNow();
    return db.transaction(() => {
      const session = authenticate();
      const current = socialPrepRepository.listPlatformsByReleaseId(session.release_id)
        .find((row) => row.platform === platform && row.session_id === sessionId);
      if (!current) throw new SocialPrepServiceError('confirmation_target_not_owned', { status: 409 });
      if (current.status === 'posted') {
        return { target: current, completion: getPostingCompletion(session.release_id) };
      }
      if (current.status !== 'ready') throw new SocialPrepServiceError('platform_not_ready', { status: 409 });
      const target = socialPrepRepository.markPlatformPostedIfReady({
        releaseId: session.release_id, platform, sessionId, now: at,
      });
      if (!target) throw new SocialPrepServiceError('confirmation_conflict', { status: 409 });
      return { target, completion: getPostingCompletion(session.release_id) };
    }).immediate();
  }

  return Object.freeze({
    initializePlatformState, getCompanionAction, activate, reissue, computeRetryablePlatforms, isRedeemedSessionStale, redeem,
    recordPlatformStatus, getPostingCompletion, readPostingConfirmation, confirmPlatformPosted,
    get intentTtlMinutes() { return staleMinutes; },
  });
}
