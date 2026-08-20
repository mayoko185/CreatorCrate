import {
  isEnhancementBound,
  liveRegionDocument,
  markEnhancementBound,
} from './dom.js';
import {
  creatorCrateDropdownForNativeSelect,
  creatorCrateDropdownSummaryForNativeSelect,
  syncCreatorCrateDropdownDisabledState,
} from './dropdowns.js';

// ─── Slideshow enhancer ───────────────────────────────────────────────────────

const SLIDESHOW_TRIGGER_SELECTOR = '[data-slideshow-trigger]';
export const SLIDESHOW_SCAFFOLD_SELECTOR = '[data-slideshow-scaffold]';
export const SLIDESHOW_SEQUENCE_SELECTOR = '[data-slideshow-sequence]';
const SLIDESHOW_PREVIEW_SELECTOR = '[data-slideshow-preview]';
const SLIDESHOW_PREV_SELECTOR = '[data-slideshow-prev]';
const SLIDESHOW_NEXT_SELECTOR = '[data-slideshow-next]';
const SLIDESHOW_STATUS_SELECTOR = '[data-slideshow-status]';
const SLIDESHOW_PLAY_PAUSE_SELECTOR = '[data-slideshow-play-pause]';
const SLIDESHOW_SPEED_SELECTOR = '[data-slideshow-speed]';
const SLIDESHOW_FULLSCREEN_SELECTOR = '[data-slideshow-fullscreen]';
const SLIDESHOW_CLOSE_SELECTOR = '[data-slideshow-close]';
const SLIDESHOW_ORIGINAL_SIZE_SELECTOR = '[data-slideshow-original-size]';
const SLIDESHOW_MEDIA_STATUS_SELECTOR = '[data-slideshow-media-status]';
const PROJECT_ASSETS_PREVIEW_SELECTOR = '[data-project-assets-preview-id]';
const PROJECT_ASSETS_PREVIEW_BOUND_KEY = 'projectAssetsPreviewSlideshowBound';
const SLIDESHOW_CHROME_HIDE_DELAY = 4000;
const SLIDESHOW_FOCUSED_SURFACE_ATTRIBUTE = 'data-slideshow-ui-focused';

function parseSlideshowSequence(scaffold) {
  try {
    const el = scaffold?.querySelector?.(SLIDESHOW_SEQUENCE_SELECTOR);
    if (!el) return [];
    const parsed = JSON.parse(el.textContent || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function enhanceSlideshow(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  let trigger = scope.querySelector?.(SLIDESHOW_TRIGGER_SELECTOR);
  const scaffold = scope.querySelector?.(SLIDESHOW_SCAFFOLD_SELECTOR);
  if (!trigger || !scaffold) return 0;

  const existingState = scaffold.__creatorCrateSlideshowState;
  if (existingState) {
    existingState.bindTrigger?.(trigger);
    return existingState.refreshSequence?.(parseSlideshowSequence(scaffold)) ?? 1;
  }

  if (isEnhancementBound(trigger, 'slideshowBound')) return 1;
  markEnhancementBound(trigger, 'slideshowBound');

  const playPauseBtn = scaffold.querySelector?.(SLIDESHOW_PLAY_PAUSE_SELECTOR);
  const speedSelect = scaffold.querySelector?.(SLIDESHOW_SPEED_SELECTOR);
  const fullscreenBtn = scaffold.querySelector?.(SLIDESHOW_FULLSCREEN_SELECTOR);
  const originalSizeBtn = scaffold.querySelector?.(SLIDESHOW_ORIGINAL_SIZE_SELECTOR);
  const fullscreenDocument = scaffold.ownerDocument || scope;
  const fullscreenApiAvailable = Boolean(
    fullscreenBtn
    && typeof scaffold.requestFullscreen === 'function'
    && fullscreenDocument
    && typeof fullscreenDocument.exitFullscreen === 'function'
    && 'fullscreenElement' in fullscreenDocument
    && typeof fullscreenDocument.addEventListener === 'function'
  );

  let normalSequence = parseSlideshowSequence(scaffold);
  let sequence = normalSequence;
  let temporarySequenceActive = false;
  let returnFocusElement = null;
  let keyboardFocusedChromeSurface = null;

  let currentIndex = 0;
  let isOpen = false;
  let timerId = null;
  let chromeHideTimerId = null;
  let isPlaying = false;
  let isOriginalMode = false;
  let originalImage = null;
  let originalRequestToken = 0;
  let pendingOriginalLoadHandler = null;
  let pendingOriginalErrorHandler = null;
  let panX = 0;
  let panY = 0;
  let maxPanX = 0;
  let maxPanY = 0;
  let dragPointerId = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;
  let recomputeOriginalPanBounds = null;

  function isFullscreenActive() {
    return fullscreenApiAvailable && fullscreenDocument.fullscreenElement === scaffold;
  }

  function clearChromeHideTimer() {
    if (chromeHideTimerId !== null) {
      clearTimeout(chromeHideTimerId);
      chromeHideTimerId = null;
    }
  }

  function getChromeSurfaces() {
    const speedDropdown = creatorCrateDropdownForNativeSelect(speedSelect);
    return [
      fullscreenBtn,
      scaffold.querySelector?.(SLIDESHOW_ORIGINAL_SIZE_SELECTOR),
      scaffold.querySelector?.(SLIDESHOW_CLOSE_SELECTOR),
      scaffold.querySelector?.(SLIDESHOW_PREV_SELECTOR),
      playPauseBtn,
      speedDropdown,
      speedSelect,
      scaffold.querySelector?.(SLIDESHOW_NEXT_SELECTOR),
    ];
  }

  function getActiveChromeSurface() {
    const activeElement = scope.activeElement;
    const surfaces = getChromeSurfaces();
    return surfaces.find((surface) => surface === activeElement || surface?.contains?.(activeElement)) || null;
  }

  function getFocusedChromeSurface() {
    const activeElement = scope.activeElement;
    if (keyboardFocusedChromeSurface === activeElement
      || keyboardFocusedChromeSurface?.contains?.(activeElement)) {
      return keyboardFocusedChromeSurface;
    }
    return null;
  }

  function rememberKeyboardFocusedChromeSurface() {
    keyboardFocusedChromeSurface = getActiveChromeSurface();
  }

  function clearKeyboardFocusedChromeSurface() {
    keyboardFocusedChromeSurface = null;
  }

  function clearFocusedChromeSurface() {
    getChromeSurfaces()
      .forEach((surface) => surface?.removeAttribute?.(SLIDESHOW_FOCUSED_SURFACE_ATTRIBUTE));
  }

  function setChromeHidden(hidden) {
    if (hidden) {
      clearFocusedChromeSurface();
      getFocusedChromeSurface()?.setAttribute?.(SLIDESHOW_FOCUSED_SURFACE_ATTRIBUTE, '');
      scaffold.setAttribute?.('data-slideshow-ui-hidden', '');
    } else {
      clearFocusedChromeSurface();
      scaffold.removeAttribute?.('data-slideshow-ui-hidden');
    }
  }

  function hideSlideshowChrome() {
    chromeHideTimerId = null;
    setChromeHidden(isOpen);
  }

  function scheduleChromeHide() {
    clearChromeHideTimer();
    if (!isOpen) return;
    chromeHideTimerId = setTimeout(hideSlideshowChrome, SLIDESHOW_CHROME_HIDE_DELAY);
  }

  function showSlideshowChrome() {
    setChromeHidden(false);
    scheduleChromeHide();
  }

  function setFullscreenState(active) {
    if (!fullscreenBtn) return;
    const label = active ? 'Exit fullscreen' : 'Enter fullscreen';
    fullscreenBtn.setAttribute?.('aria-label', label);
    fullscreenBtn.setAttribute?.('data-tooltip', label);
    fullscreenBtn.setAttribute?.('aria-pressed', active ? 'true' : 'false');
    if (active) {
      fullscreenBtn.setAttribute?.('data-slideshow-fullscreen-active', '');
    } else {
      fullscreenBtn.removeAttribute?.('data-slideshow-fullscreen-active');
    }
  }

  function syncFullscreenState() {
    const active = isFullscreenActive();
    setFullscreenState(active && isOpen);
    if (isOpen) {
      showSlideshowChrome();
      if (active) recomputeOriginalPanBounds?.();
    } else {
      clearChromeHideTimer();
      setChromeHidden(false);
    }
  }

  function requestSlideshowFullscreen() {
    try {
      const pending = scaffold.requestFullscreen();
      if (pending && typeof pending.catch === 'function') {
        pending.catch(() => {
          syncFullscreenState();
        });
      }
    } catch {
      syncFullscreenState();
    }
    syncFullscreenState();
  }

  function exitSlideshowFullscreen() {
    try {
      const pending = fullscreenDocument.exitFullscreen();
      if (pending && typeof pending.catch === 'function') {
        pending.catch(() => {
          syncFullscreenState();
        });
      }
    } catch {
      syncFullscreenState();
    }
    syncFullscreenState();
  }

  function toggleFullscreen() {
    if (!fullscreenApiAvailable || !isOpen) return;
    if (isFullscreenActive()) exitSlideshowFullscreen();
    else requestSlideshowFullscreen();
  }

  if (fullscreenBtn) {
    if (!fullscreenApiAvailable) {
      fullscreenBtn.disabled = true;
      fullscreenBtn.setAttribute?.('hidden', '');
    } else {
      fullscreenBtn.removeAttribute?.('hidden');
      fullscreenBtn.disabled = sequence.length === 0;
      fullscreenDocument.addEventListener('fullscreenchange', syncFullscreenState);
      syncFullscreenState();
    }
  }

  trigger.disabled = sequence.length === 0;
  if (playPauseBtn) playPauseBtn.disabled = sequence.length === 0;
  if (speedSelect) speedSelect.disabled = sequence.length === 0;
  if (fullscreenBtn && fullscreenApiAvailable) fullscreenBtn.disabled = sequence.length === 0;

  const preview = scaffold.querySelector?.(SLIDESHOW_PREVIEW_SELECTOR);
  const status = scaffold.querySelector?.(SLIDESHOW_STATUS_SELECTOR);
  const mediaStatus = scaffold.querySelector?.(SLIDESHOW_MEDIA_STATUS_SELECTOR);
  const prevBtn = scaffold.querySelector?.(SLIDESHOW_PREV_SELECTOR);
  const nextBtn = scaffold.querySelector?.(SLIDESHOW_NEXT_SELECTOR);
  const closeBtn = scaffold.querySelector?.(SLIDESHOW_CLOSE_SELECTOR);

  const img = scope.createElement?.('img');
  const captionEl = scope.createElement?.('p');
  if (img) {
    img.setAttribute?.('class', 'slideshow-img slideshow-preview-img');
    img.draggable = false;
    preview?.appendChild?.(img);
  }
  if (captionEl) {
    captionEl.setAttribute?.('class', 'slideshow-caption');
    preview?.appendChild?.(captionEl);
  }

  function getSpeed() {
    return parseInt(speedSelect?.value || '', 10) || 4000;
  }

  function syncSpeedDropdownTooltip() {
    const speedSummary = creatorCrateDropdownSummaryForNativeSelect(speedSelect);
    if (!speedSummary) return;

    const currentSummary = speedSummary.querySelector?.('[data-cc-dropdown-summary-current]');
    const summaryText = currentSummary?.textContent?.trim();
    if (summaryText) speedSummary.setAttribute?.('data-tooltip', summaryText);
    speedSummary.removeAttribute?.('title');

    const classNames = new Set(
      String(speedSummary.getAttribute?.('class') || '').split(/\s+/).filter(Boolean),
    );
    classNames.add('asset-tooltip');
    classNames.add('asset-tooltip--top');
    speedSummary.setAttribute?.('class', [...classNames].join(' '));
  }

  function setMediaStatus(message) {
    if (!mediaStatus) return;
    if (message) {
      mediaStatus.textContent = message;
      mediaStatus.removeAttribute?.('hidden');
      mediaStatus.hidden = false;
    } else {
      mediaStatus.textContent = '';
      mediaStatus.setAttribute?.('hidden', '');
      mediaStatus.hidden = true;
    }
  }

  function setOriginalSizeControl(active) {
    if (!originalSizeBtn) return;
    const available = Boolean(sequence[currentIndex]?.originalUrl);
    const label = active
      ? 'Fit to screen'
      : available
        ? 'View original size'
        : 'Original size unavailable';
    originalSizeBtn.disabled = !available && !active;
    originalSizeBtn.setAttribute?.('aria-label', label);
    originalSizeBtn.setAttribute?.('data-tooltip', label);
    originalSizeBtn.setAttribute?.('aria-pressed', active ? 'true' : 'false');
    if (active) {
      originalSizeBtn.setAttribute?.('data-slideshow-original-size-active', '');
    } else {
      originalSizeBtn.removeAttribute?.('data-slideshow-original-size-active');
    }
    syncImageOriginalSizeActivation();
  }

  function canActivateOriginalSizeFromImage() {
    return Boolean(
      isOpen
      && !isOriginalMode
      && originalSizeBtn
      && !originalSizeBtn.disabled
      && (sequence.length < 2 || !isPlaying)
    );
  }

  function syncImageOriginalSizeActivation() {
    if (!preview) return;
    if (canActivateOriginalSizeFromImage()) {
      preview.setAttribute?.('data-slideshow-image-zoomable', '');
    } else {
      preview.removeAttribute?.('data-slideshow-image-zoomable');
    }
  }

  function renderItem(index) {
    const item = sequence[index];
    if (!item) return;
    currentIndex = index;
    if (img) {
      img.src = item.previewUrl;
      img.setAttribute?.('alt', item.filename);
    }
    if (captionEl) captionEl.textContent = item.filename;
    if (status) status.textContent = `${index + 1} of ${sequence.length}`;
    setOriginalSizeControl(false);
    setMediaStatus('');
  }

  function setSlideshowControlHidden(control, hidden) {
    if (!control) return;
    control.hidden = hidden;
    if (hidden) control.setAttribute?.('hidden', '');
    else control.removeAttribute?.('hidden');
  }

  function syncSequenceControls() {
    const activeAvailable = sequence.length > 0;
    const normalAvailable = normalSequence.length > 0;
    const singleImageMode = sequence.length < 2;
    const speedDropdown = creatorCrateDropdownForNativeSelect(speedSelect);
    const speedControl = speedDropdown?.closest?.('fieldset') || speedDropdown || speedSelect;

    if (boundTrigger) boundTrigger.disabled = !normalAvailable;
    if (playPauseBtn) playPauseBtn.disabled = singleImageMode;
    if (speedSelect) speedSelect.disabled = singleImageMode;
    syncCreatorCrateDropdownDisabledState(speedDropdown);
    syncSpeedDropdownTooltip();
    if (fullscreenBtn && fullscreenApiAvailable) fullscreenBtn.disabled = !activeAvailable;
    if (prevBtn) prevBtn.disabled = singleImageMode;
    if (nextBtn) nextBtn.disabled = singleImageMode;

    setSlideshowControlHidden(prevBtn, singleImageMode);
    setSlideshowControlHidden(nextBtn, singleImageMode);
    setSlideshowControlHidden(playPauseBtn, singleImageMode);
    setSlideshowControlHidden(status, singleImageMode);
    setSlideshowControlHidden(speedControl, singleImageMode);
  }

  function clearAutoplay() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function setPlayPauseState(playing) {
    isPlaying = playing;
    if (playPauseBtn) {
      const label = playing ? 'Pause' : 'Play';
      playPauseBtn.setAttribute?.('aria-label', label);
      playPauseBtn.setAttribute?.('data-tooltip', label);
      if (playing) {
        playPauseBtn.setAttribute?.('data-slideshow-playing', '');
      } else {
        playPauseBtn.removeAttribute?.('data-slideshow-playing');
      }
    }
    syncImageOriginalSizeActivation();
  }

  function scheduleNext() {
    clearAutoplay();
    timerId = setTimeout(() => {
      timerId = null;
      renderItem(currentIndex === sequence.length - 1 ? 0 : currentIndex + 1);
      if (isPlaying) scheduleNext();
    }, getSpeed());
  }

  function startAutoplay() {
    if (isOriginalMode) return;
    setPlayPauseState(true);
    if (sequence.length > 1) scheduleNext();
  }

  function stopAutoplay() {
    clearAutoplay();
    setPlayPauseState(false);
  }

  function clearOriginalLoadListeners() {
    if (!originalImage) return;
    if (pendingOriginalLoadHandler) {
      originalImage.removeEventListener?.('load', pendingOriginalLoadHandler);
      pendingOriginalLoadHandler = null;
    }
    if (pendingOriginalErrorHandler) {
      originalImage.removeEventListener?.('error', pendingOriginalErrorHandler);
      pendingOriginalErrorHandler = null;
    }
  }

  function releasePanPointer() {
    if (dragPointerId !== null && typeof preview?.releasePointerCapture === 'function') {
      try {
        preview.releasePointerCapture(dragPointerId);
      } catch {
        // Pointer capture may already have been released by the browser.
      }
    }
    dragPointerId = null;
    preview?.removeAttribute?.('data-slideshow-dragging');
  }

  function updateOriginalImageTransform() {
    if (!originalImage?.style) return;
    originalImage.style.transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px))`;
  }

  function setPanEnabled(enabled) {
    if (!preview) return;
    if (enabled) preview.setAttribute?.('data-slideshow-pan-enabled', '');
    else preview.removeAttribute?.('data-slideshow-pan-enabled');
  }

  function getViewportSize() {
    const rect = preview?.getBoundingClientRect?.();
    const documentElement = fullscreenDocument?.documentElement;
    const view = fullscreenDocument?.defaultView;
    const firstPositive = (...values) => {
      for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return number;
      }
      return 0;
    };
    return {
      width: firstPositive(
        preview?.clientWidth,
        rect?.width,
        scaffold?.clientWidth,
        documentElement?.clientWidth,
        view?.innerWidth,
      ),
      height: firstPositive(
        preview?.clientHeight,
        rect?.height,
        scaffold?.clientHeight,
        documentElement?.clientHeight,
        view?.innerHeight,
      ),
    };
  }

  function clampPan(value, limit) {
    return Math.max(-limit, Math.min(limit, value));
  }

  function resetPan() {
    releasePanPointer();
    panX = 0;
    panY = 0;
    maxPanX = 0;
    maxPanY = 0;
    updateOriginalImageTransform();
    setPanEnabled(false);
  }

  recomputeOriginalPanBounds = () => {
    const naturalWidth = Number(originalImage?.naturalWidth);
    const naturalHeight = Number(originalImage?.naturalHeight);
    if (!isOriginalMode || !originalImage || naturalWidth <= 0 || naturalHeight <= 0) {
      maxPanX = 0;
      maxPanY = 0;
      panX = 0;
      panY = 0;
      setPanEnabled(false);
      updateOriginalImageTransform();
      return;
    }

    const viewport = getViewportSize();
    maxPanX = viewport.width > 0 ? Math.max(0, (naturalWidth - viewport.width) / 2) : 0;
    maxPanY = viewport.height > 0 ? Math.max(0, (naturalHeight - viewport.height) / 2) : 0;
    panX = clampPan(panX, maxPanX);
    panY = clampPan(panY, maxPanY);
    setPanEnabled(maxPanX > 0 || maxPanY > 0);
    updateOriginalImageTransform();
  };

  setOriginalSizeControl(false);

  function createOriginalImage() {
    if (originalImage || !scope.createElement || !preview) return originalImage;
    originalImage = scope.createElement('img');
    originalImage.setAttribute?.('class', 'slideshow-img slideshow-original-img');
    originalImage.setAttribute?.('alt', '');
    originalImage.draggable = false;
    preview.appendChild?.(originalImage);
    return originalImage;
  }

  function clearOriginalImage() {
    originalRequestToken += 1;
    clearOriginalLoadListeners();
    preview?.removeAttribute?.('data-slideshow-original-loaded');
    if (!originalImage) return;
    originalImage.removeAttribute?.('src');
    originalImage.removeAttribute?.('data-slideshow-original-request');
    if (originalImage.style) {
      originalImage.style.width = '';
      originalImage.style.height = '';
      originalImage.style.transform = '';
    }
  }

  function leaveOriginalSize(message = '') {
    isOriginalMode = false;
    resetPan();
    clearOriginalImage();
    preview?.removeAttribute?.('data-slideshow-mode');
    preview?.removeAttribute?.('data-slideshow-pan-enabled');
    setOriginalSizeControl(false);
    setMediaStatus(message);
  }

  function setOriginalImageDimensions() {
    const width = Number(originalImage?.naturalWidth);
    const height = Number(originalImage?.naturalHeight);
    if (!originalImage || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return false;
    }
    if (originalImage.style) {
      originalImage.style.width = `${width}px`;
      originalImage.style.height = `${height}px`;
    }
    return true;
  }

  function handleOriginalLoad(requestToken) {
    if (!isOriginalMode || requestToken !== originalRequestToken) return;
    clearOriginalLoadListeners();
    if (!setOriginalImageDimensions()) {
      leaveOriginalSize('Original size unavailable; showing fit to screen.');
      return;
    }
    preview?.setAttribute?.('data-slideshow-original-loaded', '');
    recomputeOriginalPanBounds?.();
    setMediaStatus('');
  }

  function handleOriginalError(requestToken) {
    if (!isOriginalMode || requestToken !== originalRequestToken) return;
    leaveOriginalSize('Original size unavailable; showing fit to screen.');
  }

  function enterOriginalSize() {
    const item = sequence[currentIndex];
    if (!item?.originalUrl || !originalSizeBtn || originalSizeBtn.disabled) return;

    stopAutoplay();
    isOriginalMode = true;
    resetPan();
    preview?.setAttribute?.('data-slideshow-mode', 'original');
    preview?.removeAttribute?.('data-slideshow-original-loaded');
    setOriginalSizeControl(true);
    setMediaStatus('Loading original...');

    const image = createOriginalImage();
    if (!image) {
      leaveOriginalSize('Original size unavailable; showing fit to screen.');
      return;
    }

    clearOriginalLoadListeners();
    const requestToken = ++originalRequestToken;
    pendingOriginalLoadHandler = () => handleOriginalLoad(requestToken);
    pendingOriginalErrorHandler = () => handleOriginalError(requestToken);
    image.addEventListener?.('load', pendingOriginalLoadHandler);
    image.addEventListener?.('error', pendingOriginalErrorHandler);
    image.setAttribute?.('data-slideshow-original-request', String(requestToken));
    image.setAttribute?.('alt', item.filename);
    image.src = item.originalUrl;

    if (image.complete && Number(image.naturalWidth) > 0) {
      handleOriginalLoad(requestToken);
    }
  }

  function pointerCoordinate(event, key) {
    const value = Number(event?.[key]);
    return Number.isFinite(value) ? value : 0;
  }

  function beginPan(event) {
    if (!isOriginalMode || !preview?.hasAttribute?.('data-slideshow-original-loaded')) return;
    if (maxPanX <= 0 && maxPanY <= 0) return;
    if (event?.button !== undefined && event.button !== 0) return;

    dragPointerId = event?.pointerId ?? 0;
    dragStartX = pointerCoordinate(event, 'clientX');
    dragStartY = pointerCoordinate(event, 'clientY');
    dragStartPanX = panX;
    dragStartPanY = panY;
    preview.setAttribute?.('data-slideshow-dragging', '');
    if (typeof preview.setPointerCapture === 'function') {
      try {
        preview.setPointerCapture(dragPointerId);
      } catch {
        // Pointer capture is an enhancement; dragging still works while over the preview.
      }
    }
    event?.preventDefault?.();
  }

  function updatePan(event) {
    if (dragPointerId === null) return;
    if (event?.pointerId !== undefined && event.pointerId !== dragPointerId) return;
    panX = clampPan(dragStartPanX + pointerCoordinate(event, 'clientX') - dragStartX, maxPanX);
    panY = clampPan(dragStartPanY + pointerCoordinate(event, 'clientY') - dragStartY, maxPanY);
    updateOriginalImageTransform();
    event?.preventDefault?.();
  }

  function endPan(event) {
    if (dragPointerId === null) return;
    if (event?.pointerId !== undefined && event.pointerId !== dragPointerId) return;
    releasePanPointer();
  }

  function openSlideshow(focusTarget = trigger) {
    if (sequence.length === 0) return;
    clearKeyboardFocusedChromeSurface();
    isOpen = true;
    returnFocusElement = focusTarget || trigger;
    leaveOriginalSize();
    showSlideshowChrome();
    scaffold.removeAttribute?.('hidden');
    scaffold.removeAttribute?.('inert');
    scaffold.hidden = false;
    trigger.setAttribute?.('aria-expanded', 'true');
    renderItem(0);
    closeBtn?.focus?.();
    const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    if (!reducedMotion) startAutoplay();
    else setPlayPauseState(false);
  }

  function closeSlideshow(options = {}) {
    const restoreFocus = options?.restoreFocus !== false;
    const focusTarget = returnFocusElement || trigger;
    stopAutoplay();
    leaveOriginalSize();
    const wasFullscreen = isFullscreenActive();
    isOpen = false;
    clearKeyboardFocusedChromeSurface();
    syncImageOriginalSizeActivation();
    clearChromeHideTimer();
    setChromeHidden(false);
    if (wasFullscreen) exitSlideshowFullscreen();
    setFullscreenState(false);
    scaffold.setAttribute?.('hidden', '');
    scaffold.setAttribute?.('inert', '');
    scaffold.hidden = true;
    trigger.setAttribute?.('aria-expanded', 'false');
    if (temporarySequenceActive) {
      temporarySequenceActive = false;
      sequence = normalSequence;
      currentIndex = 0;
      syncSequenceControls();
      setOriginalSizeControl(false);
    }
    returnFocusElement = null;
    if (restoreFocus) focusTarget?.focus?.();
  }

  function navigatePrev() {
    if (sequence.length < 2) return;
    stopAutoplay();
    leaveOriginalSize();
    renderItem(currentIndex === 0 ? sequence.length - 1 : currentIndex - 1);
  }

  function navigateNext() {
    if (sequence.length < 2) return;
    stopAutoplay();
    leaveOriginalSize();
    renderItem(currentIndex === sequence.length - 1 ? 0 : currentIndex + 1);
  }

  function getFocusableControls() {
    const speedControl = creatorCrateDropdownSummaryForNativeSelect(speedSelect) || speedSelect;
    return [fullscreenBtn, originalSizeBtn, closeBtn, prevBtn, playPauseBtn, speedControl, nextBtn].filter(
      (el) => el && !el.disabled
    );
  }

  function handleSlideshowActivity() {
    if (!isOpen) return;
    showSlideshowChrome();
  }

  function handlePointerSlideshowActivity() {
    clearKeyboardFocusedChromeSurface();
    handleSlideshowActivity();
  }

  function handleKeyboardSlideshowActivity() {
    rememberKeyboardFocusedChromeSurface();
    handleSlideshowActivity();
  }

  let boundTrigger = null;
  const openFromTrigger = () => openSlideshow(trigger);
  const bindTrigger = (nextTrigger) => {
    if (!nextTrigger || nextTrigger === boundTrigger) return;
    boundTrigger?.removeEventListener?.('click', openFromTrigger);
    boundTrigger = nextTrigger;
    trigger = nextTrigger;
    markEnhancementBound(boundTrigger, 'slideshowBound');
    boundTrigger.addEventListener?.('click', openFromTrigger);
  };

  const refreshSequence = (nextSequence) => {
    normalSequence = Array.isArray(nextSequence) ? nextSequence : [];
    if (!temporarySequenceActive) sequence = normalSequence;
    syncSequenceControls();
    if (!normalSequence.length && !temporarySequenceActive) {
      stopAutoplay();
      if (isOpen) closeSlideshow();
      if (originalSizeBtn) originalSizeBtn.disabled = true;
      return 0;
    }
    currentIndex = Math.min(currentIndex, sequence.length - 1);
    if (isOpen) renderItem(currentIndex);
    else setOriginalSizeControl(false);
    return 1;
  };

  const openSingleById = (assetId, opener) => {
    const item = normalSequence.find((candidate) => String(candidate?.id) === String(assetId));
    if (!item?.previewUrl) return false;
    if (isOpen) closeSlideshow({ restoreFocus: false });
    temporarySequenceActive = true;
    sequence = [item];
    currentIndex = 0;
    syncSequenceControls();
    openSlideshow(opener);
    return true;
  };

  bindTrigger(trigger);
  syncSequenceControls();
  closeBtn?.addEventListener?.('click', closeSlideshow);
  prevBtn?.addEventListener?.('click', navigatePrev);
  nextBtn?.addEventListener?.('click', navigateNext);
  originalSizeBtn?.addEventListener?.('click', () => {
    if (isOriginalMode) leaveOriginalSize();
    else enterOriginalSize();
  });
  img?.addEventListener?.('click', (event) => {
    if (event.defaultPrevented) return;
    if (event.button !== undefined && event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!canActivateOriginalSizeFromImage()) return;
    enterOriginalSize();
  });
  if (fullscreenApiAvailable) fullscreenBtn?.addEventListener?.('click', toggleFullscreen);

  scaffold.addEventListener?.('pointermove', handleSlideshowActivity);
  scaffold.addEventListener?.('pointerdown', handlePointerSlideshowActivity);
  scaffold.addEventListener?.('pointerup', endPan);
  scaffold.addEventListener?.('pointercancel', endPan);
  scaffold.addEventListener?.('click', handleSlideshowActivity);
  scaffold.addEventListener?.('focusin', handleSlideshowActivity);
  scaffold.addEventListener?.('focusout', clearFocusedChromeSurface);
  preview?.addEventListener?.('pointerdown', beginPan);
  preview?.addEventListener?.('pointermove', updatePan);
  preview?.addEventListener?.('pointerup', endPan);
  preview?.addEventListener?.('pointercancel', endPan);

  const slideshowWindow = fullscreenDocument?.defaultView;
  slideshowWindow?.addEventListener?.('resize', () => {
    recomputeOriginalPanBounds?.();
  });

  playPauseBtn?.addEventListener?.('click', () => {
    if (isPlaying) stopAutoplay();
    else startAutoplay();
  });

  speedSelect?.addEventListener?.('change', () => {
    syncSpeedDropdownTooltip();
    handleSlideshowActivity();
    if (isPlaying) {
      clearAutoplay();
      scheduleNext();
    }
  });
  scaffold.addEventListener?.('change', (event) => {
    const speedDropdown = creatorCrateDropdownForNativeSelect(speedSelect);
    if (event.target === speedSelect || speedDropdown?.contains?.(event.target)) {
      syncSpeedDropdownTooltip();
    }
  });

  scope.addEventListener?.('keydown', (event) => {
    if (!isOpen) return;
    handleKeyboardSlideshowActivity();
    if (event.key === 'Escape') {
      event.preventDefault?.();
      closeSlideshow();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault?.();
      navigatePrev();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault?.();
      navigateNext();
    } else if (event.key === 'Tab') {
      const focusables = getFocusableControls();
      if (focusables.length === 0) return;
      const active = scope.activeElement;
      const idx = focusables.indexOf(active);
      if (event.shiftKey) {
        const prevIdx = idx <= 0 ? focusables.length - 1 : idx - 1;
        event.preventDefault?.();
        focusables[prevIdx].focus?.();
        rememberKeyboardFocusedChromeSurface();
      } else {
        const nextIdx = idx >= focusables.length - 1 ? 0 : idx + 1;
        event.preventDefault?.();
        focusables[nextIdx].focus?.();
        rememberKeyboardFocusedChromeSurface();
      }
    }
  });

  scaffold.__creatorCrateSlideshowState = { bindTrigger, refreshSequence, openSingleById };
  return sequence.length > 0 ? 1 : 0;
}

export function enhanceProjectAssetsPreviewSlideshow(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const document = liveRegionDocument(scope);
  const scaffold = document?.querySelector?.(SLIDESHOW_SCAFFOLD_SELECTOR);
  const state = scaffold?.__creatorCrateSlideshowState;
  if (!state || typeof state.openSingleById !== 'function') return 0;

  const links = Array.from(scope.querySelectorAll(PROJECT_ASSETS_PREVIEW_SELECTOR));
  links.forEach((link) => {
    if (isEnhancementBound(link, PROJECT_ASSETS_PREVIEW_BOUND_KEY)) return;
    markEnhancementBound(link, PROJECT_ASSETS_PREVIEW_BOUND_KEY);
    link.addEventListener?.('click', (event) => {
      if (event.defaultPrevented) return;
      if (event.button !== undefined && event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const assetId = link.dataset?.projectAssetsPreviewId
        || link.getAttribute?.('data-project-assets-preview-id');
      if (state.openSingleById(assetId, link)) event.preventDefault?.();
    });
  });
  return links.length;
}
