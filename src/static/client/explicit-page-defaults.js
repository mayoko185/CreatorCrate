import { setFetchSaveStatus } from './settings-fetch-save.js';
import { DEFAULTS_EXPLICIT_SAVE_ATTRIBUTE } from './projects-defaults-fetch-save.js';
import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';

/*
 * Shared explicit Save new defaults controller for the combined Filters &
 * Defaults dialogs of pages with Global page defaults only (no
 * Global/Project-only scope): Asset Library (WP9a/WP9b) and Projects (WP10b).
 *
 * This is the reviewed WP9a/WP9b controller, unchanged in behaviour, with
 * every page-specific constant read from a `page` config instead:
 *   key, fields, multiFields, basePath, defaultsEndpoint, resetEndpoint,
 *   resetFiltersUrl, generationField, operationField, authoritySelector,
 *   formSelector, autosaveAttribute, dialogId, selectors, messages,
 *   savedStateMessages, live() and resetDefaultsDestination(returnTo, base).
 * Each page module (asset-library-filters-defaults.js,
 * projects-filters-defaults.js) owns its config and its public names.
 *
 * It owns, per page:
 *   - explicit "Save new defaults" (one coherent snapshot of the saveable
 *     settings, acknowledged once, reconciled when uncertain);
 *   - Reset filters (GET-only navigation to the authoritative destination);
 *   - Reset defaults (one CSRF-protected deletion POST, never repeated);
 * and the request-lifecycle rules that keep them from capturing or
 * installing stale state.
 *
 * Three states are kept apart:
 *   1. current intention  — the installed authority's `current` values while
 *      no GET is pending/failed, plus the session Grid style choice;
 *   2. installed results  — only an 'installed' live-region notification
 *      (never a prepared/parsed response) counts as installed;
 *   3. acknowledged saved defaults — only a confirmed POST answer or an
 *      authoritative read updates them.
 *
 * MUTATION PROTOCOL (WP9a F6/F7). Every Save / Reset defaults POST carries
 * the server's durable defaults generation it was prepared from and a unique
 * operation identity. The server advances the generation atomically with the
 * write and rejects an obsolete generation with a correlated 409, so an older
 * request delivered late can never overwrite a newer one (in either arrival
 * order, across reloads). Only an answer that echoes this request's operation
 * identity, with a result consistent with its HTTP status and generation, is
 * the application's answer; any other response (a gateway 502/504, an
 * unrelated 2xx, a middleware 403) proves nothing about the write.
 *
 * INITIALIZATION SAFETY (WP9b F2/F3). Save and Reset defaults are rendered
 * disabled type="button" controls with no native mutation; enhance arms them
 * LAST, only once this controller owns every one of their paths.
 */

const controllersByPage = new WeakMap();

function controllersFor(page) {
  let controllers = controllersByPage.get(page);
  if (!controllers) {
    controllers = new WeakMap();
    controllersByPage.set(page, controllers);
  }
  return controllers;
}

const GRID_STYLES = Object.freeze(['uncropped', 'cropped']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function defaultOperationId() {
  const cryptoImpl = globalThis.crypto;
  if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoImpl?.getRandomValues === 'function') cryptoImpl.getRandomValues(bytes);
  else bytes.forEach((_, index) => { bytes[index] = Math.floor(Math.random() * 256); });
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isScalar(value) {
  return typeof value === 'string' && value !== '';
}

function isMultiValue(value) {
  return value === 'all'
    || (Array.isArray(value) && value.length > 0 && value.every(isScalar) && !value.includes('all'));
}

function validValues(page, values) {
  if (!isRecord(values)) return false;
  return page.fields.every((field) => (
    page.multiFields.has(field) ? isMultiValue(values[field]) : isScalar(values[field])
  ) && (page.supportsValue?.(field, values[field]) ?? true));
}

function copyValues(page, values) {
  return Object.fromEntries(page.fields.map((field) => [
    field,
    Array.isArray(values[field]) ? [...values[field]] : values[field],
  ]));
}

function normalizedComparable(page, field, value) {
  if (!page.multiFields.has(field)) return typeof value === 'string' ? value : String(value ?? '');
  if (value === 'all' || value === undefined || value === null) return '';
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(String))].sort().join('\u0000');
}

export function sameExplicitPageDefaultsValues(page, left, right) {
  if (!isRecord(left) || !isRecord(right)) return false;
  return page.fields.every((field) => (
    normalizedComparable(page, field, left[field]) === normalizedComparable(page, field, right[field])
  ));
}

/**
 * Validates the server's authoritative metadata. Anything incomplete is
 * rejected (null) so a caller fails closed instead of guessing.
 */
export function parseExplicitPageDefaultsAuthority(page, value, { requireCurrent = false } = {}) {
  let authority = value;
  if (typeof value === 'string') {
    try {
      authority = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(authority) || authority.page !== page.key) return null;
  if (typeof authority.revision !== 'string' || authority.revision === '') return null;
  if (!isGeneration(authority.generation)) return null;
  if (!validValues(page, authority.defaults) || !validValues(page, authority.fallbacks)) return null;
  if (!isRecord(authority.saved) || !Array.isArray(authority.savedKeys)) return null;
  const savedComplete = page.fields.every((field) => (
    isRecord(authority.saved[field])
      && typeof authority.saved[field].stored === 'boolean'
      && typeof authority.saved[field].valid === 'boolean'
  ));
  if (!savedComplete) return null;
  const savedKeys = page.fields.filter((field) => authority.saved[field].stored);
  if (savedKeys.join() !== authority.savedKeys.join()) return null;
  if ((requireCurrent || (page.supportsValue && Object.hasOwn(authority, 'current')))
    && (!validValues(page, authority.current) || typeof authority.currentUrl !== 'string')) return null;
  return authority;
}

export function readExplicitPageDefaultsAuthority(page, document) {
  const script = document?.querySelector?.(page.authoritySelector);
  if (!script) return null;
  return parseExplicitPageDefaultsAuthority(page, script.textContent || '', { requireCurrent: true });
}

function defaultCsrfToken(document, form) {
  const field = form?.querySelector?.('input[name="_csrf"]')
    || document?.querySelector?.('input[name="_csrf"]');
  return field?.value || field?.getAttribute?.('value') || '';
}

/**
 * Whether a raw URL reference names something other than the base it would
 * be resolved against. The URL parser trims leading/trailing C0 controls and
 * spaces and drops every ASCII tab/newline before resolving; a reference left
 * empty, or holding only a fragment, then resolves to the base itself, query
 * included. Query-only and path-bearing references are meaningful (they
 * replace the base's query).
 *
 * P3-C3 follow-up: a scheme followed by nothing or only a fragment ("http:",
 * "HTTPS:#x") is just as empty — when the scheme matches the base's, the
 * parser resolves it relative to the base and inherits the current query —
 * so the remainder after a leading scheme must itself be meaningful.
 */
const URL_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function meaningfulUrlReference(value) {
  if (typeof value !== 'string') return false;
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  const reference = value.slice(start, end).replace(/[\t\n\r]/g, '');
  const remainder = reference.replace(URL_SCHEME_PREFIX, '');
  return remainder !== '' && !remainder.startsWith('#');
}

function pathOf(url, base) {
  try {
    const parsed = new URL(url, base || 'http://localhost/');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * The Reset defaults refresh destination when the server's own `refreshUrl`
 * was not received: the temporary context of `returnTo` (the page's
 * `temporaryQueryKeys`, repeated values kept repeated), page 1, every
 * default-backed control left to its post-deletion fallback.
 */
export function explicitPageResetDefaultsDestination(page, returnTo, base) {
  let parsed;
  try {
    parsed = new URL(returnTo || page.basePath, base || `http://localhost${page.basePath}`);
  } catch {
    return page.basePath;
  }
  const query = new URLSearchParams();
  page.temporaryQueryKeys.forEach((key) => {
    parsed.searchParams.getAll(key).forEach((value) => {
      const text = value.trim();
      if (text === '' || page.neutralTemporaryValues?.[key]?.includes(text)) return;
      query.append(key, text);
    });
  });
  const search = query.toString();
  return search ? `${page.basePath}?${search}` : page.basePath;
}

async function readJson(response) {
  if (typeof response?.json === 'function') {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  if (typeof response?.text === 'function') {
    try {
      return JSON.parse(await response.text());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Creates the explicit defaults controller for one document and page. All
 * collaborators are injectable for tests; the defaults use the page's
 * live-region engine, `fetch`, and the form's CSRF token.
 */
export function createExplicitPageDefaults(document, page, options = {}) {
  const messages = page.messages;
  const form = options.form ?? null;
  const live = options.live ?? page.live();
  const fetchImpl = options.fetch ?? document?.defaultView?.fetch?.bind(document.defaultView)
    ?? globalThis.fetch?.bind(globalThis);
  const readAuthority = options.readAuthority ?? (() => readExplicitPageDefaultsAuthority(page, document));
  const csrfToken = options.csrfToken ?? (() => defaultCsrfToken(document, form));
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const createOperationId = typeof options.createOperationId === 'function'
    ? options.createOperationId
    : defaultOperationId;
  const baseUrl = () => document?.defaultView?.location?.href || `http://localhost${page.basePath}`;

  const state = {
    seq: 0,
    // Session (unsaved) Grid style choice; null follows the installed page.
    gridStyleIntent: null,
    // Explicit Save / Reset defaults operation in progress (one at a time).
    operation: null,
    // Reset filters request: { id, generation, phase: pending|failed|incomplete }.
    filtersReset: null,
    // Saved-state metadata ownership. Every metadata source takes an order
    // from one monotonic clock: a GET (metadata read, reconciliation, live
    // page request) when it STARTS, a POST acknowledgement when it is
    // received. A source only replaces `metadata` when its order is newer,
    // so a slow older read never overwrites a newer answer. `authority:
    // null` records that a confirmed write left the known metadata stale.
    // The server's defaults generation orders metadata first: a lower
    // generation never replaces a higher one, whatever its clock order.
    clock: 0,
    metadata: null,
    liveStarts: new Map(),
    status: null,
    destroyed: false,
  };

  function snapshotLive() {
    try {
      return live.snapshot(document) || null;
    } catch {
      return null;
    }
  }

  function tick() {
    state.clock += 1;
    return state.clock;
  }

  function offerMetadata(authority, order, generation = authority?.generation) {
    const known = state.metadata;
    const offered = isGeneration(generation) ? generation : null;
    if (known) {
      if (offered !== null && known.generation !== null) {
        if (offered < known.generation) return false;
        if (offered === known.generation && order <= known.order) return false;
      } else if (order <= known.order) {
        return false;
      }
    }
    state.metadata = { authority: authority || null, order, generation: offered };
    if (authority) page.onMetadataAccepted?.(document, authority);
    return true;
  }

  // The newest known server generation: what a new mutation is based on.
  function knownGeneration() {
    const generation = state.metadata?.generation;
    return isGeneration(generation) ? generation : null;
  }

  const initialLive = snapshotLive();
  const initialAuthority = readAuthority();
  if (initialAuthority) offerMetadata(initialAuthority, 0);
  // A live request already pending at creation started after the rendered page.
  if (initialLive?.pending) state.liveStarts.set(initialLive.generation, tick());

  function report(message, kind) {
    state.status = { message, kind };
    if (form) setFetchSaveStatus(form, message, kind);
    onStatus?.(message, kind);
  }

  function changed() {
    onChange?.(api);
  }

  /*
   * Operation lifecycle (one defaults mutation at a time):
   *   posting      — POST dispatched, no answer yet;
   *   reconciling  — a GET-only check of an unconfirmed outcome is running;
   *   uncertain    — the outcome is unknown after a failed/inconclusive check;
   *   refreshing / refresh-failed — the write is CONFIRMED; only the GET
   *                  page refresh remains (never a repeated POST).
   * `confirmed` is true once a correlated committed answer proved the write
   * committed, and never reverts. `settled` is true once this request can no
   * longer commit later: its own correlated answer arrived, or an
   * authoritative read shows the server generation has moved past the one it
   * carried (the server fence now rejects it). A transport failure or any
   * uncorrelated response (a gateway 502/504 with plausible JSON, an
   * unrelated 2xx, a middleware 403) leaves the write UNRESOLVED while the
   * generation is unchanged: every later defaults mutation stays blocked.
   */
  function writeUnresolved(operation = state.operation) {
    if (!operation || operation.confirmed) return false;
    if (operation.phase === 'posting' || operation.phase === 'reconciling') return true;
    return operation.phase === 'uncertain' && !operation.settled;
  }

  function unresolvedMessage(operation) {
    if (operation.phase === 'posting' || operation.phase === 'reconciling') {
      if (operation.kind === 'save') return messages.saveInProgress;
      return messages.resetDefaultsRunning;
    }
    return operation.unresolvedMessage;
  }

  // Why a new defaults mutation (Save or Reset defaults) may not be sent.
  function mutationBlockedReason(kind) {
    const operation = state.operation;
    if (!writeUnresolved(operation)) return null;
    const message = unresolvedMessage(operation);
    if (operation.phase === 'posting' || operation.phase === 'reconciling') {
      return operation.kind === kind ? message : messages.busy;
    }
    return message;
  }

  // Only an in-flight POST or check holds the live-region navigation.
  function operationBusy() {
    const phase = state.operation?.phase;
    return phase === 'posting' || phase === 'reconciling';
  }

  function saveBlockedReason() {
    if (state.destroyed || typeof fetchImpl !== 'function') return messages.unavailable;
    const unresolved = mutationBlockedReason('save');
    if (unresolved) return unresolved;
    const liveState = snapshotLive();
    if (!liveState) return messages.unavailable;
    if (state.filtersReset?.phase === 'pending') return messages.resetPending;
    if (state.filtersReset) return messages.resetIncomplete;
    if (liveState.pending) return messages.loading;
    if (liveState.failed) return messages.loadFailed;
    // A confirmed write whose page refresh did not start: the controls still
    // show pre-write state, so they are not a coherent snapshot to save.
    if (state.operation?.phase === 'refresh-failed') return state.operation.refreshFailedMessage;
    if (!readAuthority()) return messages.unreadable;
    if (knownGeneration() === null) return messages.unreadable;
    return null;
  }

  /**
   * The one coherent current intention: the installed page's effective
   * values (one server generation) plus the session Grid style choice.
   * Returns null whenever that cannot be established safely.
   */
  function currentValues() {
    if (saveBlockedReason()) return null;
    const authority = readAuthority();
    if (!authority) return null;
    const values = copyValues(page, authority.current);
    if (state.gridStyleIntent) values.gridStyle = state.gridStyleIntent;
    return validValues(page, values) ? values : null;
  }

  // The newest owned saved-state metadata, or null when it is unknown (none
  // read yet, or a confirmed write made the last known metadata stale).
  function savedMetadata() {
    return state.metadata?.authority ?? null;
  }

  function currentGridStyle() {
    return state.gridStyleIntent || readAuthority()?.current?.gridStyle || null;
  }

  function setGridStyle(value) {
    if (!GRID_STYLES.includes(value)) return false;
    state.gridStyleIntent = value;
    changed();
    return true;
  }

  function mutationBody(operation, returnTo) {
    const body = new URLSearchParams();
    const token = csrfToken();
    if (token) body.append('_csrf', token);
    if (returnTo) body.append('returnTo', returnTo);
    body.append(page.generationField, String(operation.expectedGeneration));
    body.append(page.operationField, operation.operationId);
    return body;
  }

  function buildBody(operation, values, returnTo) {
    const body = mutationBody(operation, returnTo);
    page.fields.forEach((field) => {
      const value = values[field];
      // Repeated keys, never a comma-joined String(array).
      if (Array.isArray(value)) value.forEach((entry) => body.append(field, entry));
      else body.append(field, value);
    });
    return body;
  }

  function post(url, body) {
    return Promise.resolve().then(() => fetchImpl(url, {
      method: 'POST',
      body,
      credentials: 'same-origin',
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
    }));
  }

  // One metadata GET, owned by the clock value taken when it STARTS.
  function readAuthorityFromServer() {
    const order = tick();
    return Promise.resolve().then(() => fetchImpl(page.defaultsEndpoint, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })).then(async (response) => {
      if (!response?.ok) throw new Error('Defaults could not be read.');
      const payload = await readJson(response);
      const authority = parseExplicitPageDefaultsAuthority(page, payload?.authority);
      if (payload?.status !== 'success' || !authority) throw new Error('Defaults could not be read.');
      return { authority, order };
    });
  }

  // A POST acknowledgement describes state at least as new as its commit.
  // Without metadata the last known metadata is stale (recorded as null)
  // while the acknowledged generation stays known.
  function acknowledge(authority, order, generation) {
    offerMetadata(authority, order ?? tick(), generation ?? authority?.generation);
  }

  function isCurrent(operation) {
    return !state.destroyed && state.operation === operation;
  }

  function finishOperation(operation, message, kind) {
    if (!isCurrent(operation)) return;
    state.operation = null;
    report(message, kind);
    changed();
  }

  /*
   * F7: the application's own answer to THIS request, or null. It must echo
   * the operation identity and generation the request carried, and its
   * result must agree with the HTTP status and the generation it reports.
   * Status codes and generic `status` JSON are never enough on their own.
   */
  function correlatedAnswer(operation, response, payload) {
    const answer = payload?.operation;
    if (!isRecord(answer) || typeof answer.id !== 'string' || answer.id !== operation.operationId) return null;
    if (answer.kind !== operation.kind || answer.expectedGeneration !== operation.expectedGeneration) return null;
    const status = response?.status;
    switch (answer.result) {
      case 'committed':
        if (answer.committed !== true || answer.generation !== operation.expectedGeneration + 1) return null;
        if (status === 200 && response?.ok === true && payload.status === 'success') return answer;
        if (status === 500 && payload.status === 'error' && payload.committed === true) return answer;
        return null;
      case 'conflict':
        return status === 409 && answer.committed === false && isGeneration(answer.generation)
          && answer.generation !== operation.expectedGeneration ? answer : null;
      case 'invalid':
        return status === 422 && answer.committed === false ? answer : null;
      case 'failed':
        return status === 500 && answer.committed === false && payload.committed !== true ? answer : null;
      default:
        return null;
    }
  }

  function createOperation(kind, fields) {
    return {
      id: state.seq += 1,
      kind,
      phase: 'posting',
      operationId: String(createOperationId()),
      expectedGeneration: knownGeneration(),
      refreshGeneration: null,
      refreshDestination: null,
      confirmed: false,
      settled: false,
      unresolvedMessage: null,
      ...fields,
    };
  }

  // GET-only refresh after a confirmed operation; the POST is never repeated.
  function refreshAfter(operation, destination) {
    if (!isCurrent(operation)) return 'superseded';
    const liveState = snapshotLive();
    const url = destination || liveState?.intendedUrl || baseUrl();
    operation.refreshDestination = url;
    let historyMode = liveState?.outstandingHistoryMode;
    if (historyMode === undefined && liveState?.pending && liveState.requestedHistoryMode === 'push') {
      historyMode = 'push';
    }
    let outcome;
    try {
      outcome = live.navigate(document, url, { historyMode: historyMode ?? 'replace' });
    } catch {
      outcome = { status: 'unavailable' };
    }
    if (outcome?.status !== 'started') {
      operation.phase = 'refresh-failed';
      operation.refreshGeneration = null;
      report(operation.refreshFailedMessage, 'saved-refresh-error');
      changed();
      return 'refresh-failed';
    }
    operation.phase = 'refreshing';
    operation.refreshGeneration = outcome.generation;
    changed();
    return 'refreshing';
  }

  // Best-effort GET of the saved metadata after a confirmed write whose
  // answer carried none. Its failure never changes the confirmed outcome.
  function readMetadataAfterCommit() {
    readAuthorityFromServer().then(({ authority, order }) => {
      if (state.destroyed) return;
      if (offerMetadata(authority, order)) changed();
    }, () => {});
  }

  /**
   * The write is proven committed (an explicit acknowledgement, or an
   * application answer plus a matching authoritative read). `confirmed` is
   * permanent: later read or refresh failures are reported separately.
   */
  function confirm(operation, authority, generation) {
    if (!isCurrent(operation)) return 'superseded';
    operation.confirmed = true;
    operation.settled = true;
    acknowledge(authority, tick(), generation);
    if (!authority) readMetadataAfterCommit();
    const liveState = snapshotLive();
    // A newer explicit choice made while the POST was pending wins: refresh
    // that intent rather than the operation's own destination.
    const untouched = liveState && liveState.generation === operation.startGeneration;
    let destination = null;
    if (operation.kind === 'resetDefaults' && untouched) {
      // The server's destination, else the same post-deletion destination
      // rebuilt from the returnTo sent — never the old URL, whose
      // default-backed values are obsolete after the deletion.
      destination = operation.refreshUrl || operation.fallbackRefreshUrl;
      // Default-backed choices follow the application fallbacks again, unless
      // a newer session Grid style was chosen during the POST.
      if (state.gridStyleIntent === operation.gridStyleBefore) state.gridStyleIntent = null;
    }
    return refreshAfter(operation, destination);
  }

  function reject(operation, message) {
    finishOperation(operation, message, 'error');
    return 'rejected';
  }

  // A correlated generation conflict: the server wrote nothing. Current
  // authority from the answer (or a GET) becomes the known metadata; the
  // user's current choices stay, and nothing is resent automatically.
  function conflict(operation, payload, answer) {
    if (!isCurrent(operation)) return 'superseded';
    operation.settled = true;
    const authority = parseExplicitPageDefaultsAuthority(page, payload?.authority);
    if (authority && authority.generation === answer.generation) offerMetadata(authority, tick());
    else readMetadataAfterCommit();
    finishOperation(operation, operation.kind === 'save'
      ? messages.saveConflict
      : messages.resetConflict, 'error');
    return 'conflict';
  }

  function markUncertain(operation, message) {
    operation.phase = 'uncertain';
    operation.unresolvedMessage = message;
    report(message, 'error');
    changed();
    return 'uncertain';
  }

  function reconcile(operation) {
    if (!isCurrent(operation)) return Promise.resolve('superseded');
    operation.phase = 'reconciling';
    report(messages.checking, 'pending');
    changed();
    const save = operation.kind === 'save';
    return readAuthorityFromServer().then(({ authority, order }) => {
      if (!isCurrent(operation)) return 'superseded';
      offerMetadata(authority, order);
      // F6: once the server generation has moved past the one this request
      // carried, the fence rejects it if it ever arrives: it can no longer
      // commit, so the barrier is released. Whether it was this request that
      // moved the generation is still unknown, and is not claimed.
      if (operation.settled || authority.generation > operation.expectedGeneration) {
        operation.settled = true;
        return markUncertain(operation, save
          ? messages.saveOutcomeUnknown
          : messages.resetOutcomeUnknown);
      }
      const stored = save
        ? page.fields.every((field) => (
          authority.saved[field].stored && authority.saved[field].valid
        )) && sameExplicitPageDefaultsValues(page, authority.defaults, operation.snapshot)
        : authority.savedKeys.length === 0;
      // The generation is unchanged: the request may still be committed
      // later. Neither matching nor old values prove what this POST did, so
      // the outcome stays unresolved and the barrier stays.
      if (stored) {
        return markUncertain(operation, save
          ? messages.saveMatchesUnconfirmed
          : messages.resetMatchesUnconfirmed);
      }
      return markUncertain(operation, save
        ? messages.saveUnresolved
        : messages.resetDefaultsUnresolved);
    }, () => {
      if (!isCurrent(operation)) return 'superseded';
      if (operation.settled) {
        return markUncertain(operation, save
          ? messages.uncertain
          : messages.defaultsResetUncertain);
      }
      // Keep a known "values already match" finding from an earlier check.
      return markUncertain(operation, operation.unresolvedMessage || (save
        ? messages.saveUnresolved
        : messages.resetDefaultsUnresolved));
    });
  }

  async function save() {
    const blocked = saveBlockedReason();
    if (blocked) {
      report(blocked, 'error');
      return { outcome: 'blocked', reason: blocked };
    }
    const authority = readAuthority();
    const snapshot = currentValues();
    if (!authority || !snapshot) {
      report(messages.unreadable, 'error');
      return { outcome: 'blocked', reason: messages.unreadable };
    }
    const operation = createOperation('save', {
      snapshot,
      startGeneration: snapshotLive()?.generation ?? null,
      refreshFailedMessage: messages.savedRefreshFailed,
      doneMessage: messages.saved,
    });
    state.operation = operation;
    report(messages.saving, 'pending');
    changed();

    let response;
    try {
      response = await post(page.defaultsEndpoint, buildBody(operation, snapshot, authority.currentUrl));
    } catch {
      // Nothing proves the request did not reach the server: unresolved.
      return { outcome: await reconcile(operation), snapshot };
    }
    if (!isCurrent(operation)) return { outcome: 'superseded', snapshot };
    const payload = await readJson(response);
    if (!isCurrent(operation)) return { outcome: 'superseded', snapshot };
    const answer = correlatedAnswer(operation, response, payload);
    // Not this handler's answer to this request (a gateway, an unrelated
    // response, an unreadable body): the request may still be executing.
    if (!answer) return { outcome: await reconcile(operation), snapshot };
    operation.settled = true;

    if (answer.result === 'committed') {
      // Acknowledge only the submitted snapshot; an echo of other values is
      // not a consistent acknowledgement of this request.
      if (payload.status === 'success' && !sameExplicitPageDefaultsValues(page, payload.values, snapshot)) {
        operation.settled = false;
        return { outcome: await reconcile(operation), snapshot };
      }
      const acknowledged = parseExplicitPageDefaultsAuthority(page, payload.authority);
      const coherent = acknowledged && acknowledged.generation === answer.generation
        && sameExplicitPageDefaultsValues(page, acknowledged.defaults, snapshot);
      return { outcome: confirm(operation, coherent ? acknowledged : null, answer.generation), snapshot };
    }
    if (answer.result === 'conflict') return { outcome: conflict(operation, payload, answer), snapshot };
    if (answer.result === 'invalid') {
      operation.errors = isRecord(payload.errors) ? payload.errors : {};
      return { outcome: reject(operation, messages.invalid), snapshot, errors: operation.errors };
    }
    // 'failed': the handler rolled the transaction back and said so.
    return { outcome: reject(operation, messages.notSaved), snapshot };
  }

  // A same-origin address of this page's own path; anything else is treated
  // as no destination at all. P3 correction 3: checked BEFORE resolution, a
  // reference the URL parser would reduce to nothing or to a bare fragment
  // (empty, whitespace, "#…") resolves to the CURRENT address — its temporary
  // restrictions included — and so is no Reset destination. P3-C3 follow-up:
  // so is a scheme-only reference ("http:", "http:#x"), and so is any address
  // carrying userinfo — origin ignores credentials, but the request engine
  // cannot fetch such a URL, so the Reset would never be issued.
  function pageResetDestination(value) {
    if (!meaningfulUrlReference(value)) return false;
    try {
      const base = new URL(baseUrl());
      const url = new URL(value, base);
      if (url.username !== '' || url.password !== '') return false;
      return url.origin === base.origin && url.pathname === page.basePath;
    } catch {
      return false;
    }
  }

  function resetFilters() {
    if (state.destroyed) return { outcome: 'unavailable' };
    if (operationBusy()) {
      report(messages.busy, 'error');
      return { outcome: 'blocked' };
    }
    // The installed authority's destination; without one (authority missing,
    // unparseable or carrying no destination, or — P3-B — one that does not
    // address this page) a page may derive its Reset from the installed page
    // (C4: Calendar keeps the displayed month; P3-B: Releases keeps the
    // intended page size), and refuses rather than navigate somewhere wrong
    // when it cannot.
    const authorityDestination = readAuthority()?.resetFiltersUrl;
    const destination = pageResetDestination(authorityDestination)
      ? authorityDestination
      : (typeof page.resetFiltersFallback === 'function' ? page.resetFiltersFallback(document) : page.resetFiltersUrl);
    if (!destination) {
      report(messages.resetFiltersUnavailable, 'error');
      return { outcome: 'blocked' };
    }
    let outcome;
    try {
      outcome = live.navigate(document, destination, { historyMode: 'push' });
    } catch {
      outcome = { status: 'unavailable' };
    }
    if (outcome?.status !== 'started') return { outcome: 'unavailable', destination };
    // The session Grid style yields to the saved one; a choice made after
    // this point is newer and wins.
    state.gridStyleIntent = null;
    state.filtersReset = {
      id: state.seq += 1, generation: outcome.generation, phase: 'pending', destination: pathOf(destination, baseUrl()),
    };
    changed();
    return { outcome: 'started', generation: outcome.generation };
  }

  async function resetDefaults() {
    if (state.destroyed || typeof fetchImpl !== 'function') {
      report(messages.unavailable, 'error');
      return { outcome: 'blocked' };
    }
    // An unresolved write blocks; a confirmed one whose refresh failed is
    // recovered by its GET-only Retry, never by deleting again.
    const blocked = mutationBlockedReason('resetDefaults')
      || (state.operation?.phase === 'refresh-failed' ? state.operation.refreshFailedMessage : null)
      || (knownGeneration() === null ? messages.unreadable : null);
    if (blocked) {
      report(blocked, 'error');
      return { outcome: 'blocked', reason: blocked };
    }
    const liveState = snapshotLive();
    const returnTo = pathOf(liveState?.intendedUrl || baseUrl(), baseUrl()) || page.basePath;
    const operation = createOperation('resetDefaults', {
      startGeneration: liveState?.generation ?? null,
      refreshUrl: null,
      fallbackRefreshUrl: page.resetDefaultsDestination(returnTo, baseUrl()),
      gridStyleBefore: state.gridStyleIntent,
      refreshFailedMessage: messages.defaultsResetRefreshFailed,
      doneMessage: messages.defaultsReset,
    });
    state.operation = operation;
    report(messages.resettingDefaults, 'pending');
    changed();

    const body = mutationBody(operation, returnTo);

    let response;
    try {
      response = await post(page.resetEndpoint, body);
    } catch {
      return { outcome: await reconcile(operation) };
    }
    if (!isCurrent(operation)) return { outcome: 'superseded' };
    const payload = await readJson(response);
    if (!isCurrent(operation)) return { outcome: 'superseded' };
    const answer = correlatedAnswer(operation, response, payload);
    if (!answer) return { outcome: await reconcile(operation) };
    operation.settled = true;

    if (answer.result === 'committed') {
      if (typeof payload.refreshUrl === 'string' && pathOf(payload.refreshUrl, baseUrl())?.startsWith(page.basePath)) {
        operation.refreshUrl = payload.refreshUrl;
      }
      // The handler confirmed the deletion. Its metadata is used when it is
      // coherent; otherwise the confirmation stands and metadata is re-read.
      const authority = parseExplicitPageDefaultsAuthority(page, payload.authority);
      const coherent = authority && authority.generation === answer.generation && authority.savedKeys.length === 0;
      return { outcome: confirm(operation, coherent ? authority : null, answer.generation) };
    }
    if (answer.result === 'conflict') return { outcome: conflict(operation, payload, answer) };
    return { outcome: reject(operation, messages.defaultsNotReset) };
  }

  // GET-only recovery of a confirmed operation whose refresh failed.
  function retryRefresh() {
    const operation = state.operation;
    if (!operation || operation.phase !== 'refresh-failed') return 'unavailable';
    const liveState = snapshotLive();
    // A newer edit can already own a debounced GET before its started event.
    if (liveState?.outstandingHistoryMode != null && liveState.pending) return 'superseded';
    report(operation.kind === 'save'
      ? messages.saving
      : messages.resettingDefaults, 'pending');
    return refreshAfter(operation, operation.refreshDestination);
  }

  // GET-only re-check of an uncertain POST outcome. For an unresolved write
  // it updates what is known about the stored state but never releases the
  // mutation barrier (see writeUnresolved).
  function retryReconcile() {
    const operation = state.operation;
    if (!operation || operation.phase !== 'uncertain') return Promise.resolve('unavailable');
    return reconcile(operation);
  }

  // Reopening the dialog: re-read the authoritative saved metadata (GET).
  // An answer older than the newest known metadata is ignored.
  function refreshSavedMetadata() {
    return readAuthorityFromServer().then(({ authority, order }) => {
      if (state.destroyed) return null;
      if (offerMetadata(authority, order)) changed();
      return savedMetadata();
    });
  }

  function handleLive(detail) {
    if (state.destroyed || !isRecord(detail)) return;
    const { phase, generation } = detail;
    const operation = state.operation;
    const reset = state.filtersReset;

    if (phase === 'started') {
      state.liveStarts.set(generation, tick());
      // The engine's GET-only Retry (or any newer navigation) adopts a
      // failed refresh; the confirmed POST is not repeated.
      if (operation?.phase === 'refresh-failed') {
        operation.phase = 'refreshing';
        operation.refreshGeneration = generation;
        if (typeof detail.url === 'string') operation.refreshDestination = detail.url;
      }
      // The engine's GET Retry of a failed Reset filters repeats its address:
      // the page's fixed Reset address, or (WP12 Releases, whose Reset keeps
      // the URL page size) the exact destination that Reset requested.
      const startedPath = pathOf(detail.url, baseUrl());
      if (reset && reset.phase !== 'pending'
        && (startedPath === page.resetFiltersUrl || (reset.destination && startedPath === reset.destination))) {
        reset.generation = generation;
        reset.phase = 'pending';
      }
      changed();
      return;
    }

    const startedOrder = state.liveStarts.get(generation) ?? 0;
    state.liveStarts.delete(generation);

    if (phase === 'installed') {
      const authority = readAuthority();
      // The page's metadata is owned by when its request started: a request
      // that predates an acknowledgement cannot undo it.
      if (authority) offerMetadata(authority, startedOrder);
      if (reset && reset.generation === generation) {
        // Installed is not enough: the page must carry valid authority.
        if (authority) state.filtersReset = null;
        else reset.phase = 'incomplete';
      } else if (reset && reset.phase !== 'pending' && authority) {
        // A later successful authoritative install recovers the page.
        state.filtersReset = null;
      }
      if (operation && operation.phase === 'refreshing' && operation.refreshGeneration === generation) {
        finishOperation(operation, operation.doneMessage, 'saved');
        return;
      }
      changed();
      return;
    }

    if (phase === 'failed') {
      if (reset && reset.generation === generation) reset.phase = 'failed';
      if (operation && operation.phase === 'refreshing' && operation.refreshGeneration === generation) {
        operation.phase = 'refresh-failed';
        report(operation.refreshFailedMessage, 'saved-refresh-error');
      }
      changed();
      return;
    }

    if (phase === 'superseded') {
      // A newer explicit choice wins over an older pending Reset.
      if (reset && reset.phase === 'pending' && reset.generation === generation) state.filtersReset = null;
      if (operation && operation.phase === 'refreshing' && operation.refreshGeneration === generation) {
        // The superseding navigation started after the commit, so its
        // response renders the confirmed state; the operation is complete.
        finishOperation(operation, operation.doneMessage, 'saved');
        return;
      }
      changed();
    }
  }

  let unsubscribe = null;
  try {
    unsubscribe = live.subscribe(document, handleLive) || null;
  } catch {
    unsubscribe = null;
  }

  function destroy() {
    state.destroyed = true;
    unsubscribe?.();
  }

  const api = {
    form,
    saveBlockedReason,
    currentValues,
    savedMetadata,
    currentGridStyle,
    setGridStyle,
    save,
    resetFilters,
    resetDefaults,
    retryRefresh,
    retryReconcile,
    refreshSavedMetadata,
    destroy,
    get operation() {
      const operation = state.operation;
      return operation ? {
        kind: operation.kind,
        phase: operation.phase,
        confirmed: operation.confirmed,
        expectedGeneration: operation.expectedGeneration,
        // An earlier write may still commit: no defaults mutation is sent.
        unresolved: writeUnresolved(operation),
      } : null;
    },
    get filtersReset() {
      return state.filtersReset ? { ...state.filtersReset } : null;
    },
    get status() {
      return state.status ? { ...state.status } : null;
    },
    get generation() {
      return knownGeneration();
    },
  };
  return api;
}


export function explicitPageDefaultsController(document, page) {
  return controllersFor(page).get(document) || null;
}

export function describeExplicitPageSavedState(page, metadata, current, { readFailed = false } = {}) {
  const SAVED = page.savedStateMessages;
  if (!metadata) {
    return readFailed ? SAVED.unreadable : SAVED.checking;
  }
  const total = page.fields.length;
  const count = page.fields.filter((field) => metadata.saved?.[field]?.stored === true).length;
  const parts = [count === 0
    ? SAVED.none
    : (count === total ? SAVED.all : `${count} of ${total} defaults saved`)];
  if (validValues(page, current) && validValues(page, metadata.defaults)
    && !sameExplicitPageDefaultsValues(page, current, metadata.defaults)) {
    parts.push(count === 0
      ? SAVED.differsFromApplication
      : SAVED.differsFromSaved);
  }
  return `${parts.join(' · ')}.`;
}

function setButtonHeld(button, held) {
  if (!button) return;
  if (held) button.setAttribute?.('aria-disabled', 'true');
  else button.removeAttribute?.('aria-disabled');
}

// Save and Reset defaults are rendered disabled type="button" controls with
// no native mutation; only a fully bound controller makes them usable.
function armControl(button) {
  if (!button) return;
  button.disabled = false;
  button.removeAttribute?.('disabled');
}

function setElementHidden(element, hidden) {
  if (!element) return;
  element.hidden = hidden;
  if (hidden) element.setAttribute?.('hidden', '');
  else element.removeAttribute?.('hidden');
}

/**
 * WP9b presentation binding for the combined dialog. Returns `sync`, which
 * the controller's onChange calls; everything it writes is derived from the
 * controller and the installed page, so it can run any number of times.
 */
export function bindExplicitPageDefaultsDialog(document, controller, page, { live = page.live() } = {}) {
  const selectors = page.selectors;
  const view = { readFailed: false };

  function applyGridStyle() {
    const style = controller.currentGridStyle();
    if (!GRID_STYLES.includes(style)) return;
    document.querySelectorAll?.(selectors.grid)?.forEach?.((grid) => {
      if (grid.getAttribute?.('data-grid-style') !== style) grid.setAttribute?.('data-grid-style', style);
    });
    const control = document.querySelector?.(selectors.gridStyleControl);
    if (control && control.value !== style) {
      control.value = style;
      syncCreatorCrateDropdownFromNative(control);
    }
  }

  function currentIntention() {
    const authority = readExplicitPageDefaultsAuthority(page, document);
    if (!authority) return null;
    const current = copyValues(page, authority.current);
    const style = controller.currentGridStyle();
    if (GRID_STYLES.includes(style)) current.gridStyle = style;
    return current;
  }

  function renderIndicator() {
    const indicator = document.querySelector?.(selectors.indicator);
    if (!indicator) return;
    const text = describeExplicitPageSavedState(page, controller.savedMetadata(), currentIntention(), view);
    if (indicator.textContent !== text) indicator.textContent = text;
    // R1: after a confirmed Save of every eligible setting the indicator reads
    // exactly what the status line just announced ("Defaults saved."). The
    // status line owns that confirmation (it is the live region), so the
    // indicator steps aside while the two would be identical and returns as
    // soon as its saved state says something the status line does not.
    // Compared with the rendered status line, so the indicator is never
    // hidden behind a status the user cannot see.
    const shown = String(controller.form?.querySelector?.('[data-settings-fetch-save-status]')?.textContent ?? '').trim();
    setElementHidden(indicator, shown !== '' && shown === text.trim());
  }

  function renderOperation() {
    const operation = controller.operation;
    const busy = operation?.phase === 'posting' || operation?.phase === 'reconciling';
    setButtonHeld(document.querySelector?.(selectors.save), busy);
    setButtonHeld(document.querySelector?.(selectors.defaultsReset), busy);
    const form = controller.form;
    if (busy) form?.setAttribute?.('aria-busy', 'true');
    else form?.removeAttribute?.('aria-busy');

    let liveFailed = false;
    try {
      liveFailed = Boolean(live.snapshot(document)?.failed);
    } catch {
      liveFailed = false;
    }
    // The engine's own GET Retry owns a failed load; this one covers a
    // confirmed write whose refresh could not even start.
    const retry = operation?.phase === 'refresh-failed' && !liveFailed;
    const check = operation?.phase === 'uncertain';
    setElementHidden(document.querySelector?.(selectors.retry), !retry);
    setElementHidden(document.querySelector?.(selectors.check), !check);
    setElementHidden(document.querySelector?.(selectors.recovery), !(retry || check));
  }

  function sync() {
    applyGridStyle();
    renderIndicator();
    renderOperation();
  }

  function refreshMetadata() {
    return controller.refreshSavedMetadata().then((metadata) => {
      view.readFailed = false;
      sync();
      return metadata;
    }, () => {
      view.readFailed = true;
      sync();
      return null;
    });
  }

  document.addEventListener?.('change', (event) => {
    const target = event.target;
    if (!target?.matches?.(selectors.gridStyleControl)) return;
    // A current-session choice: no POST, no navigation.
    if (!controller.setGridStyle(String(target.value ?? ''))) sync();
  });
  document.addEventListener?.('click', (event) => {
    const target = event.target;
    if (target?.closest?.(selectors.retry)) {
      event.preventDefault?.();
      controller.retryRefresh();
      sync();
      return;
    }
    if (target?.closest?.(selectors.check)) {
      event.preventDefault?.();
      void controller.retryReconcile().then(sync, sync);
      return;
    }
    const opener = target?.closest?.(`[data-dialog-open="${page.dialogId}"]`);
    // Reopening re-reads the authoritative saved metadata (GET only).
    if (opener) void refreshMetadata();
  });

  sync();
  return { sync, refreshMetadata };
}

export function enhanceExplicitPageDefaults(document, page, options = {}) {
  const selectors = page.selectors;
  const controllers = controllersFor(page);
  if (!document?.querySelector) return null;
  const existing = controllers.get(document);
  if (existing) return existing;
  const form = document.querySelector(page.formSelector);
  if (!form?.hasAttribute?.(DEFAULTS_EXPLICIT_SAVE_ATTRIBUTE)
    || (page.autosaveAttribute && form.hasAttribute?.(page.autosaveAttribute))) return null;

  let dialog = null;
  const controller = createExplicitPageDefaults(document, page, {
    ...options,
    form,
    onChange: (api) => {
      options.onChange?.(api);
      dialog?.sync();
    },
    // R1: a new status line can make the saved-state indicator redundant
    // (or no longer redundant), so the indicator re-renders with it.
    onStatus: (message, kind) => {
      options.onStatus?.(message, kind);
      dialog?.sync();
    },
  });
  controllers.set(document, controller);
  dialog = bindExplicitPageDefaultsDialog(document, controller, page, options.live ? { live: options.live } : {});
  form.addEventListener?.('submit', (event) => {
    // Never a native submission: requestSubmit() saves through the same
    // controller as the button, as one snapshot.
    event.preventDefault?.();
    void controller.save();
  });
  document.addEventListener?.('click', (event) => {
    const target = event.target;
    // The Save button is type="button": the controller owns its activation
    // (pointer and keyboard both dispatch this click).
    if (target?.closest?.(selectors.save)) {
      event.preventDefault?.();
      void controller.save();
      return;
    }
    const defaultsReset = target?.closest?.(selectors.defaultsReset);
    if (defaultsReset) {
      event.preventDefault?.();
      void controller.resetDefaults();
      return;
    }
    const filtersReset = target?.closest?.(selectors.filtersReset);
    if (!filtersReset) return;
    // Started: the live GET owns it. Blocked: a defaults POST is in flight, so
    // the native GET fallback must not navigate away from it either. Only an
    // unavailable live engine falls back to the native GET form.
    const { outcome } = controller.resetFilters();
    if (outcome === 'started' || outcome === 'blocked') event.preventDefault?.();
  });
  // Armed last: the server renders Save and Reset defaults disabled, so they
  // only become usable once this controller owns every one of their paths.
  // A failure above leaves both inert (WP9b F2, F3).
  armControl(document.querySelector?.(selectors.save));
  armControl(document.querySelector?.(selectors.defaultsReset));
  return controller;
}
