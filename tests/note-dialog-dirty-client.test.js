import { describe, expect, it, vi } from 'vitest';
import {
  enhanceNoteDialogUnsavedChanges,
  noteDialogIsDirty,
} from '../src/static/creatorcrate.js';

function makeFixture() {
  const baseline = {
    title: 'Original title',
    content: '# Original',
    projectIds: ['2', '1'],
    assetIds: ['20', '10'],
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
});
