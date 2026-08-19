import { hideElement, isEnhancementBound, markEnhancementBound, showElement } from './dom.js';

const NOTES_ASSET_PICKER_SELECTOR = '[data-notes-asset-picker]';
const NOTES_ASSET_PICKER_PROJECT_SEARCH_SELECTOR = '#note-asset-picker-project-search';
const NOTES_ASSET_PICKER_PROJECT_RESULTS_SELECTOR = '#note-asset-picker-project-results';
const NOTES_ASSET_PICKER_ASSET_SEARCH_SELECTOR = '#note-asset-picker-asset-search';
const NOTES_ASSET_PICKER_ASSET_RESULTS_SELECTOR = '#note-asset-picker-asset-results';
const NOTES_ASSET_PICKER_LOAD_MORE_SELECTOR = '.notes-asset-picker-load-more';
const NOTES_ASSET_PICKER_STATUS_SELECTOR = '#note-asset-picker-status';
const NOTES_ASSET_PICKER_ERROR_SELECTOR = '#note-asset-picker-error';
const NOTES_ASSET_PICKER_SELECTED_PROJECT_SELECTOR = '[data-notes-asset-picker-selected-project]';
const NOTES_ASSET_PICKER_NO_JS_SELECTOR = '.notes-asset-picker-no-js';
const NOTES_SELECTED_ASSETS_SELECTOR = '.notes-selected-assets';
const NOTES_SELECTED_ASSET_SELECTOR = '.notes-selected-asset';
const NOTES_SELECTED_ASSETS_EMPTY_SELECTOR = '.notes-selected-assets-empty';
const NOTES_ASSET_PICKER_REMOVE_SELECTOR = '[data-notes-asset-picker-remove]';
const NOTES_ASSET_PICKER_ADD_SELECTOR = '[data-notes-asset-picker-add]';
const NOTES_ASSET_PICKER_DEBOUNCE_MS = 250;
const NOTES_ASSET_PICKER_MIN_QUERY_LENGTH = 2;
const NOTES_ASSET_PICKER_MAX_QUERY_LENGTH = 100;

function notesAssetPickerDocument(host) {
  return host?.ownerDocument || globalThis.document;
}

function clearNotesAssetPickerElement(element) {
  if (!element) return;
  if (typeof element.replaceChildren === 'function') {
    element.replaceChildren();
    return;
  }
  while (element.firstChild && typeof element.removeChild === 'function') {
    element.removeChild(element.firstChild);
  }
}

function setNotesAssetPickerDisabled(control, disabled) {
  if (!control) return;
  control.disabled = disabled;
  if (disabled) control.setAttribute?.('disabled', '');
  else control.removeAttribute?.('disabled');
}

function notesAssetPickerStatus(state, message) {
  if (state.status && state.status.textContent !== message) state.status.textContent = message;
}

function notesAssetPickerError(state, message) {
  if (state.error && state.error.textContent !== message) state.error.textContent = message;
}

function notesAssetPickerQuery(input) {
  return String(input?.value || '')
    .trim()
    .slice(0, NOTES_ASSET_PICKER_MAX_QUERY_LENGTH);
}

function notesAssetPickerRequestUrl(endpoint, params) {
  const endpointString = String(endpoint || '');
  const hashIndex = endpointString.indexOf('#');
  const base = hashIndex === -1 ? endpointString : endpointString.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : endpointString.slice(hashIndex);
  const separator = base.includes('?')
    ? (base.endsWith('?') || base.endsWith('&') ? '' : '&')
    : '?';
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${base}${separator}${query}${hash}`;
}

function notesAssetPickerSelectedProjectElement(state) {
  const existing = state.host.querySelector?.(NOTES_ASSET_PICKER_SELECTED_PROJECT_SELECTOR);
  if (existing) return existing;

  const document = notesAssetPickerDocument(state.host);
  if (!document || typeof document.createElement !== 'function') return null;

  const selected = document.createElement('p');
  selected.className = 'notes-asset-picker-selected-project';
  selected.setAttribute('data-notes-asset-picker-selected-project', '');
  hideElement(selected);

  const parent = state.projectResults.parentNode;
  if (parent && typeof parent.insertBefore === 'function') parent.insertBefore(selected, state.projectResults);
  else state.host.appendChild?.(selected);
  return selected;
}

function notesAssetPickerProjectTitle(project) {
  const title = project?.title;
  if (typeof title === 'string' && title.length > 0) return title;
  return `Project ${project?.id ?? ''}`.trim();
}

function renderNotesAssetPickerProjects(state, projects) {
  clearNotesAssetPickerElement(state.projectResults);
  const document = notesAssetPickerDocument(state.host);
  if (!document || typeof document.createElement !== 'function') return;

  projects.forEach((project) => {
    if (!project || project.id === undefined || project.id === null) return;

    const item = document.createElement('li');
    item.className = 'notes-asset-picker-result';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-secondary notes-asset-picker-result-control';

    const title = document.createElement('span');
    title.className = 'notes-asset-picker-result-title';
    title.textContent = notesAssetPickerProjectTitle(project);
    button.appendChild(title);

    const archived = Boolean(project.archived);
    if (archived) {
      const marker = document.createElement('span');
      marker.className = 'notes-asset-picker-result-state';
      marker.textContent = ' (Archived)';
      button.appendChild(marker);
    }

    button.addEventListener('click', () => selectNotesAssetPickerProject(state, project));
    item.appendChild(button);
    state.projectResults.appendChild(item);
  });
}

function notesAssetPickerAssetId(asset) {
  if (!asset || asset.id === undefined || asset.id === null) return null;
  return String(asset.id);
}

function notesAssetPickerAssetFilename(asset) {
  if (typeof asset?.filename === 'string' && asset.filename.length > 0) return asset.filename;
  return `Asset ${asset?.id ?? ''}`.trim();
}

function notesAssetPickerFormControls(state) {
  const controls = state.form?.elements
    ? Array.from(state.form.elements)
    : (state.form?.querySelectorAll?.('input') || []);
  return controls.filter((control) => control?.name === 'assetIds[]');
}

function notesAssetPickerControlId(control) {
  if (!control || control.name !== 'assetIds[]' || control.value === undefined || control.value === null) {
    return null;
  }
  const value = String(control.value);
  return value.length > 0 ? value : null;
}

function notesAssetPickerSelectedIds(state) {
  return new Set(
    notesAssetPickerFormControls(state)
      .map((control) => (
        control.checked === true && control.disabled !== true
          ? notesAssetPickerControlId(control)
          : null
      ))
      .filter((assetId) => assetId !== null),
  );
}

function notesAssetPickerRowForControl(state, control) {
  const closest = control?.closest?.(NOTES_SELECTED_ASSET_SELECTOR);
  if (closest) return closest;

  let parent = control?.parentNode || null;
  while (parent && parent !== state.form) {
    if (parent.matches?.(NOTES_SELECTED_ASSET_SELECTOR)) return parent;
    parent = parent.parentNode;
  }

  const rows = state.selectedAssets?.querySelectorAll?.(NOTES_SELECTED_ASSET_SELECTOR) || [];
  return Array.from(rows).find((row) => row.querySelector?.('input') === control) || null;
}

function removeNotesAssetPickerNode(node) {
  if (node?.parentNode?.removeChild) node.parentNode.removeChild(node);
}

function deduplicateNotesAssetPickerControls(state) {
  const controlsById = new Map();
  notesAssetPickerFormControls(state).forEach((control) => {
    const assetId = notesAssetPickerControlId(control);
    if (assetId === null) return;
    const controls = controlsById.get(assetId) || [];
    controls.push(control);
    controlsById.set(assetId, controls);
  });

  controlsById.forEach((controls) => {
    const keeper = controls.find((control) => control.checked === true && control.disabled !== true)
      || controls[0];
    controls.forEach((control) => {
      if (control === keeper) return;
      const row = notesAssetPickerRowForControl(state, control);
      if (row) removeNotesAssetPickerNode(row);
      else removeNotesAssetPickerNode(control);
    });
  });
}

function notesAssetPickerSelectedAssetRow(state, assetId) {
  const rows = state.selectedAssets?.querySelectorAll?.(NOTES_SELECTED_ASSET_SELECTOR) || [];
  return Array.from(rows).find((row) => {
    if (row.getAttribute?.('data-notes-selected-asset-id') === assetId) return true;
    return notesAssetPickerControlId(row.querySelector?.('input')) === assetId;
  }) || null;
}

function notesAssetPickerSelectedAssetEmptyElement(state) {
  const existing = state.form?.querySelector?.(NOTES_SELECTED_ASSETS_EMPTY_SELECTOR);
  if (existing) return existing;

  const document = notesAssetPickerDocument(state.host);
  if (!document || typeof document.createElement !== 'function' || !state.selectedAssets) return null;
  const empty = document.createElement('p');
  empty.className = 'notes-selected-assets-empty';
  empty.textContent = 'No assets selected.';
  state.selectedAssets.parentNode?.appendChild?.(empty);
  return empty;
}

function notesAssetPickerRefreshSelectedAssetList(state) {
  const selectedIds = notesAssetPickerSelectedIds(state);
  const empty = notesAssetPickerSelectedAssetEmptyElement(state);
  if (empty) {
    if (selectedIds.size === 0) showElement(empty);
    else hideElement(empty);
  }

  state.selectedAssets?.querySelectorAll?.(NOTES_SELECTED_ASSET_SELECTOR)
    .forEach((row) => bindNotesAssetPickerSelectedAssetRow(state, row));
  state.assetRows?.forEach((_asset, assetId) => {
    setNotesAssetPickerCandidateSelected(state, assetId, selectedIds.has(assetId));
  });
}

function appendNotesSelectedAssetMetadata(details, asset, projectTitle, isProjectArchived, document) {
  const filename = notesAssetPickerAssetFilename(asset);
  const filenameElement = document.createElement('span');
  filenameElement.className = 'notes-selected-asset-filename';
  filenameElement.textContent = filename;
  details.appendChild(filenameElement);

  const projectElement = document.createElement('span');
  projectElement.className = 'notes-selected-asset-project';
  projectElement.textContent = `Project: ${projectTitle}`;
  details.appendChild(projectElement);

  const relativePath = typeof asset?.relativePath === 'string' ? asset.relativePath : '';
  if (relativePath.length > 0 && relativePath !== filename) {
    const pathElement = document.createElement('span');
    pathElement.className = 'notes-selected-asset-path';
    pathElement.textContent = `Path: ${relativePath}`;
    details.appendChild(pathElement);
  }

  if (isProjectArchived) {
    const marker = document.createElement('span');
    marker.className = 'notes-selected-asset-state notes-selected-asset-state--archived';
    marker.textContent = 'Archived project';
    details.appendChild(marker);
  }

  if (asset?.isPresent === false) {
    const marker = document.createElement('span');
    marker.className = 'notes-selected-asset-state notes-selected-asset-state--missing';
    marker.textContent = 'Missing';
    details.appendChild(marker);
  }
}

function addNotesAssetPickerRemoveButton(state, row, input, assetId) {
  if (row.querySelector?.(NOTES_ASSET_PICKER_REMOVE_SELECTOR)) return;
  const document = notesAssetPickerDocument(state.host);
  if (!document || typeof document.createElement !== 'function') return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button button-secondary notes-selected-asset-remove';
  button.setAttribute('data-notes-asset-picker-remove', '');
  button.textContent = 'Remove';
  button.addEventListener('click', () => deselectNotesAssetPickerAsset(state, assetId));
  row.appendChild(button);
  if (input) input.notesAssetPickerRemoveButton = button;
}

function bindNotesAssetPickerSelectedAssetRow(state, row) {
  const input = row.querySelector?.('input');
  const assetId = notesAssetPickerControlId(input);
  if (!input || assetId === null) return;

  row.setAttribute?.('data-notes-selected-asset-id', assetId);
  if (!input.notesAssetPickerSelectionBound) {
    input.notesAssetPickerSelectionBound = true;
    input.addEventListener('change', () => {
      if (!input.checked) {
        deselectNotesAssetPickerAsset(state, assetId);
        return;
      }
      deduplicateNotesAssetPickerControls(state);
      notesAssetPickerRefreshSelectedAssetList(state);
    });
  }

  addNotesAssetPickerRemoveButton(state, row, input, assetId);
}

function createNotesAssetPickerSelectedAssetRow(state, asset, existingControl = null) {
  const assetId = notesAssetPickerAssetId(asset);
  const document = notesAssetPickerDocument(state.host);
  if (assetId === null || !document || typeof document.createElement !== 'function') return null;

  const filename = notesAssetPickerAssetFilename(asset);
  const row = document.createElement('li');
  row.className = 'notes-selected-asset';
  row.setAttribute('data-notes-selected-asset-id', assetId);

  const label = document.createElement('label');
  label.className = 'notes-selected-asset-control';

  const input = existingControl || document.createElement('input');
  if (existingControl?.parentNode) existingControl.parentNode.removeChild(existingControl);
  input.type = 'checkbox';
  input.name = 'assetIds[]';
  input.value = assetId;
  input.checked = true;
  input.disabled = false;
  if (!input.id) input.id = `note-asset-option-${assetId}`;
  input.setAttribute?.('name', 'assetIds[]');
  input.setAttribute?.('value', assetId);
  input.setAttribute?.('aria-label', `Deselect ${filename}`);

  const details = document.createElement('span');
  details.className = 'notes-selected-asset-details';
  const descriptionId = `note-asset-option-description-${assetId}`;
  details.id = descriptionId;
  details.setAttribute?.('id', descriptionId);
  input.setAttribute?.('aria-describedby', descriptionId);
  appendNotesSelectedAssetMetadata(
    details,
    asset,
    typeof asset?.projectTitle === 'string' && asset.projectTitle.length > 0
      ? asset.projectTitle
      : (state.selectedProject?.title || 'Selected project'),
    Boolean(asset?.isProjectArchived ?? state.selectedProject?.archived),
    document,
  );

  label.setAttribute?.('for', input.id);
  label.appendChild(input);
  label.appendChild(details);
  row.appendChild(label);
  if (state.selectedAssets) state.selectedAssets.appendChild(row);
  else state.form?.appendChild?.(input);
  bindNotesAssetPickerSelectedAssetRow(state, row);
  return row;
}

function ensureNotesAssetPickerSelectedAssetRow(state, asset, existingControl = null) {
  const assetId = notesAssetPickerAssetId(asset);
  if (assetId === null) return null;
  const existing = notesAssetPickerSelectedAssetRow(state, assetId);
  if (existing) {
    bindNotesAssetPickerSelectedAssetRow(state, existing);
    return existing;
  }
  return createNotesAssetPickerSelectedAssetRow(state, asset, existingControl);
}

function notesAssetPickerCandidateAction(state, assetId) {
  const row = state.assetRows?.get(assetId)
    || state.assetResults?.querySelector?.(`[data-notes-asset-picker-asset-id="${assetId}"]`);
  return row?.querySelector?.(NOTES_ASSET_PICKER_ADD_SELECTOR) || null;
}

function setNotesAssetPickerCandidateSelected(state, assetId, selected) {
  const row = state.assetRows?.get(assetId)
    || state.assetResults?.querySelector?.(`[data-notes-asset-picker-asset-id="${assetId}"]`);
  const action = row?.querySelector?.(NOTES_ASSET_PICKER_ADD_SELECTOR);
  if (!row || !action) return;

  action.textContent = selected ? 'Selected' : 'Add';
  setNotesAssetPickerDisabled(action, selected);
  if (selected) row.setAttribute('data-notes-asset-picker-selected', '');
  else row.removeAttribute?.('data-notes-asset-picker-selected');
}

function deselectNotesAssetPickerAsset(state, assetId) {
  notesAssetPickerFormControls(state)
    .filter((control) => notesAssetPickerControlId(control) === assetId)
    .forEach((control) => {
      const row = notesAssetPickerRowForControl(state, control);
      if (row) removeNotesAssetPickerNode(row);
      else removeNotesAssetPickerNode(control);
    });

  setNotesAssetPickerCandidateSelected(state, assetId, false);
  notesAssetPickerRefreshSelectedAssetList(state);
  const asset = state.assetItems?.get(assetId);
  notesAssetPickerStatus(
    state,
    `Removed ${notesAssetPickerAssetFilename(asset || { id: assetId })} from selected assets.`,
  );
  notesAssetPickerCandidateAction(state, assetId)?.focus?.();
}

function addNotesAssetPickerAsset(state, asset) {
  const assetId = notesAssetPickerAssetId(asset);
  if (assetId === null) return;

  deduplicateNotesAssetPickerControls(state);
  let control = notesAssetPickerFormControls(state)
    .find((candidate) => notesAssetPickerControlId(candidate) === assetId) || null;
  const alreadySelected = control?.checked === true && control.disabled !== true;
  if (!control) {
    const document = notesAssetPickerDocument(state.host);
    if (!document || typeof document.createElement !== 'function') return;
    control = document.createElement('input');
  }
  control.type = 'checkbox';
  control.name = 'assetIds[]';
  control.value = assetId;
  control.checked = true;
  control.disabled = false;
  ensureNotesAssetPickerSelectedAssetRow(state, asset, control);

  setNotesAssetPickerCandidateSelected(state, assetId, true);
  notesAssetPickerRefreshSelectedAssetList(state);
  if (!alreadySelected) {
    notesAssetPickerStatus(state, `Added ${notesAssetPickerAssetFilename(asset)} to selected assets.`);
  }
}

function renderNotesAssetPickerAssets(state) {
  clearNotesAssetPickerElement(state.assetResults);
  state.assetRows = new Map();
  const document = notesAssetPickerDocument(state.host);
  if (!document || typeof document.createElement !== 'function') return;
  const selectedIds = notesAssetPickerSelectedIds(state);

  state.assetItems.forEach((asset, assetId) => {
    const filename = notesAssetPickerAssetFilename(asset);
    const relativePath = typeof asset.relativePath === 'string' ? asset.relativePath : '';
    const hasUsefulPath = relativePath.length > 0 && relativePath !== filename;
    const missing = asset.isPresent === false;
    const selected = selectedIds.has(assetId);
    const item = document.createElement('li');
    item.className = 'notes-asset-picker-asset-result';
    item.tabIndex = 0;
    item.setAttribute('data-notes-asset-picker-asset-id', assetId);
    item.setAttribute('data-asset-id', assetId);
    item.setAttribute('aria-label', [
      filename,
      hasUsefulPath ? `Path: ${relativePath}` : '',
      missing ? 'Missing' : '',
      selected ? 'Selected' : '',
    ].filter(Boolean).join(', '));

    const details = document.createElement('span');
    details.className = 'notes-asset-picker-asset-details';

    const filenameElement = document.createElement('span');
    filenameElement.className = 'notes-asset-picker-asset-filename';
    filenameElement.textContent = filename;
    details.appendChild(filenameElement);

    if (hasUsefulPath) {
      const pathElement = document.createElement('span');
      pathElement.className = 'notes-asset-picker-asset-path';
      pathElement.textContent = `Path: ${relativePath}`;
      details.appendChild(pathElement);
    }

    if (missing) {
      const marker = document.createElement('span');
      marker.className = 'notes-asset-picker-asset-state notes-asset-picker-asset-state--missing';
      marker.textContent = 'Missing';
      details.appendChild(marker);
    }

    item.appendChild(details);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'button button-secondary notes-asset-picker-asset-action';
    action.setAttribute('data-notes-asset-picker-add', '');
    action.textContent = selected ? 'Selected' : 'Add';
    setNotesAssetPickerDisabled(action, selected);
    action.addEventListener('click', () => addNotesAssetPickerAsset(state, asset));
    item.appendChild(action);
    state.assetResults.appendChild(item);
    state.assetRows.set(assetId, item);
  });
}

function setNotesAssetPickerLoadMoreEnabled(state, enabled) {
  setNotesAssetPickerDisabled(state.loadMoreButton, !enabled);
}

function abortNotesAssetPickerAssetRequest(state) {
  if (state.assetController) {
    state.assetController.abort();
    state.assetController = null;
  }
}

function resetNotesAssetPickerAssetResults(state) {
  state.assetQueryVersion += 1;
  abortNotesAssetPickerAssetRequest(state);
  if (state.assetTimer !== null) {
    clearTimeout(state.assetTimer);
    state.assetTimer = null;
  }
  state.assetItems.clear();
  state.assetNextCursor = null;
  state.assetLoadingMore = false;
  renderNotesAssetPickerAssets(state);
  setNotesAssetPickerLoadMoreEnabled(state, false);
}

function loadNotesAssetPickerAssets(state, { append = false, cursor = null } = {}) {
  const project = state.selectedProject;
  if (!project) return;

  const version = state.assetQueryVersion;
  const requestVersion = state.assetRequestVersion + 1;
  const projectId = project.id;
  const query = state.assetQuery;
  const controller = typeof globalThis.AbortController === 'function'
    ? new globalThis.AbortController()
    : null;
  state.assetRequestVersion = requestVersion;
  state.assetController = controller;
  state.assetLoadingMore = append;
  setNotesAssetPickerLoadMoreEnabled(state, false);
  notesAssetPickerError(state, '');
  notesAssetPickerStatus(
    state,
    append ? 'Loading more assets...' : (query ? 'Searching assets...' : 'Loading project assets...'),
  );

  const options = { method: 'GET', credentials: 'same-origin' };
  if (controller) options.signal = controller.signal;

  Promise.resolve().then(() => {
    if (typeof globalThis.fetch !== 'function') throw new Error('Asset search is unavailable.');
    return globalThis.fetch(notesAssetPickerRequestUrl(state.assetsEndpoint, {
      projectId,
      q: query,
      ...(append ? { cursor } : {}),
    }), options);
  }).then(async (response) => {
    if (!response || response.ok === false) throw new Error('Asset search failed.');
    if (typeof response.json !== 'function') throw new Error('Asset search returned invalid data.');
    return response.json();
  }).then((payload) => {
    if (
      version !== state.assetQueryVersion
      || requestVersion !== state.assetRequestVersion
      || state.selectedProject?.id !== projectId
    ) return;

    state.assetController = null;
    state.assetLoadingMore = false;
    if (!append) state.assetItems.clear();
    const assets = Array.isArray(payload?.items) ? payload.items : [];
    assets.forEach((asset) => {
      const assetId = notesAssetPickerAssetId(asset);
      if (assetId !== null && !state.assetItems.has(assetId)) state.assetItems.set(assetId, asset);
    });
    state.assetNextCursor = typeof payload?.nextCursor === 'string' && payload.nextCursor.length > 0
      ? payload.nextCursor
      : null;
    renderNotesAssetPickerAssets(state);
    setNotesAssetPickerLoadMoreEnabled(state, state.assetNextCursor !== null);
    notesAssetPickerError(state, '');
    notesAssetPickerStatus(
      state,
      state.assetItems.size === 0
        ? 'No assets found.'
        : `${state.assetItems.size} asset result${state.assetItems.size === 1 ? '' : 's'}.`,
    );
  }).catch((error) => {
    if (
      version !== state.assetQueryVersion
      || requestVersion !== state.assetRequestVersion
      || error?.name === 'AbortError'
    ) return;

    state.assetController = null;
    state.assetLoadingMore = false;
    setNotesAssetPickerLoadMoreEnabled(state, state.assetNextCursor !== null);
    notesAssetPickerStatus(
      state,
      append ? 'Loading more assets failed.' : (query ? 'Asset search failed.' : 'Loading project assets failed.'),
    );
    notesAssetPickerError(
      state,
      append ? 'Could not load more assets. Try again.' : 'Could not load project assets. Try again.',
    );
  });
}

function scheduleNotesAssetPickerAssetSearch(state) {
  state.assetQueryVersion += 1;
  const version = state.assetQueryVersion;
  abortNotesAssetPickerAssetRequest(state);
  if (state.assetTimer !== null) clearTimeout(state.assetTimer);

  state.assetTimer = null;
  state.assetQuery = notesAssetPickerQuery(state.assetSearch);
  state.assetItems.clear();
  state.assetNextCursor = null;
  state.assetLoadingMore = false;
  renderNotesAssetPickerAssets(state);
  setNotesAssetPickerLoadMoreEnabled(state, false);
  notesAssetPickerError(state, '');

  if (!state.selectedProject) return;

  notesAssetPickerStatus(state, state.assetQuery ? 'Searching assets...' : 'Loading project assets...');
  state.assetTimer = setTimeout(() => {
    if (version !== state.assetQueryVersion) return;
    state.assetTimer = null;
    loadNotesAssetPickerAssets(state);
  }, NOTES_ASSET_PICKER_DEBOUNCE_MS);
}

function loadMoreNotesAssetPickerAssets(state) {
  if (!state.selectedProject || state.assetLoadingMore || state.assetNextCursor === null) return;
  loadNotesAssetPickerAssets(state, { append: true, cursor: state.assetNextCursor });
}

function selectNotesAssetPickerProject(state, project) {
  state.queryVersion += 1;
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  const title = notesAssetPickerProjectTitle(project);
  const id = String(project.id);
  state.selectedProject = { id, title, archived: Boolean(project.archived) };
  state.host.dataset.selectedProjectId = id;

  if (state.selectedProjectElement) {
    state.selectedProjectElement.textContent = `Selected project: ${title}${project.archived ? ' (Archived)' : ''}`;
    showElement(state.selectedProjectElement);
  }

  clearNotesAssetPickerElement(state.projectResults);
  state.assetQuery = '';
  state.assetSearch.value = '';
  resetNotesAssetPickerAssetResults(state);
  setNotesAssetPickerDisabled(state.assetSearch, false);
  notesAssetPickerStatus(state, `Loading assets for ${title}...`);
  loadNotesAssetPickerAssets(state);
}

function searchNotesAssetPickerProjects(state, query) {
  if (state.queryVersion !== state.scheduledVersion) return;

  const version = state.queryVersion;
  const controller = typeof globalThis.AbortController === 'function'
    ? new globalThis.AbortController()
    : null;
  state.controller = controller;
  state.timer = null;
  notesAssetPickerStatus(state, 'Searching projects...');

  const options = { method: 'GET', credentials: 'same-origin' };
  if (controller) options.signal = controller.signal;

  Promise.resolve().then(() => {
    if (typeof globalThis.fetch !== 'function') throw new Error('Project search is unavailable.');
    return globalThis.fetch(notesAssetPickerRequestUrl(state.projectsEndpoint, { q: query }), options);
  }).then(async (response) => {
    if (!response || response.ok === false) throw new Error('Project search failed.');
    if (typeof response.json !== 'function') throw new Error('Project search returned invalid data.');
    return response.json();
  }).then((payload) => {
    if (version !== state.queryVersion) return;
    state.controller = null;
    const projects = Array.isArray(payload?.items) ? payload.items : [];
    renderNotesAssetPickerProjects(state, projects);
    notesAssetPickerError(state, '');
    notesAssetPickerStatus(
      state,
      projects.length === 0
        ? 'No projects found.'
        : `${projects.length} project result${projects.length === 1 ? '' : 's'}.`,
    );
  }).catch((error) => {
    if (version !== state.queryVersion || error?.name === 'AbortError') return;
    state.controller = null;
    notesAssetPickerStatus(state, 'Project search failed.');
    notesAssetPickerError(state, 'Could not search projects. Try again.');
  });
}

function scheduleNotesAssetPickerProjectSearch(state) {
  state.queryVersion += 1;
  state.scheduledVersion = state.queryVersion;
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  if (state.timer !== null) clearTimeout(state.timer);

  const query = notesAssetPickerQuery(state.projectSearch);
  clearNotesAssetPickerElement(state.projectResults);
  notesAssetPickerError(state, '');

  if (query.length < NOTES_ASSET_PICKER_MIN_QUERY_LENGTH) {
    state.timer = null;
    notesAssetPickerStatus(state, 'Type at least 2 characters to search projects.');
    return;
  }

  notesAssetPickerStatus(state, '');
  state.timer = setTimeout(() => searchNotesAssetPickerProjects(state, query), NOTES_ASSET_PICKER_DEBOUNCE_MS);
}

export function enhanceNotesAssetPicker(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const hosts = scope.querySelectorAll(NOTES_ASSET_PICKER_SELECTOR);
  hosts.forEach((host) => {
    if (isEnhancementBound(host, 'notesAssetPickerBound')) return;

    const projectSearch = host.querySelector?.(NOTES_ASSET_PICKER_PROJECT_SEARCH_SELECTOR);
    const projectResults = host.querySelector?.(NOTES_ASSET_PICKER_PROJECT_RESULTS_SELECTOR);
    const assetSearch = host.querySelector?.(NOTES_ASSET_PICKER_ASSET_SEARCH_SELECTOR);
    const assetResults = host.querySelector?.(NOTES_ASSET_PICKER_ASSET_RESULTS_SELECTOR);
    const loadMoreContainer = host.querySelector?.(NOTES_ASSET_PICKER_LOAD_MORE_SELECTOR);
    const loadMoreButton = loadMoreContainer?.querySelector?.('button');
    const status = host.querySelector?.(NOTES_ASSET_PICKER_STATUS_SELECTOR);
    const error = host.querySelector?.(NOTES_ASSET_PICKER_ERROR_SELECTOR);
    const document = notesAssetPickerDocument(host);
    const formId = host.dataset?.noteFormId || host.getAttribute?.('data-note-form-id') || '';
    const form = host.closest?.('form')
      || (formId ? document?.querySelector?.(`#${formId}`) : null);
    const selectedAssets = form?.querySelector?.(NOTES_SELECTED_ASSETS_SELECTOR) || null;
    const projectsEndpoint = host.dataset?.projectsUrl
      || host.getAttribute?.('data-projects-url')
      || '';
    if (!projectSearch || !projectResults || !assetSearch || !assetResults || !status || !error) return;

    const state = {
      host,
      form,
      selectedAssets,
      projectSearch,
      projectResults,
      assetSearch,
      assetResults,
      loadMoreButton,
      status,
      error,
      projectsEndpoint,
      assetsEndpoint: host.dataset?.assetsUrl
        || host.getAttribute?.('data-assets-url')
        || '',
      selectedProject: null,
      selectedProjectElement: null,
      assetQuery: '',
      controller: null,
      timer: null,
      queryVersion: 0,
      scheduledVersion: 0,
      assetController: null,
      assetTimer: null,
      assetQueryVersion: 0,
      assetRequestVersion: 0,
      assetItems: new Map(),
      assetRows: new Map(),
      assetNextCursor: null,
      assetLoadingMore: false,
    };
    state.selectedProjectElement = notesAssetPickerSelectedProjectElement(state);
    host.notesAssetPickerState = state;
    markEnhancementBound(host, 'notesAssetPickerBound');
    deduplicateNotesAssetPickerControls(state);
    notesAssetPickerRefreshSelectedAssetList(state);
    hideElement(host.querySelector?.(NOTES_ASSET_PICKER_NO_JS_SELECTOR));
    setNotesAssetPickerDisabled(assetSearch, true);
    setNotesAssetPickerLoadMoreEnabled(state, false);
    notesAssetPickerStatus(state, 'Type at least 2 characters to search projects.');

    projectSearch.addEventListener('input', () => scheduleNotesAssetPickerProjectSearch(state));
    assetSearch.addEventListener('input', () => scheduleNotesAssetPickerAssetSearch(state));
    loadMoreButton?.addEventListener('click', () => loadMoreNotesAssetPickerAssets(state));
  });

  return hosts.length;
}
