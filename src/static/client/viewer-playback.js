// ─── Unified viewer: slideshow playback ──────────────────────────────────────
//
// The playback participant of the unified viewer (unified-viewer.js). It
// observes the controller's session changes and the content participant's
// media state, and owns, for the open session only:
//
// - whether playback is available (B1's canPlayViewerSlideshow: an explicit
//   slideshow source with at least two available items) and whether it is
//   playing;
// - the speed (2, 4 or 6 seconds; 4 by default) chosen in the viewer's
//   speed dropdown;
// - at most one advancement timer.
//
// Load-aware advancement: the display interval of a slide starts only once
// its media is loaded and shown in Fit. While the media is loading no timer
// runs, so a slow image keeps its full interval. A failed or unavailable item
// pauses playback, and so do manual navigation, Actual Size inspection,
// zooming, a hidden tab and the end of a non-wrapping sequence. Playback
// never resumes after these pauses on its own: only Play does. A pending
// source-quality replacement suspends its countdown without pausing playback;
// settlement starts a fresh interval at the selected speed.
//
// Every timer is bound to the session, the selected item and a generation
// bumped on every change that touches the current item, and re-checks all of
// them when it fires, so a stale media result, a late timer or a source
// update can never advance or reactivate an obsolete session.
//
// It never loads media (B3 does), never keeps its own index (advancing uses
// the controller's own `next` step, marked as playback so it is not taken
// for manual navigation) and never touches fullscreen.

import { canPlayViewerSlideshow } from './viewer-sequence.js';
import {
  VIEWER_MEDIA_FAILED,
  VIEWER_MEDIA_LOADED,
  VIEWER_MEDIA_UNAVAILABLE,
  VIEWER_ORIGINAL_LOADING,
} from './viewer-content.js';
import { VIEWER_VIEW_MODE_FIT } from './viewer-viewport.js';

export const VIEWER_PLAYBACK_SPEEDS = Object.freeze([2000, 4000, 6000]);
export const VIEWER_PLAYBACK_DEFAULT_SPEED = 4000;

// Navigation causes carried on controller changes.
export const VIEWER_CAUSE_USER = 'user';
export const VIEWER_CAUSE_PLAYBACK = 'playback';

// Why playback last stopped (null while playing or before any playback).
export const VIEWER_PAUSE_USER = 'user';
export const VIEWER_PAUSE_NAVIGATION = 'navigation';
export const VIEWER_PAUSE_INSPECTION = 'inspection';
export const VIEWER_PAUSE_MEDIA = 'media';
export const VIEWER_PAUSE_HIDDEN = 'hidden';
export const VIEWER_PAUSE_END = 'end';
export const VIEWER_PAUSE_REDUCED_MOTION = 'reduced-motion';
export const VIEWER_PAUSE_CLOSED = 'closed';

const PLAY_SELECTOR = '[data-unified-viewer-play]';
const SPEED_SELECTOR = '[data-unified-viewer-speed]';
const POSITION_SELECTOR = '[data-unified-viewer-position]';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * A supported speed in milliseconds, or null.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function normalizeViewerPlaybackSpeed(value) {
  const number = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  return VIEWER_PLAYBACK_SPEEDS.includes(number) ? number : null;
}

function setHiddenFlag(element, hidden) {
  if (!element) return;
  element.hidden = hidden;
  if (hidden) element.setAttribute?.('hidden', '');
  else element.removeAttribute?.('hidden');
}

function setDisabledFlag(control, disabled) {
  if (!control) return;
  control.disabled = disabled;
  if (disabled) control.setAttribute?.('disabled', '');
  else control.removeAttribute?.('disabled');
}

/**
 * Create the playback participant.
 *
 * @param {object} options
 * @param {Document} options.document
 * @param {{ root: Element, playback: Element }} options.regions
 * @param {(listener: Function) => Function} options.observe       controller observe()
 * @param {{ getState: Function, observe: Function, fit: Function }} options.media  content participant
 * @param {() => object|null} options.advance  steps to the next item as playback (not user) navigation
 * @param {() => Element|null} [options.focusFallback]
 * @param {Window|null} [options.view]  for timers and matchMedia
 */
export function createViewerPlayback(options = {}) {
  const { document, regions, observe, media, advance } = options;
  const view = options.view !== undefined ? options.view : (document?.defaultView || null);
  const focusFallback = typeof options.focusFallback === 'function' ? options.focusFallback : () => null;
  const timers = {
    set: typeof view?.setTimeout === 'function' ? view.setTimeout.bind(view) : globalThis.setTimeout.bind(globalThis),
    clear: typeof view?.clearTimeout === 'function' ? view.clearTimeout.bind(view) : globalThis.clearTimeout.bind(globalThis),
  };
  const root = regions?.root || null;
  const group = regions?.playback || null;
  const playButton = group?.querySelector?.(PLAY_SELECTOR) || null;
  const speedSelect = group?.querySelector?.(SPEED_SELECTOR) || null;
  const position = root?.querySelector?.(POSITION_SELECTOR) || null;

  let speed = normalizeViewerPlaybackSpeed(speedSelect?.value) || VIEWER_PLAYBACK_DEFAULT_SPEED;
  // The open session: { session, source, key, generation }.
  let current = null;
  let available = false;
  let playing = false;
  let pauseReason = null;
  // At most one timer: { handle, session, key, generation }.
  let timer = null;
  let generation = 0;
  let destroyed = false;
  const listeners = new Set();

  let reducedMotionQuery = null;
  try {
    reducedMotionQuery = typeof view?.matchMedia === 'function' ? view.matchMedia(REDUCED_MOTION_QUERY) : null;
  } catch {
    reducedMotionQuery = null;
  }
  const prefersReducedMotion = () => reducedMotionQuery?.matches === true;

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * A frozen snapshot: { session, key, available, playing, speed, waiting,
   * scheduled, pauseReason }. `waiting` is true while playing and the current
   * slide is not ready yet; `scheduled` while its display interval runs.
   */
  function getState() {
    return Object.freeze({
      session: current ? current.session : null,
      key: current ? current.key : null,
      available,
      playing,
      speed,
      waiting: playing && !timer,
      scheduled: Boolean(timer),
      pauseReason,
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

  // ── Rendering ─────────────────────────────────────────────────────────────

  function inspecting(state = media?.getState?.()) {
    return Boolean(state?.quality?.loading) || state?.original?.status === VIEWER_ORIGINAL_LOADING;
  }

  function render() {
    const focused = document?.activeElement;
    setHiddenFlag(group, !available);
    root?.setAttribute?.('data-viewer-playback', available ? (playing ? 'playing' : 'paused') : 'none');
    if (playButton) {
      const label = playing ? 'Pause slideshow' : 'Play slideshow';
      playButton.setAttribute?.('aria-label', label);
      playButton.setAttribute?.('data-tooltip', label);
      if (playing) playButton.setAttribute?.('data-viewer-playing', '');
      else playButton.removeAttribute?.('data-viewer-playing');
      // Play waits while an original is loading; Pause is always usable.
      setDisabledFlag(playButton, !available || (!playing && inspecting()));
    }
    // An auto-advancing slideshow must not announce every slide; the
    // position is announced again once playback stops.
    position?.setAttribute?.('aria-live', playing ? 'off' : 'polite');
    if (focused && (focused === playButton || group?.contains?.(focused))
      && (!available || playButton?.disabled)) {
      focusFallback()?.focus?.({ preventScroll: true });
    }
  }

  // ── Timer ─────────────────────────────────────────────────────────────────

  function clearTimer() {
    if (!timer) return;
    timers.clear(timer.handle);
    timer = null;
  }

  // Whether the current slide is shown and ready for its display interval.
  function slideReady(state) {
    return Boolean(current) && state?.session === current.session && state.key === current.key
      && state.status === VIEWER_MEDIA_LOADED
      && !state.quality?.loading
      && state.original?.status !== VIEWER_ORIGINAL_LOADING
      && state.view?.mode === VIEWER_VIEW_MODE_FIT;
  }

  function onTimer(owner) {
    if (timer !== owner) return;
    timer = null;
    if (destroyed || !playing || !current || current.session !== owner.session
      || current.key !== owner.key || current.generation !== owner.generation) return;
    if (!slideReady(media?.getState?.())) return;
    let step = null;
    try {
      step = advance?.() || null;
    } catch {
      step = null;
    }
    // The controller's change (observed below) restarts the wait for the
    // next slide; a step that could not move ends playback.
    if (!step || !step.moved) stop(VIEWER_PAUSE_END);
  }

  // Arm the interval for a ready slide, unless one already runs for it.
  function schedule() {
    if (!playing || !current) return;
    if (timer && timer.session === current.session && timer.key === current.key
      && timer.generation === current.generation) return;
    clearTimer();
    const owner = { handle: null, session: current.session, key: current.key, generation: current.generation };
    owner.handle = timers.set(() => onTimer(owner), speed);
    timer = owner;
  }

  // React to the current media state: start the interval once the slide is
  // ready, stop on failure, unavailability or inspection.
  function reconcileMedia(state = media?.getState?.(), { allowSchedule = true } = {}) {
    if (!current || !state || state.session !== current.session || state.key !== current.key) return;
    if (state.quality?.loading) {
      clearTimer();
      render();
      emit('waiting');
      return;
    }
    if ((!state.quality && state.original?.status === VIEWER_ORIGINAL_LOADING) || (state.view?.hasContent && state.view.mode !== VIEWER_VIEW_MODE_FIT)) {
      if (playing) stop(VIEWER_PAUSE_INSPECTION);
      else render();
      return;
    }
    if (state.status === VIEWER_MEDIA_FAILED || state.status === VIEWER_MEDIA_UNAVAILABLE) {
      if (playing) stop(VIEWER_PAUSE_MEDIA);
      return;
    }
    if (!playing) {
      render();
      return;
    }
    if (allowSchedule && slideReady(state)) {
      const wasScheduled = Boolean(timer);
      schedule();
      if (!wasScheduled) emit('scheduled');
    } else if (!slideReady(state)) {
      clearTimer();
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  function stop(reason) {
    const wasPlaying = playing;
    clearTimer();
    playing = false;
    if (wasPlaying || reason === VIEWER_PAUSE_CLOSED) pauseReason = reason;
    render();
    if (wasPlaying) emit('pause');
  }

  /**
   * Start playback (explicit user action). On a failed or unavailable slide
   * it moves on at once; on a magnified slide it returns to Fit first.
   * Returns whether playback is now running.
   */
  function play() {
    if (destroyed || !current || !available) return false;
    if (playing) return true;
    const state = media?.getState?.();
    if (inspecting(state)) return false;
    if (state?.session === current.session && state.key === current.key
      && state.view?.hasContent && state.view.mode !== VIEWER_VIEW_MODE_FIT) {
      media?.fit?.();
    }
    playing = true;
    pauseReason = null;
    render();
    emit('play');
    const latest = media?.getState?.();
    if (latest?.session === current.session && latest.key === current.key
      && (latest.status === VIEWER_MEDIA_FAILED || latest.status === VIEWER_MEDIA_UNAVAILABLE)) {
      let step = null;
      try {
        step = advance?.() || null;
      } catch {
        step = null;
      }
      if (!step || !step.moved) stop(VIEWER_PAUSE_END);
      return playing;
    }
    reconcileMedia(latest);
    return playing;
  }

  /** Pause playback (explicit user action). Returns whether it was playing. */
  function pause() {
    if (!playing) return false;
    stop(VIEWER_PAUSE_USER);
    return true;
  }

  function toggle() {
    return playing ? !pause() : play();
  }

  /**
   * Choose the speed (2000, 4000 or 6000 ms). While a slide's interval runs
   * it restarts at the new speed; paused playback stays paused.
   */
  function setSpeed(value) {
    const next = normalizeViewerPlaybackSpeed(value);
    if (!next) return false;
    if (speedSelect && String(speedSelect.value) !== String(next)) speedSelect.value = String(next);
    if (next === speed) return true;
    speed = next;
    if (timer) {
      clearTimer();
      schedule();
    }
    emit('speed');
    return true;
  }

  // ── Session changes ───────────────────────────────────────────────────────

  function beginItem(change) {
    current.key = change.key;
    current.source = change.source;
    generation += 1;
    current.generation = generation;
    clearTimer();
  }

  function onSessionChange(change) {
    if (destroyed || !change) return;
    switch (change.type) {
      case 'open': {
        clearTimer();
        generation += 1;
        current = { session: change.session, source: change.source, key: change.key, generation };
        available = canPlayViewerSlideshow(change.source);
        playing = false;
        pauseReason = null;
        const autoplay = available && change.autoplay !== false;
        if (autoplay && prefersReducedMotion()) pauseReason = VIEWER_PAUSE_REDUCED_MOTION;
        else if (autoplay) playing = true;
        render();
        emit('open');
        reconcileMedia();
        break;
      }
      case 'navigate': {
        if (!current || current.session !== change.session) break;
        beginItem(change);
        if (change.cause !== VIEWER_CAUSE_PLAYBACK && playing) stop(VIEWER_PAUSE_NAVIGATION);
        else render();
        reconcileMedia();
        break;
      }
      case 'update': {
        if (!current || current.session !== change.session) break;
        const stillAvailable = canPlayViewerSlideshow(change.source);
        const itemChanged = change.key !== current.key || change.reload === true;
        current.source = change.source;
        if (itemChanged) beginItem(change);
        available = stillAvailable;
        if (!available && playing) stop(VIEWER_PAUSE_END);
        else render();
        // An unchanged slide keeps its running interval.
        reconcileMedia();
        break;
      }
      case 'close': {
        if (!current || current.session !== change.session) break;
        stop(VIEWER_PAUSE_CLOSED);
        current = null;
        available = false;
        generation += 1;
        render();
        emit('close');
        break;
      }
      default:
        break;
    }
  }

  // ── Listeners ─────────────────────────────────────────────────────────────

  const onMedia = (state) => reconcileMedia(state);
  const onPlayClick = (event) => {
    event?.preventDefault?.();
    toggle();
  };
  const onSpeedChange = () => setSpeed(speedSelect?.value);
  const onVisibility = () => {
    if (document?.visibilityState === 'hidden' || document?.hidden === true) {
      if (playing) stop(VIEWER_PAUSE_HIDDEN);
    }
  };
  const onReducedMotion = () => {
    if (prefersReducedMotion() && playing) stop(VIEWER_PAUSE_REDUCED_MOTION);
  };

  playButton?.addEventListener?.('click', onPlayClick);
  speedSelect?.addEventListener?.('change', onSpeedChange);
  document?.addEventListener?.('visibilitychange', onVisibility);
  if (typeof reducedMotionQuery?.addEventListener === 'function') {
    reducedMotionQuery.addEventListener('change', onReducedMotion);
  } else {
    reducedMotionQuery?.addListener?.(onReducedMotion);
  }
  const unobserveMedia = typeof media?.observe === 'function' ? media.observe(onMedia) : () => {};
  const unobserve = typeof observe === 'function' ? observe(onSessionChange) : () => {};
  if (speedSelect && normalizeViewerPlaybackSpeed(speedSelect.value) === null) speedSelect.value = String(speed);
  render();

  /** Register a playback-state listener `(state, reason)`; returns an unsubscribe. */
  function observePlayback(listener) {
    if (destroyed || typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function destroy() {
    if (destroyed) return;
    clearTimer();
    playing = false;
    current = null;
    available = false;
    render();
    destroyed = true;
    listeners.clear();
    unobserve();
    unobserveMedia();
    playButton?.removeEventListener?.('click', onPlayClick);
    speedSelect?.removeEventListener?.('change', onSpeedChange);
    document?.removeEventListener?.('visibilitychange', onVisibility);
    if (typeof reducedMotionQuery?.removeEventListener === 'function') {
      reducedMotionQuery.removeEventListener('change', onReducedMotion);
    } else {
      reducedMotionQuery?.removeListener?.(onReducedMotion);
    }
  }

  return Object.freeze({
    getState,
    observe: observePlayback,
    play,
    pause,
    toggle,
    setSpeed,
    destroy,
  });
}
