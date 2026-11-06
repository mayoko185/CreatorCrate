import { appDialogFeedback, enhanceAutoSubmit } from './app-dialogs.js';
import { enhanceCategoryDetails, setCategoryDetailsLifecycle } from './category-details.js';
import { enhanceCategoryReorder } from './category-reorder.js';
import {
  describeAppConfirmation,
  enhanceAppConfirmationControls,
  installAppConfirmationSubmitGate,
} from './confirm-dialog.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import {
  creatorCrateDropdownForNativeSelect,
  enhanceDropdowns,
  syncCreatorCrateDropdownFromNative,
} from './dropdowns.js';
import {
  ASSET_CATEGORY_PREFERENCE_ANSWER_EVENT,
  ASSET_CATEGORY_PREFERENCE_SETTLED_EVENT,
  enhanceAssetCategoryPreferencesFetchSave,
} from './settings-asset-category-preferences-fetch-save.js';
import { captureRegionFocus, restoreRegionFocus } from './settings-fetch-save.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// WP11C: Delete a global asset category default (Settings → Asset
// Categories) in place.
//
//  - The shared confirmation (confirm-dialog.js) names the default by its
//    saved name and slug and says what Delete actually does: only the global
//    default row goes, so projects created from then on do not get it;
//    categories already copied into projects (with their assets, files and
//    release selections) are untouched; the other defaults keep their order.
//    When the saved global asset browser default or preview category names
//    it, that setting keeps its value and reads as unavailable afterward.
//    Cancel, Escape and the backdrop send nothing; the form's own submit
//    (Enter, requestSubmit) is confirmed first (data-confirm-submit-required).
//  - A Delete that cannot run now is refused before the confirmation opens:
//    another Delete in flight, a list refresh in flight or failed, the
//    category order saving, this default's details or status saving, or a
//    Defaults setting saving.
//  - One confirmed Delete sends one POST (Accept: application/json). Nothing
//    is ever sent again by itself.
//  - While a Delete is pending or unresolved, that default's details, status
//    and Delete, and the category order, are refused before they send
//    anything, and so is the native Add form (it would leave the page and
//    lose the hold); other defaults and the other Settings controls keep
//    working.
//  - Deleted by this request: the row goes at once (focus moves to the list
//    heading), then the list and the Defaults settings are re-read (GET) and
//    installed, keeping every row and setting that holds unsaved or newer
//    local state. If that read fails, the Delete stays reported as done, the
//    list is marked possibly out of date, Delete stays unavailable and Retry
//    refresh reads only.
//  - Refused or failed with nothing deleted: everything stays as it was.
//  - A lost or unreadable answer leaves the Delete unresolved: the request may
//    still be on its way and run later, so no read showing the default present
//    ends that. Check again reads only (GET). A read finding it gone settles
//    that it is gone, never that this request deleted it (default ids are
//    AUTOINCREMENT and never reused, so a late request can only find it gone).
//  - WP11C-F2: a Defaults setting answer rendered before a Delete this page
//    saw settle (its render still lists that default, and ids are never
//    reused) is not installed: it would offer the deleted default again and
//    say the setting is saved and usable. What the save proves is kept (the
//    stored value), the deleted default is no longer offered, and when the
//    saved choice was that default the status says so and the list is
//    re-read (GET) for the server's own unavailable-setting display. The
//    settings stop offering a default as soon as this page sees it gone
//    (also when the refresh fails or keeps a setting that is still saving).
//    Nothing is saved to repair a setting.
//  - WP11C-F6: the same holds for a default deleted elsewhere (another tab,
//    another person) that this page holds no Delete record for. An installed
//    (current) list read that no longer lists a default this page's list
//    showed is the observation that it is gone; a failed or superseded read
//    observes nothing. The Defaults settings then stop offering it, an older
//    answer still listing it is not installed, and a kept setting whose
//    "Settings saved." names it says it is unavailable. It is never reported
//    as deleted by this page, no Delete is held or released by it, and a
//    current default that has the same slug (a new id) stays choosable.
//  - WP11C-F9: choosable means ENABLED. The server offers only enabled
//    defaults in both settings and refuses a disabled one; each row says how
//    its render showed it (data-category-enabled). A gone default's slug that
//    a current but DISABLED default has again stays unavailable: that default
//    stays listed and managed under its own id, but neither the settings nor
//    an older answer offer or name its slug as a choice. Enabled by a later
//    installed read, it is choosable again; nothing is saved either way.
//  - WP11C-F9A: an id that is still current does not make an answer current.
//    A Defaults setting answer is a render of the whole list as it was when
//    its save ran. When a list read has been installed since that setting
//    was last changed (it may have been rendered after the save, whenever it
//    was sent), and the answer's ENABLED defaults (id, saved slug and name)
//    differ from those the installed list shows, the answer may be older
//    than what this page already knows about which defaults can be chosen,
//    so it is not installed. What the save proves is kept (the stored
//    value; a refusal stays a refusal), every known slug that no enabled
//    default shown has is withdrawn, a saved choice that is now unavailable
//    says so instead of "Settings saved.", and the list is re-read (GET) for
//    the server's own display. The same withdrawal applies whenever a setting
//    is kept through an install. Nothing is saved, and an answer with no newer
//    installed read (a current save or a current 422) installs as before.
//  - WP11C-F9B: a list read never rolls back a Defaults setting save it may
//    predate. A read sent while a setting's save is in flight may be rendered
//    before that save runs and arrive after its acknowledgement; that setting
//    then keeps the region its acknowledgement (or refusal) left: the
//    selected value, the stored value and the save's own baseline. Each
//    setting decides for itself; a read sent after the save settled installs
//    it as rendered (another tab's later save included). Nothing is saved,
//    and choosing the read's older value afterwards is a new change.
//  - Without fetch the form stays native (POST, then the server's redirect).
const SECTION_SELECTOR = '[data-settings-category-defaults]';
const ROW_SELECTOR = 'article[data-category-id]';
const DELETE_FORM_SELECTOR = 'form[data-settings-category-delete-form]';
const DETAILS_FORM_SELECTOR = 'form[data-category-details-form]';
const ENABLED_FORM_SELECTOR = 'form.category-enabled-form';
const REORDER_FORM_SELECTOR = 'form[data-category-reorder-form]';
const REORDER_ITEM_SELECTOR = '[data-category-reorder-item]';
const REORDER_HANDLE_SELECTOR = '[data-category-reorder-handle]';
const PREFERENCE_SELECTOR = '[data-settings-asset-category-preference]';
const PREFERENCE_STORED_ATTRIBUTE = 'data-settings-asset-category-preference-stored';
// WP11C-F6: marks a selected option this page made unchoosable.
const WITHDRAWN_ATTRIBUTE = 'data-settings-category-withdrawn';
// WP11C-F9: each row's enabled state as the server rendered it.
const ENABLED_ATTRIBUTE = 'data-category-enabled';
// WP11C-F9A: the settings' own non-category values (All Categories, Disabled).
const SENTINEL_VALUES = new Set(['', 'all', '__disabled__']);
const CARD_BODY_SELECTOR = '.category-management-card-body';
const HEADING_ID = 'settings-category-defaults-heading';
const HOLD_ATTRIBUTE = 'data-settings-category-delete-hold';
const ROW_STATUS_ATTRIBUTE = 'data-settings-category-delete-row-status';
const CHECK_ATTRIBUTE = 'data-settings-category-delete-check';
const REFRESH_RETRY_ATTRIBUTE = 'data-settings-category-delete-refresh-retry';
const STATE_KEY = '__creatorCrateSettingsCategoryDelete';
const GUARD_BOUND_KEY = 'settingsCategoryDeleteBound';
const LIST_URL = '/settings/asset-categories';
const REORDER_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End']);

export const SETTINGS_CATEGORY_DELETE_MESSAGES = Object.freeze({
  pending: 'This category default is being deleted. Wait for the result.',
  otherPending: 'Another category default is being deleted. Wait for the result, then try again.',
  refreshing: 'The category defaults are being updated. Wait for that to finish, then try again.',
  stale: 'The category defaults shown may be out of date. Use Retry refresh, then try again.',
  reorderBusy: 'Wait for the category order to save, then try again.',
  detailsBusy: 'Wait for this category’s details to save, then try again.',
  statusBusy: 'Wait for this category’s status to save, then try again.',
  preferenceBusy: 'Wait for the Defaults setting to save, then try again.',
  preferenceSavedUnavailable: 'Saved, but that category default no longer exists, so this setting is unavailable until another category is chosen.',
  preferenceSavedDisabled: 'Saved, but that category default is disabled, so this setting is unavailable until it is enabled or another category is chosen.',
  // WP11C-F11: a save whose answer was lost or unreadable may or may not
  // have run; its choice is no longer available here.
  preferenceUnconfirmedUnavailable: 'Could not confirm whether this setting was saved. That category default no longer exists, so choose another category.',
  preferenceUnconfirmedDisabled: 'Could not confirm whether this setting was saved. That category default is disabled, so choose another category or enable it first.',
  // settings-fetch-save's own wording for a save that did not settle as saved.
  preferenceNotSaved: 'Could not save settings. Your current changes were kept.',
  wrongTarget: 'This Delete control does not match its category default. Reload the page and try again.',
  unresolved: 'The earlier Delete request for this category default has not been confirmed, so it cannot be deleted again from this page.',
  gone: 'This category default no longer exists.',
  changeHeld: 'This category default cannot be changed while its Delete request is unconfirmed. Nothing was sent.',
  changePending: 'This category default cannot be changed while it is being deleted. Nothing was sent.',
  orderHeld: 'The category order cannot be changed while a Delete request is unconfirmed or the list is updating. Nothing was sent.',
  addPending: 'Wait for the Delete to finish, then add the category.',
  addHeld: 'The category was not added and nothing was sent: an earlier category default Delete has not been confirmed, and adding would leave this page. Use Check again first.',
  deletedFallback: 'Asset category default deleted.',
  updating: 'Updating the category defaults…',
  upToDate: 'The category defaults are up to date.',
  refreshFailed: 'The category defaults shown could not be refreshed and may be out of date. Delete stays unavailable until they are; nothing will be deleted again. Retry refresh only reads them.',
  nothingDeleted: 'Nothing was deleted.',
  refusedFallback: 'The category default could not be deleted.',
  draftsKept: 'Your unsaved changes are kept.',
  goneUnconfirmed: 'This category default no longer exists, so it was not deleted by this page.',
  unconfirmed: 'Could not confirm whether the category default was deleted.',
  checking: 'Checking…',
  stillPresent: 'It still exists, but the earlier Delete request may still run. Nothing will be sent again by itself. Its details, status and the category order stay unavailable here; Check again only reads the list.',
  checkFailed: 'The category defaults could not be checked. Nothing will be sent again by itself. Check again only reads the list.',
  observedMissing: 'no longer exists, but this page could not confirm whether its Delete request deleted it.',
  rowHeld: 'Delete not confirmed. This default cannot be changed from this page.',
  rowPending: 'Deleting…',
});

const M = SETTINGS_CATEGORY_DELETE_MESSAGES;

function quoted(text) {
  return `“${text}”`;
}

function documentState(document) {
  document[STATE_KEY] ||= {
    // id → { phase: 'pending' | 'unresolved' | 'deleted' | 'missing', label, slug, attempt }
    records: new Map(),
    pendingId: null,
    attempt: 0,
    // Display synchronization, separate from any Delete's outcome.
    sync: 'idle', // 'idle' | 'refreshing' | 'stale'
    getSeq: 0,
    refreshSeq: 0,
    installedSeq: 0,
    checkSeq: 0,
    // A clock of local category/preference changes, so a GET that started
    // earlier cannot overwrite what changed here after it started.
    clock: 0,
    touched: new Map(),
    // Above zero only while a read is being installed (WP11C-F1).
    installing: 0,
    // WP11C-F5: each name/slug field's value when the person focused it, and
    // the one focused field whose edit an install ended for the browser.
    focusValues: new WeakMap(),
    lastFocus: null,
    owedChange: null,
    // WP11C-F6: every default id this page's list has shown (id → { slug,
    // name, slugs }, as saved), and those a later installed read showed gone.
    // That is an observation of the current list, never a Delete of this
    // page. WP11C-F8: `slugs` holds every saved slug a render showed for it.
    seen: null,
    observedGone: new Map(),
    // WP11C-F9A: each Defaults setting's installed read (installedSeq) when
    // it was last changed here; a read installed since then may be newer
    // than that setting's save answer.
    preferenceMarks: new Map(),
    // WP11C-F10: every details form's reviewed field that was already in the
    // page when a read this page installed was sent (older than that read).
    readBasis: new WeakSet(),
    // WP11C-F11: Defaults setting forms whose last save settled with no
    // readable answer (lost or unreadable): it may or may not have run.
    unconfirmed: new WeakSet(),
    primary: null, // { message, error }
    ui: { checkButton: null, refreshButton: null },
  };
  return document[STATE_KEY];
}

/** This page's Delete state for a category default id, or null. For tests and hosts. */
export function settingsCategoryDeleteState(document, categoryId) {
  return document?.[STATE_KEY]?.records.get(String(categoryId)) || null;
}

/** This page's display synchronization state: 'idle' | 'refreshing' | 'stale'. */
export function settingsCategoryDeleteSync(document) {
  return document?.[STATE_KEY]?.sync || 'idle';
}

function canSubmitInPlace(windowObject) {
  return typeof windowObject?.fetch === 'function'
    && typeof windowObject.FormData === 'function'
    && typeof windowObject.URLSearchParams === 'function';
}

function canRead(windowObject) {
  return typeof windowObject?.fetch === 'function' && typeof windowObject.DOMParser === 'function';
}

function formCategoryId(form) {
  const id = form?.getAttribute?.('data-category-delete-id') || '';
  return /^[1-9]\d*$/.test(id) ? id : null;
}

function sectionOf(scope) {
  return scope?.querySelector?.(SECTION_SELECTOR) || null;
}

function rowsOf(section) {
  return Array.from(section?.querySelectorAll?.(ROW_SELECTOR) || []);
}

function rowId(row) {
  return row?.getAttribute?.('data-category-id') || '';
}

function rowFor(scope, id) {
  return rowsOf(sectionOf(scope)).find((row) => rowId(row) === String(id)) || null;
}

function isBusy(element) {
  return element?.getAttribute?.('aria-busy') === 'true';
}

function textFields(form) {
  return Array.from(form?.querySelectorAll?.('input[name="displayName"], input[name="directorySlug"]') || []);
}

function isTextField(node) {
  return Boolean(node?.matches?.('input[name="displayName"], input[name="directorySlug"]')
    && node.closest?.(DETAILS_FORM_SELECTOR));
}

function detailsDirty(form) {
  return textFields(form).some((field) => field.value !== field.defaultValue);
}

function enabledDirty(form) {
  const control = form?.querySelector?.('input[type="checkbox"]');
  return Boolean(control) && control.checked !== control.defaultChecked;
}

// The saved name and slug: the details form is replaced by the server's own
// render after each acknowledged save, so its default values are the saved
// ones unless that render showed a refusal.
//
// WP11C-F8: every render of the details form (the page, a read, a save's
// answer, a refusal or a stale 409) carries the saved details it is based on
// as hidden reviewed fields, always from the database row and never from the
// draft. They are this default's confirmed name and slug, also after a
// refusal; a save still in flight has not changed them yet.
function savedIdentity(row) {
  const details = row?.querySelector?.(DETAILS_FORM_SELECTOR);
  const errored = details?.getAttribute?.('data-category-details-state') === 'error';
  const field = (name) => details?.querySelector?.(`input[name="${name}"]`);
  const reviewed = (name) => details?.querySelector?.(`input[data-category-details-reviewed="${name}"]`)?.value;
  const name = reviewed('displayName') || (!errored && field('displayName')?.defaultValue)
    || row?.getAttribute?.('data-category-label') || '';
  const slug = reviewed('directorySlug') || (!errored && field('directorySlug')?.defaultValue)
    || row?.getAttribute?.('data-category-slug') || '';
  return { name: String(name).trim(), slug: String(slug).trim() };
}

// WP11C-F9: whether the server render that listed this row showed the
// default enabled (from the database row). The row's article always comes
// from the page or the latest installed read: a kept row moves only its body
// into the read's article, so this is never a switch's unsaved or unread
// state. Existing is not being choosable: only an enabled default can be a
// Defaults setting's choice.
function rowEnabled(row) {
  return row?.getAttribute?.(ENABLED_ATTRIBUTE) === 'true';
}

function reviewedInputs(scope) {
  return Array.from(scope?.querySelectorAll?.(`${DETAILS_FORM_SELECTOR} input[data-category-details-reviewed]`) || []);
}

// WP11C-F10: the saved name and slug the default has NOW, as far as this page
// knows: which Defaults choices it can be. The row's article is the page's or
// the latest installed read's render; a kept row keeps only its own body, and
// that body's reviewed fields stay the basis of its draft (the stale-write
// witness, WP11C-F7), which a change made elsewhere since leaves older. So the
// body is newer evidence only when its reviewed fields were rendered after the
// installed read was sent: a details answer (saved, refused or stale) this
// page installed since then. Fields the page held when that read was sent
// (`readBasis`) are older than or as old as the read, and the article wins.
function currentIdentity(row, readBasis) {
  const reviewed = reviewedInputs(row);
  const slug = row?.getAttribute?.('data-category-slug');
  if (reviewed.length === 0 || !slug || reviewed.some((input) => !readBasis?.has(input))) return savedIdentity(row);
  return { name: String(row.getAttribute('data-category-label') || '').trim(), slug: String(slug).trim() };
}

function storedPreference(document, identity) {
  const region = Array.from(document.querySelectorAll(PREFERENCE_SELECTOR))
    .find((candidate) => candidate.getAttribute('data-settings-asset-category-preference') === identity);
  return region?.getAttribute?.(PREFERENCE_STORED_ATTRIBUTE) ?? null;
}

/** The confirmation's fields for a default, from what the page shows as saved. */
export function settingsCategoryDeleteConfirmation({ name, slug, browserDefault = false, previewCategory = false, drafts = false }) {
  const named = name ? `the asset category default ${quoted(name)}` : 'this asset category default';
  const slugText = slug ? ` (directory slug ${quoted(slug)})` : '';
  const parts = [
    `Delete ${named}${slugText}?`,
    'It is removed from the global defaults, so projects created from now on will not get this category.',
    'Categories already copied into existing projects, with their assets, files and release selections, are not changed, and the other defaults keep their order.',
    'This deletes the default as it is when the deletion runs, including changes made to it elsewhere since this page loaded.',
  ];
  if (browserDefault) {
    parts.push('It is the saved global asset browser default: that setting keeps its value but becomes unavailable, so projects that inherit it open Assets at All Categories until another default is chosen.');
  }
  if (previewCategory) {
    parts.push('It is the saved preview category: that setting keeps its value but becomes unavailable, so scans stop choosing preview images automatically until another preview category is chosen. Preview images already chosen are kept.');
  }
  parts.push('This cannot be undone.');
  if (drafts) {
    parts.push('Your unsaved changes to its name or slug will not be saved: they are kept if you cancel or it is not deleted.');
  }
  return {
    title: 'Delete category default?',
    message: parts.join(' '),
    confirmLabel: 'Delete default',
    cancelLabel: drafts ? 'Keep editing' : 'Cancel',
  };
}

/**
 * What a Delete answer proves for the default `categoryId`:
 * 'deleted' (this request deleted it), 'missing' (it was already gone; this
 * request deleted nothing), 'refused' / 'failed' (nothing was deleted), or
 * 'uncertain' (it may have been deleted).
 */
export function classifySettingsCategoryDeleteResponse(response, payload, categoryId) {
  const id = String(categoryId);
  if (response?.ok && response.status === 200 && payload?.status === 'success' && payload.outcome === 'deleted'
    && String(payload.categoryId ?? '') === id && String(payload.category?.id ?? '') === id
    && payload.category?.deleted === true) return 'deleted';
  if (payload?.status === 'error' && response && !response.ok) {
    if (response.status === 404 && payload.code === 'ASSET_CATEGORY_DEFAULT_NOT_FOUND' && payload.outcome === 'refused') return 'missing';
    if (response.status === 500 && payload.code === 'ASSET_CATEGORY_DEFAULT_DELETE_FAILED' && payload.outcome === 'failed') return 'failed';
    // Refused before the route ran (authentication, CSRF, maintenance); none
    // names an outcome other than a refusal.
    if (((response.status >= 400 && response.status < 500) || response.status === 503)
      && response.status !== 404
      && (payload.outcome === undefined || payload.outcome === 'refused')) return 'refused';
  }
  // A lost answer, an unreadable body, an unknown 500: it may have deleted.
  return 'uncertain';
}

function heldPhase(state) {
  for (const record of state.records.values()) {
    if (record.phase === 'pending' || record.phase === 'unresolved') return true;
  }
  return false;
}

function orderHeld(state) {
  return heldPhase(state) || state.sync === 'refreshing';
}

function controller(document) {
  const state = documentState(document);
  const windowObject = document.defaultView || globalThis;
  const { records, ui } = state;

  // ------------------------------------------------------------- feedback --

  function feedbackElement() {
    return document.querySelector('[data-dialog-feedback]');
  }

  function unresolvedRecords() {
    return [...records.entries()].filter(([, record]) => record.phase === 'unresolved');
  }

  function unresolvedWarning(record) {
    return `${quoted(record.label || 'Category default')}: ${record.message || M.unconfirmed}`;
  }

  // The feedback says the latest result, then every Delete still unresolved
  // (each stays accessible until a read settles it), with Check again while
  // any is unresolved and Retry refresh while the list may be out of date.
  function render({ focus = null } = {}) {
    const primary = state.primary;
    const parts = primary?.message ? [primary.message] : [];
    let error = Boolean(primary?.error);
    unresolvedRecords().forEach(([, record]) => {
      const warning = unresolvedWarning(record);
      if (!parts.some((part) => part.includes(warning))) parts.push(warning);
      error = true;
    });
    if (state.sync === 'stale') error = true;
    if (parts.length === 0) return;
    appDialogFeedback(document, parts.join(' '), error);
    const feedback = feedbackElement();
    if (!feedback) return;
    let focusTarget = null;
    if (unresolvedRecords().length > 0) {
      const button = showStatusRetry({
        state: ui,
        status: feedback,
        attribute: CHECK_ATTRIBUTE,
        key: 'checkButton',
        label: 'Check again',
        onRetry: ({ wasFocused }) => check({ focusResult: wasFocused }),
      });
      if (focus === 'check') focusTarget = button;
    } else {
      removeStatusRetry(ui, 'checkButton');
    }
    if (state.sync === 'stale') {
      const button = showStatusRetry({
        state: ui,
        status: feedback,
        attribute: REFRESH_RETRY_ATTRIBUTE,
        key: 'refreshButton',
        label: 'Retry refresh',
        onRetry: ({ wasFocused }) => refresh({ focusResult: wasFocused }),
      });
      if (focus === 'refresh') focusTarget = button;
    } else {
      removeStatusRetry(ui, 'refreshButton');
    }
    if (focus && !focusTarget) focusTarget = feedback.querySelector('button') || null;
    focusTarget?.focus?.({ preventScroll: true });
  }

  function report(message, error, options) {
    state.primary = { message, error };
    render(options);
  }

  // A refusal adds to what the feedback already says; nothing it said goes.
  function refuse(message) {
    const previous = state.primary;
    const standing = previous?.message || '';
    state.primary = {
      message: standing && !standing.includes(message) ? `${standing} ${message}` : message,
      error: true,
    };
    render();
    state.primary = previous;
  }

  // ---------------------------------------------------------------- holds --

  // Every row's standing Delete state, applied again after each install.
  function applyHolds() {
    rowsOf(sectionOf(document)).forEach((row) => {
      const record = records.get(rowId(row));
      const held = record && (record.phase === 'pending' || record.phase === 'unresolved') ? record.phase : null;
      const button = row.querySelector(`${DELETE_FORM_SELECTOR} button`);
      let status = row.querySelector(`[${ROW_STATUS_ATTRIBUTE}]`);
      if (held) {
        row.setAttribute(HOLD_ATTRIBUTE, held);
        row.setAttribute('aria-busy', held === 'pending' ? 'true' : 'false');
        button?.setAttribute('aria-disabled', 'true');
        if (!status) {
          status = document.createElement('p');
          status.className = 'help-text settings-category-delete-row-status';
          status.setAttribute(ROW_STATUS_ATTRIBUTE, '');
          status.id = `settings-category-delete-status-${rowId(row)}`;
          row.querySelector('.category-management-actions')?.appendChild(status);
        }
        status.textContent = held === 'pending' ? M.rowPending : M.rowHeld;
        button?.setAttribute('aria-describedby', status.id);
      } else {
        row.removeAttribute(HOLD_ATTRIBUTE);
        row.removeAttribute('aria-busy');
        button?.removeAttribute('aria-disabled');
        if (status) {
          if (button?.getAttribute('aria-describedby') === status.id) button.removeAttribute('aria-describedby');
          status.remove();
        }
      }
    });
  }

  function updatePositions() {
    const rows = rowsOf(sectionOf(document)).filter((row) => row.matches(REORDER_ITEM_SELECTOR));
    rows.forEach((row, index) => {
      row.setAttribute('aria-posinset', String(index + 1));
      row.setAttribute('aria-setsize', String(rows.length));
    });
  }

  // The row of a default that is gone goes from the page. Focus moves to the
  // list heading first, so it never drops to the page or lands on the next
  // row's Delete (a repeated Enter there would start another Delete).
  function removeRow(id) {
    const row = rowFor(document, id);
    if (row) {
      const active = document.activeElement;
      const confirmationOpen = document.getElementById('app-confirmation-dialog')?.open;
      if (row.contains(active) || !active || active === document.body || confirmationOpen) {
        document.getElementById(HEADING_ID)?.focus?.({ preventScroll: true });
      }
      row.remove();
      updatePositions();
    }
    // WP11C-F2: the Defaults settings stop offering it at once, whether or
    // not the list can be re-read.
    document.querySelectorAll(PREFERENCE_SELECTOR).forEach(withdrawGoneOptions);
  }

  // ------------------------------------------------------------- refusals --

  function refusal(form) {
    const id = formCategoryId(form);
    if (!id || form.getAttribute('action') !== `${LIST_URL}/${id}/delete`) return M.wrongTarget;
    const record = records.get(id);
    if (record?.phase === 'pending') return M.pending;
    if (record?.phase === 'unresolved') return M.unresolved;
    if (record) return M.gone;
    if (state.pendingId) return M.otherPending;
    if (state.sync === 'refreshing') return M.refreshing;
    if (state.sync === 'stale') return M.stale;
    if (isBusy(document.querySelector(REORDER_FORM_SELECTOR))) return M.reorderBusy;
    const row = form.closest(ROW_SELECTOR);
    if (isBusy(row?.querySelector(DETAILS_FORM_SELECTOR))) return M.detailsBusy;
    if (isBusy(row?.querySelector(ENABLED_FORM_SELECTOR))) return M.statusBusy;
    if (Array.from(document.querySelectorAll(`${PREFERENCE_SELECTOR} form`)).some(isBusy)) return M.preferenceBusy;
    return null;
  }

  function confirmationFor(form) {
    const row = form.closest(ROW_SELECTOR);
    const { name, slug } = savedIdentity(row);
    return settingsCategoryDeleteConfirmation({
      name,
      slug,
      browserDefault: Boolean(slug) && storedPreference(document, 'browser-default') === slug,
      previewCategory: Boolean(slug) && storedPreference(document, 'preview-category') === slug,
      drafts: detailsDirty(row?.querySelector(DETAILS_FORM_SELECTOR)),
    });
  }

  // ---------------------------------------------------------------- reads --

  function readList(seq) {
    return Promise.resolve()
      .then(() => windowObject.fetch(LIST_URL, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'follow',
        headers: { Accept: 'text/html' },
      }))
      .then((response) => Promise.resolve()
        .then(() => (response?.ok && typeof response.text === 'function' ? response.text() : null))
        .catch(() => null)
        .then((html) => {
          if (!response?.ok || response.redirected && new URL(response.url, document.baseURI).pathname !== LIST_URL
            || typeof html !== 'string') return null;
          const parsed = new windowObject.DOMParser().parseFromString(html, 'text/html');
          return sectionOf(parsed) ? { parsed, seq } : null;
        }))
      .catch(() => null);
  }

  function touchedSince(key, clock) {
    return (state.touched.get(key) || 0) > clock;
  }

  function keepLocalRow(row, startClock) {
    const id = rowId(row);
    const record = records.get(id);
    if (record && (record.phase === 'pending' || record.phase === 'unresolved')) return true;
    if (touchedSince(`row:${id}`, startClock)) return true;
    const details = row.querySelector(DETAILS_FORM_SELECTOR);
    const enabled = row.querySelector(ENABLED_FORM_SELECTOR);
    return isBusy(details) || isBusy(enabled) || detailsDirty(details) || enabledDirty(enabled)
      || details?.getAttribute('data-category-details-state') === 'error'
      || enabled?.getAttribute('data-category-enabled-state') === 'error'
      || Boolean(row.querySelector('[role="alert"]'));
  }

  // What a list read knows when it is sent: the change clock, (WP11C-F9B)
  // each Defaults setting that has a save in flight then, and (WP11C-F10) the
  // reviewed details fields the page shows then.
  function readStart() {
    const saving = new Set(Array.from(document.querySelectorAll(PREFERENCE_SELECTOR))
      .filter((region) => isBusy(region.querySelector('form')))
      .map((region) => region.getAttribute('data-settings-asset-category-preference')));
    return { clock: state.clock, saving, basis: reviewedInputs(sectionOf(document)) };
  }

  function currentOf(row) {
    return currentIdentity(row, state.readBasis);
  }

  // WP11C-A: the read a details answer started (see setCategoryDetailsLifecycle
  // below) shows that answer's saved details for its row, enabled as before:
  // the answer's form is already current, so it stays with its status.
  function confirmsAnswer(answer, localRow, nextRow) {
    if (!answer || answer.id !== rowId(nextRow) || !localRow.contains(answer.form)) return false;
    const shown = savedIdentity(nextRow);
    return shown.slug === answer.identity.slug && shown.name === answer.identity.name
      && rowEnabled(nextRow) === rowEnabled(localRow);
  }

  // WP11C-F9B: a setting that was saving when the read was sent keeps its
  // region through that read's install. The read may have been rendered before
  // that save ran, so the stored value it shows may be older than the save's
  // acknowledgement this page has installed since (the region then looks
  // clean: neither busy nor touched after the read was sent). The kept region
  // is what the acknowledgement (or refusal, or failure) left; nothing is
  // saved by keeping it. Its options still follow the installed list
  // (withdrawGoneOptions), and a read sent after the save settled installs it
  // as rendered, so an older read only ever loses to a newer acknowledgement.
  function keepLocalPreference(region, identity, start) {
    const form = region.querySelector('form');
    return isBusy(form) || form?.getAttribute('data-settings-fetch-save-state') === 'error'
      || Boolean(region.querySelector('details[open]'))
      || Boolean(region.querySelector('[role="alert"]'))
      || touchedSince(`pref:${identity}`, start.clock)
      || start.saving.has(identity);
  }

  // WP11C-F2: the defaults this page saw deleted or found gone.
  function goneRecords() {
    return [...records.entries()].filter(([, record]) => record.phase === 'deleted' || record.phase === 'missing');
  }

  // WP11C-F6: with those an installed read showed gone (deleted elsewhere,
  // say in another tab), as id → { slug, name, slugs }.
  //
  // WP11C-F8: `slugs` is every saved slug this page has seen the id have.
  // Ids are the identity; a slug is not: a confirmed details save renames a
  // default, and an answer rendered before that save (or before the Delete)
  // still offers whichever slug it had then.
  function goneDefaults() {
    const gone = new Map(state.observedGone);
    goneRecords().forEach(([id, record]) => {
      const known = state.observedGone.get(id) || state.seen?.get(id);
      gone.set(id, { slug: record.slug, name: record.label, slugs: new Set([...(known?.slugs || []), record.slug]) });
    });
    return gone;
  }

  function shownDefaults(section) {
    return new Map(rowsOf(section).map((row) => [rowId(row), savedIdentity(row)]));
  }

  // WP11C-F8: records a saved identity a server render showed for `id`.
  // `latest` (a list this page shows or installs) also makes it the id's
  // current name and slug; an answer's render, which may be older, only adds
  // its slug. An id already seen gone stays gone (ids are never reused).
  function learnIdentity(id, { slug, name }, latest) {
    if (!id || !slug) return;
    state.seen ||= new Map();
    const gone = state.observedGone.get(id);
    const entry = gone || state.seen.get(id) || { slug, name, slugs: new Set() };
    entry.slugs ||= new Set([entry.slug].filter(Boolean));
    entry.slugs.add(slug);
    if (latest && !gone) Object.assign(entry, { slug, name });
    if (!gone) state.seen.set(id, entry);
  }

  function learnShown(section, latest) {
    shownDefaults(section).forEach((identity, id) => learnIdentity(id, identity, latest));
  }

  // WP11C-F6: an installed read is the current list. A default this page's
  // list showed before that the read no longer lists is gone for good (ids
  // are AUTOINCREMENT and never reused). Reads that fail or are superseded
  // are never installed, so they observe nothing.
  //
  // WP11C-F8: this page's own rows are learned first: a details save
  // acknowledged since the last read has re-rendered its row's details form
  // with the renamed slug as saved, so a default renamed here and deleted
  // elsewhere is withdrawn under the slug it has now.
  function observeInstalled(section) {
    state.seen ||= new Map();
    learnShown(sectionOf(document), true);
    const current = shownDefaults(section);
    state.seen.forEach((entry, id) => {
      if (current.has(id)) return;
      state.observedGone.set(id, entry);
      state.seen.delete(id);
    });
    current.forEach((identity, id) => learnIdentity(id, identity, true));
  }

  // WP11C-F9: the saved identities of the defaults the list shown has
  // ENABLED. Only those can be chosen (the server offers only enabled
  // defaults in both settings and refuses a disabled one), so a disabled
  // default that has a slug again is present, never choosable.
  //
  // WP11C-F10: each with the identity it has now (currentIdentity), never a
  // kept draft's older review basis: a slug it had is only known (F8), so it
  // can still be recognized in an older answer, and is not choosable.
  function eligibleDefaults() {
    return rowsOf(sectionOf(document)).filter(rowEnabled).map(currentOf);
  }

  // Their slugs, unless the list shown has an enabled default with that slug
  // again (WP11C-F9: a disabled one keeps it unavailable).
  function goneSlugs() {
    const present = new Set(eligibleDefaults().map(({ slug }) => slug));
    const slugs = [...goneDefaults().values()].flatMap(({ slug, slugs: known }) => [slug, ...(known || [])]);
    return new Set(slugs.filter((slug) => slug && !present.has(slug)));
  }

  // WP11C-F9A: every saved slug this page knows a default has or had (gone
  // defaults, the defaults shown and what any render showed them with) that
  // no ENABLED default shown has now. None of them can be chosen: the server
  // refuses each. Being a current id's slug does not make one choosable.
  function unavailableSlugs() {
    const present = new Set(eligibleDefaults().map(({ slug }) => slug));
    const known = new Set(goneSlugs());
    rowsOf(sectionOf(document)).forEach((row) => {
      known.add(savedIdentity(row).slug);
      known.add(currentOf(row).slug);
      (state.seen?.get(rowId(row))?.slugs || []).forEach((slug) => known.add(slug));
    });
    return new Set([...known].filter((slug) => slug && !present.has(slug) && !SENTINEL_VALUES.has(slug)));
  }

  // What a saved but now unavailable choice says: a gone default's slug keeps
  // the WP11C-F2/F6 wording; a disabled default's slug says it is disabled.
  function savedUnavailableMessage(slug) {
    if (goneSlugs().has(slug)) return M.preferenceSavedUnavailable;
    const disabled = rowsOf(sectionOf(document)).some((row) => !rowEnabled(row) && currentOf(row).slug === slug);
    return disabled ? M.preferenceSavedDisabled : M.preferenceSavedUnavailable;
  }

  // WP11C-F9A: the ENABLED defaults a render lists, by id with the saved slug
  // and name it shows, as one comparable key.
  function eligibilityKey(section) {
    return rowsOf(section).filter(rowEnabled).map((row) => {
      const { slug, name } = currentOf(row);
      return `${rowId(row)}\u0001${slug}\u0001${name}`;
    }).sort().join('\u0002');
  }

  // WP11C-F9A: an answer that may be older than the installed list for what
  // can be chosen. A read has been installed since the setting was last
  // changed here (so it arrived while the save was on its way and may have
  // been rendered after it, whenever it was sent), and the answer's enabled
  // defaults differ from the list shown. Which render is newer cannot be told
  // from ids, so the answer does not replace the installed list, and a GET
  // sent after both re-reads the server's own display.
  function answerEligibilityObsolete(region, parsed) {
    const identity = region.getAttribute('data-settings-asset-category-preference');
    const mark = state.preferenceMarks.get(identity);
    if (mark === undefined || state.installedSeq <= mark) return false;
    const answered = sectionOf(parsed);
    return Boolean(answered) && eligibilityKey(answered) !== eligibilityKey(sectionOf(document));
  }

  // A render that still lists a default this page saw gone was made before
  // that Delete (default ids are never reused).
  function renderedBeforeGone(parsed) {
    const gone = goneDefaults();
    return gone.size > 0 && rowsOf(sectionOf(parsed)).some((row) => gone.has(rowId(row)));
  }

  function dropdownInput(select, value) {
    return Array.from(creatorCrateDropdownForNativeSelect(select)?.querySelectorAll('input[type="radio"]') || [])
      .find((input) => input.value === value) || null;
  }

  // A kept or stale setting stops offering the deleted defaults. Its selected
  // value stays: while it is saving it is that save's value (the save reads
  // the form), and otherwise it is shown but can no longer be chosen. Nothing
  // here raises change, so nothing is saved.
  //
  // WP11C-F6: a slug a gone default had that a current default (a new id)
  // has again is that current default's: an option this page withdrew for it
  // can be chosen again, and an option still named after the gone default is
  // named after the current one. WP11C-F9: only while that current default
  // is enabled; a disabled one stays listed but is not offered or named here.
  // WP11C-F9A: the same for any known slug no enabled default shown has (a
  // current default disabled since the setting's render, say).
  function withdrawGoneOptions(region) {
    const gone = unavailableSlugs();
    const current = new Map(eligibleDefaults().map(({ slug, name }) => [slug, name]));
    const reused = new Map();
    goneDefaults().forEach(({ slug, name }) => {
      if (slug && name && current.has(slug) && current.get(slug) !== name) reused.set(slug, { from: name, to: current.get(slug) });
    });
    const owners = new Map(rowsOf(sectionOf(document)).filter(rowEnabled).map((row) => [currentOf(row).slug, rowId(row)]));
    const movedSlugs = new Set();
    state.seen?.forEach((entry, id) => entry.slugs?.forEach((slug) => {
      if (owners.has(slug) && owners.get(slug) !== id) movedSlugs.add(slug);
    }));
    const saving = isBusy(region.querySelector('form'));
    region.querySelectorAll('select').forEach((select) => {
      let changed = false;
      Array.from(select.options).forEach((option) => {
        if (option.hasAttribute(WITHDRAWN_ATTRIBUTE) && !gone.has(option.value)) {
          option.disabled = false;
          option.removeAttribute(WITHDRAWN_ATTRIBUTE);
          dropdownInput(select, option.value)?.removeAttribute('data-cc-dropdown-option-disabled');
          changed = true;
        }
        // WP11C-F10: a slug another default still listed had (renamed since)
        // is named after the enabled default that has it now.
        const label = reused.get(option.value) || (movedSlugs.has(option.value)
          ? { from: option.textContent.trim(), to: current.get(option.value) } : null);
        if (label && label.to && option.textContent.trim() === label.from && label.from !== label.to) {
          option.textContent = label.to;
          const text = dropdownInput(select, option.value)?.closest('label')?.querySelector('span');
          if (text) text.textContent = label.to;
          changed = true;
        }
      });
      const withdrawn = Array.from(select.options).filter((option) => gone.has(option.value));
      withdrawn.forEach((option) => {
        if (!option.selected) option.remove();
        else if (!saving && !option.disabled) {
          option.disabled = true;
          option.setAttribute(WITHDRAWN_ATTRIBUTE, '');
        }
      });
      withdrawn.forEach((option) => {
        if (option.disabled) dropdownInput(select, option.value)?.setAttribute('data-cc-dropdown-option-disabled', 'true');
      });
      if (changed || withdrawn.length > 0) syncCreatorCrateDropdownFromNative(select);
    });
  }

  // WP11C-F6: a setting kept as shown through an installed read whose last
  // answer said "Settings saved." while its stored choice is a default now
  // gone says what is true: the save happened, and the setting is unavailable
  // until another default is chosen. A saving or refused setting keeps its
  // own status (its answer settles it). Nothing is saved.
  function reconcileSavedStatus(region) {
    const form = region.querySelector('form');
    if (isBusy(form) || form?.getAttribute('data-settings-fetch-save-state') !== 'saved') return;
    const stored = region.getAttribute(PREFERENCE_STORED_ATTRIBUTE);
    if (!stored || !unavailableSlugs().has(stored)) return;
    const status = region.querySelector('[data-settings-fetch-save-status]');
    const message = savedUnavailableMessage(stored);
    if (status && status.textContent !== message) status.textContent = message;
  }

  // WP11C-F11: a setting whose save settled with no readable answer keeps
  // fetch-save's error state and its stored value (the last acknowledged
  // one), since the save may or may not have run. While its selected choice
  // is one the installed list cannot offer, the status says so without
  // claiming the save happened or was refused; once that choice can be
  // chosen again it goes back to fetch-save's own wording. Nothing is saved.
  function reconcileUnconfirmedStatus(region) {
    const form = region.querySelector('form');
    if (!form || !state.unconfirmed?.has(form) || isBusy(form)
      || form.getAttribute('data-settings-fetch-save-state') !== 'error') return;
    const status = region.querySelector('[data-settings-fetch-save-status]');
    const selected = region.querySelector('select[name]')?.value;
    if (!status) return;
    let message = M.preferenceNotSaved;
    if (selected && unavailableSlugs().has(selected)) {
      message = savedUnavailableMessage(selected) === M.preferenceSavedDisabled
        ? M.preferenceUnconfirmedDisabled
        : M.preferenceUnconfirmedUnavailable;
    } else if (status.textContent !== M.preferenceUnconfirmedDisabled
      && status.textContent !== M.preferenceUnconfirmedUnavailable) return;
    if (status.textContent !== message) status.textContent = message;
  }

  // Unresolved Deletes the read shows gone are settled as gone, unattributed.
  function settleObservations(parsed) {
    const present = new Set(rowsOf(sectionOf(parsed)).map(rowId));
    let settled = false;
    unresolvedRecords().forEach(([id, record]) => {
      if (present.has(id)) return;
      record.phase = 'missing';
      record.message = '';
      settled = true;
      removeRow(id);
    });
    return settled;
  }

  // Installs the read's list and Defaults settings, keeping every local row
  // and setting that holds unsaved, pending, refused or newer state. Returns
  // false when a newer read is already installed.
  //
  // WP11C-F1: a read never saves anything. Taking a focused, edited name or
  // slug out of the page makes the browser end that edit (change, then blur),
  // and the details form saves on change. So the read's list goes into the
  // page first and each kept row's own body moves into it atomically
  // (moveBefore: it never leaves the page, so no event fires, and focus,
  // caret and the field's own pending-change state stay, a later real Tab or
  // Enter still saves it). Where a browser cannot move atomically, any change
  // raised while installing is not the person's and is stopped before it
  // reaches the details form; the draft stays unsaved and on screen.
  //
  // WP11C-F5: moving the field the ordinary way also ends the browser's own
  // edit: back in the page and focused again, it compares later changes with
  // the draft, so the person's next Tab or click away would raise no change
  // and save nothing. That field is remembered (state.owedChange) and, when
  // the person really leaves it, the change the browser no longer raises is
  // raised once, only if its value differs from what it held when they
  // focused it, exactly as the browser would have. A change the browser does
  // raise (they typed more), Enter (its own submit) or leaving it unchanged
  // ends that; nothing is saved by the install itself.
  function install(result, start) {
    state.installing += 1;
    try {
      return installRead(result, start);
    } finally {
      state.installing -= 1;
    }
  }

  function installRead({ parsed, seq }, start) {
    if (seq <= state.installedSeq) return false;
    const current = sectionOf(document);
    const next = sectionOf(parsed);
    if (!current || !next) return false;
    state.installedSeq = seq;
    // WP11C-F10: what the page showed when this read was sent is older.
    (start.basis || []).forEach((input) => state.readBasis.add(input));
    // WP11C-F6: what this current read shows gone, before anything moves.
    observeInstalled(next);
    // Taken before any local row moves, so the focus can come back to it.
    const focus = captureRegionFocus(current);
    const hadFocus = current.contains(document.activeElement);
    const scroll = { x: windowObject.scrollX, y: windowObject.scrollY };
    // The local rows, by id, before the read's list is in the page.
    const localRows = new Map(rowsOf(current).map((row) => [rowId(row), row]));
    // A default this page saw deleted or gone cannot come back from a read.
    rowsOf(next).forEach((row) => {
      const record = records.get(rowId(row));
      if (record && (record.phase === 'deleted' || record.phase === 'missing')) row.remove();
    });
    const adopted = document.adoptNode ? document.adoptNode(next) : next;
    const atomic = typeof current.moveBefore === 'function' && typeof current.before === 'function';
    if (atomic) current.before(adopted);
    rowsOf(adopted).forEach((nextRow) => {
      const localRow = localRows.get(rowId(nextRow));
      if (!localRow || !(keepLocalRow(localRow, start.clock) || confirmsAnswer(start.answer, localRow, nextRow))) return;
      const localBody = localRow.querySelector(CARD_BODY_SELECTOR);
      const nextBody = nextRow.querySelector(CARD_BODY_SELECTOR);
      if (!localBody || !nextBody) return;
      if (atomic) {
        try {
          nextBody.parentNode.moveBefore(localBody, nextBody);
          nextBody.remove();
          return;
        } catch {
          // Not movable atomically here: moved the ordinary way below.
        }
      }
      const active = document.activeElement;
      if (active && active !== localBody && localBody.contains(active) && isTextField(active)) state.owedChange = active;
      nextBody.replaceWith(localBody);
    });
    if (atomic) current.remove();
    else current.replaceWith(adopted);
    enhanceCategoryReorder(adopted);
    enhanceCategoryDetails(adopted);
    enhanceAutoSubmit(adopted);
    enhanceAppConfirmationControls(adopted);
    if (!restoreRegionFocus(adopted, focus) && hadFocus) {
      document.getElementById(HEADING_ID)?.focus?.({ preventScroll: true });
    }
    // WP11C-F5: only a field the person is still in can still be left.
    if (state.owedChange && document.activeElement !== state.owedChange) state.owedChange = null;
    // WP11C-F10: each default's current name and slug is what the read shows,
    // unless a details answer this page installed after it was sent is newer.
    rowsOf(adopted).forEach((row) => learnIdentity(rowId(row), currentOf(row), true));

    document.querySelectorAll(PREFERENCE_SELECTOR).forEach((region) => {
      const identity = region.getAttribute('data-settings-asset-category-preference');
      const nextRegion = Array.from(parsed.querySelectorAll(PREFERENCE_SELECTOR))
        .find((candidate) => candidate.getAttribute('data-settings-asset-category-preference') === identity);
      if (!nextRegion) return;
      if (keepLocalPreference(region, identity, start)) {
        withdrawGoneOptions(region);
        reconcileSavedStatus(region);
        reconcileUnconfirmedStatus(region);
        return;
      }
      const regionFocus = captureRegionFocus(region);
      const adoptedRegion = document.adoptNode ? document.adoptNode(nextRegion) : nextRegion;
      region.replaceWith(adoptedRegion);
      enhanceDropdowns(adoptedRegion);
      enhanceAssetCategoryPreferencesFetchSave(adoptedRegion);
      restoreRegionFocus(adoptedRegion, regionFocus);
    });
    if (windowObject.scrollX !== scroll.x || windowObject.scrollY !== scroll.y) {
      windowObject.scrollTo?.(scroll.x, scroll.y);
    }
    applyHolds();
    return true;
  }

  // Display synchronization after a Delete this page saw settle: GET only.
  function refresh({ focusResult = false, answer = null } = {}) {
    if (!canRead(windowObject)) {
      state.sync = 'stale';
      report(`${state.lastResult || ''} ${M.refreshFailed}`.trim(), true);
      return Promise.resolve(false);
    }
    state.sync = 'refreshing';
    const seq = (state.getSeq += 1);
    state.refreshSeq = seq;
    const start = { ...readStart(), answer };
    report(`${state.lastResult || ''} ${M.updating}`.trim(), false);
    return readList(seq).then((result) => {
      // A newer refresh owns the display now.
      if (state.refreshSeq !== seq) return false;
      if (!result) {
        state.sync = 'stale';
        report(`${state.lastResult || ''} ${M.refreshFailed}`.trim(), true, { focus: focusResult ? 'refresh' : null });
        return false;
      }
      settleObservations(result.parsed);
      install(result, start);
      state.sync = 'idle';
      report(`${state.lastResult || ''} ${M.upToDate}`.trim(), false);
      return true;
    });
  }

  // Check again for every unresolved Delete: GET only. A default the read
  // shows present stays held (its request may still run); one it shows gone
  // is settled as gone, never as deleted by this page.
  function check({ focusResult = false } = {}) {
    if (unresolvedRecords().length === 0) return Promise.resolve();
    unresolvedRecords().forEach(([, record]) => { record.message = `${M.unconfirmed} ${M.checking}`; });
    render();
    if (!canRead(windowObject)) {
      unresolvedRecords().forEach(([, record]) => { record.message = `${M.unconfirmed} ${M.checkFailed}`; });
      render({ focus: focusResult ? 'check' : null });
      return Promise.resolve();
    }
    const seq = (state.getSeq += 1);
    state.checkSeq = seq;
    const start = readStart();
    return readList(seq).then((result) => {
      if (state.checkSeq !== seq) return;
      if (!result) {
        unresolvedRecords().forEach(([, record]) => { record.message = `${M.unconfirmed} ${M.checkFailed}`; });
        render({ focus: focusResult ? 'check' : null });
        return;
      }
      const goneLabels = unresolvedRecords()
        .filter(([id]) => !rowsOf(sectionOf(result.parsed)).some((row) => rowId(row) === id))
        .map(([, record]) => record.label);
      unresolvedRecords().forEach(([, record]) => { record.message = `${M.unconfirmed} ${M.stillPresent}`; });
      if (settleObservations(result.parsed)) {
        // The read is current: install it, unless a refresh is in flight
        // (its own read installs then) or a newer read is installed.
        if (state.sync !== 'refreshing') {
          install(result, start);
          if (state.sync === 'stale') state.sync = 'idle';
        }
        const text = goneLabels.map((label) => `${quoted(label || 'Category default')} ${M.observedMissing}`).join(' ');
        state.lastResult = text;
        report(text, true, { focus: focusResult ? 'check' : null });
        return;
      }
      render({ focus: focusResult ? 'check' : null });
    });
  }

  // WP11C-A: a details answer (saved, refused or stale) renders the saved
  // details as they were when the server answered. Its form nodes are new, but
  // that does not make it newer than a list read installed while its request
  // was on its way: that read may have been rendered after it (a change made
  // elsewhere since, say). Such an answer still settles its own form (status,
  // reviewed witnesses, draft), but is no evidence of the default's current
  // identity: its reviewed fields join readBasis, so the installed list stays
  // the authority, and when the two disagree one GET-only refresh, sent after
  // both, re-reads the server's own display. An answer whose request was sent
  // after the last installed read is newer and stays the identity (F10).
  setCategoryDetailsLifecycle(document, {
    requestStarted: () => ({ installedSeq: state.installedSeq }),
    answerInstalled: (form, started) => {
      if (!started || started.installedSeq === state.installedSeq) return;
      Array.from(form?.querySelectorAll?.('input[data-category-details-reviewed]') || [])
        .forEach((input) => state.readBasis.add(input));
      const row = form?.closest?.(ROW_SELECTOR);
      if (!row || !sectionOf(document)?.contains(row)) return;
      const answered = savedIdentity(row);
      const current = currentOf(row);
      if (answered.slug !== current.slug || answered.name !== current.name) {
        void refresh({ answer: { id: rowId(row), form, identity: answered } });
      }
    },
  });

  // --------------------------------------------------------------- Delete --

  function submit(form) {
    const id = formCategoryId(form);
    const row = form.closest(ROW_SELECTOR);
    const { name, slug } = savedIdentity(row);
    // Captured before anything is held: the request carries exactly this
    // form's default and token.
    const action = form.getAttribute('action');
    const body = new windowObject.URLSearchParams(new windowObject.FormData(form));
    const record = { phase: 'pending', attempt: (state.attempt += 1), label: name, slug, message: '' };
    records.set(id, record);
    state.pendingId = id;
    applyHolds();
    report(`Deleting ${name ? quoted(name) : 'the category default'}…`, false);

    Promise.resolve()
      .then(() => windowObject.fetch(action, {
        method: 'POST',
        body,
        credentials: 'same-origin',
        redirect: 'follow',
        headers: { Accept: 'application/json' },
      }))
      .then((response) => Promise.resolve()
        .then(() => (typeof response?.json === 'function' ? response.json() : null))
        .catch(() => null)
        .then((payload) => ({ outcome: classifySettingsCategoryDeleteResponse(response, payload, id), payload })))
      .catch(() => ({ outcome: 'uncertain', payload: null }))
      .then(({ outcome, payload }) => {
        if (records.get(id) !== record || record.phase !== 'pending') return;
        if (state.pendingId === id) state.pendingId = null;
        const message = typeof payload?.message === 'string' && payload.message ? payload.message : '';

        if (outcome === 'deleted') {
          record.phase = 'deleted';
          state.lastResult = message || M.deletedFallback;
          removeRow(id);
          applyHolds();
          void refresh();
          return;
        }
        if (outcome === 'missing') {
          record.phase = 'missing';
          state.lastResult = M.goneUnconfirmed;
          removeRow(id);
          applyHolds();
          void refresh();
          return;
        }
        if (outcome === 'refused' || outcome === 'failed') {
          records.delete(id);
          applyHolds();
          const nothing = /nothing was deleted/i.test(message) ? '' : ` ${M.nothingDeleted}`;
          const drafts = detailsDirty(rowFor(document, id)?.querySelector(DETAILS_FORM_SELECTOR)) ? ` ${M.draftsKept}` : '';
          report(`${message || M.refusedFallback}${nothing}${drafts}`, true);
          rowFor(document, id)?.querySelector(`${DELETE_FORM_SELECTOR} button`)?.focus?.({ preventScroll: true });
          return;
        }
        record.phase = 'unresolved';
        record.message = M.unconfirmed;
        state.primary = null;
        applyHolds();
        void check();
      });
  }

  // ------------------------------------------------------------- guards --

  function touch(target) {
    const row = target?.closest?.(ROW_SELECTOR);
    const region = target?.closest?.(PREFERENCE_SELECTOR);
    if (!row && !region) return;
    state.clock += 1;
    if (row && sectionOf(document)?.contains(row)) state.touched.set(`row:${rowId(row)}`, state.clock);
    if (region) {
      const identity = region.getAttribute('data-settings-asset-category-preference');
      state.touched.set(`pref:${identity}`, state.clock);
      // WP11C-F9A: a save of this setting is sent at or after this change,
      // so a read installed later may have been rendered after it.
      state.preferenceMarks.set(identity, state.installedSeq);
    }
  }

  function heldRecordFor(target) {
    const row = target?.closest?.(ROW_SELECTOR);
    if (!row || !sectionOf(document)?.contains(row)) return null;
    const record = records.get(rowId(row));
    return record && (record.phase === 'pending' || record.phase === 'unresolved') ? record : null;
  }

  function stop(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  // Captured on the document, ahead of every control's own listeners.
  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('button, input[type="submit"]');
    const form = button?.form || button?.closest?.('form');
    if (!form?.matches?.(DELETE_FORM_SELECTOR) || !canSubmitInPlace(windowObject)) return;
    const refused = refusal(form);
    if (refused) {
      stop(event);
      refuse(refused);
      return;
    }
    // Asked when the confirmation opens, so it says what is saved then.
    if (button.hasAttribute('data-confirm')) describeAppConfirmation(button, () => confirmationFor(form));
  }, true);

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form?.matches?.('form')) return;
    // WP11C-F5: Enter in that field is the person's own submit of it.
    if (state.owedChange && form.contains(state.owedChange)) state.owedChange = null;
    if (form.matches(DELETE_FORM_SELECTOR)) {
      // Only a confirmed replay reaches here: the confirmation's own submit
      // gate (installed first) stops any other submit of this form.
      if (event.defaultPrevented || !canSubmitInPlace(windowObject)) return;
      stop(event);
      const refused = refusal(form);
      if (refused) {
        refuse(refused);
        return;
      }
      submit(form);
      return;
    }
    if (form.matches(DETAILS_FORM_SELECTOR) || form.matches(ENABLED_FORM_SELECTOR)) {
      const record = heldRecordFor(form);
      if (record) {
        stop(event);
        refuse(record.phase === 'pending' ? M.changePending : M.changeHeld);
        return;
      }
      touch(form);
      return;
    }
    if (form.matches(REORDER_FORM_SELECTOR) && orderHeld(state)) {
      stop(event);
      refuse(M.orderHeld);
      return;
    }
    // The native Add form leaves the page. While any Delete is pending or
    // unresolved that would lose its answer, its hold (so another Delete of
    // the same default could be sent while the first may still run), Check
    // again and the unsaved drafts. Only a read finding the default gone, or
    // an answer, ends the hold; nothing is queued, and the Add fields keep
    // what was typed.
    if (heldPhase(state) && form.getAttribute('action') === LIST_URL
      && (form.getAttribute('method') || '').toLowerCase() === 'post') {
      stop(event);
      refuse(state.pendingId ? M.addPending : M.addHeld);
      return;
    }
    touch(form);
  }, true);

  document.addEventListener('change', (event) => {
    const target = event.target;
    // WP11C-F1: raised by the browser because a read's install moved an
    // edited field, not by the person; it must not save that draft.
    if (state.installing > 0) {
      event.stopImmediatePropagation();
      return;
    }
    // WP11C-F5: the browser raised it itself, so nothing more is owed. Back
    // at what it held when the person focused it, it is a change only because
    // the install moved the browser's comparison, and is not raised.
    if (target === state.owedChange) {
      state.owedChange = null;
      if (target.value === focusValueOf(target)) {
        event.stopImmediatePropagation();
        return;
      }
    }
    const record = heldRecordFor(target);
    if (record) {
      // Not saved: a switch goes back to its state; typed text stays as a draft.
      event.stopImmediatePropagation();
      if (target.type === 'checkbox') target.checked = !target.checked;
      refuse(record.phase === 'pending' ? M.changePending : M.changeHeld);
      return;
    }
    touch(target);
  }, true);

  document.addEventListener('input', (event) => touch(event.target), true);

  function focusValueOf(field) {
    return state.focusValues.has(field) ? state.focusValues.get(field) : field.defaultValue;
  }

  // WP11C-F5: what a name or slug held when the person focused it. Focus put
  // back by an install, or coming back with the window to the field that kept
  // the page's focus, is not a new focus and leaves it as it was.
  document.addEventListener('focusin', (event) => {
    if (state.installing > 0) return;
    const target = event.target;
    if (isTextField(target) && target !== state.lastFocus) state.focusValues.set(target, target.value);
    state.lastFocus = target;
  }, true);

  // WP11C-F5: the person leaves the field whose edit an install ended for the
  // browser. Taking it out of the page again (another install) or the
  // window losing focus (the field keeps the page's focus) is not leaving it.
  document.addEventListener('focusout', (event) => {
    if (state.installing > 0 || document.activeElement === event.target) return;
    if (event.target === state.lastFocus) state.lastFocus = null;
    const field = state.owedChange;
    if (!field || event.target !== field) return;
    state.owedChange = null;
    if (!field.isConnected || field.value === focusValueOf(field) || typeof windowObject.Event !== 'function') return;
    field.dispatchEvent(new windowObject.Event('change', { bubbles: true }));
  }, true);

  // WP11C-F2: a Defaults setting answer older than a Delete this page saw.
  document.addEventListener(ASSET_CATEGORY_PREFERENCE_ANSWER_EVENT, (event) => {
    const { region, parsed, next, kind, payload } = event.detail || {};
    // WP11C-F8: the slugs its render offers are each default's saved slug at
    // that time (a rename this page has not read yet included).
    if (parsed) learnShown(sectionOf(parsed), false);
    if (!region?.isConnected || !parsed) return;
    const beforeGone = renderedBeforeGone(parsed);
    // WP11C-F9A: rendered before what the installed list shows can be chosen.
    const obsolete = !beforeGone && answerEligibilityObsolete(region, parsed);
    if (!beforeGone && !obsolete) return;
    event.preventDefault();
    // The stored value it shows is what this save left (a refusal changed
    // nothing); nothing else on this page changes it.
    if (next?.hasAttribute?.(PREFERENCE_STORED_ATTRIBUTE)) {
      region.setAttribute(PREFERENCE_STORED_ATTRIBUTE, next.getAttribute(PREFERENCE_STORED_ATTRIBUTE));
    }
    withdrawGoneOptions(region);
    if (kind !== 'saved') return;
    const select = region.querySelector('select[name]');
    const saved = select ? new windowObject.URLSearchParams(payload || '').get(select.name) : null;
    if (obsolete) {
      // The save ran; "Settings saved." stays only while its choice can
      // still be chosen. The server's current display, by GET only.
      const status = region.querySelector('[data-settings-fetch-save-status]');
      if (status && saved !== null && unavailableSlugs().has(saved)) status.textContent = savedUnavailableMessage(saved);
      if (state.sync !== 'refreshing') void refresh();
      return;
    }
    // WP11C-F10: also a default still listed whose current slug is another.
    if (saved === null || !unavailableSlugs().has(saved)) return;
    const status = region.querySelector('[data-settings-fetch-save-status]');
    if (status) status.textContent = savedUnavailableMessage(saved);
    // The server's own display of the unavailable setting, by GET only; a
    // refresh already in flight was sent after the Delete and installs it.
    if (state.sync !== 'refreshing') void refresh();
  });

  // WP11C-F11: a Defaults save settled and no answer render replaced its
  // region (lost, unreadable, refused but not installed). While it was
  // saving, its selected option was deliberately left enabled so the save's
  // payload stayed as submitted (withdrawGoneOptions); the save no longer
  // owns the form, so the region now follows the installed list for what
  // can be chosen like any other kept region. A queued save that already
  // started owns it again (busy) and settles on its own. Nothing is saved,
  // read or retried here; the stored value (last acknowledged) is unchanged.
  document.addEventListener(ASSET_CATEGORY_PREFERENCE_SETTLED_EVENT, (event) => {
    const { region, uncertain } = event.detail || {};
    const form = region?.isConnected ? region.querySelector('form') : null;
    if (!form || isBusy(form)) return;
    state.unconfirmed ||= new WeakSet();
    if (uncertain) state.unconfirmed.add(form);
    else state.unconfirmed.delete(form);
    withdrawGoneOptions(region);
    reconcileUnconfirmedStatus(region);
  });

  document.addEventListener('dragstart', (event) => {
    if (!orderHeld(state)) return;
    if (!event.target?.closest?.(REORDER_ITEM_SELECTOR)) return;
    stop(event);
    refuse(M.orderHeld);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!REORDER_KEYS.has(event.key) || !orderHeld(state)) return;
    if (!event.target?.closest?.(REORDER_HANDLE_SELECTOR)) return;
    stop(event);
    refuse(M.orderHeld);
  }, true);

  // WP11C-F6: the list this page was rendered with is the first one shown.
  if (!state.seen) learnShown(sectionOf(document), true);

  return { check, refresh, refusal, applyHolds };
}

/**
 * Binds the in-place Delete of global asset category defaults on Settings →
 * Asset Categories (once per document). Returns { check, refresh, refusal,
 * applyHolds } or null on any other page (the native form then keeps its own
 * confirmation, POST and redirect).
 */
export function enhanceSettingsCategoryDelete(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  if (!document?.addEventListener || !document.querySelector?.(SECTION_SELECTOR)) return null;
  const root = document.documentElement;
  if (isEnhancementBound(root, GUARD_BOUND_KEY)) return document[STATE_KEY]?.controller || null;
  markEnhancementBound(root, GUARD_BOUND_KEY);
  // The gate must run ahead of this module's own submit listener.
  installAppConfirmationSubmitGate(document);
  const state = documentState(document);
  state.controller = controller(document);
  return state.controller;
}
