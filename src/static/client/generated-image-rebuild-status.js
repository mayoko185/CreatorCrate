import { presentGeneratedImageRebuild } from './generated-image-rebuild-presenter.js';

const CARD_SELECTOR = '[data-generated-images-rebuild]';
const STATUS_URL = '/settings/defaults/generated-images/rebuild-status';
const POLL_INTERVAL_MS = 2_000;
const ACTIVE_PHASES = new Set(['queued', 'running']);
const controllers = new WeakMap();

function cardFor(state) {
  return state.document.querySelector(CARD_SELECTOR);
}

function clearPoll(state) {
  if (state.timer !== null) state.window.clearTimeout(state.timer);
  state.timer = null;
}

function invalidate(state) {
  state.generation += 1;
  clearPoll(state);
}

function schedulePoll(state) {
  clearPoll(state);
  if (state.stopped || !ACTIVE_PHASES.has(cardFor(state)?.dataset.rebuildPhase)) return;
  state.timer = state.window.setTimeout(() => {
    state.timer = null;
    refreshStatus(state);
  }, POLL_INTERVAL_MS);
}

function showStatus(state, status) {
  const card = cardFor(state);
  if (!card) return;
  const view = presentGeneratedImageRebuild(status);
  const message = card.querySelector('[data-rebuild-message]');
  const details = card.querySelector('[data-rebuild-details]');
  card.dataset.rebuildPhase = view.phase;
  card.dataset.rebuildRunId = view.runId;
  if (message && message.textContent !== view.message) message.textContent = view.message;
  if (details) {
    if (details.textContent !== view.details) details.textContent = view.details;
    details.hidden = !view.details;
  }
  schedulePoll(state);
}

async function refreshStatus(state) {
  if (state.stopped || !cardFor(state)) return;
  const generation = state.generation;
  const request = ++state.latestRequest;
  try {
    const response = await globalThis.fetch(STATUS_URL, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Status request failed.');
    const status = await response.json();
    if (state.stopped || generation !== state.generation || request !== state.latestRequest) return;
    showStatus(state, status);
  } catch {
    if (!state.stopped && generation === state.generation && request === state.latestRequest) {
      schedulePoll(state);
    }
  }
}

function setActionError(state, message) {
  const error = cardFor(state)?.querySelector('[data-rebuild-action-error]');
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

async function submitManualRebuild(state, form) {
  if (state.manualPending) return;
  const button = cardFor(state)?.querySelector('[data-generated-images-rebuild-button]');
  state.manualPending = true;
  if (button) button.disabled = true;
  setActionError(state, '');
  invalidate(state);
  const generation = state.generation;
  try {
    const response = await globalThis.fetch(form.action, {
      method: 'POST',
      body: new globalThis.URLSearchParams(new globalThis.FormData(form)),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      credentials: 'same-origin',
      redirect: 'follow',
    });
    const location = new URL(response.url, state.document.location.href);
    if (!response.ok || !response.redirected || location.pathname !== '/settings/defaults'
      || location.searchParams.get('notice') !== 'generated_images_rebuild_queued') {
      throw new Error('Rebuild request was not acknowledged.');
    }
    if (generation === state.generation) showStatus(state, { phase: 'queued', runId: '', total: 0 });
    refreshStatus(state);
  } catch {
    // The error answers the user's explicit action, so it is shown on the current card even when
    // another Settings update advanced the generation; only polling stays generation-guarded.
    setActionError(state, 'Could not queue the rebuild. Please try again.');
    if (generation === state.generation) schedulePoll(state);
  } finally {
    state.manualPending = false;
    const currentButton = cardFor(state)?.querySelector('[data-generated-images-rebuild-button]');
    if (currentButton) currentButton.disabled = false;
  }
}

export function enhanceGeneratedImageRebuildStatus(scope = globalThis.document) {
  const document = scope?.ownerDocument || scope;
  if (!document?.querySelector?.(CARD_SELECTOR)) return null;
  let state = controllers.get(document);
  const newController = !state;
  if (!state) {
    const window = document.defaultView || globalThis;
    state = { document, window, timer: null, generation: 0, latestRequest: 0,
      manualPending: false, stopped: false };
    controllers.set(document, state);
    document.addEventListener('submit', (event) => {
      if (event.target?.id !== 'generated-images-rebuild-form') return;
      event.preventDefault();
      submitManualRebuild(state, event.target);
    });
    window.addEventListener?.('pagehide', () => {
      state.stopped = true;
      invalidate(state);
    });
    window.addEventListener?.('pageshow', () => {
      state.stopped = false;
      invalidate(state);
      schedulePoll(state);
    });
  }
  if (newController || scope !== document) {
    invalidate(state);
    schedulePoll(state);
  }
  const button = cardFor(state)?.querySelector('[data-generated-images-rebuild-button]');
  if (button && state.manualPending) button.disabled = true;
  return {
    imageSaveStarted() { invalidate(state); },
    imageSaveSucceeded() { invalidate(state); refreshStatus(state); },
    resume() { schedulePoll(state); },
  };
}
