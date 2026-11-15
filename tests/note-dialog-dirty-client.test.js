import { describe, expect, it, vi } from 'vitest';
import {
  enhanceNoteDialogUnsavedChanges,
  noteDialogIsDirty,
} from '../src/static/creatorcrate.js';

function makeFixture({ location = undefined } = {}) {
  const baseline = {
    title: 'Original title',
    content: '# Original',
    ...(location === undefined ? {} : { targetContainer: location }),
    projectIds: ['2', '1'],
    assetIds: ['20', '10'],
  };
  // Project Detail's Create Note: the native select behind the Note location dropdown.
  const locationSelect = {
    value: location ?? '',
    options: [{ value: '' }, { value: 'book:1' }, { value: 'chapter:2' }],
  };
  const title = { value: baseline.title };
  const textarea = { value: baseline.content };
  const baselineNode = { textContent: JSON.stringify({ ...baseline, assets: [] }) };
  const connectionsState = {
    projectIds: ['1', '2'],
    assetIds: ['10', '20'],
  };
  const connections = {
    __creatorCrateNoteConnections: {
      getState: vi.fn(() => connectionsState),
      resetState: vi.fn((next) => {
        connectionsState.projectIds = [...next.projectIds];
        connectionsState.assetIds = [...next.assetIds];
      }),
    },
  };
  let markdown = baseline.content;
  const editor = {
    getMarkdown: vi.fn(() => markdown),
    resetMarkdown: vi.fn((value) => { markdown = value; textarea.value = value; }),
  };
  const document = {};
  const state = { document, lifecycle: 1, beforeClose: null };
  const dialog = { __creatorCrateAppDialogState: state };
  const form = {
    dataset: {},
    __creatorCrateNotesEditor: editor,
    closest: vi.fn(() => dialog),
    querySelector(selector) {
      if (selector === '[data-note-dialog-baseline]') return baselineNode;
      if (selector === '[name="title"]') return title;
      if (selector === '[data-notes-editor-source]') return textarea;
      if (selector === '[data-note-connections]') return connections;
      if (selector === '#note-location-target') return location === undefined ? null : locationSelect;
      return null;
    },
    querySelectorAll: vi.fn(() => []),
  };
  const scope = {
    querySelectorAll: vi.fn(selector => selector === '[data-note-dialog-dirty]' ? [form] : []),
  };
  return {
    baseline,
    connections,
    connectionsState,
    dialog,
    document,
    editor,
    form,
    locationSelect,
    scope,
    state,
    title,
    getMarkdown: () => markdown,
    setMarkdown: value => { markdown = value; },
  };
}

describe('Page dialog dirty state', () => {
  it('compares effective title, live Markdown, Project, and Asset state and becomes clean after exact reverts', () => {
    const page = makeFixture();
    expect(noteDialogIsDirty(page.form, page.baseline)).toBe(false);

    page.title.value = 'Changed';
    expect(noteDialogIsDirty(page.form, page.baseline)).toBe(true);
    page.title.value = page.baseline.title;
    expect(noteDialogIsDirty(page.form, page.baseline)).toBe(false);

    page.setMarkdown('Changed Markdown');
    expect(noteDialogIsDirty(page.form, page.baseline)).toBe(true);
    page.setMarkdown(page.baseline.content);
    expect(noteDialogIsDirty(page.form, page.baseline)).toBe(false);

    page.connectionsState.projectIds.push('3');
    expect(noteDialogIsDirty(page.form, page.baseline)).toBe(true);
    page.connectionsState.projectIds.pop();
    expect(noteDialogIsDirty(page.form, page.baseline)).toBe(false);

    page.connectionsState.assetIds.splice(0, 1);
    expect(noteDialogIsDirty(page.form, page.baseline)).toBe(true);
    page.connectionsState.assetIds.push('10');
    expect(noteDialogIsDirty(page.form, page.baseline)).toBe(false);
  });

  it('closes clean Add/Edit state without requesting confirmation', async () => {
    const page = makeFixture();
    const requestConfirmation = vi.fn();
    expect(enhanceNoteDialogUnsavedChanges(page.scope, { requestConfirmation })).toBe(1);
    expect(enhanceNoteDialogUnsavedChanges(page.scope, { requestConfirmation })).toBe(0);

    expect(page.state.beforeClose({ lifecycle: 1, opener: null })).toBe(true);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('keeps edits when discard is cancelled and resets every effective field when confirmed', async () => {
    const page = makeFixture();
    page.title.value = 'Draft';
    page.setMarkdown('Draft Markdown');
    page.connectionsState.projectIds = ['3'];
    page.connectionsState.assetIds = ['30'];
    const requestConfirmation = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    enhanceNoteDialogUnsavedChanges(page.scope, { requestConfirmation });

    await expect(page.state.beforeClose({ lifecycle: 1, opener: page.title })).resolves.toBe(false);
    expect(page.title.value).toBe('Draft');
    expect(page.getMarkdown()).toBe('Draft Markdown');
    expect(page.connectionsState).toEqual({ projectIds: ['3'], assetIds: ['30'] });

    await expect(page.state.beforeClose({ lifecycle: 1, opener: page.title })).resolves.toBe(true);
    expect(requestConfirmation).toHaveBeenLastCalledWith(page.document, {
      title: 'Discard changes?',
      message: 'Your unsaved changes will be lost.',
      confirmLabel: 'Discard',
      opener: page.title,
    });
    expect(page.title.value).toBe(page.baseline.title);
    expect(page.getMarkdown()).toBe(page.baseline.content);
    expect(page.connectionsState).toEqual({ projectIds: ['1', '2'], assetIds: ['10', '20'] });
    expect(noteDialogIsDirty(page.form, page.baseline)).toBe(false);
  });

  it('WP6-F4: an unresolved creation closes without Discard or reset only where its draft is retained', () => {
    const page = makeFixture();
    const requestConfirmation = vi.fn();
    enhanceNoteDialogUnsavedChanges(page.scope, { requestConfirmation });
    page.title.value = 'Unresolved draft';
    page.state.unresolvedOutcome = true;

    // Without a host that retains it, an unresolved creation stays open.
    expect(page.state.beforeClose({ lifecycle: 1, opener: null })).toBe(false);
    page.state.retainsDraft = () => page.state.unresolvedOutcome === true;
    expect(page.state.beforeClose({ lifecycle: 1, opener: null })).toBe(true);
    // A save in flight stays open whatever is retained.
    page.state.submitting = true;
    expect(page.state.beforeClose({ lifecycle: 1, opener: null })).toBe(false);

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(page.title.value).toBe('Unresolved draft');
    expect(page.editor.resetMarkdown).not.toHaveBeenCalled();
  });

  it('ignores a confirmed result from a stale Page-dialog lifecycle', async () => {
    const page = makeFixture();
    page.title.value = 'Old draft';
    let resolveConfirmation;
    const requestConfirmation = vi.fn(() => new Promise(resolve => { resolveConfirmation = resolve; }));
    enhanceNoteDialogUnsavedChanges(page.scope, { requestConfirmation });

    const close = page.state.beforeClose({ lifecycle: 1, opener: null });
    page.state.lifecycle = 2;
    page.title.value = 'New lifecycle draft';
    resolveConfirmation(true);

    await expect(close).resolves.toBe(false);
    expect(page.title.value).toBe('New lifecycle draft');
    expect(page.editor.resetMarkdown).not.toHaveBeenCalled();
    expect(page.connections.__creatorCrateNoteConnections.resetState).not.toHaveBeenCalled();
  });

  describe('Create Note location (WP6.3)', () => {
    it('marks a location-only change dirty and becomes clean when it is reverted', () => {
      const page = makeFixture({ location: '' });
      expect(noteDialogIsDirty(page.form, page.baseline)).toBe(false);

      page.locationSelect.value = 'chapter:2';
      expect(noteDialogIsDirty(page.form, page.baseline)).toBe(true);
      page.locationSelect.value = 'book:1';
      expect(noteDialogIsDirty(page.form, page.baseline)).toBe(true);
      page.locationSelect.value = '';
      expect(noteDialogIsDirty(page.form, page.baseline)).toBe(false);
    });

    it('reads the location from the rendered baseline only when the form has one', async () => {
      const { readNoteDialogBaseline } = await import('../src/static/client/note-dialog-dirty.js');
      expect(readNoteDialogBaseline(makeFixture({ location: '' }).form)).toHaveProperty('targetContainer', '');
      expect(readNoteDialogBaseline(makeFixture().form)).not.toHaveProperty('targetContainer');
    });

    it('keeps the chosen location on Keep Editing and restores the original on Discard', async () => {
      const page = makeFixture({ location: '' });
      page.locationSelect.value = 'chapter:2';
      const requestConfirmation = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      enhanceNoteDialogUnsavedChanges(page.scope, { requestConfirmation });

      await expect(page.state.beforeClose({ lifecycle: 1, opener: null })).resolves.toBe(false);
      expect(page.locationSelect.value).toBe('chapter:2');

      await expect(page.state.beforeClose({ lifecycle: 1, opener: null })).resolves.toBe(true);
      expect(page.locationSelect.value).toBe('');
      expect(noteDialogIsDirty(page.form, page.baseline)).toBe(false);
    });

    it('restores a saved location that is still offered, and the placeholder when it is gone', async () => {
      const { resetNoteDialogToBaseline } = await import('../src/static/client/note-dialog-dirty.js');
      const kept = makeFixture({ location: 'book:1' });
      kept.locationSelect.value = 'chapter:2';
      resetNoteDialogToBaseline(kept.form);
      expect(kept.locationSelect.value).toBe('book:1');

      const gone = makeFixture({ location: 'chapter:9' });
      gone.locationSelect.value = 'book:1';
      resetNoteDialogToBaseline(gone.form);
      expect(gone.locationSelect.value).toBe('');
    });

    it('leaves a dialog without a Note location unaffected by any location field', () => {
      const page = makeFixture();
      page.locationSelect.value = 'chapter:2';
      expect(noteDialogIsDirty(page.form, page.baseline)).toBe(false);
    });
  });
});
