import { isEnhancementBound, markEnhancementBound } from './dom.js';

// WP3B: Project Detail Related Notes disclosure and browser-local Pin.
//
// Each server-rendered note card ([data-project-related-note="<id>"]) gets an
// independent disclosure (its native button toggles only its own preview) and
// a Pin toggle. A pin is a note-level, browser-local preference stored as
//   creatorcrate:related-notes:v1:note:<noteId> = "1"
// and removed on Unpin; it only decides whether the card starts expanded.
// Collapsing a pinned note keeps the pin, and expanding an unpinned note does
// not pin it. The disclosure's visible text follows its state (WP6.1): "Show
// note" while collapsed, "Hide note" while expanded; the icon-only Pin keeps
// its accessible name and tooltip in step with aria-pressed.
//
// Reinitialization (WP5): enhanceProjectRelatedNotes(scope) binds every card
// in `scope` (a document, the Related Notes region, or a card) that is not
// bound yet, so calling it again after replacing the region's content binds
// only the new cards. Listeners live on the card's own controls and go away
// with them. To keep the current expansion across a replacement, read
// projectRelatedNoteExpansion(region) before replacing and pass it back as
// { expansion } afterwards; notes it does not mention use their pin default.

export const RELATED_NOTE_PIN_KEY_PREFIX = 'creatorcrate:related-notes:v1:note:';
const PINNED_VALUE = '1';

const CARD_SELECTOR = '[data-project-related-note]';
const DISCLOSURE_SELECTOR = '[data-project-related-note-disclosure]';
const PREVIEW_SELECTOR = '[data-project-related-note-preview]';
const PIN_SELECTOR = '[data-project-related-note-pin]';
const DISCLOSURE_LABEL_SELECTOR = '[data-project-related-note-disclosure-label]';
const BOUND_KEY = 'projectRelatedNoteBound';

// The last pin failure each document's feedback notice shows, so a later
// successful pin or unpin can clear it without touching other messages.
const shownFailures = new WeakMap();

export function relatedNotePinKey(noteId) {
  const id = String(noteId ?? '');
  return /^[1-9]\d*$/.test(id) ? `${RELATED_NOTE_PIN_KEY_PREFIX}${id}` : null;
}

function resolveStorage(storage) {
  try {
    const store = typeof storage === 'function' ? storage() : storage;
    return store || null;
  } catch {
    return null;
  }
}

// true or false when the preference was read; null when it could not be.
// Anything but "1" (including an invalid value) reads as not pinned.
export function readRelatedNotePin(noteId, storage = () => globalThis.localStorage) {
  const key = relatedNotePinKey(noteId);
  const store = resolveStorage(storage);
  if (!key || !store) return null;
  try {
    return store.getItem(key) === PINNED_VALUE;
  } catch {
    return null;
  }
}

// true only when the storage call returned normally; never retried.
export function writeRelatedNotePin(noteId, pinned, storage = () => globalThis.localStorage) {
  const key = relatedNotePinKey(noteId);
  const store = resolveStorage(storage);
  if (!key || !store) return false;
  try {
    if (pinned) store.setItem(key, PINNED_VALUE);
    else store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function cardsIn(scope) {
  const cards = [];
  if (scope?.matches?.(CARD_SELECTOR)) cards.push(scope);
  cards.push(...Array.from(scope?.querySelectorAll?.(CARD_SELECTOR) || []));
  return cards;
}

function noteTitle(card) {
  const heading = card.querySelector?.('.project-related-note-title');
  return (heading?.textContent || '').replace(/\s+/g, ' ').trim() || 'this note';
}

// The preview the disclosure's aria-controls names, when it belongs to this
// card and note; otherwise the card's own preview.
function previewFor(card, disclosure, noteId) {
  const controls = disclosure?.getAttribute?.('aria-controls');
  const document = card.ownerDocument;
  const named = controls ? document?.getElementById?.(controls) : null;
  if (named && card.contains?.(named) && named.getAttribute?.('data-project-related-note-preview') === noteId) {
    return named;
  }
  return card.querySelector?.(PREVIEW_SELECTOR) || null;
}

function setExpanded(disclosure, preview, expanded) {
  if (!disclosure || !preview) return;
  if (expanded) {
    preview.hidden = false;
    preview.removeAttribute?.('hidden');
  } else {
    preview.hidden = true;
    preview.setAttribute?.('hidden', '');
  }
  disclosure.setAttribute('aria-expanded', String(expanded));
  const label = disclosure.querySelector?.(DISCLOSURE_LABEL_SELECTOR);
  if (label) label.textContent = expanded ? 'Hide note' : 'Show note';
}

function isExpanded(disclosure) {
  return disclosure?.getAttribute?.('aria-expanded') === 'true';
}

function setPinned(pin, pinned, title) {
  if (!pin) return;
  const verb = pinned ? 'Unpin' : 'Pin';
  pin.setAttribute('aria-pressed', String(pinned));
  pin.setAttribute('aria-label', `${verb} ${title}`);
  pin.setAttribute('data-tooltip', `${verb} note`);
}

function feedbackNotice(document) {
  const notice = document?.querySelector?.('[data-dialog-feedback]');
  const text = notice?.querySelector?.('[data-dialog-feedback-text]');
  return notice && text ? { notice, text } : null;
}

function showPinFailure(document, message) {
  const feedback = feedbackNotice(document);
  if (!feedback) return;
  feedback.notice.classList?.toggle?.('notice--error', true);
  feedback.notice.classList?.toggle?.('notice--success', false);
  feedback.text.textContent = message;
  feedback.notice.hidden = false;
  shownFailures.set(document, message);
}

function clearPinFailure(document) {
  const message = shownFailures.get(document);
  if (!message) return;
  shownFailures.delete(document);
  const feedback = feedbackNotice(document);
  if (feedback && feedback.text.textContent === message) {
    feedback.notice.hidden = true;
    feedback.text.textContent = '';
  }
}

function enhanceCard(card, { storage, expansion }) {
  const noteId = card.getAttribute('data-project-related-note');
  const disclosure = card.querySelector?.(DISCLOSURE_SELECTOR) || null;
  const preview = disclosure ? previewFor(card, disclosure, noteId) : null;
  const pin = card.querySelector?.(PIN_SELECTOR) || null;
  const title = noteTitle(card);

  const stored = readRelatedNotePin(noteId, storage);
  let pinned = stored === true;
  setPinned(pin, pinned, title);

  const kept = expansion?.get?.(noteId);
  setExpanded(disclosure, preview, typeof kept === 'boolean' ? kept : pinned);

  if (disclosure && preview) {
    disclosure.addEventListener('click', () => {
      setExpanded(disclosure, preview, !isExpanded(disclosure));
    });
  }

  if (pin) {
    pin.addEventListener('click', () => {
      const next = !pinned;
      if (!writeRelatedNotePin(noteId, next, storage)) {
        showPinFailure(card.ownerDocument, next
          ? `Couldn't pin ${title}. This browser isn't saving preferences right now.`
          : `Couldn't unpin ${title}. This browser isn't saving preferences right now.`);
        return;
      }
      pinned = next;
      setPinned(pin, pinned, title);
      clearPinFailure(card.ownerDocument);
      if (pinned) setExpanded(disclosure, preview, true);
    });
  }
}

/**
 * Bind every not-yet-bound Related Notes card in `scope`.
 *
 * @param {Document|Element} scope
 * @param {{ storage?: Storage|(() => Storage), expansion?: Map<string, boolean> }} [options]
 *   `expansion` (noteId → expanded) overrides the pin default for the notes it
 *   names; see projectRelatedNoteExpansion().
 */
export function enhanceProjectRelatedNotes(scope, { storage = () => globalThis.localStorage, expansion } = {}) {
  for (const card of cardsIn(scope)) {
    if (isEnhancementBound(card, BOUND_KEY)) continue;
    markEnhancementBound(card, BOUND_KEY);
    try {
      enhanceCard(card, { storage, expansion });
    } catch (error) {
      // One malformed card must not stop the others or the page bootstrap.
      try {
        globalThis.reportError?.(error);
      } catch {
        // Reporting is best effort.
      }
    }
  }
}

/** Current expansion (noteId → expanded) of the bound cards in `scope`. */
export function projectRelatedNoteExpansion(scope) {
  const expansion = new Map();
  for (const card of cardsIn(scope)) {
    if (!isEnhancementBound(card, BOUND_KEY)) continue;
    const disclosure = card.querySelector?.(DISCLOSURE_SELECTOR);
    if (disclosure) expansion.set(card.getAttribute('data-project-related-note'), isExpanded(disclosure));
  }
  return expansion;
}
