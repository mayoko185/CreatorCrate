import { appDialogFeedback, setAppDialogBaseline } from './app-dialogs.js';
import {
  adoptBookHierarchySnapshot,
  adoptChapterPageOrder,
  applyChapterPageOrder,
  chapterPageOrderDragging,
  chapterPageOrderIds,
  renderedChapterPageOrderIds,
} from './dedicated-reorder.js';
import { bindRecordDelete, readPageDeletionStatus, refusedWithoutWriting } from './dialog-record-delete.js';
import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';
import { beginBookDetailDefaultsLiveRefresh, supersedeBookDetailLiveRefresh } from './live-regions.js';
import {
  noteDialogIsDirty,
  readNoteDialogBaseline,
  resetNoteDialogToBaseline,
  setNoteDialogBaseline,
} from './note-dialog-dirty.js';
import { enhanceNotesCodeBlocks } from './notes-editor.js';
import { bindPageMove } from './page-move-dialog.js';
import { enhancePreviewMedia } from './preview.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// New Chapter on Book Detail, Edit Chapter and Change order on Chapter Detail,
// New Page on both, and Edit Page on Page Detail, saved through the shared async
// dialog binder. A save leaves the user on the host page: the binder closes the
// dialog and shows its message in the page feedback, and this module updates only
// what names the Chapter or lists its Pages, or on Page Detail what shows the
// Page. Everything else on the host (a New Page draft, the other dialogs' drafts)
// is left alone. The POST is never repeated: a failed refresh offers Retry
// refresh, which only reads again. A directly visited /chapters/new, /edit,
// /notes/order, /notes/new or /notes/:id/edit URL renders its form native.
const RETRY_KEY = 'chapterRefreshRetryButton';
const REFRESHING_MESSAGE = 'Refreshing Book contents…';
const NAVIGATOR_SELECTOR = '.notes-book-nav';
const NAV_CHAPTER_ATTRIBUTE = 'data-book-nav-chapter';
const BOOK_ORDER_TRIGGER_SELECTOR = '[data-book-detail-toolbar] [data-dialog-open="book-order-dialog"]';
const BOOK_EDIT_TRIGGER_SELECTOR = '[data-book-detail-toolbar] [data-dialog-open="book-edit-dialog"]';
const CHAPTER_TITLE_FIELD_SELECTOR = '#chapter-edit-title';
const CHAPTER_PAGES_SELECTOR = '.notes-chapter-pages';
const CHAPTER_ORDER_TRIGGER_SELECTOR = '.page-heading [data-dialog-open="chapter-order-dialog"]';
const CHAPTER_EDIT_TRIGGER_SELECTOR = '.page-heading [data-dialog-open="chapter-edit-dialog"]';
const BOOK_PAGE_PREVIEWS_SELECTOR = '.notes-page-previews';
const BOOK_DETAILS_SELECTOR = '.notes-detail-details';
const PREVIEW_PAGE_CHOICES_SELECTOR = '#book-preview-pages';
const PAGE_DELETED_URL = /^\/notes\/(?:books|chapters)\/[1-9]\d*\?notice=page_deleted&undo=[0-9a-f]{64}$/;
const PAGE_PARENT_URL = /^\/notes\/(?:books|chapters)\/[1-9]\d*$/;
const PAGE_CONTENT_SELECTOR = '.notes-page-detail-content';
const PAGE_HISTORY_SELECTOR = '.notes-revision-history';
const PAGE_BOOK_COVER_SELECTOR = '.notes-page-detail-sidebar .notes-book-cover';
const NOTE_FORM_SELECTOR = '#note-form';
const ORDER_FIELD = 'orderedNoteIds';
const ORDER_SECTION_SELECTOR = '#notes-chapter-order-form [data-notes-chapter-order-page]';
const ORDER_RETRY_KEY = 'orderCheckRetryButton';
const ORDER_CHECKING_MESSAGE = 'Checking the current Page order…';
const ORDER_CHECK_FAILED_MESSAGE = 'The current Page order could not be confirmed, so it cannot be saved yet. The order shown may be out of date.';
const ORDER_CONFLICT_MESSAGE = 'The saved Page order has changed since this order was arranged, so it cannot be saved. Close this dialog to see the current order.';

// What the dialogs of one document share: every read reconciles the same host,
// so only the newest may show its result, whichever dialog started it.
const hosts = new WeakMap();

function hostFor(document) {
  if (!hosts.has(document)) hosts.set(document, { refresh: null, latestRead: null, edit: null, order: null });
  return hosts.get(document);
}

function feedbackParts(document) {
  const feedback = document.querySelector('[data-dialog-feedback]');
  return { feedback, text: feedback?.querySelector('[data-dialog-feedback-text]') };
}

function openerFor(ctrl) {
  return ctrl.document.querySelector(`[data-dialog-open="${ctrl.dialog.id}"]`);
}

// Runs after the binder writes the success message, so the link and Dismiss sit
// inside the feedback text and go with it on the next write.
function decorateFeedback(ctrl, url) {
  const { document } = ctrl;
  const { feedback, text } = feedbackParts(document);
  if (!feedback || !text) return;
  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.textContent = ctrl.viewLabel;
    link.setAttribute(ctrl.viewAttribute, '');
    text.append(' ', link);
  }
  feedback.classList.add('app-dialog-feedback--pinned');
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'button button-small button-secondary';
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('data-chapter-feedback-dismiss', '');
  dismiss.addEventListener('click', () => {
    feedback.classList.remove('app-dialog-feedback--pinned');
    feedback.hidden = true;
    text.textContent = '';
    openerFor(ctrl)?.focus?.({ preventScroll: true });
  });
  text.append(' ', dismiss);
}

// A refresh note has its own span so a retry can replace it; an empty message
// removes it. Returns the Retry refresh button when one is offered.
function setRefreshNote(ctrl, message, onRetry = null) {
  removeStatusRetry(ctrl.host, RETRY_KEY);
  const { feedback, text } = feedbackParts(ctrl.document);
  let note = text?.querySelector('[data-chapter-refresh-note]');
  if (!message) {
    note?.remove();
    return null;
  }
  if (!text) return null;
  if (!note) {
    note = ctrl.document.createElement('span');
    note.setAttribute('data-chapter-refresh-note', '');
    text.append(note);
  }
  note.textContent = ` ${message} `;
  // A confirmation dismissed before the refresh failed still reports it.
  feedback.classList.add('app-dialog-feedback--pinned');
  feedback.hidden = false;
  if (!onRetry) return null;
  return showStatusRetry({
    state: ctrl.host,
    status: text,
    attribute: 'data-chapter-refresh-retry',
    key: RETRY_KEY,
    onRetry,
  });
}

function focusKey(navigator, active) {
  if (!active || !navigator.contains(active)) return null;
  const href = active.getAttribute('href');
  if (href) return { selector: `a[href="${href}"]` };
  const chapter = active.querySelector(`[${NAV_CHAPTER_ATTRIBUTE}]`)?.getAttribute(NAV_CHAPTER_ATTRIBUTE);
  return chapter ? { selector: `summary:has([${NAV_CHAPTER_ATTRIBUTE}="${chapter}"])` } : null;
}

// A page has its sidebar navigator and one more in the New Page dialog. Neither
// holds a control, so swapping them keeps every draft; which Chapters are open
// and where focus was carry over to the new markup.
function installNavigators(ctrl, parsed) {
  const { document } = ctrl;
  const current = [...document.querySelectorAll(NAVIGATOR_SELECTOR)];
  const next = [...parsed.querySelectorAll(NAVIGATOR_SELECTOR)];
  if (current.length === 0 || current.length !== next.length) throw new Error('Book contents could not be matched.');
  current.forEach((navigator, index) => {
    const replacement = next[index];
    navigator.querySelectorAll(`[${NAV_CHAPTER_ATTRIBUTE}]`).forEach((item) => {
      const chapter = item.getAttribute(NAV_CHAPTER_ATTRIBUTE);
      const details = replacement.querySelector(`[${NAV_CHAPTER_ATTRIBUTE}="${chapter}"]`)?.closest('details');
      const previous = item.closest('details');
      // A Page moved into this Chapter opens it, as the server rendered it.
      const pageArrived = details?.querySelector('[aria-current="page"]') && !previous?.querySelector('[aria-current="page"]');
      if (details && !pageArrived) details.open = previous?.open === true;
    });
    const focus = focusKey(navigator, document.activeElement);
    navigator.replaceWith(replacement);
    if (focus) {
      (replacement.querySelector(focus.selector) || openerFor(ctrl))?.focus?.({ preventScroll: true });
    }
  });
}

// Reordering appears once a Book has enough contents; the trigger is outside
// what a refresh replaces.
function syncBookOrderTrigger(document, parsed) {
  const replacement = parsed.querySelector(BOOK_ORDER_TRIGGER_SELECTOR);
  if (!replacement || document.querySelector(BOOK_ORDER_TRIGGER_SELECTOR)) return;
  document.querySelector(BOOK_EDIT_TRIGGER_SELECTOR)?.after(replacement);
}

function installBookDetail(ctrl, parsed) {
  installNavigators(ctrl, parsed);
  adoptBookHierarchySnapshot(ctrl.document, parsed);
  syncBookOrderTrigger(ctrl.document, parsed);
}

function replaceKeepingFocus(ctrl, current, replacement) {
  const focus = focusKey(current, ctrl.document.activeElement);
  current.replaceWith(replacement);
  if (focus) (replacement.querySelector(focus.selector) || openerFor(ctrl))?.focus?.({ preventScroll: true });
}

// A random sample is drawn anew on every read, so it is adopted only when
// nothing on screen would vanish. Otherwise the user keeps what they are
// reading, and the Page is reachable through the navigator and View Page.
function syncPagePreviews(ctrl, parsed) {
  const current = ctrl.document.querySelector(BOOK_PAGE_PREVIEWS_SELECTOR);
  const replacement = parsed.querySelector(BOOK_PAGE_PREVIEWS_SELECTOR);
  if (!current || !replacement) return;
  const shownPages = (section) => Array.from(section.querySelectorAll('a[href]'), (link) => link.getAttribute('href'));
  const nextPages = new Set(shownPages(replacement));
  if (!shownPages(current).every((href) => nextPages.has(href))) return;
  replaceKeepingFocus(ctrl, current, replacement);
  enhancePreviewMedia(replacement);
  enhanceNotesCodeBlocks(replacement);
}

// Book defaults lists every Page as a preview choice; its selection stays.
function syncPreviewPageChoices(document, parsed) {
  const native = document.querySelector(PREVIEW_PAGE_CHOICES_SELECTOR);
  const next = parsed.querySelector(PREVIEW_PAGE_CHOICES_SELECTOR);
  if (!native || !next) return;
  const choices = (select) => Array.from(select.options, (option) => [option.value, option.textContent]);
  if (JSON.stringify(choices(native)) === JSON.stringify(choices(next))) return;
  const selected = new Set(Array.from(native.selectedOptions, (option) => option.value));
  const known = new Set(Array.from(native.options, (option) => option.value));
  // A Page new to this list (one restored by Undo) comes with its saved selection.
  next.querySelectorAll('option').forEach((option) => {
    if (option.selected && !known.has(option.value)) selected.add(option.value);
  });
  const options = Array.from(next.options);
  native.replaceChildren(...options);
  options.forEach((option) => { option.selected = selected.has(option.value); });
  syncCreatorCrateDropdownFromNative(native);
  const empty = native.closest('[data-dialog-field]')
    ?.querySelector('.asset-filter-multiselect-empty:not([data-cc-dropdown-no-results])');
  if (empty) empty.hidden = options.length > 0;
}

function installBookDetailPages(ctrl, parsed) {
  installBookDetail(ctrl, parsed);
  syncPagePreviews(ctrl, parsed);
  syncPreviewPageChoices(ctrl.document, parsed);
  const details = ctrl.document.querySelector(BOOK_DETAILS_SELECTOR);
  const nextDetails = parsed.querySelector(BOOK_DETAILS_SELECTOR);
  if (details && nextDetails) details.replaceWith(nextDetails);
}

function showChapterTitle(document, title) {
  const heading = `Notes — ${title}`;
  document.title = `CreatorCrate — ${heading}`;
  document.querySelectorAll('h1.app-section-title, .mobile-nav-section').forEach((element) => {
    element.textContent = heading;
  });
  document.querySelectorAll('.notes-book-nav-item--current .notes-book-nav-chapter-title').forEach((element) => {
    element.textContent = title;
  });
  document.querySelectorAll('[aria-label^="Pages in "]').forEach((element) => {
    element.setAttribute('aria-label', `Pages in ${title}`);
  });
}

// The title as last read from the server: shown now, or once the open dialog
// holding a draft has closed.
function adoptChapterTitle(ctrl, title) {
  if (ctrl.dialog.open || ctrl.dialogState.submitting) {
    ctrl.pendingTitle = title;
    return;
  }
  ctrl.pendingTitle = null;
  setAppDialogBaseline(ctrl.document, ctrl.dialog.id, { title });
  showChapterTitle(ctrl.document, title);
}

function savedPageOrder(ctrl) {
  return String(ctrl.dialogState.savedValues?.[ORDER_FIELD] || '').split(',').filter(Boolean);
}

function publishPageOrder(ctrl, parsed) {
  ctrl.pendingOrder = null;
  const value = adoptChapterPageOrder(ctrl.dialogState.form, parsed);
  if (value !== null) ctrl.dialogState.savedValues = { [ORDER_FIELD]: value };
}

// What the rendered order is worth to Save: 'unverified' while closed, 'checking'
// during the opening read, 'rechecking' during Check again, 'failed' after a read
// that did not answer, 'conflict' when a draft was overtaken, and 'verified'. Save
// takes the binder's submit lock from this, so every way of submitting is refused,
// and a failed read also freezes the order that could not be confirmed.
function syncOrderCheck(ctrl) {
  const { document, dialog, dialogState } = ctrl;
  const verified = ctrl.orderCheck === 'verified';
  dialog.querySelectorAll('[data-dialog-submit]').forEach((save) => {
    if (!verified && dialog.open && document.activeElement === save) {
      dialog.querySelector('[data-dialog-close]')?.focus?.({ preventScroll: true });
    }
    save.disabled = !verified || dialogState.submitting;
  });
  dialog.querySelector('[data-notes-chapter-order-page]')
    ?.toggleAttribute('inert', ctrl.orderCheck === 'failed' || ctrl.orderCheck === 'rechecking');
}

function setOrderCheck(ctrl, check) {
  ctrl.orderCheck = check;
  syncOrderCheck(ctrl);
}

function setOrderStatus(ctrl, message) {
  const status = ctrl.dialog.querySelector('[data-dialog-status]');
  if (status) status.textContent = message;
}

function setOrderError(ctrl, message) {
  const error = ctrl.dialog.querySelector('[data-dialog-error]');
  if (error) error.hidden = !message;
  const errorText = ctrl.dialog.querySelector('[data-dialog-error-text]');
  if (errorText) errorText.textContent = message;
}

// Only the check's own messages go: an answer to a read leaves a refused Save's
// explanation standing.
function settleOrderCheck(ctrl, conflict) {
  const checkOpen = ctrl.orderCheck !== 'verified' && ctrl.orderCheck !== 'conflict';
  if (checkOpen) {
    removeStatusRetry(ctrl, ORDER_RETRY_KEY);
    setOrderStatus(ctrl, '');
    setOrderError(ctrl, '');
  }
  if (conflict) {
    const standing = ctrl.dialog.querySelector('[data-dialog-error-text]')?.textContent || '';
    if (!standing.includes(ORDER_CONFLICT_MESSAGE)) setOrderError(ctrl, `${standing} ${ORDER_CONFLICT_MESSAGE}`.trim());
  }
  setOrderCheck(ctrl, conflict ? 'conflict' : 'verified');
}

// A draft in the open dialog stays until the user has decided about it: the
// read waits behind it and takes over when the dialog closes. Only a sequence
// comparison can tell a draft was overtaken: the server refuses a change of
// membership, but would accept this draft over an order the user never saw.
function installPageOrder(ctrl, parsed) {
  const { form, submitting } = ctrl.dialogState;
  const saved = savedPageOrder(ctrl).join();
  const draft = chapterPageOrderIds(form).join();
  const draftInUse = submitting || chapterPageOrderDragging(form) || (ctrl.dialog.open && draft !== saved);
  const rendered = renderedChapterPageOrderIds(form, parsed);
  const overtaken = draftInUse && rendered.join() !== saved && rendered.join() !== draft
    && [...rendered].sort().join() === chapterPageOrderIds(form).sort().join();
  if (draftInUse) ctrl.pendingOrder = parsed;
  else publishPageOrder(ctrl, parsed);
  // Opening supersedes every older read, so one answering now began after it.
  if (ctrl.dialog.open) settleOrderCheck(ctrl, overtaken);
  else syncOrderCheck(ctrl);
}

function installPageList(ctrl, parsed) {
  const current = ctrl.document.querySelector(CHAPTER_PAGES_SELECTOR);
  const replacement = parsed.querySelector(CHAPTER_PAGES_SELECTOR);
  if (current.isEqualNode(replacement)) return;
  replaceKeepingFocus(ctrl, current, replacement);
}

// The server decides when Change order is offered, and the Edit trigger's
// tooltip side follows it; both sit outside what a refresh replaces.
function syncChapterOrderTrigger(document, parsed) {
  const edit = document.querySelector(CHAPTER_EDIT_TRIGGER_SELECTOR);
  const nextEdit = parsed.querySelector(CHAPTER_EDIT_TRIGGER_SELECTOR);
  if (!edit || !nextEdit) return;
  edit.className = nextEdit.className;
  const trigger = document.querySelector(CHAPTER_ORDER_TRIGGER_SELECTOR);
  const replacement = parsed.querySelector(CHAPTER_ORDER_TRIGGER_SELECTOR);
  if (replacement && !trigger) edit.after(replacement);
  if (trigger && !replacement) {
    if (document.activeElement === trigger) edit.focus({ preventScroll: true });
    trigger.remove();
  }
}

function installChapterDetail(ctrl, parsed) {
  const title = parsed.querySelector(CHAPTER_TITLE_FIELD_SELECTOR)?.value;
  if (typeof title !== 'string' || !title) throw new Error('Chapter response did not include its title.');
  if (!parsed.querySelector(CHAPTER_PAGES_SELECTOR) || !ctrl.document.querySelector(CHAPTER_PAGES_SELECTOR)) {
    throw new Error('Chapter response did not include its Pages.');
  }
  if (ctrl.host.order && !parsed.querySelector(ORDER_SECTION_SELECTOR)) {
    throw new Error('Chapter response did not include its Page order.');
  }
  installNavigators(ctrl, parsed);
  installPageList(ctrl, parsed);
  syncChapterOrderTrigger(ctrl.document, parsed);
  if (ctrl.host.edit) adoptChapterTitle(ctrl.host.edit, title);
  if (ctrl.host.order) installPageOrder(ctrl.host.order, parsed);
}

function showPageTitle(document, title) {
  const heading = `Notes — Page — ${title}`;
  document.title = `CreatorCrate — ${heading}`;
  document.querySelectorAll('h1.app-section-title, .mobile-nav-section').forEach((element) => {
    element.textContent = heading;
  });
  document.querySelectorAll('#notes-detail-content-heading, .notes-book-nav-page-link[aria-current="page"]')
    .forEach((element) => { element.textContent = title; });
}

// The saved values follow every read. A draft stays as typed and is compared with
// them, so one the server already holds no longer counts as unsaved; a form with
// no draft shows them.
function adoptPageBaseline(ctrl, baseline) {
  const { form, submitting } = ctrl.dialogState;
  const draftHeld = submitting || noteDialogIsDirty(form, readNoteDialogBaseline(form));
  setNoteDialogBaseline(form, baseline);
  ctrl.dialogState.savedValues = baseline;
  if (!draftHeld && noteDialogIsDirty(form, baseline)) resetNoteDialogToBaseline(form);
}

function installPageHistory(ctrl, parsed) {
  const current = ctrl.document.querySelector(PAGE_HISTORY_SELECTOR);
  const replacement = parsed.querySelector(PAGE_HISTORY_SELECTOR);
  if (!current || !replacement) return;
  const summary = current.querySelector('summary');
  const summaryFocused = Boolean(summary) && ctrl.document.activeElement === summary;
  const disclosure = replacement.querySelector('details');
  if (disclosure) disclosure.open = current.querySelector('details')?.open === true;
  replaceKeepingFocus(ctrl, current, replacement);
  if (summaryFocused) replacement.querySelector('summary')?.focus?.({ preventScroll: true });
}

// The cover names the Book, so it follows a move; otherwise an image already on
// screen is left alone rather than loaded again.
function installPageBookCover(ctrl, parsed) {
  const current = ctrl.document.querySelector(PAGE_BOOK_COVER_SELECTOR);
  const replacement = parsed.querySelector(PAGE_BOOK_COVER_SELECTOR);
  if (!current || !replacement) return;
  const bookUrl = (cover) => cover.querySelector('a[href]')?.getAttribute('href');
  if (bookUrl(current) === bookUrl(replacement)) return;
  current.replaceWith(replacement);
  enhancePreviewMedia(replacement.parentElement);
}

function installPageDetail(ctrl, parsed) {
  const nextForm = parsed.querySelector(NOTE_FORM_SELECTOR);
  const sameForm = nextForm?.getAttribute('action') === ctrl.dialogState.form.getAttribute('action');
  const baseline = sameForm ? readNoteDialogBaseline(nextForm) : null;
  const content = ctrl.document.querySelector(PAGE_CONTENT_SELECTOR);
  const nextContent = parsed.querySelector(PAGE_CONTENT_SELECTOR);
  if (!baseline || !content || !nextContent) throw new Error('Page response did not include this Page.');
  installNavigators(ctrl, parsed);
  replaceKeepingFocus(ctrl, content, nextContent);
  enhancePreviewMedia(nextContent);
  enhanceNotesCodeBlocks(nextContent);
  const details = ctrl.document.querySelector(BOOK_DETAILS_SELECTOR);
  const nextDetails = parsed.querySelector(BOOK_DETAILS_SELECTOR);
  if (details && nextDetails) details.replaceWith(nextDetails);
  installPageHistory(ctrl, parsed);
  installPageBookCover(ctrl, parsed);
  showPageTitle(ctrl.document, baseline.title);
  adoptPageBaseline(ctrl, baseline);
  ctrl.move?.adoptTargets(parsed);
}

function orderLinkedItems(list, ids) {
  if (!list) return;
  const items = new Map(Array.from(list.children).map((item) => [
    item.querySelector('a[href]')?.getAttribute('href').split('/').pop(),
    item,
  ]));
  if (items.size !== ids.length || ids.some((id) => !items.has(id))) return;
  ids.forEach((id) => list.append(items.get(id)));
}

// The acknowledged order shows at once, even if the refresh after it fails.
function showSavedPageOrder(ctrl, payload) {
  ctrl.pendingOrder = null;
  if (!Array.isArray(payload?.orderedNoteIds)) return;
  const ids = payload.orderedNoteIds.map(String);
  applyChapterPageOrder(ctrl.dialogState.form, ids);
  orderLinkedItems(ctrl.document.querySelector(`${CHAPTER_PAGES_SELECTOR} .notes-page-nav-list`), ids);
  ctrl.document.querySelectorAll('.notes-book-nav-item--current .notes-book-nav-pages')
    .forEach((list) => orderLinkedItems(list, ids));
}

// Dismissal returns to the saved order, or to a newer one read in the meantime.
function discardPageOrderDraft(ctrl) {
  const { document, dialog, dialogState } = ctrl;
  if (ctrl.pendingOrder) publishPageOrder(ctrl, ctrl.pendingOrder);
  else applyChapterPageOrder(dialogState.form, savedPageOrder(ctrl));
  setAppDialogBaseline(document, dialog.id, dialogState.savedValues);
  removeStatusRetry(ctrl, ORDER_RETRY_KEY);
  setOrderCheck(ctrl, 'unverified');
}

// Only the newest refresh shows its result, so an older answer cannot overwrite
// what a later save has already shown. A Book save refreshing Book Detail meanwhile
// (its defaults, say) may be missing from this answer, so it reads again.
async function fetchAndInstallHost(ctrl, request) {
  const windowObject = ctrl.document.defaultView || globalThis;
  const detailGeneration = beginBookDetailDefaultsLiveRefresh(ctrl.document);
  const response = await windowObject.fetch(ctrl.hostUrl, {
    method: 'GET',
    headers: { Accept: 'text/html' },
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response?.ok) throw new Error('Host response failed.');
  const parsed = new windowObject.DOMParser().parseFromString(await response.text(), 'text/html');
  if (ctrl.host.refresh !== request) return false;
  if (beginBookDetailDefaultsLiveRefresh(ctrl.document) !== detailGeneration) return fetchAndInstallHost(ctrl, request);
  ctrl.installHost(ctrl, parsed);
  return true;
}

// Every read of the host starts here, so the newest one can be waited for.
function startHostRead(ctrl, settle) {
  const request = {};
  ctrl.host.refresh = request;
  const settled = settle(fetchAndInstallHost(ctrl, request), request);
  ctrl.host.latestRead = settled;
  return settled;
}

async function hostReadsSettled(host) {
  let awaited;
  while (awaited !== host.latestRead) {
    awaited = host.latestRead;
    await awaited;
  }
}

// A read a write depends on. A newer read taking its turn does not discharge it: that
// one may fail unreported or install less, so this one reads again once the newest
// has settled. Answers true once installed and false if it failed.
async function readHostAfterWrite(ctrl) {
  for (;;) {
    const outcome = await startHostRead(ctrl, (read, request) => read
      .then((installed) => (installed ? true : undefined))
      .catch(() => (ctrl.host.refresh === request ? false : undefined)));
    if (outcome !== undefined) return outcome;
    await hostReadsSettled(ctrl.host);
  }
}

async function refreshHost(ctrl, { focusRetry = false, refocus = false, failureMessage = ctrl.refreshFailureMessage } = {}) {
  if (await readHostAfterWrite(ctrl)) {
    setRefreshNote(ctrl, '');
    if (refocus) openerFor(ctrl)?.focus?.({ preventScroll: true });
    return true;
  }
  const retry = setRefreshNote(ctrl, failureMessage, ({ wasFocused }) => {
    setRefreshNote(ctrl, REFRESHING_MESSAGE);
    refreshHost(ctrl, { focusRetry: wasFocused, refocus: wasFocused, failureMessage });
  });
  if (focusRetry) retry?.focus?.();
  return false;
}

// Brings a Book or Chapter up to date after Undo restored a Page into it, with no
// dialog of its own: the same reads, the same turns. Answers as readHostAfterWrite
// does and reports nothing itself, since the Undo alert says what happened.
export async function refreshPageDeletionParent(document, parentUrl) {
  const ctrl = {
    document,
    host: hostFor(document),
    hostUrl: parentUrl,
    dialog: { id: 'note-create-dialog' },
    installHost: /^\/notes\/chapters\//.test(parentUrl) ? installChapterDetail : installBookDetailPages,
  };
  supersedeBookDetailLiveRefresh(document);
  const installed = await readHostAfterWrite(ctrl);
  if (installed) setRefreshNote(ctrl, '');
  return installed;
}

// A read nobody is waiting on: it reports nothing if it fails.
function readHostQuietly(ctrl) {
  startHostRead(ctrl, (read) => read.then((installed) => {
    if (installed) setRefreshNote(ctrl, '');
  }).catch(() => {}));
}

function showOrderCheckFailed(ctrl, focusRetry) {
  const { document, dialog } = ctrl;
  const active = document.activeElement;
  const focusLost = focusRetry || dialog.querySelector('[data-notes-chapter-order-page]')?.contains(active);
  setOrderStatus(ctrl, '');
  setOrderError(ctrl, ORDER_CHECK_FAILED_MESSAGE);
  setOrderCheck(ctrl, 'failed');
  const retry = showStatusRetry({
    state: ctrl,
    status: dialog.querySelector('[data-dialog-error]'),
    attribute: 'data-chapter-order-recheck',
    key: ORDER_RETRY_KEY,
    label: 'Check again',
    onRetry: ({ wasFocused }) => {
      // The button is gone with its click, so Close holds focus for the read.
      if (wasFocused) dialog.querySelector('[data-dialog-close]')?.focus?.({ preventScroll: true });
      setOrderError(ctrl, '');
      setOrderStatus(ctrl, ORDER_CHECKING_MESSAGE);
      setOrderCheck(ctrl, 'rechecking');
      checkPageOrder(ctrl, wasFocused);
    },
  });
  if (focusLost) retry?.focus?.();
}

// The read an open dialog's Save depends on. It writes nothing, and it reports
// only while it is the newest read and its dialog is still open.
function checkPageOrder(ctrl, focusRetry = false) {
  startHostRead(ctrl, (read, request) => read.then((installed) => {
    if (installed) setRefreshNote(ctrl, '');
  }).catch(() => {
    if (ctrl.host.refresh === request && ctrl.dialog.open) showOrderCheckFailed(ctrl, focusRetry);
  }));
}

function beginOrderCheck(ctrl) {
  setOrderStatus(ctrl, ORDER_CHECKING_MESSAGE);
  setOrderCheck(ctrl, 'checking');
  checkPageOrder(ctrl);
}

// Only reads: whatever the write did is already settled on the server, and the
// draft stays in the dialog for the user to decide.
function showUnconfirmed(ctrl) {
  const errorText = ctrl.dialog.querySelector('[data-dialog-error-text]');
  if (errorText) errorText.textContent = ctrl.unconfirmedMessage;
  const status = ctrl.dialog.querySelector('[data-dialog-status]');
  if (status) status.textContent = '';
  supersedeBookDetailLiveRefresh(ctrl.document);
  readHostQuietly(ctrl);
}

// A Chapter that is gone has no detail page left, so it returns to its Book. The
// section names the Book for an outcome only a read could confirm.
function bindChapterDelete(ctrl) {
  const { document, dialog, dialogState } = ctrl;
  const bookUrl = dialog.querySelector('[data-chapter-book-url]')?.getAttribute('data-chapter-book-url');
  if (!/^\/notes\/books\/[1-9]\d*$/.test(bookUrl || '')) return;
  bindRecordDelete({
    dialog,
    dialogState,
    form: dialog.querySelector('#chapter-delete-form'),
    label: 'Chapter',
    validDestination: (url) => url === bookUrl,
    onGone: () => (document.defaultView || globalThis).location.assign(bookUrl),
  });
}

// A lost Delete answer is settled by the recovery record this form named: an owned
// record proves the deletion committed. Without one, nothing is known from it, and
// the Page's existence is read instead.
async function readPageDeleteOutcome(document, form) {
  const deletionId = form.querySelector('[name="deletionId"]')?.value;
  if (!/^[0-9a-f]{64}$/.test(deletionId || '')) return null;
  const { state, payload } = await readPageDeletionStatus(
    document.defaultView || globalThis,
    `/notes/page-deletions/${deletionId}`,
  );
  if (state === 'unavailable') return null;
  if (state === 'restored') {
    return { refusal: 'This Page was deleted and has since been restored. Reload it before making further changes.' };
  }
  const parentUrl = payload?.parent?.url;
  if (state === 'available' && PAGE_DELETED_URL.test(`${parentUrl}?notice=page_deleted&undo=${deletionId}`)) {
    return { redirectUrl: `${parentUrl}?notice=page_deleted&undo=${deletionId}` };
  }
  if (state === 'expired' && PAGE_PARENT_URL.test(parentUrl || '')) {
    return { redirectUrl: `${parentUrl}?notice=page_unavailable` };
  }
  return { unknown: true };
}

// A Page that is gone has no detail page left, so it returns to its parent: the one
// the server names when this request deleted it, or else the last one read, whose
// notice says only that the Page has gone. Save waits while the outcome is open.
function bindPageDelete(ctrl) {
  const { document, dialog, dialogState } = ctrl;
  const form = dialog.querySelector('#note-delete-form');
  const remove = bindRecordDelete({
    dialog,
    dialogState,
    form,
    label: 'Page',
    validDestination: (url) => PAGE_DELETED_URL.test(url || ''),
    readOutcome: () => readPageDeleteOutcome(document, form),
    onGone: ({ redirectUrl }) => {
      const [kind, id] = (ctrl.move?.savedContainer() || '').split(':');
      const parentUrl = kind === 'chapter' ? `/notes/chapters/${id}` : kind === 'book' ? `/notes/books/${id}` : '/notes';
      (document.defaultView || globalThis).location.assign(redirectUrl || `${parentUrl}?notice=page_unavailable`);
    },
  });
  if (remove) dialogState.submitLocked = remove.holdsRecord;
}

// The locator and notice a Page's parent was reached with leave the URL, whatever
// the server made of them, so a reload or Back does not repeat a claim about an
// earlier moment.
function clearPageDeletionUrl(document) {
  if (!document?.querySelector?.('[data-page-deletion-recovery]')) return;
  const windowObject = document.defaultView || globalThis;
  const url = new URL(windowObject.location.href);
  const notice = url.searchParams.get('notice');
  if (notice !== 'page_deleted' && notice !== 'page_unavailable' && !url.searchParams.has('undo')) return;
  if (notice === 'page_deleted' || notice === 'page_unavailable') url.searchParams.delete('notice');
  url.searchParams.delete('undo');
  windowObject.history?.replaceState?.(windowObject.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

// The notice a Page's parent rendered on arrival. It stays in the page feedback, so
// a later save replaces it. Actions on it (Dismiss) sit in the feedback text.
export function enhancePageDeletionNotice(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  clearPageDeletionUrl(document);
  const feedback = document?.querySelector?.('[data-page-deletion-notice]');
  const text = feedback?.querySelector('[data-dialog-feedback-text]');
  if (!text || text.querySelector('[data-chapter-feedback-dismiss]')) return;
  feedback.classList.add('app-dialog-feedback--pinned');
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'button button-small button-secondary';
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('data-chapter-feedback-dismiss', '');
  dismiss.addEventListener('click', () => {
    feedback.classList.remove('app-dialog-feedback--pinned');
    feedback.hidden = true;
    text.textContent = '';
    document.querySelector('.page-heading [data-dialog-open], [data-book-detail-toolbar] [data-dialog-open]')
      ?.focus?.({ preventScroll: true });
  });
  text.append(' ', dismiss);
}

function createdChapterUrl(payload) {
  const url = payload?.chapter?.url;
  return typeof url === 'string' && /^\/notes\/chapters\/\d+$/.test(url) ? url : null;
}

function createdPageUrl(payload) {
  const url = payload?.page?.url;
  return typeof url === 'string' && /^\/notes\/\d+$/.test(url) ? url : null;
}

function newPageHostUrl(form) {
  const chapterId = form.querySelector('[name="chapterId"]')?.value;
  if (/^[1-9]\d*$/.test(chapterId || '')) return `/notes/chapters/${chapterId}`;
  const bookId = form.querySelector('[name="bookId"]')?.value;
  return /^[1-9]\d*$/.test(bookId || '') ? `/notes/books/${bookId}` : null;
}

// The editor copies its Markdown to the textarea from a listener added when it
// finishes loading, after the binder's, whose request reads the form first. A
// capture listener runs ahead of both.
function syncEditorBeforeSubmit(ctrl) {
  const { form } = ctrl.dialogState;
  form.addEventListener('submit', () => {
    const markdown = form.__creatorCrateNotesEditor?.getMarkdown?.();
    const source = form.querySelector('[data-notes-editor-source]');
    if (source && typeof markdown === 'string') source.value = markdown;
  }, true);
}

// A move leaves the dialog and its draft open and updates only the saved location
// from a read, which also ends the turn of any read begun before it. The way to the
// destination sits in the page feedback, reached once the dialog's own guard has
// settled the draft.
function bindPageMoveToHost(ctrl) {
  ctrl.move = bindPageMove({
    dialog: ctrl.dialog,
    dialogState: ctrl.dialogState,
    refresh: (options) => refreshHost(ctrl, options),
    readQuietly: () => readHostQuietly(ctrl),
    showMoved: (payload) => {
      removeStatusRetry(ctrl.host, RETRY_KEY);
      appDialogFeedback(ctrl.document, payload.message);
      decorateFeedback({
        ...ctrl,
        viewLabel: payload.destination.kind === 'chapter' ? 'View Chapter' : 'View Book',
        viewAttribute: 'data-page-move-destination',
      }, payload.destination.url);
    },
  });
}

// The binder focused the first invalid control without scrolling; a refusal no
// field holds leaves focus on Save, which lost it while disabled.
function focusAfterNewPageFailure(ctrl) {
  const invalid = ctrl.dialog.querySelector('[aria-invalid="true"]');
  if (invalid) {
    invalid.scrollIntoView?.({ block: 'nearest' });
    return;
  }
  ctrl.dialog.querySelector('[data-dialog-submit]')?.focus?.({ preventScroll: true });
}

function bindDialog(document, config) {
  const dialog = document.getElementById(config.dialogId);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  const form = dialogState?.form;
  if (!form || form.getAttribute('data-dialog-async') !== 'true' || dialogState.chapterDialogBound) return;
  const hostUrl = config.hostUrl(form);
  if (!hostUrl) return;
  dialogState.chapterDialogBound = true;

  const ctrl = {
    document,
    dialog,
    dialogState,
    hostUrl,
    host: hostFor(document),
    pendingTitle: null,
    pendingOrder: null,
    installHost: config.installHost,
    viewLabel: config.viewLabel || 'View Chapter',
    viewAttribute: config.viewAttribute || 'data-chapter-view',
    refreshFailureMessage: config.refreshFailureMessage,
    unconfirmedMessage: config.unconfirmedMessage,
  };
  if (config.role) ctrl.host[config.role] = ctrl;

  dialogState.preserveValuesOnError = true;
  // Dismissal restores this baseline, and each save replaces it, rather than
  // the title the page was rendered with.
  setAppDialogBaseline(document, config.dialogId, config.baseline(form));

  // A save in flight may already have written, so the dialog stays open until
  // its outcome is known.
  dialogState.beforeClose = () => !dialogState.submitting;

  dialogState.onUnconfirmedSubmit = () => {
    showUnconfirmed(ctrl);
    config.onFailed?.(ctrl);
  };
  dialogState.onFailedSubmit = (payload, response) => {
    if (!refusedWithoutWriting(payload, response)) showUnconfirmed(ctrl);
    else config.onRefused?.(ctrl, payload);
    config.onFailed?.(ctrl);
  };
  config.onBind?.(ctrl);
  if (config.onOpen) dialogState.onOpen = () => config.onOpen(ctrl);
  if (config.onClose) dialogState.onClose = () => config.onClose(ctrl);

  dialogState.onSuccessfulSubmit = (payload) => {
    ctrl.pendingTitle = null;
    config.onSaved?.(ctrl, payload);
    // After the binder records the saved values, shows the message and closes
    // the dialog.
    Promise.resolve().then(() => {
      removeStatusRetry(ctrl.host, RETRY_KEY);
      decorateFeedback(ctrl, config.viewUrl?.(payload));
      supersedeBookDetailLiveRefresh(ctrl.document);
      refreshHost(ctrl);
    });
    return false;
  };

  dialog.addEventListener('close', () => {
    if (dialog.open || ctrl.pendingTitle === null) return;
    adoptChapterTitle(ctrl, ctrl.pendingTitle);
  });
}

export function enhanceChapterDialogs(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  if (!document?.getElementById) return;
  bindDialog(document, {
    dialogId: 'chapter-create-dialog',
    hostUrl: (form) => form.getAttribute('action').match(/^(\/notes\/books\/[1-9]\d*)\/chapters$/)?.[1],
    baseline: () => ({ title: '' }),
    installHost: installBookDetail,
    viewUrl: createdChapterUrl,
    refreshFailureMessage: 'The Chapter was created, but Book contents could not refresh.',
    unconfirmedMessage: 'Could not confirm whether the Chapter was created. It may already exist, so check Book contents before trying again.',
  });
  bindDialog(document, {
    dialogId: 'chapter-edit-dialog',
    role: 'edit',
    hostUrl: (form) => form.getAttribute('action').match(/^\/notes\/chapters\/[1-9]\d*$/)?.[0],
    baseline: (form) => ({ title: form.querySelector('[name="title"]').defaultValue }),
    installHost: installChapterDetail,
    onBind: bindChapterDelete,
    // The save is acknowledged, so its title shows even if the refresh fails.
    onSaved: (ctrl, payload) => {
      if (typeof payload?.chapter?.title === 'string') showChapterTitle(ctrl.document, payload.chapter.title);
    },
    refreshFailureMessage: 'The Chapter was saved, but Book contents could not refresh.',
    unconfirmedMessage: 'Could not confirm whether the Chapter change was saved. Check the Chapter before trying again.',
  });
  bindDialog(document, {
    dialogId: 'chapter-order-dialog',
    role: 'order',
    hostUrl: (form) => form.getAttribute('action').match(/^(\/notes\/chapters\/[1-9]\d*)\/notes\/reorder$/)?.[1],
    baseline: (form) => ({ [ORDER_FIELD]: chapterPageOrderIds(form).join(',') }),
    installHost: installChapterDetail,
    onBind: (ctrl) => {
      ctrl.dialogState.submitLocked = () => ctrl.orderCheck !== 'verified';
      setOrderCheck(ctrl, 'unverified');
    },
    onSaved: showSavedPageOrder,
    // Pages may have changed since this page was read, here or in another tab, so
    // what the page rendered cannot be saved until a read has confirmed it.
    onOpen: beginOrderCheck,
    onClose: discardPageOrderDraft,
    onRefused: (ctrl, payload) => {
      if (payload?.code === 'ORDER_STALE') readHostQuietly(ctrl);
    },
    // No field holds the error, and Save lost focus while it was disabled.
    onFailed: (ctrl) => ctrl.dialog.querySelector('[data-dialog-submit]')?.focus?.({ preventScroll: true }),
    refreshFailureMessage: 'The Page order was saved, but this page could not refresh.',
    unconfirmedMessage: 'Could not confirm whether the Page order was saved. Your order is kept here; close this dialog to see the current order before trying again.',
  });
  // Its unsaved-changes guard replaces the close check set here, and keeps a
  // save in flight open the same way.
  bindDialog(document, {
    dialogId: 'note-create-dialog',
    hostUrl: newPageHostUrl,
    baseline: () => ({ title: '', content: '' }),
    installHost: (ctrl, parsed) => (ctrl.dialogState.form.querySelector('[name="chapterId"]')
      ? installChapterDetail(ctrl, parsed)
      : installBookDetailPages(ctrl, parsed)),
    onBind: syncEditorBeforeSubmit,
    onClose: (ctrl) => resetNoteDialogToBaseline(ctrl.dialogState.form),
    onFailed: focusAfterNewPageFailure,
    viewUrl: createdPageUrl,
    viewLabel: 'View Page',
    viewAttribute: 'data-page-view',
    refreshFailureMessage: 'The Page was created, but this page could not refresh.',
    unconfirmedMessage: 'Could not confirm whether the Page was created. It may already exist, so check the Pages listed in Book contents before trying again. Your draft is kept here.',
  });
  bindDialog(document, {
    dialogId: 'note-edit-dialog',
    hostUrl: (form) => form.getAttribute('action').match(/^\/notes\/[1-9]\d*$/)?.[0],
    baseline: readNoteDialogBaseline,
    installHost: installPageDetail,
    onBind: (ctrl) => {
      syncEditorBeforeSubmit(ctrl);
      bindPageMoveToHost(ctrl);
      bindPageDelete(ctrl);
    },
    // Acknowledged, so the dialog's saved values and the title change even if the
    // refresh fails.
    onSaved: (ctrl, payload) => {
      if (payload?.values) setNoteDialogBaseline(ctrl.dialogState.form, payload.values);
      if (typeof payload?.page?.title === 'string') showPageTitle(ctrl.document, payload.page.title);
    },
    onClose: (ctrl) => {
      resetNoteDialogToBaseline(ctrl.dialogState.form);
      ctrl.move?.reset();
    },
    onFailed: focusAfterNewPageFailure,
    refreshFailureMessage: 'The Page was saved, but this page could not refresh.',
    unconfirmedMessage: 'Could not confirm whether the Page was saved. Your draft is kept here, and this page shows the saved Page once it can be read.',
  });
}
