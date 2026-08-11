import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enhanceNotesAssetPicker } from '../src/static/creatorcrate.js';

function dataKey(attribute) {
  return attribute.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

class FakeElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    this.children = [];
    this.listeners = [];
    this._textContent = '';
    this.parentNode = null;
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.className = '';
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.replaceChildren();
    this._textContent = String(value);
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === 'id') this.id = stringValue;
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = stringValue;
    if (name === 'hidden') this.hidden = true;
    if (name === 'disabled') this.disabled = true;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith('data-')) delete this.dataset[dataKey(name)];
    if (name === 'hidden') this.hidden = false;
    if (name === 'disabled') this.disabled = false;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    child.parentNode = this;
    const index = this.children.indexOf(reference);
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  replaceChildren(...children) {
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    this._textContent = '';
    children.forEach((child) => this.appendChild(child));
  }

  addEventListener(type, handler) {
    this.listeners.push({ type, handler });
  }

  dispatch(type, props = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...props,
    };
    this.listeners.filter((listener) => listener.type === type)
      .forEach((listener) => listener.handler(event));
    return event;
  }

  matches(selector) {
    const candidate = selector.trim();
    if (candidate.startsWith('#')) return this.id === candidate.slice(1);
    if (candidate.startsWith('.')) {
      return this.className.split(/\s+/).includes(candidate.slice(1));
    }
    const attribute = candidate.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
    if (attribute) {
      const value = this.getAttribute(attribute[1]);
      return value !== null && (attribute[2] === undefined || value === attribute[2]);
    }
    return this.tagName.toLowerCase() === candidate.toLowerCase();
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      node.children.forEach((child) => {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      });
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super(null, 'document');
    this.ownerDocument = this;
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }
}

function makePickerFixture() {
  const document = new FakeDocument();
  const root = document.createElement('main');
  document.appendChild(root);

  const form = document.createElement('form');
  form.setAttribute('id', 'note-form');
  const emptyAssetId = document.createElement('input');
  emptyAssetId.type = 'hidden';
  emptyAssetId.name = 'assetIds[]';
  emptyAssetId.value = '';
  const selectedAssetId = document.createElement('input');
  selectedAssetId.type = 'checkbox';
  selectedAssetId.name = 'assetIds[]';
  selectedAssetId.value = '41';
  selectedAssetId.checked = true;
  selectedAssetId.setAttribute('id', 'note-asset-option-41');
  selectedAssetId.setAttribute('aria-label', 'Deselect existing.png');
  const selectedAssets = document.createElement('ul');
  selectedAssets.className = 'notes-selected-assets';
  const selectedRow = document.createElement('li');
  selectedRow.className = 'notes-selected-asset';
  const selectedLabel = document.createElement('label');
  selectedLabel.className = 'notes-selected-asset-control';
  const selectedDetails = document.createElement('span');
  selectedDetails.className = 'notes-selected-asset-details';
  const selectedFilename = document.createElement('span');
  selectedFilename.className = 'notes-selected-asset-filename';
  selectedFilename.textContent = 'existing.png';
  selectedDetails.appendChild(selectedFilename);
  const selectedProject = document.createElement('span');
  selectedProject.className = 'notes-selected-asset-project';
  selectedProject.textContent = 'Project: Hydrated project';
  selectedDetails.appendChild(selectedProject);
  const selectedPath = document.createElement('span');
  selectedPath.className = 'notes-selected-asset-path';
  selectedPath.textContent = 'Path: source/existing.png';
  selectedDetails.appendChild(selectedPath);
  const selectedArchived = document.createElement('span');
  selectedArchived.className = 'notes-selected-asset-state notes-selected-asset-state--archived';
  selectedArchived.textContent = 'Archived project';
  selectedDetails.appendChild(selectedArchived);
  const selectedMissing = document.createElement('span');
  selectedMissing.className = 'notes-selected-asset-state notes-selected-asset-state--missing';
  selectedMissing.textContent = 'Missing';
  selectedDetails.appendChild(selectedMissing);
  selectedLabel.appendChild(selectedAssetId);
  selectedLabel.appendChild(selectedDetails);
  selectedRow.appendChild(selectedLabel);
  selectedAssets.appendChild(selectedRow);
  const emptySelectedAssets = document.createElement('p');
  emptySelectedAssets.className = 'notes-selected-assets-empty';
  emptySelectedAssets.textContent = 'No assets selected.';
  emptySelectedAssets.hidden = true;
  emptySelectedAssets.setAttribute('hidden', '');
  form.appendChild(emptyAssetId);
  form.appendChild(selectedAssets);
  form.appendChild(emptySelectedAssets);
  root.appendChild(form);

  const host = document.createElement('div');
  host.setAttribute('data-notes-asset-picker', '');
  host.setAttribute('data-projects-url', '/notes/asset-picker/projects');
  host.setAttribute('data-assets-url', '/notes/asset-picker/assets');
  host.setAttribute('data-note-form-id', 'note-form');

  const noJs = document.createElement('p');
  noJs.className = 'notes-asset-picker-no-js';
  const projectSearch = document.createElement('input');
  projectSearch.setAttribute('id', 'note-asset-picker-project-search');
  const projectResults = document.createElement('ul');
  projectResults.setAttribute('id', 'note-asset-picker-project-results');
  const assetSearch = document.createElement('input');
  assetSearch.setAttribute('id', 'note-asset-picker-asset-search');
  assetSearch.setAttribute('disabled', '');
  const assetResults = document.createElement('ul');
  assetResults.setAttribute('id', 'note-asset-picker-asset-results');
  const loadMoreContainer = document.createElement('div');
  loadMoreContainer.className = 'notes-asset-picker-load-more';
  const loadMoreButton = document.createElement('button');
  loadMoreButton.type = 'button';
  loadMoreButton.textContent = 'Load more';
  loadMoreContainer.appendChild(loadMoreButton);
  const status = document.createElement('p');
  status.setAttribute('id', 'note-asset-picker-status');
  const error = document.createElement('p');
  error.setAttribute('id', 'note-asset-picker-error');

  host.appendChild(noJs);
  host.appendChild(projectSearch);
  host.appendChild(projectResults);
  host.appendChild(assetSearch);
  host.appendChild(assetResults);
  host.appendChild(loadMoreContainer);
  host.appendChild(status);
  host.appendChild(error);
  root.appendChild(host);

  return {
    document,
    root,
    form,
    selectedAssets,
    emptySelectedAssets,
    host,
    noJs,
    projectSearch,
    projectResults,
    assetSearch,
    assetResults,
    loadMoreButton,
    status,
    error,
    assetControls: [emptyAssetId, selectedAssetId],
  };
}

function responseWithProjects(items) {
  return { ok: true, json: async () => ({ items, nextCursor: 'ignored' }) };
}

function responseWithAssets(items, nextCursor = null) {
  return {
    ok: true,
    json: async () => ({
      project: { id: 1, title: 'Picker project', archived: false },
      items,
      nextCursor,
    }),
  };
}

async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe('Notes asset-picker project discovery', () => {
  let originalFetch;

  beforeEach(() => {
    vi.useFakeTimers();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('does not request projects before two trimmed characters', async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);

    fixture.projectSearch.value = ' a ';
    fixture.projectSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(500);

    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.status.textContent).toBe('Type at least 2 characters to search projects.');
  });

  it('debounces project requests and uses the configured encoded endpoint with a capped query', async () => {
    const fetch = vi.fn().mockResolvedValue(responseWithProjects([]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);

    fixture.projectSearch.value = ` Alpha & ${'x'.repeat(120)} `;
    fixture.projectSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(249);
    expect(fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toContain('/notes/asset-picker/projects?q=Alpha%20%26%20');
    expect(new URL(url, 'http://creatorcrate.test').searchParams.get('q')).toHaveLength(100);
    expect(options).toEqual(expect.objectContaining({ method: 'GET', credentials: 'same-origin' }));
    await settle();
  });

  it('renders returned projects and their archived marker', async () => {
    const fetch = vi.fn().mockResolvedValue(responseWithProjects([
      { id: 7, title: 'Concept & Color', archived: false },
      { id: 8, title: 'Old Studies', archived: true },
    ]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);

    fixture.projectSearch.value = 'studies';
    fixture.projectSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();

    const buttons = fixture.projectResults.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toBe('Concept & Color');
    expect(buttons[1].textContent).toBe('Old Studies (Archived)');
    expect(fixture.status.textContent).toBe('2 project results.');
    expect(fixture.noJs.hidden).toBe(true);
  });

  it('reports no results and request failures locally', async () => {
    const fetch = vi.fn().mockResolvedValue(responseWithProjects([]));
    globalThis.fetch = fetch;
    const noResults = makePickerFixture();
    enhanceNotesAssetPicker(noResults.root);
    noResults.projectSearch.value = 'none';
    noResults.projectSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(noResults.status.textContent).toBe('No projects found.');
    expect(noResults.projectResults.querySelectorAll('button')).toHaveLength(0);

    fetch.mockRejectedValueOnce(new Error('offline'));
    noResults.projectSearch.value = 'retry';
    noResults.projectSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(noResults.status.textContent).toBe('Project search failed.');
    expect(noResults.error.textContent).toBe('Could not search projects. Try again.');
  });

  it('aborts the old request and ignores its response after a newer query', async () => {
    const requests = [];
    const fetch = vi.fn((url, options) => new Promise((resolve) => {
      requests.push({ url, options, resolve });
    }));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);

    fixture.projectSearch.value = 'old';
    fixture.projectSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    fixture.projectSearch.value = 'new';
    fixture.projectSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);

    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);

    requests[0].resolve(responseWithProjects([{ id: 1, title: 'Old result', archived: false }]));
    await settle();
    expect(fixture.projectResults.querySelectorAll('button')).toHaveLength(0);

    requests[1].resolve(responseWithProjects([{ id: 2, title: 'New result', archived: false }]));
    await settle();
    expect(fixture.projectResults.querySelectorAll('button')[0].textContent).toBe('New result');
  });

  it('selects and changes projects without touching existing asset controls', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 1, title: 'First project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([]))
      .mockResolvedValueOnce(responseWithProjects([{ id: 2, title: 'Second project', archived: true }]))
      .mockResolvedValueOnce(responseWithAssets([]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);

    fixture.projectSearch.value = 'first';
    fixture.projectSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();

    fixture.assetSearch.value = 'stale asset query';
    fixture.assetResults.appendChild(fixture.document.createElement('li'));
    const before = fixture.assetControls.map((control) => ({
      value: control.value,
      checked: control.checked,
      disabled: control.disabled,
    }));
    fixture.projectResults.querySelectorAll('button')[0].dispatch('click');

    expect(fixture.host.notesAssetPickerState.selectedProject).toEqual({
      id: '1', title: 'First project', archived: false,
    });
    expect(fixture.host.querySelector('[data-notes-asset-picker-selected-project]').textContent)
      .toBe('Selected project: First project');
    expect(fixture.assetSearch.disabled).toBe(false);
    expect(fixture.assetSearch.value).toBe('');
    expect(fixture.assetResults.children).toHaveLength(0);
    expect(fixture.projectResults.children).toHaveLength(0);

    fixture.projectSearch.value = 'second';
    fixture.projectSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    fixture.assetSearch.value = 'future stale query';
    fixture.assetResults.appendChild(fixture.document.createElement('li'));
    fixture.projectResults.querySelectorAll('button')[0].dispatch('click');

    expect(fixture.host.dataset.selectedProjectId).toBe('2');
    expect(fixture.host.querySelector('[data-notes-asset-picker-selected-project]').textContent)
      .toBe('Selected project: Second project (Archived)');
    expect(fixture.assetSearch.value).toBe('');
    expect(fixture.assetResults.children).toHaveLength(0);
    expect(fixture.assetControls.map((control) => ({
      value: control.value,
      checked: control.checked,
      disabled: control.disabled,
    }))).toEqual(before);
  });

  it('does not initialize or request outside a picker host', async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch;
    const scope = { querySelectorAll: vi.fn(() => []) };

    expect(enhanceNotesAssetPicker(scope)).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).not.toHaveBeenCalled();
    expect(scope.querySelectorAll).toHaveBeenCalledWith('[data-notes-asset-picker]');
  });
});

describe('Notes asset-picker asset browse and search', () => {
  let originalFetch;

  beforeEach(() => {
    vi.useFakeTimers();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  async function selectProject(fixture, project = { id: 7, title: 'Picker project', archived: false }) {
    fixture.projectSearch.value = 'picker';
    fixture.projectSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    fixture.projectResults.querySelectorAll('button')[0].dispatch('click');
    await settle();
  }

  function assetRequests(fetch) {
    return fetch.mock.calls.filter(([url]) => (
      new URL(url, 'http://creatorcrate.test').pathname === '/notes/asset-picker/assets'
    ));
  }

  function selectedAssetControls(fixture) {
    return fixture.form.querySelectorAll('input')
      .filter((control) => control.name === 'assetIds[]' && control.value !== '');
  }

  function selectedAssetIds(fixture) {
    return selectedAssetControls(fixture)
      .filter((control) => control.checked === true && control.disabled !== true)
      .map((control) => control.value);
  }

  function candidateRow(fixture, assetId) {
    return fixture.assetResults.querySelector(`[data-asset-id="${assetId}"]`);
  }

  function selectedRow(fixture, assetId) {
    return fixture.selectedAssets.querySelector(`[data-notes-selected-asset-id="${assetId}"]`)
      || fixture.selectedAssets.querySelectorAll('.notes-selected-asset').find((row) => (
        row.querySelector('input')?.value === String(assetId)
      ))
      || null;
  }

  it('browses the selected project with an empty query and renders bounded assets', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 41, filename: 'cover.png', relativePath: 'cover.png', isPresent: true },
        { id: 42, filename: 'missing.bin', relativePath: 'exports/missing.bin', isPresent: false },
      ], 'browse-next'));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);

    await selectProject(fixture);

    const requests = assetRequests(fetch);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0][0], 'http://creatorcrate.test');
    expect(url.searchParams.get('projectId')).toBe('7');
    expect(url.searchParams.get('q')).toBe('');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(fixture.assetSearch.disabled).toBe(false);
    expect(fixture.assetResults.querySelectorAll('[data-asset-id]')).toHaveLength(2);
    expect(fixture.assetResults.textContent).toContain('cover.png');
    expect(fixture.assetResults.textContent).toContain('Path: exports/missing.bin');
    expect(fixture.assetResults.textContent).toContain('Missing');
    expect(fixture.loadMoreButton.disabled).toBe(false);
    expect(fixture.status.textContent).toBe('2 asset results.');
  });

  it('debounces, trims, caps, and encodes asset search queries', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 43, filename: 'folder-result.png', relativePath: 'folder-result.png', isPresent: true },
    ]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);

    fixture.assetSearch.value = `  folder & ${'x'.repeat(120)} `;
    fixture.assetSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(249);
    expect(assetRequests(fetch)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await settle();

    const requests = assetRequests(fetch);
    expect(requests).toHaveLength(2);
    const url = new URL(requests[1][0], 'http://creatorcrate.test');
    expect(url.searchParams.get('projectId')).toBe('7');
    expect(url.searchParams.get('q')).toHaveLength(100);
    expect(url.searchParams.get('q')).toMatch(/^folder & /);
    expect(requests[1][0]).toContain('q=folder%20%26%20');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(fixture.assetResults.textContent).toContain('folder-result.png');
  });

  it('cancels asset searches and ignores stale responses', async () => {
    const requests = [];
    const fetch = vi.fn((url, options) => {
      if (new URL(url, 'http://creatorcrate.test').pathname === '/notes/asset-picker/projects') {
        return Promise.resolve(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]));
      }
      return new Promise((resolve) => requests.push({ url, options, resolve }));
    });
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);
    expect(requests).toHaveLength(1);
    requests[0].resolve(responseWithAssets([]));
    await settle();

    fixture.assetSearch.value = 'old';
    fixture.assetSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    fixture.assetSearch.value = 'new';
    fixture.assetSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);

    expect(requests).toHaveLength(3);
    expect(requests[1].options.signal.aborted).toBe(true);
    requests[1].resolve(responseWithAssets([
      { id: 44, filename: 'old.png', relativePath: 'old.png', isPresent: true },
    ]));
    await settle();
    expect(fixture.assetResults.querySelectorAll('[data-asset-id]')).toHaveLength(0);

    requests[2].resolve(responseWithAssets([
      { id: 45, filename: 'new.png', relativePath: 'new.png', isPresent: true },
    ]));
    await settle();
    expect(fixture.assetResults.textContent).toContain('new.png');
    expect(fixture.assetResults.textContent).not.toContain('old.png');
  });

  it('deduplicates asset IDs and keeps result rows keyboard-readable', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 46, filename: 'same.png', relativePath: 'same.png', isPresent: true },
        { id: 46, filename: 'same.png', relativePath: 'duplicate/same.png', isPresent: true },
        { id: 47, filename: 'other.png', relativePath: 'other.png', isPresent: false },
      ]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);

    const rows = fixture.assetResults.querySelectorAll('[data-asset-id]');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute('data-asset-id'))).toEqual(['46', '47']);
    expect(rows.every((row) => row.tabIndex === 0)).toBe(true);
    expect(fixture.assetResults.textContent).toContain('Missing');
  });

  it('reports no assets and asset request failures without changing selected controls', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    const before = fixture.assetControls.map((control) => ({
      value: control.value,
      checked: control.checked,
      disabled: control.disabled,
    }));
    await selectProject(fixture);
    expect(fixture.status.textContent).toBe('No assets found.');
    expect(fixture.assetResults.children).toHaveLength(0);

    fetch.mockRejectedValueOnce(new Error('offline'));
    fixture.assetSearch.value = 'broken';
    fixture.assetSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();

    expect(fixture.status.textContent).toBe('Asset search failed.');
    expect(fixture.error.textContent).toBe('Could not load project assets. Try again.');
    expect(fixture.assetControls.map((control) => ({
      value: control.value,
      checked: control.checked,
      disabled: control.disabled,
    }))).toEqual(before);
  });

  it('propagates opaque cursors, appends load-more results, and prevents repeated requests', async () => {
    let resolveMore;
    const fetch = vi.fn((url) => {
      const path = new URL(url, 'http://creatorcrate.test').pathname;
      if (path === '/notes/asset-picker/projects') {
        return Promise.resolve(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]));
      }
      if (assetRequests(fetch).length === 1) {
        return Promise.resolve(responseWithAssets([
          { id: 48, filename: 'first.png', relativePath: 'first.png', isPresent: true },
          { id: 49, filename: 'overlap.png', relativePath: 'overlap.png', isPresent: true },
        ], 'opaque-cursor-1'));
      }
      return new Promise((resolve) => { resolveMore = resolve; });
    });
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);
    const before = fixture.assetControls.map((control) => ({ value: control.value, checked: control.checked }));

    fixture.loadMoreButton.dispatch('click');
    fixture.loadMoreButton.dispatch('click');
    await settle();

    const requests = assetRequests(fetch);
    expect(requests).toHaveLength(2);
    const moreUrl = new URL(requests[1][0], 'http://creatorcrate.test');
    expect(moreUrl.searchParams.get('projectId')).toBe('7');
    expect(moreUrl.searchParams.get('q')).toBe('');
    expect(moreUrl.searchParams.get('cursor')).toBe('opaque-cursor-1');
    expect(fixture.loadMoreButton.disabled).toBe(true);

    resolveMore(responseWithAssets([
      { id: 49, filename: 'overlap.png', relativePath: 'overlap.png', isPresent: true },
      { id: 50, filename: 'second.png', relativePath: 'nested/second.png', isPresent: true },
    ]));
    await settle();

    expect(fixture.assetResults.querySelectorAll('[data-asset-id]')).toHaveLength(3);
    expect(fixture.assetResults.textContent).toContain('second.png');
    expect(fixture.loadMoreButton.disabled).toBe(true);
    expect(fixture.status.textContent).toBe('3 asset results.');
    expect(fixture.assetControls.map((control) => ({ value: control.value, checked: control.checked }))).toEqual(before);
  });

  it('resets results and cursor for query changes, including cleared browse', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 51, filename: 'browse.png', relativePath: 'browse.png', isPresent: true },
      ], 'browse-cursor'))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 52, filename: 'needle.png', relativePath: 'needle.png', isPresent: true },
      ], 'search-cursor'))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 53, filename: 'cleared.png', relativePath: 'cleared.png', isPresent: true },
      ]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);

    fixture.assetSearch.value = 'needle';
    fixture.assetSearch.dispatch('input');
    expect(fixture.assetResults.children).toHaveLength(0);
    expect(fixture.loadMoreButton.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(fixture.assetResults.textContent).toContain('needle.png');
    expect(new URL(assetRequests(fetch)[1][0], 'http://creatorcrate.test').searchParams.get('cursor')).toBeNull();

    fixture.assetSearch.value = '   ';
    fixture.assetSearch.dispatch('input');
    expect(fixture.assetResults.children).toHaveLength(0);
    expect(fixture.loadMoreButton.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    await settle();

    const requests = assetRequests(fetch);
    const clearedUrl = new URL(requests[2][0], 'http://creatorcrate.test');
    expect(clearedUrl.searchParams.get('q')).toBe('');
    expect(clearedUrl.searchParams.has('cursor')).toBe(false);
    expect(fixture.assetResults.textContent).toContain('cleared.png');
  });

  it('resets candidates and cursor when switching projects without touching asset IDs', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'First project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 54, filename: 'first.png', relativePath: 'first.png', isPresent: true },
      ], 'first-cursor'))
      .mockResolvedValueOnce(responseWithProjects([{ id: 8, title: 'Second project', archived: true }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 55, filename: 'second.png', relativePath: 'second.png', isPresent: true },
      ]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    const before = fixture.assetControls.map((control) => ({ value: control.value, checked: control.checked }));
    await selectProject(fixture, { id: 7, title: 'First project', archived: false });
    expect(fixture.assetResults.textContent).toContain('first.png');

    fixture.projectSearch.value = 'second';
    fixture.projectSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    fixture.projectResults.querySelectorAll('button')[0].dispatch('click');
    expect(fixture.assetResults.children).toHaveLength(0);
    expect(fixture.loadMoreButton.disabled).toBe(true);
    expect(fixture.assetSearch.value).toBe('');
    await settle();

    const requests = assetRequests(fetch);
    const secondBrowseUrl = new URL(requests[1][0], 'http://creatorcrate.test');
    expect(secondBrowseUrl.searchParams.get('projectId')).toBe('8');
    expect(secondBrowseUrl.searchParams.get('q')).toBe('');
    expect(secondBrowseUrl.searchParams.has('cursor')).toBe(false);
    expect(fixture.assetResults.textContent).toContain('second.png');
    expect(fixture.assetControls.map((control) => ({ value: control.value, checked: control.checked }))).toEqual(before);
  });

  it('retains the first page and retries after a failed load-more request', async () => {
    let assetCall = 0;
    const fetch = vi.fn((url) => {
      const path = new URL(url, 'http://creatorcrate.test').pathname;
      if (path === '/notes/asset-picker/projects') {
        return Promise.resolve(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]));
      }
      assetCall += 1;
      if (assetCall === 1) {
        return Promise.resolve(responseWithAssets([
          { id: 56, filename: 'first.png', relativePath: 'first.png', isPresent: true },
        ], 'retry-cursor'));
      }
      if (assetCall === 2) return Promise.reject(new Error('offline'));
      return Promise.resolve(responseWithAssets([
        { id: 57, filename: 'retry-success.png', relativePath: 'retry-success.png', isPresent: true },
      ]));
    });
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);

    fixture.loadMoreButton.dispatch('click');
    await settle();
    expect(fixture.assetResults.textContent).toContain('first.png');
    expect(fixture.assetResults.textContent).not.toContain('retry-success.png');
    expect(fixture.loadMoreButton.disabled).toBe(false);
    expect(fixture.status.textContent).toBe('Loading more assets failed.');
    expect(fixture.error.textContent).toBe('Could not load more assets. Try again.');

    fixture.loadMoreButton.dispatch('click');
    await settle();
    expect(fixture.assetResults.querySelectorAll('[data-asset-id]')).toHaveLength(2);
    expect(fixture.assetResults.textContent).toContain('retry-success.png');
    expect(fixture.loadMoreButton.disabled).toBe(true);
    expect(fixture.error.textContent).toBe('');
  });

  it('adds exactly one candidate control and selected row, then restores Add after removal', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 42, filename: 'added.png', relativePath: 'renders/added.png', isPresent: true },
      ]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);

    const candidate = candidateRow(fixture, 42);
    const add = candidate.querySelector('button');
    add.dispatch('click');
    add.dispatch('click');

    expect(selectedAssetIds(fixture)).toEqual(['41', '42']);
    expect(selectedAssetControls(fixture).filter((control) => control.value === '42')).toHaveLength(1);
    expect(fixture.selectedAssets.querySelectorAll('.notes-selected-asset')).toHaveLength(2);
    expect(selectedRow(fixture, 42).textContent).toContain('added.png');
    expect(selectedRow(fixture, 42).textContent).toContain('Project: Picker project');
    expect(selectedRow(fixture, 42).textContent).toContain('Path: renders/added.png');
    expect(add.textContent).toBe('Selected');
    expect(add.disabled).toBe(true);

    const selectedControl = selectedRow(fixture, 42).querySelector('input');
    selectedControl.checked = false;
    selectedControl.dispatch('change');
    expect(selectedAssetIds(fixture)).toEqual(['41']);
    expect(selectedRow(fixture, 42)).toBeNull();
    expect(add.textContent).toBe('Add');
    expect(add.disabled).toBe(false);
  });

  it('supports multiple selections while removing only the requested asset', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 42, filename: 'first.png', relativePath: 'first.png', isPresent: true },
        { id: 43, filename: 'second.png', relativePath: 'second.png', isPresent: true },
      ]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);

    candidateRow(fixture, 42).querySelector('button').dispatch('click');
    candidateRow(fixture, 43).querySelector('button').dispatch('click');
    expect(selectedAssetIds(fixture)).toEqual(['41', '42', '43']);

    selectedRow(fixture, 42).querySelector('[data-notes-asset-picker-remove]').dispatch('click');
    expect(selectedAssetIds(fixture)).toEqual(['41', '43']);
    expect(candidateRow(fixture, 42).querySelector('button').textContent).toBe('Add');
    expect(candidateRow(fixture, 43).querySelector('button').textContent).toBe('Selected');
    expect(candidateRow(fixture, 43).querySelector('button').disabled).toBe(true);
  });

  it('leaves only the empty sentinel after clearing every selection', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 41, filename: 'existing.png', relativePath: 'existing.png', isPresent: true },
      ]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);

    selectedRow(fixture, 41).querySelector('[data-notes-asset-picker-remove]').dispatch('click');
    expect(selectedAssetIds(fixture)).toEqual([]);
    expect(selectedAssetControls(fixture)).toHaveLength(0);
    expect(fixture.assetControls[0].name).toBe('assetIds[]');
    expect(fixture.assetControls[0].value).toBe('');
    expect(fixture.emptySelectedAssets.hidden).toBe(false);
    expect(candidateRow(fixture, 41).querySelector('button').textContent).toBe('Add');
  });

  it('initializes hydrated selections and preserves their server metadata', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 41, filename: 'candidate.png', relativePath: 'candidate.png', isPresent: true },
    ]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    const duplicate = fixture.document.createElement('input');
    duplicate.type = 'checkbox';
    duplicate.name = 'assetIds[]';
    duplicate.value = '41';
    duplicate.checked = true;
    fixture.form.appendChild(duplicate);
    enhanceNotesAssetPicker(fixture.root);
    expect(fetch).not.toHaveBeenCalled();
    await selectProject(fixture);

    const candidate = candidateRow(fixture, 41);
    expect(candidate.querySelector('button').textContent).toBe('Selected');
    expect(candidate.querySelector('button').disabled).toBe(true);
    expect(fixture.selectedAssets.textContent).toContain('existing.png');
    expect(fixture.selectedAssets.textContent).toContain('Hydrated project');
    expect(fixture.selectedAssets.textContent).toContain('Path: source/existing.png');
    expect(fixture.selectedAssets.textContent).toContain('Archived project');
    expect(fixture.selectedAssets.textContent).toContain('Missing');
    expect(fixture.selectedAssets.querySelectorAll('.notes-selected-asset')).toHaveLength(1);
    expect(selectedAssetControls(fixture).filter((control) => control.value === '41')).toHaveLength(1);
  });

  it('marks a hydrated selection when the candidate appears after a query change', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 41, filename: 'later.png', relativePath: 'later.png', isPresent: true },
      ]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);

    fixture.assetSearch.value = 'later';
    fixture.assetSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();

    expect(candidateRow(fixture, 41).querySelector('button').textContent).toBe('Selected');
    expect(selectedAssetIds(fixture)).toEqual(['41']);
  });

  it('uses the selected project state for archived and missing added-asset metadata', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'Archived picker project', archived: true }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 42, filename: 'missing.png', relativePath: 'exports/missing.png', isPresent: false },
      ]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);

    candidateRow(fixture, 42).querySelector('button').dispatch('click');
    expect(selectedRow(fixture, 42).textContent).toContain('missing.png');
    expect(selectedRow(fixture, 42).textContent).toContain('Project: Archived picker project');
    expect(selectedRow(fixture, 42).textContent).toContain('Path: exports/missing.png');
    expect(selectedRow(fixture, 42).textContent).toContain('Archived project');
    expect(selectedRow(fixture, 42).textContent).toContain('Missing');
  });

  it('retains added selections when a later asset request fails', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'Picker project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 42, filename: 'kept.png', relativePath: 'kept.png', isPresent: true },
      ]))
      .mockRejectedValueOnce(new Error('offline'));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);
    candidateRow(fixture, 42).querySelector('button').dispatch('click');

    fixture.assetSearch.value = 'offline';
    fixture.assetSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();

    expect(selectedAssetIds(fixture)).toEqual(['41', '42']);
    expect(fixture.error.textContent).toBe('Could not load project assets. Try again.');
  });

  it('preserves controls across project, query, and pagination changes', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(responseWithProjects([{ id: 7, title: 'First project', archived: false }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 42, filename: 'first.png', relativePath: 'first.png', isPresent: true },
      ], 'next'))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 43, filename: 'search.png', relativePath: 'search.png', isPresent: true },
      ]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 42, filename: 'cleared.png', relativePath: 'cleared.png', isPresent: true },
      ], 'page-two'))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 44, filename: 'page-two.png', relativePath: 'page-two.png', isPresent: true },
      ]))
      .mockResolvedValueOnce(responseWithProjects([{ id: 8, title: 'Second project', archived: true }]))
      .mockResolvedValueOnce(responseWithAssets([
        { id: 45, filename: 'second-project.png', relativePath: 'second-project.png', isPresent: true },
      ]));
    globalThis.fetch = fetch;
    const fixture = makePickerFixture();
    enhanceNotesAssetPicker(fixture.root);
    await selectProject(fixture);

    candidateRow(fixture, 42).querySelector('button').dispatch('click');
    fixture.assetSearch.value = 'search';
    fixture.assetSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(selectedAssetIds(fixture)).toEqual(['41', '42']);

    fixture.assetSearch.value = '';
    fixture.assetSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(candidateRow(fixture, 42).querySelector('button').textContent).toBe('Selected');
    fixture.loadMoreButton.dispatch('click');
    await settle();
    expect(selectedAssetIds(fixture)).toEqual(['41', '42']);
    expect(candidateRow(fixture, 44).querySelector('button').textContent).toBe('Add');

    fixture.projectSearch.value = 'second';
    fixture.projectSearch.dispatch('input');
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    fixture.projectResults.querySelector('button').dispatch('click');
    await settle();
    expect(selectedAssetIds(fixture)).toEqual(['41', '42']);
    expect(candidateRow(fixture, 45).querySelector('button').textContent).toBe('Add');
  });
});
