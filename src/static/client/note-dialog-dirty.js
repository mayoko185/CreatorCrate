import { describeAppConfirmation, requestAppConfirmation } from './confirm-dialog.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';

const NOTE_DIALOG_FORM_SELECTOR = '[data-note-dialog-dirty]';
const NOTE_DIALOG_BASELINE_SELECTOR = '[data-note-dialog-baseline]';
// Project Detail's Create Note adds an editable Note location. Only a baseline
// that names one (`targetContainer`) compares and restores it, so the other
// Notes dialogs, which have no such field, keep their exact behavior.
const NOTE_LOCATION_SELECTOR = '#note-location-target';

function sortedStrings(values) {
  return [...new Set(Array.from(values || [], value => String(value)))].sort();
}

function sameStrings(left, right) {
  const a = sortedStrings(left);
  const b = sortedStrings(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function readNoteDialogBaseline(form) {
  try {
    const value = JSON.parse(form.querySelector?.(NOTE_DIALOG_BASELINE_SELECTOR)?.textContent || 'null');
    if (!value || typeof value !== 'object') return null;
    return {
      title: String(value.title ?? ''),
      content: String(value.content ?? ''),
      ...(typeof value.targetContainer === 'string' ? { targetContainer: value.targetContainer } : {}),
      projectIds: sortedStrings(value.projectIds),
      assetIds: sortedStrings(value.assetIds),
      assets: Array.isArray(value.assets) ? value.assets : [],
    };
  } catch {
    return null;
  }
}

function isIdList(value) {
  return Array.isArray(value) && value.every(id => typeof id === 'string' && /^[1-9]\d*$/.test(id));
}

// A read's saved values only when they are whole, as the server renders them
// (routes/notes.js buildNoteDialogBaseline): string title and content, id-string
// association lists (an empty one included) and the selected assets. A field
// missing or of another type is not a default to fill in, so the read is null.
export function readCompleteNoteDialogBaseline(form) {
  let value;
  try {
    value = JSON.parse(form.querySelector?.(NOTE_DIALOG_BASELINE_SELECTOR)?.textContent || 'null');
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.title !== 'string' || typeof value.content !== 'string') return null;
  if (!isIdList(value.projectIds) || !isIdList(value.assetIds) || !Array.isArray(value.assets)) return null;
  if (Object.hasOwn(value, 'targetContainer') && typeof value.targetContainer !== 'string') return null;
  return readNoteDialogBaseline(form);
}

// The saved values the guard compares with and a discard restores: an in-place
// save or a later read of the host replaces the ones the page was rendered with.
export function setNoteDialogBaseline(form, values) {
  const node = form.querySelector?.(NOTE_DIALOG_BASELINE_SELECTOR);
  if (node) node.textContent = JSON.stringify(values);
}

function checkedValues(form, name) {
  return Array.from(form.querySelectorAll?.(`input[name="${name}"]:checked`) || [])
    .map(control => control.value)
    .filter(Boolean);
}

function selectedAssetValues(form) {
  const native = form.querySelector?.('#note-assets-native');
  return [
    ...Array.from(native?.options || []).filter(option => option.selected).map(option => option.value),
    ...checkedValues(form, 'assetIds[]'),
  ];
}

function readConnections(form) {
  const controller = form.querySelector?.('[data-note-connections]')
    ?.__creatorCrateNoteConnections;
  return controller?.getState?.() || {
    projectIds: sortedStrings(checkedValues(form, 'projectIds[]')),
    assetIds: sortedStrings(selectedAssetValues(form)),
  };
}

// What the form holds now, in the terms a baseline compares: kept aside, it is
// the draft a save sent, to compare with what a later read says was saved.
export function readNoteDialogDraft(form) {
  if (!form) return null;
  const editor = form.__creatorCrateNotesEditor;
  const connections = readConnections(form);
  return {
    title: String(form.querySelector?.('[name="title"]')?.value ?? ''),
    content: String(editor?.getMarkdown?.()
      ?? form.querySelector?.('[data-notes-editor-source]')?.value
      ?? ''),
    location: String(form.querySelector?.(NOTE_LOCATION_SELECTOR)?.value ?? ''),
    projectIds: sortedStrings(connections.projectIds),
    assetIds: sortedStrings(connections.assetIds),
  };
}

// Whether a draft is exactly what a baseline holds, as the guard compares them.
export function noteDialogDraftSaved(draft, baseline) {
  if (!draft || !baseline) return false;
  return draft.title === baseline.title
    && draft.content === baseline.content
    && (typeof baseline.targetContainer !== 'string' || draft.location === baseline.targetContainer)
    && sameStrings(draft.projectIds, baseline.projectIds)
    && sameStrings(draft.assetIds, baseline.assetIds);
}

export function noteDialogIsDirty(form, baseline) {
  if (!form || !baseline) return false;
  return !noteDialogDraftSaved(readNoteDialogDraft(form), baseline);
}

function resetNoteDialog(form, baseline) {
  const title = form.querySelector?.('[name="title"]');
  if (title) title.value = baseline.title;
  const editor = form.__creatorCrateNotesEditor;
  if (editor?.resetMarkdown) editor.resetMarkdown(baseline.content);
  else {
    const textarea = form.querySelector?.('[data-notes-editor-source]');
    if (textarea) textarea.value = baseline.content;
  }
  const location = typeof baseline.targetContainer === 'string'
    ? form.querySelector?.(NOTE_LOCATION_SELECTOR)
    : null;
  if (location) {
    const restored = Array.from(location.options || [])
      .some(option => option.value === baseline.targetContainer);
    location.value = restored ? baseline.targetContainer : '';
    syncCreatorCrateDropdownFromNative(location);
  }
  form.querySelector?.('[data-note-connections]')
    ?.__creatorCrateNoteConnections
    ?.resetState?.(baseline);
}

// Back to the values the dialog opens with: the live editor and connections,
// which a native form reset cannot reach.
export function resetNoteDialogToBaseline(form) {
  const baseline = readNoteDialogBaseline(form);
  if (baseline) resetNoteDialog(form, baseline);
}

export function enhanceNoteDialogUnsavedChanges(
  scope = globalThis.document,
  { requestConfirmation = requestAppConfirmation } = {},
) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  let count = 0;
  scope.querySelectorAll(NOTE_DIALOG_FORM_SELECTOR).forEach((form) => {
    if (isEnhancementBound(form, 'noteDialogDirtyBound')) return;
    const dialog = form.closest?.('[data-app-dialog]');
    const state = dialog?.__creatorCrateAppDialogState;
    if (!readNoteDialogBaseline(form) || !state) return;

    markEnhancementBound(form, 'noteDialogDirtyBound');
    count += 1;
    // Deleting the saved Page is not discarding a draft, so a draft it would take
    // with it is named here, and Keep Editing goes back to it untouched.
    const deletePage = dialog.querySelector?.('button[form="note-delete-form"]');
    if (deletePage) {
      describeAppConfirmation(deletePage, () => (noteDialogIsDirty(form, readNoteDialogBaseline(form))
        ? {
          title: 'Delete Page with unsaved changes?',
          message: 'This deletes the saved Page, not just your unsaved changes. Its saved content, revision history and connections will be removed. Undo can restore the saved Page for ten minutes, but may be refused if related records or the Page order change. Your unsaved changes will be lost, and Undo cannot restore them.',
          cancelLabel: 'Keep Editing',
        }
        : null));
    }
    state.beforeClose = ({ lifecycle, opener }) => {
      // A save in flight may already have written, so it stays until its outcome is
      // known. A creation whose outcome could not be confirmed (chapter-dialogs.js)
      // closes without a Discard question only where its whole draft is retained
      // across the close (state.retainsDraft, WP6-F4); elsewhere it stays.
      if (state.submitting) return false;
      if (state.unresolvedOutcome) return state.retainsDraft?.() === true;
      if (!noteDialogIsDirty(form, readNoteDialogBaseline(form))) return true;
      return requestConfirmation(state.document, {
        title: 'Discard changes?',
        message: 'Your unsaved changes will be lost.',
        confirmLabel: 'Discard',
        opener,
      }).then((confirmed) => {
        if (!confirmed || state.lifecycle !== lifecycle) return false;
        resetNoteDialogToBaseline(form);
        return true;
      });
    };
  });
  return count;
}
