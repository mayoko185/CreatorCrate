import { isEnhancementBound, markEnhancementBound } from './dom.js';

const COMPANION_SELECTOR = '[data-release-social-prep-companion]';
const ACTION_SELECTOR = '[data-release-social-prep-companion-action]';
const STATUS_SELECTOR = '[data-release-social-prep-companion-status]';
const BOUND_KEY = 'releaseSocialPrepCompanionBound';
const OPENING_MESSAGE = 'Opening publishing companion…';
const FAILURE_MESSAGE = 'Could not open publishing companion.';
const ACTIVE_MESSAGE = 'Publishing companion preparation is already active.';
const RECOVERY_LABEL = 'Refresh page to retry';
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INTENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

function companionElements(scope) {
  if (!scope) return [];
  if (scope.matches?.(COMPANION_SELECTOR)) return [scope];
  if (typeof scope.querySelectorAll === 'function') return [...scope.querySelectorAll(COMPANION_SELECTOR)];
  const element = scope.querySelector?.(COMPANION_SELECTOR);
  return element ? [element] : [];
}

function setStatus(element, message, failed = false) {
  const status = element?.querySelector?.(STATUS_SELECTOR);
  if (!status) return;
  status.hidden = false;
  status.removeAttribute?.('hidden');
  status.setAttribute?.('role', failed ? 'alert' : 'status');
  status.textContent = message;
}

function claimPrepMarker(windowObject) {
  const url = new URL(windowObject.location.href);
  const markers = url.searchParams.getAll('prep');
  if (markers.length !== 1 || markers[0] !== '1') return false;
  url.searchParams.delete('prep');
  windowObject.history.replaceState(windowObject.history.state, '', url.href);
  return true;
}

async function readResponse(response) {
  if (!response || typeof response.json !== 'function') return { response, body: null };
  try {
    return { response, body: await response.json() };
  } catch {
    return { response, body: null };
  }
}

function cleanServerOrigin(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.pathname !== '/'
    || parsed.search || parsed.hash) return null;
  if (value !== parsed.origin && value !== `${parsed.origin}/`) return null;
  return parsed.origin;
}

function validActivationResponse(body, expectedCurrentOrigin, targetPlatform = null) {
  if (!body || body.ok !== true || typeof body.sessionId !== 'string'
    || !SESSION_ID_PATTERN.test(body.sessionId) || typeof body.uri !== 'string'
    || body.uri !== body.uri.trim()) return false;
  if (targetPlatform !== null
    && (!Array.isArray(body.platforms) || body.platforms.length !== 1 || body.platforms[0] !== targetPlatform)) return false;

  let parsed;
  try {
    parsed = new URL(body.uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'creatorcrate-social:' || parsed.host !== 'prepare'
    || parsed.username || parsed.password || parsed.port || parsed.pathname !== ''
    || parsed.hash || !body.uri.startsWith('creatorcrate-social://prepare?')) return false;

  const rawQuery = body.uri.slice(body.uri.indexOf('?') + 1);
  const fields = new Map();
  for (const pair of rawQuery.split('&')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) return false;
    const key = pair.slice(0, separator);
    if (!['v', 'server', 'intent'].includes(key) || fields.has(key)) return false;
    fields.set(key, pair.slice(separator + 1));
  }
  if (fields.size !== 3 || fields.get('v') !== '2'
    || !INTENT_TOKEN_PATTERN.test(fields.get('intent'))) return false;

  const serverOrigin = parsed.searchParams.get('server');
  const decodedServerOrigin = cleanServerOrigin(serverOrigin);
  return decodedServerOrigin !== null
    && fields.get('server') === encodeURIComponent(serverOrigin)
    && decodedServerOrigin === expectedCurrentOrigin;
}

function enhanceCompanionElement(element, scope, options) {
  if (!element || isEnhancementBound(element, BOUND_KEY)) return 0;

  const action = element.querySelector?.(ACTION_SELECTOR);
  const document = element.ownerDocument || (scope?.nodeType === 9 ? scope : globalThis.document);
  const windowObject = options.windowObject || document?.defaultView || globalThis;
  const fetchRequest = options.fetchRequest || ((...args) => globalThis.fetch(...args));
  const launchProtocol = options.launchProtocol || ((uri) => windowObject.location.assign(uri));
  const activationUrl = element.getAttribute?.('data-activation-url');
  const reissueUrl = element.getAttribute?.('data-reissue-url');
  const csrfToken = element.getAttribute?.('data-csrf-token');
  const targetPlatform = element.getAttribute?.('data-target-platform');
  let mode = element.getAttribute?.('data-action-mode');
  let sessionId = element.getAttribute?.('data-session-id');
  let inFlight = false;
  let reloadRequired = false;

  if (!action || !activationUrl || !reissueUrl || !csrfToken || typeof fetchRequest !== 'function' || typeof launchProtocol !== 'function') {
    return 0;
  }
  markEnhancementBound(element, BOUND_KEY);

  const openCompanion = async () => {
    if (inFlight || reloadRequired) return;
    inFlight = true;
    action.disabled = true;
    setStatus(element, OPENING_MESSAGE);

    const requestMode = mode;
    const requestSessionId = sessionId;
    const url = requestMode === 'reissue' ? reissueUrl : activationUrl;
    const body = requestMode === 'reissue'
      ? { sessionId: requestSessionId }
      : requestMode === 'reprepare'
        ? { ...(targetPlatform ? { platforms: [targetPlatform] } : {}), reprepare: true }
        : {};

    try {
      const { response, body: responseBody } = await readResponse(await fetchRequest(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(body),
      }));
      if (!response?.ok || !validActivationResponse(responseBody, windowObject.location.origin, targetPlatform)) {
        const active = response?.status === 409 && responseBody?.error?.code === 'attempt_in_progress';
        if (response?.ok) {
          // A 2xx response may already have rotated server authority. Clear the local session and
          // require a refresh rather than retrying either an unvalidated replacement or a stale ID.
          mode = 'recover';
          sessionId = null;
          reloadRequired = true;
          action.textContent = RECOVERY_LABEL;
          action.removeAttribute?.('aria-label');
          action.removeAttribute?.('title');
        }
        setStatus(element, active ? ACTIVE_MESSAGE : FAILURE_MESSAGE, true);
        return;
      }

      mode = 'reissue';
      sessionId = responseBody.sessionId;
      action.textContent = 'Retry opening companion';
      action.removeAttribute?.('aria-label');
      action.removeAttribute?.('title');
      try {
        launchProtocol(responseBody.uri);
      } catch {
        setStatus(element, FAILURE_MESSAGE, true);
      }
    } catch {
      setStatus(element, FAILURE_MESSAGE, true);
    } finally {
      inFlight = false;
      action.disabled = reloadRequired;
    }
  };

  action.addEventListener?.('click', openCompanion);

  if (element.getAttribute?.('data-auto-launch') === 'true') {
    try {
      if (claimPrepMarker(windowObject)) Promise.resolve().then(openCompanion);
    } catch {
      setStatus(element, FAILURE_MESSAGE, true);
    }
  }

  return 1;
}

export function enhanceReleaseSocialPrepAutoLaunch(scope = globalThis.document, options = {}) {
  return companionElements(scope)
    .reduce((count, element) => count + enhanceCompanionElement(element, scope, options), 0);
}
