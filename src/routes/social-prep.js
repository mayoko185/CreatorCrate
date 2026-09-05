import express from 'express';
import { SocialPrepServiceError } from '../services/social-prep-service.js';
import { digestToken, generateIntentToken, generateMediaToken } from '../services/social-prep-tokens.js';
import { formatSocialPrepTimestamp } from '../data/social-prep-repository.js';
import { buildSocialContent } from '../services/social-content-builder.js';
import { buildOpenLocallyPath } from '../util/open-locally.js';
import { buildSocialPrepUri, isSocialPrepIntentToken } from '../util/social-prep-uri.js';
import { SocialPrepCapabilityError, createSocialPrepCapabilityService } from '../services/social-prep-capability.js';
import { SocialPrepMediaError, createSocialPrepMediaService } from '../services/social-prep-media-service.js';

const INVALID_INTENT_MESSAGE = 'Invalid or expired Social Preparation intent.';
const SOCIAL_PREP_PLATFORM_STATUSES = new Set([
  'pending', 'starting', 'preparing', 'uploading', 'auth_required', 'prepared', 'failed', 'cancelled',
]);
const DIAGNOSTIC_WORD = /^[a-z0-9_]{1,64}$/;
const DIAGNOSTIC_CDP_CODE_MIN = -2_147_483_648;
const DIAGNOSTIC_CDP_CODE_MAX = 2_147_483_647;
const DIAGNOSTIC_CLASSES = new Set([
  'browser_preparation', 'cdp_command', 'cdp_transport', 'target_closed', 'timeout',
  'authentication_manual_attention', 'validation', 'unexpected',
]);

function diagnosticWord(value) {
  return typeof value === 'string' && DIAGNOSTIC_WORD.test(value) ? value : null;
}

// The native helper sends only this compact, payload-free schema in `message`.
// Keeping the parser here makes the existing status endpoint the sole transport
// while the application logger remains the production diagnostic sink.
const CREATE_RESOLUTION_OUTCOMES = new Set([
  'root_unavailable', 'zero_matches', 'no_usable_candidate', 'ambiguous', 'candidate_limit_exceeded',
  'malformed_query', 'invalid_candidate_identity', 'malformed_description', 'stale_description',
  'malformed_geometry', 'unique_candidate',
]);
const CREATE_RESOLUTION_COUNTS = ['candidate_count', 'inspected_count', 'usable_count', 'layout_rejected_count'];
const CREATE_RESOLUTION_KEYS = new Set(['stage', 'outcome', 'candidate_limit', 'limit_exceeded', 'complete', ...CREATE_RESOLUTION_COUNTS]);

function readCreateResolution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !CREATE_RESOLUTION_KEYS.has(key))
    || value.stage !== 'create_resolution' || value.candidate_limit !== 16
    || typeof value.limit_exceeded !== 'boolean' || typeof value.complete !== 'boolean'
    || (Object.hasOwn(value, 'outcome') && !CREATE_RESOLUTION_OUTCOMES.has(value.outcome))) return null;
  const evidence = {
    stage: 'create_resolution', candidate_limit: 16,
    limit_exceeded: value.limit_exceeded, complete: value.complete,
  };
  if (Object.hasOwn(value, 'outcome')) evidence.outcome = value.outcome;
  for (const key of CREATE_RESOLUTION_COUNTS) {
    if (!Object.hasOwn(value, key)) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 16) return null;
    evidence[key] = value[key];
  }
  return evidence;
}

const MANUAL_BOUNDARY_STATES = new Set(['not_started', 'entered', 'completed', 'failed']);
const MANUAL_EXCEPTION_CLASSES = new Set([
  'invalid_operation', 'io', 'unauthorized_access', 'argument', 'operation_canceled', 'object_disposed',
  'timeout', 'websocket_connection', 'social_preparation_runtime', 'browser_preparation', 'cdp_command', 'cdp_transport', 'unexpected',
]);
const MANUAL_BOUNDARIES = ['composition', 'consent', 'discovery', 'connection_setup', 'connection', 'browser_setup', 'adapter_invocation', 'runtime_disposal'];
const MANUAL_DECISIONS = new Set(['continue', 'cancel', 'display_failed', 'unknown']);
const MANUAL_PRESENTATIONS = new Set(['presented_and_dismissed', 'failed', 'unknown']);
const MANUAL_DISCOVERY_RESULTS = new Set(['chrome_not_running', 'chrome_discovery_missing', 'chrome_discovery_malformed']);
const MANUAL_CONNECTION_RESULTS = new Set([
  'chrome_connection_cancelled', 'chrome_approval_timeout', 'chrome_connection_refused', 'chrome_approval_denied', 'chrome_handshake_failed',
]);
const MANUAL_FAILURE_KINDS = new Set(['caught_exception', 'failure_outcome', 'disposal_failure']);

function exactDiagnosticKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function readManualPreparation(value) {
  if (!exactDiagnosticKeys(value, [...MANUAL_BOUNDARIES, 'failure'])) return null;
  const evidence = {};
  for (const boundary of MANUAL_BOUNDARIES) {
    const entry = value[boundary];
    const keys = boundary === 'consent'
      ? ['state', 'parent_requested', 'parent_response_accepted', 'decision', 'local_presentation']
      : ['discovery', 'connection'].includes(boundary) ? ['state', 'result'] : ['state'];
    if (!exactDiagnosticKeys(entry, keys) || !MANUAL_BOUNDARY_STATES.has(entry.state)) return null;
    evidence[boundary] = { state: entry.state };
    if (boundary === 'consent') {
      if (![entry.parent_requested, entry.parent_response_accepted].every((flag) => flag === null || typeof flag === 'boolean')
        || !MANUAL_DECISIONS.has(entry.decision) || !MANUAL_PRESENTATIONS.has(entry.local_presentation)) return null;
      Object.assign(evidence.consent, {
        parent_requested: entry.parent_requested, parent_response_accepted: entry.parent_response_accepted,
        decision: entry.decision, local_presentation: entry.local_presentation,
      });
    } else if (boundary === 'discovery' || boundary === 'connection') {
      const vocabulary = boundary === 'discovery' ? MANUAL_DISCOVERY_RESULTS : MANUAL_CONNECTION_RESULTS;
      if (entry.result !== null && !vocabulary.has(entry.result)) return null;
      evidence[boundary].result = entry.result;
    }
  }
  const failure = value.failure;
  if (!exactDiagnosticKeys(failure, ['kind', 'exception_class', 'disposal_exception_class'])
    || !MANUAL_FAILURE_KINDS.has(failure.kind)
    || ![failure.exception_class, failure.disposal_exception_class].every((entry) => entry === null || MANUAL_EXCEPTION_CLASSES.has(entry))) return null;
  evidence.failure = {
    kind: failure.kind, exception_class: failure.exception_class, disposal_exception_class: failure.disposal_exception_class,
  };
  return evidence;
}

function readFailureDiagnostic(value, platform) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 6_144) return null;
  let report;
  try { report = JSON.parse(value); } catch { return null; }
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || report.subsystem !== 'social_preparation' || report.platform !== platform
    || report.adapter !== `${platform}_social_preparation` || report.outcome !== 'failed'
    || !diagnosticWord(report.phase) || !diagnosticWord(report.stable_code)
    || !DIAGNOSTIC_CLASSES.has(report.error_class)
    || !report.checkpoints || typeof report.checkpoints !== 'object' || Array.isArray(report.checkpoints)
    || !report.target_state || typeof report.target_state !== 'object' || Array.isArray(report.target_state)) return null;
  const boundedFlags = (flags, maximum) => Object.entries(flags).length <= maximum
    && Object.entries(flags).every(([key, entry]) => diagnosticWord(key) && (entry === true || entry === false || entry === null));
  if (!boundedFlags(report.checkpoints, 16) || !boundedFlags(report.target_state, 8)) return null;
  const cdpPresent = ['cdp_operation', 'cdp_code', 'cdp_message'].filter((key) => report[key] !== undefined);
  if (cdpPresent.length !== 0 && cdpPresent.length !== 3) return null;
  if (cdpPresent.length === 3 && (!diagnosticWord(report.cdp_operation)
    || !Number.isSafeInteger(report.cdp_code) || report.cdp_code < DIAGNOSTIC_CDP_CODE_MIN || report.cdp_code > DIAGNOSTIC_CDP_CODE_MAX
    || typeof report.cdp_message !== 'string' || report.cdp_message.length > 256)) return null;
  if (report.cleanup !== undefined && (!report.cleanup || typeof report.cleanup !== 'object' || Array.isArray(report.cleanup)
    || !DIAGNOSTIC_CLASSES.has(report.cleanup.error_class) || Object.keys(report.cleanup).length !== 1)) return null;
  const createResolution = Object.hasOwn(report, 'create_resolution') ? readCreateResolution(report.create_resolution) : undefined;
  if (createResolution === null) return null;
  const manualPreparation = Object.hasOwn(report, 'manual_preparation') ? readManualPreparation(report.manual_preparation) : undefined;
  if (manualPreparation === null) return null;

  // This route is the persistence boundary: reconstruct only the helper's
  // payload-free diagnostic contract, never retain caller-supplied extensions.
  const diagnostic = {
    subsystem: 'social_preparation',
    platform,
    adapter: `${platform}_social_preparation`,
    phase: report.phase,
    stable_code: report.stable_code,
    outcome: 'failed',
    error_class: report.error_class,
    checkpoints: Object.fromEntries(Object.entries(report.checkpoints)),
    target_state: Object.fromEntries(Object.entries(report.target_state)),
  };
  if (cdpPresent.length === 3) {
    diagnostic.cdp_operation = report.cdp_operation;
    diagnostic.cdp_code = report.cdp_code;
    diagnostic.cdp_message = report.cdp_message;
  }
  if (report.cleanup !== undefined) diagnostic.cleanup = { error_class: report.cleanup.error_class };
  if (createResolution !== undefined) diagnostic.create_resolution = createResolution;
  if (manualPreparation !== undefined) diagnostic.manual_preparation = manualPreparation;
  return diagnostic;
}

function invalidActivationInput(res, issues) {
  return res.status(422).json({ ok: false, error: { code: 'validation_failed', message: 'Social Preparation validation failed.', issues } });
}

function parseReleaseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readActivationInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { issues: [{ code: 'invalid_input', severity: 'blocking' }] };
  const allowed = new Set(['platforms', 'reprepare']);
  if (Object.keys(body).some((key) => !allowed.has(key))) return { issues: [{ code: 'invalid_input', severity: 'blocking' }] };
  if (body.platforms !== undefined && (!Array.isArray(body.platforms) || body.platforms.some((platform) => typeof platform !== 'string'))) {
    return { issues: [{ code: 'invalid_platforms', severity: 'blocking' }] };
  }
  if (body.reprepare !== undefined && typeof body.reprepare !== 'boolean') return { issues: [{ code: 'invalid_reprepare', severity: 'blocking' }] };
  return { platforms: body.platforms, reprepare: body.reprepare ?? false };
}

function activationError(res, error) {
  if (!(error instanceof SocialPrepServiceError)) throw error;
  const payload = { ok: false, error: { code: error.code, message: error.message } };
  if (error.code === 'validation_failed' && error.issues) payload.error.issues = error.issues;
  return res.status(error.status).json(payload);
}

function requestOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function invalidIntent(res) {
  return res.status(401).json({ ok: false, error: { code: 'invalid_intent', message: INVALID_INTENT_MESSAGE } });
}

function capabilityError(res, error) {
  return res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } });
}

function platformStatusPayload(row) {
  return {
    platform: row.platform,
    status: row.status,
    detailCode: row.detail_code,
    attempts: row.attempts,
    preparedAt: row.prepared_at,
  };
}

function readPlatformStatusInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some((key) => !['status', 'detailCode', 'message'].includes(key))) return null;
  if (!SOCIAL_PREP_PLATFORM_STATUSES.has(body.status)) return null;
  if (![undefined, null].includes(body.detailCode) && typeof body.detailCode !== 'string') return null;
  if (![undefined, null].includes(body.message) && typeof body.message !== 'string') return null;
  return { status: body.status, detailCode: body.detailCode ?? null, message: body.message ?? null };
}

function assetPayload(asset, windowsPath) {
  return {
    assetId: asset.assetId,
    role: asset.role,
    sortOrder: asset.sortOrder,
    filename: asset.filename,
    extension: asset.extension,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    relativePath: asset.relativePath,
    isPresent: asset.isPresent,
    ...(windowsPath ? { windowsPath } : {}),
  };
}

function getWindowsPath(asset, release, projectService, openLocallySettingsService) {
  const windowsRoot = openLocallySettingsService.getWindowsProjectsPath();
  const project = projectService.repository.findById(release.project_id);
  return buildOpenLocallyPath({
    windowsRoot,
    projectDir: project?.project_dir,
    assetRelativePath: asset.relativePath,
  });
}

function buildRedeemPayload({ session, socialPrepRepository, releaseService, projectService, openLocallySettingsService }) {
  const release = releaseService.repository.findById(session.release_id);
  if (!release) throw new Error('Redeemed Social Preparation session has no release.');
  const platforms = socialPrepRepository.listPlatformsByReleaseId(session.release_id)
    .filter((platform) => platform.session_id === session.id)
    .map((platform) => platform.platform);
  const snapshots = socialPrepRepository.listSessionAssets(session.id);
  const content = buildSocialContent({ release, releaseAssets: snapshots, platforms });
  return {
    ok: true,
    sessionId: session.id,
    releaseId: session.release_id,
    attemptDeadlineAt: session.attempt_deadline_at,
    platforms: platforms.map((platform) => ({
      platform,
      ...(content[platform].title === undefined ? {} : { title: content[platform].title }),
      body: content[platform].body,
      assets: content[platform].includedAssets.map((asset) => assetPayload(asset, getWindowsPath(asset, release, projectService, openLocallySettingsService))),
    })),
  };
}

/** Browser-authenticated activation endpoint. */
export function createSocialPrepActivationRouter({ socialPrepService } = {}) {
  if (!socialPrepService) throw new Error('createSocialPrepActivationRouter requires socialPrepService.');
  const router = express.Router();
  router.post('/:id/social-prep/activate', express.json(), (req, res, next) => {
    const releaseId = parseReleaseId(req.params.id);
    const input = readActivationInput(req.body ?? {});
    if (releaseId === null) return invalidActivationInput(res, [{ code: 'invalid_release_id', severity: 'blocking' }]);
    if (input.issues) return invalidActivationInput(res, input.issues);
    try {
      const intent = generateIntentToken();
      const expiresAt = formatSocialPrepTimestamp(new Date(Date.now() + socialPrepService.intentTtlMinutes * 60_000));
      const activation = socialPrepService.activate({
        releaseId,
        platforms: input.platforms,
        reprepare: input.reprepare,
        intentHash: digestToken(intent),
        expiresAt,
      });
      const uri = buildSocialPrepUri({ origin: requestOrigin(req), intent });
      return res.json({ ok: true, sessionId: activation.session.id, uri, platforms: activation.platforms });
    } catch (error) {
      try { return activationError(res, error); } catch (unhandled) { return next(unhandled); }
    }
  });
  return router;
}

/** Capability-authenticated native-helper endpoint; intentionally mounted before browser auth/CSRF. */
export function createSocialPrepCapabilityRouter({ socialPrepService, socialPrepRepository, releaseService, projectService, openLocallySettingsService, applicationLogger = null, db, projectsRoot, now } = {}) {
  if (!socialPrepService || !socialPrepRepository || !releaseService?.repository || !projectService?.repository || !openLocallySettingsService || !db) {
    throw new Error('createSocialPrepCapabilityRouter requires Social Preparation, release, project, and Open Locally dependencies.');
  }
  const router = express.Router();
  router.use(express.json());
  router.use(express.urlencoded({ extended: true }));
  const capabilityService = createSocialPrepCapabilityService({ socialPrepRepository, now });
  const mediaService = projectsRoot ? createSocialPrepMediaService({ db, projectsRoot, socialPrepRepository }) : null;
  router.get('/social-prep/:sessionId/assets/:assetId', (req, res, next) => {
    try {
      capabilityService.authenticate({ authorization: req.get('authorization'), sessionId: req.params.sessionId });
      const assetId = Number(req.params.assetId);
      if (!Number.isSafeInteger(assetId) || assetId <= 0) {
        return res.status(404).json({ ok: false, error: { code: 'asset_not_in_preparation', message: 'The asset is not in this preparation.' } });
      }
      if (!mediaService) throw new SocialPrepMediaError('asset_unavailable', 404, 'The asset is unavailable.');
      const download = mediaService.prepareDownload({ sessionId: req.params.sessionId, assetId });
      res.set(download.headers);
      const cleanup = () => download.cleanup();
      res.once('close', cleanup);
      download.stream.once('error', (error) => {
        cleanup();
        if (!res.headersSent) next(error);
        else res.destroy(error);
      });
      download.stream.pipe(res);
    } catch (error) {
      if (error instanceof SocialPrepCapabilityError || error instanceof SocialPrepMediaError) {
        return res.status(error.status).json({ ok: false, error: { code: error.code, message: error.message } });
      }
      return next(error);
    }
  });
  router.get('/social-prep/:sessionId/status', (req, res, next) => {
    try {
      const session = capabilityService.authenticate({ authorization: req.get('authorization'), sessionId: req.params.sessionId });
      const platforms = socialPrepRepository.listPlatformsByReleaseId(session.release_id)
        .filter((platform) => platform.session_id === session.id)
        .map(platformStatusPayload);
      return res.json({
        ok: true,
        sessionId: session.id,
        state: session.state,
        attemptDeadlineAt: session.attempt_deadline_at,
        platforms,
      });
    } catch (error) {
      if (error instanceof SocialPrepCapabilityError) return capabilityError(res, error);
      return next(error);
    }
  });
  router.patch('/social-prep/:sessionId/platforms/:platform', (req, res, next) => {
    try {
      const session = capabilityService.authenticate({ authorization: req.get('authorization'), sessionId: req.params.sessionId });
      const input = readPlatformStatusInput(req.body);
      if (!input) {
        return res.status(422).json({ ok: false, error: { code: 'validation_failed', message: 'Social Preparation validation failed.' } });
      }
      const platform = socialPrepRepository.listPlatformsByReleaseId(session.release_id)
        .find((row) => row.platform === req.params.platform);
      if (!platform) {
        return res.status(404).json({ ok: false, error: { code: 'platform_not_in_release', message: 'The platform is not in this release.' } });
      }
      const updated = socialPrepService.recordPlatformStatus({
        releaseId: session.release_id,
        platform: req.params.platform,
        sessionId: session.id,
        ...input,
      });
      if (!updated) {
        const currentSession = socialPrepRepository.findSessionById(session.id);
        if (currentSession?.state === 'finished') {
          return res.status(409).json({ ok: false, error: { code: 'attempt_finished', message: 'The preparation attempt has finished.' } });
        }
        if (currentSession?.state !== 'redeemed') {
          return res.status(409).json({ ok: false, error: { code: 'attempt_not_active', message: 'The preparation attempt is not active.' } });
        }
        return res.status(409).json({ ok: false, error: { code: 'attempt_superseded', message: 'The preparation attempt was superseded.' } });
      }
      const diagnostic = input.status === 'failed' ? readFailureDiagnostic(input.message, req.params.platform) : null;
      if (diagnostic) {
        try {
          const release = releaseService.repository.findById(session.release_id);
          applicationLogger?.error?.({
            kind: 'diagnostic',
            subsystem: 'social_preparation',
            event: 'social_preparation.adapter_failed',
            message: 'A social-preparation adapter failed; see the bounded diagnostic context.',
            projectId: release?.project_id ?? null,
            // The capability/session ID is never logged. The non-secret release ID
            // identifies this authoritative row together with platform and attempt.
            context: { release_id: session.release_id, platform: req.params.platform, attempt: updated.attempts, diagnostic },
          });
        } catch {
          // Post-commit reporting must not change the existing helper status result.
        }
      }
      return res.json({ ok: true, sessionId: session.id, platform: platformStatusPayload(updated) });
    } catch (error) {
      if (error instanceof SocialPrepCapabilityError) return capabilityError(res, error);
      return next(error);
    }
  });
  router.post('/social-prep/redeem', (req, res, next) => {
    const intent = req.body?.intent;
    if (!isSocialPrepIntentToken(intent)) return invalidIntent(res);
    try {
      const mediaToken = generateMediaToken();
      const session = socialPrepService.redeem({ intentHash: digestToken(intent), mediaTokenHash: digestToken(mediaToken) });
      if (!session) return invalidIntent(res);
      const payload = buildRedeemPayload({ session, socialPrepRepository, releaseService, projectService, openLocallySettingsService });
      return res.json({ ...payload, mediaToken });
    } catch (error) {
      return next(error);
    }
  });
  return router;
}
