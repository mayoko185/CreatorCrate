// ─── Unified viewer: fullscreen and fullscreen-only idle chrome ──────────────
//
// The fullscreen participant of the unified viewer (unified-viewer.js). The
// viewer is a native modal dialog, and a <dialog> itself cannot be made
// fullscreen (Chromium rejects dialog.requestFullscreen() with a TypeError),
// so the target is the dialog's card: the inner container that holds the
// header with Close, the context bar with the view tools, the media stage
// and the Previous / playback / Next controls. The same controller, content
// and playback participants keep running; nothing is re-created or reloaded.
//
// - Enter/Exit through the viewer's fullscreen button; the UI state is
//   always re-derived from `document.fullscreenElement` on fullscreenchange.
// - Escape while the card is fullscreen exits fullscreen only. It runs in the
//   capture phase on the dialog, so an open dropdown (closed by the shared
//   dropdown handler, which runs earlier on the document) keeps precedence and
//   the shared dialog binder's Escape-to-close sees a handled event.
// - Closing the viewer, or a request that settles after the viewer closed,
//   moved to another session or was destroyed, exits fullscreen. Fullscreen
//   held by any other element (a video, say) is never touched.
// - In fullscreen only, the chrome (header, context bar, controls) hides
//   after VIEWER_CHROME_IDLE_DELAY without pointer or keyboard activity. It
//   stays while a dropdown is open, while the pointer is over it, and while
//   keyboard focus is inside it. Hidden chrome is transparent, not removed:
//   it stays in the focus order and the first key or focus reveals it.
// - Geometry is re-measured through the content participant's
//   refreshGeometry() after each change (B3's ResizeObserver also follows).

export const VIEWER_CHROME_IDLE_DELAY = 4000;

const CHROME_HIDDEN_ATTRIBUTE = 'data-viewer-chrome-hidden';
const FULLSCREEN_ATTRIBUTE = 'data-viewer-fullscreen';
const DROPDOWN_OPEN_SELECTOR = '[data-cc-dropdown][open]';
const OPEN_DIALOG_SELECTOR = 'dialog[open]';

// Fullscreen ownership of a target element. A participant can be destroyed
// and a replacement bound to the same card (enhanceUnifiedViewer rebinds a
// dialog whose controller was destroyed) while the old one's request is still
// outstanding, so `document.fullscreenElement === target` alone cannot tell
// whose fullscreen the card holds. The claim is the request that most
// recently asked for the target's fullscreen: { instance, session, cancelled }.
// A destroyed participant releases fullscreen, and completes a focus return,
// only while the claim is still its own; a replacement's enter() replaces it.
// The claim is removed by its own participant once the target has left
// fullscreen, its request was refused, or the participant ended without one.
// It lives on the target under a realm-wide symbol, so participants from two
// copies of this module (a re-run bundle, say) still see each other's claim.
const CLAIM = Symbol.for('creatorcrate.viewerFullscreenClaim');

function claimOf(target) {
  return target && typeof target === 'object' ? target[CLAIM] || null : null;
}

function setClaim(target, request) {
  if (target && typeof target === 'object') target[CLAIM] = request;
}

function clearClaim(target) {
  if (target && typeof target === 'object') delete target[CLAIM];
}

/** Whether a participant's fullscreen request still claims `target` (tests, diagnostics). */
export function viewerFullscreenClaimed(target) {
  return claimOf(target) !== null;
}

// An exit already issued to the browser for a target. Unlike the claim, it
// cannot be cancelled by replacing it: once document.exitFullscreen() has
// been called for the card, a new requestFullscreen() on the same card that
// the browser grants before that exit completes is undone by it. So no
// participant (this one, a replacement bound to the same card, or one from
// another copy of this module) requests the card's fullscreen while the
// record exists, and none issues a second exit; they join this one.
//
// The record is { waiters } under a realm-wide symbol. It
// outlives the participant that issued the exit and ends exactly once: when
// the exit's promise settles ('exited' or 'failed'), when the call throws
// ('failed'), or, only for a promise-less exit, when the card leaves fullscreen.
// Another element can take fullscreen before a native exit promise settles;
// that observation cannot release its protection. Each waiter is called with
// the outcome and the record is removed.
const EXIT = Symbol.for('creatorcrate.viewerFullscreenExit');

function exitOf(target) {
  return target && typeof target === 'object' ? target[EXIT] || null : null;
}

/** Whether an exit issued for `target` is still in flight (tests, diagnostics). */
export function viewerFullscreenExiting(target) {
  return exitOf(target) !== null;
}

// Join the target's exit in flight, or issue one. `waiter(outcome)` is
// called once when it ends (possibly synchronously, if the call throws).
function joinExit(document, target, waiter) {
  const existing = exitOf(target);
  if (existing) {
    existing.waiters.add(waiter);
    return;
  }
  const waiters = new Set([waiter]);
  let settled = false;
  let onChange = null;
  const settle = (outcome) => {
    if (settled) return;
    settled = true;
    if (target[EXIT] === record) delete target[EXIT];
    if (onChange) document?.removeEventListener?.('fullscreenchange', onChange);
    const pendingWaiters = Array.from(waiters);
    waiters.clear();
    for (const notify of pendingWaiters) {
      try {
        notify(outcome);
      } catch {
        // One waiter never blocks the others.
      }
    }
  };
  const record = Object.freeze({ waiters });
  target[EXIT] = record;
  let result;
  try {
    result = document.exitFullscreen();
  } catch {
    settle('failed');
    return;
  }
  if (typeof result?.then === 'function') {
    result.then(() => settle('exited'), () => settle('failed'));
  } else if (!settled) {
    // No promise to report completion: the card leaving fullscreen does.
    onChange = () => {
      if (document.fullscreenElement !== target) settle('exited');
    };
    document?.addEventListener?.('fullscreenchange', onChange);
    onChange();
  }
}

function setHiddenFlag(element, hidden) {
  if (!element) return;
  element.hidden = hidden;
  if (hidden) element.setAttribute?.('hidden', '');
  else element.removeAttribute?.('hidden');
}

/**
 * Whether a document and element support the Fullscreen API.
 *
 * @param {Document} document
 * @param {Element} target
 */
export function viewerFullscreenSupported(document, target) {
  return Boolean(target && typeof target.requestFullscreen === 'function'
    && document && typeof document.exitFullscreen === 'function'
    && 'fullscreenElement' in document
    && document.fullscreenEnabled !== false);
}

/**
 * Create the fullscreen participant.
 *
 * @param {object} options
 * @param {Document} options.document
 * @param {HTMLDialogElement} options.dialog
 * @param {HTMLElement} options.target   the fullscreen container (the dialog card)
 * @param {HTMLElement} [options.root]   receives data-viewer-fullscreen
 * @param {HTMLButtonElement} [options.button]
 * @param {Array<HTMLElement>} [options.chrome]  surfaces that idle-hide in fullscreen
 * @param {(listener: Function) => Function} options.observe  controller observe()
 * @param {{ refreshGeometry: Function }} [options.media]
 * @param {Window|null} [options.view]
 */
export function createViewerFullscreen(options = {}) {
  const { document, dialog, target, observe, media } = options;
  const view = options.view !== undefined ? options.view : (document?.defaultView || null);
  const root = options.root || null;
  const button = options.button || null;
  const chrome = (options.chrome || []).filter(Boolean);
  const timers = {
    set: typeof view?.setTimeout === 'function' ? view.setTimeout.bind(view) : globalThis.setTimeout.bind(globalThis),
    clear: typeof view?.clearTimeout === 'function' ? view.clearTimeout.bind(view) : globalThis.clearTimeout.bind(globalThis),
  };
  const frames = typeof view?.requestAnimationFrame === 'function'
    ? { request: view.requestAnimationFrame.bind(view), cancel: view.cancelAnimationFrame?.bind(view) || (() => {}) }
    : null;
  const supported = viewerFullscreenSupported(document, target);

  let session = null;
  // The session a request or the current fullscreen belongs to.
  let owner = null;
  // This participant's identity in the target's fullscreen claim.
  const instance = Object.freeze({});
  // An outstanding requestFullscreen(): { instance, session, cancelled }.
  let pending = null;
  let active = false;
  let exiting = false;
  // Entry is refused while an exit for the card is still in flight (EXIT).
  let blocked = false;
  // This participant's subscription to that exit: { record, waiter }.
  let watched = null;
  let syncing = false;
  let chromeHidden = false;
  let idleTimer = null;
  let frame = null;
  let modality = 'pointer';
  let pointerInChrome = false;
  // A focus return owed by a closed viewer (deferFocus):
  // { target, fallback, latest, superseded, track }.
  let deferredFocus = null;
  // After destroy(): a temporary fullscreenchange listener that lasts only
  // while an owed focus return waits for this participant's exit to land.
  let lateChange = null;
  let destroyed = false;
  const listeners = new Set();

  // The target holds fullscreen (which may be another participant's).
  const isMine = () => supported && document.fullscreenElement === target;
  const ownClaim = () => claimOf(target)?.instance === instance;
  const claimedElsewhere = () => {
    const claim = claimOf(target);
    return claim !== null && claim.instance !== instance;
  };
  function releaseClaim() {
    if (ownClaim()) clearClaim(target);
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * A frozen snapshot: { supported, active, pending, entryBlocked, chromeHidden }.
   * `entryBlocked`: an earlier fullscreen exit for the card is still in
   * flight, so enter() is refused until it completes.
   */
  function getState() {
    return Object.freeze({
      supported,
      active,
      pending: Boolean(pending),
      entryBlocked: blocked,
      chromeHidden,
    });
  }

  function emit(reason) {
    if (destroyed || listeners.size === 0) return;
    const state = getState();
    for (const listener of Array.from(listeners)) {
      try {
        listener(state, reason);
      } catch {
        // One listener never blocks the others.
      }
    }
  }

  // ── Idle chrome ───────────────────────────────────────────────────────────

  function clearIdle() {
    if (idleTimer === null) return;
    timers.clear(idleTimer);
    idleTimer = null;
  }

  function setChromeHidden(hidden) {
    if (chromeHidden === hidden) return;
    chromeHidden = hidden;
    if (hidden) target?.setAttribute?.(CHROME_HIDDEN_ATTRIBUTE, '');
    else target?.removeAttribute?.(CHROME_HIDDEN_ATTRIBUTE);
    emit(hidden ? 'chrome-hidden' : 'chrome-shown');
  }

  function inChrome(element) {
    return Boolean(element) && chrome.some((surface) => surface === element || surface.contains?.(element));
  }

  function chromeHeld() {
    if (dialog?.querySelector?.(DROPDOWN_OPEN_SELECTOR)) return true;
    if (pointerInChrome) return true;
    return modality === 'keyboard' && inChrome(document?.activeElement);
  }

  function onIdle() {
    idleTimer = null;
    if (destroyed || !active || session === null) return;
    if (chromeHeld()) {
      scheduleIdle();
      return;
    }
    setChromeHidden(true);
  }

  function scheduleIdle() {
    clearIdle();
    if (!active || session === null) return;
    idleTimer = timers.set(onIdle, VIEWER_CHROME_IDLE_DELAY);
  }

  function revealChrome() {
    if (!active) return;
    setChromeHidden(false);
    scheduleIdle();
  }

  // ── Fullscreen state ──────────────────────────────────────────────────────

  function refreshGeometry() {
    try {
      media?.refreshGeometry?.();
    } catch {
      // Geometry is refreshed again by the viewport's own resize observer.
    }
    if (!frames) return;
    if (frame !== null) frames.cancel(frame);
    const expected = session;
    frame = frames.request(() => {
      frame = null;
      if (destroyed || session !== expected) return;
      try {
        media?.refreshGeometry?.();
      } catch {
        // As above.
      }
    });
  }

  function render() {
    setHiddenFlag(button, !supported || session === null);
    if (button) {
      // Temporarily unavailable entry stays focusable (aria-disabled, not
      // disabled, which would drop focus to <body>); enter() refuses it.
      const unavailable = !active && blocked;
      const label = active
        ? 'Exit fullscreen'
        : (unavailable ? 'Enter fullscreen (unavailable while fullscreen closes)' : 'Enter fullscreen');
      button.setAttribute?.('aria-label', label);
      button.setAttribute?.('data-tooltip', label);
      if (unavailable) button.setAttribute?.('aria-disabled', 'true');
      else button.removeAttribute?.('aria-disabled');
      if (active) button.setAttribute?.('data-viewer-fullscreen-active', '');
      else button.removeAttribute?.('data-viewer-fullscreen-active');
    }
    if (active) root?.setAttribute?.(FULLSCREEN_ATTRIBUTE, '');
    else root?.removeAttribute?.(FULLSCREEN_ATTRIBUTE);
  }

  // One exit request at a time for the card: this participant joins an exit
  // already in flight for it (its own, a destroyed predecessor's, another
  // bundle's) instead of issuing a second one. `exiting` lasts until the
  // native operation settles (or the promise-less exit is observed). An
  // exit still in flight when the participant is destroyed reports its
  // outcome to settleAfterDestroy, the only work left after destroy().
  function exitDocumentFullscreen() {
    if (!isMine() || exiting) return;
    exiting = true;
    joinExit(document, target, (outcome) => {
      if (outcome === 'failed') exiting = false;
      if (destroyed) settleAfterDestroy(outcome);
      else if (!isMine()) restoreDeferredFocus();
    });
    watchExit();
  }

  // ── Entry availability ────────────────────────────────────────────────────

  function stopWatching() {
    if (watched === null) return;
    watched.record.waiters.delete(watched.waiter);
    watched = null;
  }

  // Follow the card's exit in flight, so the control becomes available again
  // as soon as it ends, whoever issued it.
  function watchExit() {
    if (destroyed) return;
    const record = exitOf(target);
    if (watched?.record === record) return;
    stopWatching();
    if (record === null) return;
    const entry = {
      record,
      waiter: () => {
        if (watched === entry) watched = null;
        if (!destroyed && !syncing) refreshAvailability();
      },
    };
    watched = entry;
    record.waiters.add(entry.waiter);
  }

  function computeBlocked() {
    return supported && !active && exitOf(target) !== null;
  }

  function refreshAvailability() {
    const wasBlocked = blocked;
    blocked = computeBlocked();
    watchExit();
    render();
    if (blocked !== wasBlocked) emit(blocked ? 'unavailable' : 'available');
  }

  function sync(reason) {
    syncing = true;
    try {
      syncState(reason);
    } finally {
      syncing = false;
    }
  }

  function syncState(reason) {
    const wasActive = active;
    const wasBlocked = blocked;
    const mine = isMine();
    if (!mine) {
      exiting = false;
      if (!pending) releaseClaim();
      restoreDeferredFocus();
    }
    // Fullscreen that is being left, or no longer belongs to the open
    // session, is never adopted; it is released instead.
    if (mine && (exiting || session === null || owner !== session || pending?.cancelled)) {
      if (pending?.cancelled) pending = null;
      active = false;
      exitDocumentFullscreen();
    } else {
      active = mine;
    }
    if (!active) {
      clearIdle();
      setChromeHidden(false);
      pointerInChrome = false;
    } else if (!wasActive) {
      revealChrome();
    }
    blocked = computeBlocked();
    watchExit();
    render();
    if (active !== wasActive) {
      refreshGeometry();
      emit(reason || (active ? 'enter' : 'exit'));
    } else if (blocked !== wasBlocked) {
      emit(blocked ? 'unavailable' : 'available');
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  /**
   * Request fullscreen for the open viewer. Returns whether a request was made.
   * Refused (no native request, no claim taken, nothing queued) while an
   * earlier exit for the card is still in flight; the control shows it as
   * unavailable until then, and a fresh request is needed afterwards.
   */
  function enter() {
    if (destroyed || !supported || session === null || active || pending) return false;
    if (exitOf(target) !== null) {
      refreshAvailability();
      return false;
    }
    const request = { instance, session, cancelled: false };
    pending = request;
    owner = session;
    // This request now owns the card's fullscreen, replacing any claim left
    // by a destroyed participant whose request is still outstanding.
    setClaim(target, request);
    emit('request');
    let result;
    try {
      result = target.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      if (pending === request) pending = null;
      sync('rejected');
      emit('rejected');
      return false;
    }
    const settle = (ok) => {
      if (pending === request) pending = null;
      if (destroyed) {
        settleAfterDestroy();
        return;
      }
      sync(ok ? undefined : 'rejected');
      if (!ok) emit('rejected');
    };
    if (typeof result?.then === 'function') result.then(() => settle(true), () => settle(false));
    else settle(isMine());
    return true;
  }

  /** Leave fullscreen if the viewer holds it. Returns whether it did. */
  function exit() {
    // After destroy, only settleAfterDestroy may release this participant's
    // own fullscreen; a stale reference never exits a replacement's.
    if (destroyed) return false;
    if (pending) pending.cancelled = true;
    if (!isMine()) return false;
    exitDocumentFullscreen();
    return true;
  }

  function toggle() {
    return active ? exit() : enter();
  }

  // While the card is fullscreen Chromium treats everything outside it as
  // inert, even after the dialog has closed, so the shared binder's focus
  // restoration silently fails when the viewer closes from fullscreen. The
  // controller hands the intended target over here, and it is focused once
  // the card has actually left fullscreen — unless the viewer reopened or
  // focus has meanwhile gone somewhere real.
  //
  // The same applies while an entry request is still pending at close: the
  // binder's focus return succeeds at first, but a late grant takes focus
  // with it (Chromium leaves it on <body>) before the release lands. The plan
  // is kept until that request has settled and any fullscreen it took is
  // gone. Meanwhile a capture focusin listener remembers the last real focus
  // outside the dialog (the binder's own return, or wherever the user went),
  // so a grant's automatic blur is never mistaken for deliberate movement.
  function dropDeferredFocus() {
    const plan = deferredFocus;
    deferredFocus = null;
    if (plan) document?.removeEventListener?.('focusin', plan.track, true);
    return plan;
  }

  function focusTarget(plan) {
    const connected = (element) => Boolean(element)
      && (typeof document?.contains !== 'function' || document.contains(element))
      && !dialog?.contains?.(element);
    if (connected(plan.latest)) return plan.latest;
    if (connected(plan.target)) return plan.target;
    let fallback = null;
    try {
      fallback = plan.fallback?.() || null;
    } catch {
      fallback = null;
    }
    return connected(fallback) ? fallback : null;
  }

  // Another open modal dialog that `element` is not part of owns focus now.
  function blockedByModal(element) {
    let open = [];
    try {
      open = Array.from(document?.querySelectorAll?.(OPEN_DIALOG_SELECTOR) || []);
    } catch {
      open = [];
    }
    return open.some((other) => other !== dialog && !other.contains?.(element));
  }

  function restoreDeferredFocus() {
    if (!deferredFocus) return;
    // An exit still in flight may take focus again before it settles.
    if (exitOf(target) !== null) return;
    // A reopened viewer owns focus now; an outstanding request may still take
    // fullscreen (and focus) from the closed one, so its plan waits for it.
    if (session === null && pending) return;
    const plan = dropDeferredFocus();
    // A newer session (this participant's, or a replacement's on the same
    // dialog after destroy) is never handed the obsolete opener.
    if (session !== null || plan.superseded || dialog?.open === true || claimedElsewhere()) return;
    const focused = document?.activeElement;
    if (focused && focused !== document.body && !dialog?.contains?.(focused)) return;
    const element = focusTarget(plan);
    if (!element || blockedByModal(element)) return;
    element.focus?.({ preventScroll: true });
  }

  /**
   * Focus `element` after the viewer's fullscreen ends, when it is still held
   * now (the viewer has just closed from fullscreen) or an entry request is
   * still pending. `fallback()` supplies a connected target if `element` and
   * any later focus are gone by then. Returns whether it was deferred;
   * otherwise the caller's own focus restoration already works.
   */
  function deferFocus(element, fallback) {
    if (destroyed || (!element && typeof fallback !== 'function')) return false;
    if (!(isMine() && ownClaim()) && !pending) return false;
    dropDeferredFocus();
    const plan = {
      target: element || null,
      fallback: typeof fallback === 'function' ? fallback : null,
      latest: null,
      superseded: false,
      track: (event) => {
        const focused = event?.target;
        if (!focused || focused === document.body) return;
        // Focus entering the reopened dialog: a newer session owns it.
        if (dialog?.contains?.(focused)) {
          if (dialog.open === true) plan.superseded = true;
          return;
        }
        plan.latest = focused;
      },
    };
    document?.addEventListener?.('focusin', plan.track, true);
    deferredFocus = plan;
    return true;
  }

  function stopLateChange() {
    if (lateChange === null) return;
    document?.removeEventListener?.('fullscreenchange', lateChange);
    lateChange = null;
  }

  // The only work left after destroy(): this participant's own outstanding
  // fullscreen (a late-granted entry request, or an exit already underway)
  // and the focus return owed from a close before the destroy. Nothing is
  // rendered, emitted or re-listened beyond a temporary fullscreenchange
  // listener that waits for an owed focus return's exit to land.
  //
  // `outcome` is 'exited' when this participant's exit request resolved (the
  // card has left fullscreen), 'failed' when it was refused.
  function settleAfterDestroy(outcome) {
    if (!destroyed) return;
    // The request's own settlement comes back here.
    if (pending) return;
    // A replacement participant claimed the card: its fullscreen and its
    // session are never touched, and the obsolete focus return is dropped.
    if (claimedElsewhere()) {
      finishAfterDestroy(false);
      return;
    }
    if (outcome !== 'exited' && isMine()) {
      // Fullscreen this participant no longer claims is never exited by it.
      if (outcome === 'failed' || !ownClaim()) {
        finishAfterDestroy(false);
        return;
      }
      if (deferredFocus && lateChange === null) {
        lateChange = () => {
          if (!isMine() || claimedElsewhere()) settleAfterDestroy('exited');
        };
        document?.addEventListener?.('fullscreenchange', lateChange);
      }
      // Releases a late grant; an exit already underway is awaited. Either
      // reports back through its own settlement.
      exitDocumentFullscreen();
      return;
    }
    if (exitOf(target) !== null) return;
    finishAfterDestroy(true);
  }

  function finishAfterDestroy(restore) {
    stopLateChange();
    exiting = false;
    if (restore) restoreDeferredFocus();
    else dropDeferredFocus();
    releaseClaim();
  }

  // ── Session changes ───────────────────────────────────────────────────────

  function onSessionChange(change) {
    if (destroyed || !change) return;
    if (change.type === 'open') {
      session = change.session;
      sync();
    } else if (change.type === 'close' && change.session === session) {
      session = null;
      owner = null;
      if (pending) pending.cancelled = true;
      if (frame !== null) frames?.cancel(frame);
      frame = null;
      // Releases fullscreen this viewer holds (sync exits it for no session).
      sync();
    }
  }

  // ── Listeners ─────────────────────────────────────────────────────────────

  const onFullscreenChange = () => sync();
  const onFullscreenError = () => sync('rejected');

  const onKeydown = (event) => {
    modality = 'keyboard';
    if (active) revealChrome();
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    if (!active && !pending) return;
    // An open dropdown closes first (normally already handled on the document).
    if (dialog?.querySelector?.(DROPDOWN_OPEN_SELECTOR)) return;
    event.preventDefault?.();
    exit();
  };
  const onPointerMove = (event) => {
    if (event?.pointerType && event.pointerType !== 'touch') modality = 'pointer';
    pointerInChrome = inChrome(event?.target);
    if (active) revealChrome();
  };
  const onPointerDown = (event) => {
    modality = 'pointer';
    pointerInChrome = inChrome(event?.target);
    if (active) revealChrome();
  };
  const onPointerLeave = () => { pointerInChrome = false; };
  const onFocusIn = () => {
    if (active) revealChrome();
  };
  const onButton = (event) => {
    event?.preventDefault?.();
    toggle();
  };

  if (supported) {
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('fullscreenerror', onFullscreenError);
  }
  dialog?.addEventListener?.('keydown', onKeydown, true);
  target?.addEventListener?.('pointermove', onPointerMove);
  target?.addEventListener?.('pointerdown', onPointerDown);
  target?.addEventListener?.('pointerleave', onPointerLeave);
  target?.addEventListener?.('focusin', onFocusIn);
  button?.addEventListener?.('click', onButton);
  const unobserve = typeof observe === 'function' ? observe(onSessionChange) : () => {};
  render();

  /** Register a fullscreen-state listener `(state, reason)`; returns an unsubscribe. */
  function observeFullscreen(listener) {
    if (destroyed || typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function destroy() {
    if (destroyed) return;
    session = null;
    owner = null;
    if (pending) pending.cancelled = true;
    sync();
    clearIdle();
    if (frame !== null) frames?.cancel(frame);
    frame = null;
    destroyed = true;
    // Only the subscription that refreshed this control ends here; an exit
    // this participant issued or joined keeps running and stays recorded on
    // the card until the browser completes it.
    stopWatching();
    // An outstanding request, or an exit already underway, keeps only its own
    // release and any focus return owed from an earlier close until it has
    // settled (settleAfterDestroy); otherwise both end here.
    settleAfterDestroy();
    listeners.clear();
    unobserve();
    if (supported) {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('fullscreenerror', onFullscreenError);
    }
    dialog?.removeEventListener?.('keydown', onKeydown, true);
    target?.removeEventListener?.('pointermove', onPointerMove);
    target?.removeEventListener?.('pointerdown', onPointerDown);
    target?.removeEventListener?.('pointerleave', onPointerLeave);
    target?.removeEventListener?.('focusin', onFocusIn);
    button?.removeEventListener?.('click', onButton);
  }

  return Object.freeze({
    getState,
    observe: observeFullscreen,
    enter,
    exit,
    toggle,
    deferFocus,
    destroy,
  });
}
