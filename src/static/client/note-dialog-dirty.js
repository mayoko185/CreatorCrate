import { requestAppConfirmation } from './confirm-dialog.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';

const NOTE_DIALOG_FORM_SELECTOR = '[data-note-dialog-dirty]';
const NOTE_DIALOG_BASELINE_SELECTOR = '[data-note-dialog-baseline]';

function sortedStrings(values) {
  return [...new Set(Array.from(values || [], value => String(value)))].sort();
}

function sameStrings(left, right) {
  const a = sortedStrings(left);
  const b = sortedStrings(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function readBaseline(form) {
  try {
    const value = JSON.parse(form.querySelector?.(NOTE_DIALOG_BASELINE_SELECTOR)?.textContent || 'null');
    if (!value || typeof value !== 'object') return null;
    return {
      title: String(value.title ?? ''),
      content: String(value.content ?? ''),
      projectIds: sortedStrings(value.projectIds),
      assetIds: sortedStrings(value.assetIds),
    };
  } catch {
    return null;
  }
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

export function noteDialogIsDirty(form, baseline) {
  if (!form || !baseline) return false;
  const title = form.querySelector?.('[name="title"]')?.value ?? '';
  const editor = form.__creatorCrateNotesEditor;
  const content = editor?.getMarkdown?.()
    ?? form.querySelector?.('[data-notes-editor-source]')?.value
    ?? '';
  const connections = readConnections(form);
  return String(title) !== baseline.title
    || String(content) !== baseline.content
    || !sameStrings(connections.projectIds, baseline.projectIds)
    || !sameStrings(connections.assetIds, baseline.assetIds);
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
  form.querySelector?.('[data-note-connections]')
    ?.__creatorCrateNoteConnections
    ?.resetState?.(baseline);
}

export function enhanceNoteDialogUnsavedChanges(
  scope = globalThis.document,
  { requestConfirmation = requestAppConfirmation } = {},
) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  let count = 0;
  scope.querySelectorAll(NOTE_DIALOG_FORM_SELECTOR).forEach((form) => {
    if (isEnhancementBound(form, 'noteDialogDirtyBound')) return;
    const baseline = readBaseline(form);
    const dialog = form.closest?.('[data-app-dialog]');
    const state = dialog?.__creatorCrateAppDialogState;
    if (!baseline || !state) return;

    markEnhancementBound(form, 'noteDialogDirtyBound');
    count += 1;
    state.beforeClose = ({ lifecycle, opener }) => {
      if (!noteDialogIsDirty(form, baseline)) return true;
      return requestConfirmation(state.document, {
        title: 'Discard changes?',
        message: 'Your unsaved changes will be lost.',
        confirmLabel: 'Discard',
        opener,
      }).then((confirmed) => {
        if (!confirmed || state.lifecycle !== lifecycle) return false;
        resetNoteDialog(form, baseline);
        return true;
      });
    };
  });
  return count;
}
