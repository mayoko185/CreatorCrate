import {
  hideElement,
  isEnhancementBound,
  markEnhancementBound,
  showElement,
} from './dom.js';
import { enhanceClickableCards } from './clickable-cards.js';

const PREVIEW_ROOT_SELECTOR = '[data-preview-enhancement]';
const PREVIEW_IMAGE_SELECTOR = '[data-preview-image]';
const PREVIEW_FALLBACK_SELECTOR = '[data-preview-fallback]';
const PROJECT_CARD_SELECTOR = '[data-project-card]';
const PROJECT_CARD_LINK_SELECTOR = '[data-project-card-link]';
const PROJECT_CARD_INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'form',
  'input',
  'select',
  'textarea',
  'label',
  'details',
  'summary',
  '[contenteditable]',
  '[role="button"]',
  '[tabindex]',
].join(', ');

function setPreviewState(root, state) {
  if (!root) return;
  if (root.dataset) root.dataset.previewState = state;
  if (typeof root.setAttribute === 'function') {
    root.setAttribute('data-preview-state', state);
  }
}

export function markPreviewLoaded(root) {
  if (!root || root.dataset?.previewState === 'failed') return 'failed';
  const image = root.querySelector?.(PREVIEW_IMAGE_SELECTOR);
  const fallback = root.querySelector?.(PREVIEW_FALLBACK_SELECTOR);

  setPreviewState(root, 'loaded');
  showElement(image);
  hideElement(fallback);
  return 'loaded';
}

export function markPreviewFailed(root) {
  if (!root) return 'skipped';
  if (root.dataset?.previewState === 'failed') return 'failed';

  const image = root.querySelector?.(PREVIEW_IMAGE_SELECTOR);
  const fallback = root.querySelector?.(PREVIEW_FALLBACK_SELECTOR);
  const previewLink = image?.closest?.('.asset-preview-link');

  setPreviewState(root, 'failed');
  hideElement(image);
  hideElement(previewLink);
  showElement(fallback);
  return 'failed';
}

export function enhancePreview(root) {
  if (!root || typeof root.querySelector !== 'function') return 'skipped';

  const image = root.querySelector(PREVIEW_IMAGE_SELECTOR);
  if (!image) return 'skipped';
  if (isEnhancementBound(root, 'previewBound')) {
    return root.dataset?.previewState === 'failed'
      ? 'failed'
      : root.dataset?.previewState === 'loaded'
        ? 'loaded'
        : 'listening';
  }
  markEnhancementBound(root, 'previewBound');

  if (image.complete === true) {
    return image.naturalWidth > 0
      ? markPreviewLoaded(root)
      : markPreviewFailed(root);
  }

  if (typeof image.addEventListener !== 'function') return 'skipped';

  image.addEventListener('load', () => markPreviewLoaded(root), { once: true });
  image.addEventListener('error', () => markPreviewFailed(root), { once: true });
  return 'listening';
}

export function enhancePreviewMedia(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const roots = scope.querySelectorAll(PREVIEW_ROOT_SELECTOR);
  roots.forEach((root) => enhancePreview(root));
  return roots.length;
}

export function enhanceProjectCards(scope = globalThis.document) {
  return enhanceClickableCards(scope, {
    cardSelector: PROJECT_CARD_SELECTOR,
    linkSelector: PROJECT_CARD_LINK_SELECTOR,
    interactiveSelector: PROJECT_CARD_INTERACTIVE_SELECTOR,
    boundKey: 'projectCardBound',
  });
}
