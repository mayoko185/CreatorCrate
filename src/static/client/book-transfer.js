import {
  beginNotesBooksLiveRefresh,
  installNotesBooksLiveRegionSnapshot,
} from './live-regions.js';

const DIALOG_SELECTOR = '#book-transfer-dialog';
const CONTENT_SELECTOR = '[data-book-transfer-content]';
const SHELF_SELECTOR = '[data-notes-books-live-region]';

function setStatus(element, message, kind = null) {
  if (!element) return;
  element.textContent = message || '';
  if (kind) element.setAttribute?.('data-status-kind', kind);
  else element.removeAttribute?.('data-status-kind');
}

function safeJson(response) {
  return response?.json?.().catch?.(() => null) ?? Promise.resolve(null);
}

function filenameFromResponse(response) {
  const disposition = response?.headers?.get?.('content-disposition') || '';
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch { /* use the default below */ }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain?.[1] || 'creatorcrate-books.zip';
}

function triggerDownload(state, response, blob) {
  const urlApi = state.window.URL;
  if (!urlApi?.createObjectURL) throw new Error('Downloads are unavailable.');
  const url = urlApi.createObjectURL(blob);
  const link = state.document.createElement('a');
  link.href = url;
  link.download = filenameFromResponse(response);
  link.hidden = true;
  state.document.body?.append?.(link);
  link.click?.();
  link.remove?.();
  state.window.setTimeout?.(() => urlApi.revokeObjectURL?.(url), 0);
}

function checkedChoices(content) {
  return Array.from(content?.querySelectorAll?.('[data-book-export-choice]') || [])
    .filter((choice) => choice.checked);
}

function syncSelectAll(content) {
  const choices = Array.from(content?.querySelectorAll?.('[data-book-export-choice]') || []);
  const control = content?.querySelector?.('[data-book-export-select-all]');
  if (!control) return;
  const allSelected = choices.length > 0 && choices.every((choice) => choice.checked);
  control.setAttribute?.('aria-pressed', allSelected ? 'true' : 'false');
  control.textContent = allSelected ? 'Deselect all' : 'Select all';
}

function syncExportOrderFromShelf(state) {
  const content = state.dialog.querySelector?.(CONTENT_SELECTOR);
  const list = content?.querySelector?.('.book-transfer-book-list');
  if (!list) return;
  const shelfIds = snapshotBookIds(state.document.querySelector?.(SHELF_SELECTOR), '.notes-book-card-title a');
  const choices = Array.from(content.querySelectorAll?.('[data-book-export-choice]') || []);
  const currentIds = choices.map((choice) => String(choice.value));
  if (shelfIds.length !== currentIds.length
    || shelfIds.some((id) => !currentIds.includes(id))
    || shelfIds.every((id, index) => id === currentIds[index])) return;
  const rows = new Map(choices.map((choice) => [String(choice.value), choice.closest?.('li')]));
  shelfIds.forEach((id) => {
    const row = rows.get(id);
    if (row) list.append?.(row);
  });
}

function descriptor(entry, kind) {
  const locator = entry?.locator || {};
  if (kind === 'asset') {
    const project = locator.project?.slug ? `Project ${locator.project.slug}, ` : '';
    return `${project}Asset ${locator.relativePath || 'unknown path'}`;
  }
  return `Project ${locator.slug || 'unknown'}`;
}

function appendList(document, parent, items) {
  const list = document.createElement('ul');
  items.forEach((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    list.append?.(item);
  });
  parent.append?.(list);
}

export function renderBookImportResult(container, payload) {
  if (!container || !payload) return;
  const document = container.ownerDocument;
  container.replaceChildren?.();
  container.hidden = false;
  container.removeAttribute?.('hidden');

  const heading = document.createElement('h3');
  heading.textContent = 'Import result';
  container.append?.(heading);
  const summary = document.createElement('p');
  summary.textContent = `${payload.importedBookCount || 0} ${payload.importedBookCount === 1 ? 'Book' : 'Books'} imported.`;
  container.append?.(summary);

  const books = Array.isArray(payload.books) ? payload.books : [];
  if (books.length) appendList(document, container, books.map((book) => book.renamed
    ? `${book.sourceTitle || 'Book'} → ${book.destinationTitle || 'Book'}`
    : (book.destinationTitle || 'Book')));

  const coverFallbacks = books.filter((book) => book.coverOutcome?.kind === 'managed'
    && book.coverOutcome?.sourceKind === 'project_asset');
  if (coverFallbacks.length) {
    const message = document.createElement('p');
    message.textContent = `${coverFallbacks.length} Project cover ${coverFallbacks.length === 1 ? 'source could' : 'sources could'} not be relinked; the ${coverFallbacks.length === 1 ? 'cover was' : 'covers were'} preserved as managed media.`;
    container.append?.(message);
  }

  const associations = payload.associations || {};
  const unresolvedProjects = Array.isArray(associations.unresolvedProjectLocators)
    ? associations.unresolvedProjectLocators : [];
  const unresolvedAssets = Array.isArray(associations.unresolvedAssetLocators)
    ? associations.unresolvedAssetLocators : [];
  if (unresolvedProjects.length || unresolvedAssets.length) {
    const warning = document.createElement('div');
    warning.className = 'book-transfer-warning';
    const count = unresolvedProjects.length + unresolvedAssets.length;
    const text = document.createElement('p');
    text.textContent = `${count} portable ${count === 1 ? 'association was' : 'associations were'} not relinked. The Books were still imported.`;
    warning.append?.(text);
    appendList(document, warning, [
      ...unresolvedProjects.map((entry) => descriptor(entry, 'project')),
      ...unresolvedAssets.map((entry) => descriptor(entry, 'asset')),
    ]);
    container.append?.(warning);
  }

  const historicalProjects = Number(associations.historicalUnresolvedProjectCount) || 0;
  const historicalAssets = Number(associations.historicalUnresolvedAssetCount) || 0;
  if (historicalProjects || historicalAssets) {
    const historical = document.createElement('p');
    historical.textContent = `${historicalProjects + historicalAssets} historical unresolved ${historicalProjects + historicalAssets === 1 ? 'association had' : 'associations had'} no portable source locator.`;
    container.append?.(historical);
  }

  if (payload.activity?.recorded === false) {
    const activity = document.createElement('p');
    activity.className = 'book-transfer-warning';
    activity.textContent = 'Books were imported successfully, but activity logging was not recorded. Do not retry the import.';
    container.append?.(activity);
  }
}

function snapshotBookIds(root, selector) {
  return Array.from(root?.querySelectorAll?.(selector) || []).map((element) => {
    if (element.value !== undefined) return String(element.value);
    const href = element.getAttribute?.('href') || '';
    return href.match(/^\/notes\/books\/(\d+)$/)?.[1] || '';
  }).filter(Boolean);
}

function coherentSnapshot(parsed) {
  const shelf = parsed?.querySelector?.(SHELF_SELECTOR);
  const content = parsed?.querySelector?.(`${DIALOG_SELECTOR} ${CONTENT_SELECTOR}`);
  if (!shelf || !content || !content.querySelector?.('input[name="_csrf"]')) return null;
  const shelfIds = snapshotBookIds(shelf, '.notes-book-card-title a');
  const exportIds = snapshotBookIds(content, '[data-book-export-choice]');
  if (shelfIds.length !== exportIds.length || shelfIds.some((id, index) => id !== exportIds[index])) return null;
  return { shelf, content };
}

function dialogIsOpen(dialog) {
  return dialog?.open === true || dialog?.__creatorCrateAppDialogState?.open === true;
}

function applyRetainedResult(state) {
  const content = state.dialog.querySelector?.(CONTENT_SELECTOR);
  if (!content) return;
  if (state.importResult) {
    renderBookImportResult(content.querySelector?.('[data-book-import-result]'), state.importResult);
  }
  if (state.refreshFailed) {
    const status = content.querySelector?.('[data-book-import-status]');
    setStatus(status, 'Books imported, but page refresh failed.', 'error');
    let retry = content.querySelector?.('[data-book-import-refresh-retry]');
    if (!retry) {
      retry = state.document.createElement('button');
      retry.type = 'button';
      retry.className = 'button button-secondary';
      retry.textContent = 'Retry refresh';
      retry.setAttribute?.('data-book-import-refresh-retry', '');
      status?.after?.(retry);
    }
  } else if (state.importResult) {
    setStatus(content.querySelector?.('[data-book-import-status]'), 'Books imported and shelf refreshed.', 'success');
  }
}

async function refreshCanonical(state, refreshUrl = '/notes') {
  const authority = beginNotesBooksLiveRefresh(state.document);
  if (authority === null) throw new Error('Live refresh is unavailable.');
  const response = await state.window.fetch(refreshUrl, {
    method: 'GET', credentials: 'same-origin', headers: { Accept: 'text/html' },
  });
  if (!response?.ok) throw new Error('Canonical refresh failed.');
  const html = await response.text();
  const parsed = new state.window.DOMParser().parseFromString(html, 'text/html');
  const snapshot = coherentSnapshot(parsed);
  if (!snapshot) throw new Error('Canonical response was incomplete.');

  const currentContent = state.dialog.querySelector?.(CONTENT_SELECTOR);
  if (!currentContent?.parentNode) throw new Error('Transfer dialog is unavailable.');
  const installed = installNotesBooksLiveRegionSnapshot(state.document, authority, snapshot.shelf);
  if (installed !== 'installed') throw new Error('Canonical refresh was superseded.');
  currentContent.replaceWith(snapshot.content);
  state.refreshFailed = false;
  bindContent(state, snapshot.content);
  applyRetainedResult(state);
  if (dialogIsOpen(state.dialog)) {
    snapshot.content.querySelector?.('[data-book-import-submit]')?.focus?.({ preventScroll: true });
  }
}

function showRefreshFailure(state) {
  state.refreshFailed = true;
  applyRetainedResult(state);
  bindRetry(state);
}

function bindRetry(state) {
  const retry = state.dialog.querySelector?.('[data-book-import-refresh-retry]');
  if (!retry || retry.dataset?.bookImportRefreshBound === 'true') return;
  retry.dataset.bookImportRefreshBound = 'true';
  retry.addEventListener?.('click', async () => {
    if (state.refreshing) return;
    state.refreshing = true;
    retry.disabled = true;
    setStatus(state.dialog.querySelector?.('[data-book-import-status]'), 'Refreshing Books.', null);
    try { await refreshCanonical(state, state.refreshUrl); }
    catch { showRefreshFailure(state); }
    finally {
      state.refreshing = false;
      const currentRetry = state.dialog.querySelector?.('[data-book-import-refresh-retry]');
      if (currentRetry) currentRetry.disabled = false;
    }
  });
}

function bindExport(state, content) {
  const form = content.querySelector?.('[data-book-export-form]');
  const selectAll = content.querySelector?.('[data-book-export-select-all]');
  const status = content.querySelector?.('[data-book-export-status]');
  if (!form) return;
  selectAll?.addEventListener?.('click', () => {
    const choices = Array.from(content.querySelectorAll?.('[data-book-export-choice]') || []);
    const select = !choices.length || !choices.every((choice) => choice.checked);
    choices.forEach((choice) => { choice.checked = select; });
    syncSelectAll(content);
  });
  content.querySelectorAll?.('[data-book-export-choice]').forEach((choice) => {
    choice.addEventListener?.('change', () => syncSelectAll(content));
  });
  form.addEventListener?.('submit', async (event) => {
    event.preventDefault?.();
    const choices = checkedChoices(content);
    if (!choices.length) {
      setStatus(status, 'Select at least one Book to export.', 'error');
      return;
    }
    const submit = content.querySelector?.('[data-book-export-submit]');
    submit.disabled = true;
    setStatus(status, 'Preparing Book export.', null);
    try {
      const body = new state.window.URLSearchParams(new state.window.FormData(form));
      const response = await state.window.fetch(form.action || form.getAttribute?.('action'), {
        method: 'POST', body, credentials: 'same-origin', headers: { Accept: 'application/zip, application/json' },
      });
      if (!response?.ok) {
        const payload = await safeJson(response);
        setStatus(status, payload?.message || 'Book export failed.', 'error');
        return;
      }
      triggerDownload(state, response, await response.blob());
      setStatus(status, 'Book export download started.', 'success');
    } catch {
      setStatus(status, 'Book export failed. Check your connection and try again.', 'error');
    } finally { submit.disabled = false; }
  });
}

function bindImport(state, content) {
  const form = content.querySelector?.('[data-book-import-form]');
  const file = content.querySelector?.('[data-book-import-archive]');
  const submit = content.querySelector?.('[data-book-import-submit]');
  const status = content.querySelector?.('[data-book-import-status]');
  if (!form) return;
  form.addEventListener?.('submit', async (event) => {
    event.preventDefault?.();
    if (state.importing) return;
    if (!file?.files?.length) {
      setStatus(status, 'Choose one CreatorCrate Books ZIP to import.', 'error');
      return;
    }
    const body = new state.window.FormData(form);
    state.importing = true;
    file.disabled = true;
    submit.disabled = true;
    form.setAttribute?.('aria-busy', 'true');
    setStatus(status, 'Importing Books.', null);
    try {
      const response = await state.window.fetch(form.action || form.getAttribute?.('action'), {
        method: 'POST', body, credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const payload = await safeJson(response);
      if (!response?.ok || payload?.success !== true) {
        const controlled = response?.status >= 400 && response?.status < 500 && payload?.message;
        setStatus(status, controlled ? payload.message : 'Book import could not be confirmed. Do not retry until you verify the shelf.', 'error');
        return;
      }
      state.importResult = payload;
      state.refreshUrl = payload.refreshUrl || '/notes';
      renderBookImportResult(content.querySelector?.('[data-book-import-result]'), payload);
      setStatus(status, 'Books imported. Refreshing the shelf.', 'success');
      try { await refreshCanonical(state, state.refreshUrl); }
      catch { showRefreshFailure(state); }
    } catch {
      setStatus(status, 'Book import could not be confirmed. Do not retry until you verify the shelf.', 'error');
    } finally {
      state.importing = false;
      const currentContent = state.dialog.querySelector?.(CONTENT_SELECTOR);
      const currentFile = currentContent?.querySelector?.('[data-book-import-archive]');
      const currentSubmit = currentContent?.querySelector?.('[data-book-import-submit]');
      currentContent?.querySelector?.('[data-book-import-form]')?.removeAttribute?.('aria-busy');
      if (currentFile) currentFile.disabled = false;
      if (currentSubmit) currentSubmit.disabled = false;
    }
  });
}

function bindContent(state, content) {
  if (!content || content.dataset?.bookTransferBound === 'true') return;
  content.dataset.bookTransferBound = 'true';
  bindExport(state, content);
  bindImport(state, content);
  bindRetry(state);
}

function discardTransferDraft(state) {
  const content = state.dialog.querySelector?.(CONTENT_SELECTOR);
  content?.querySelector?.('[data-book-export-form]')?.reset?.();
  content?.querySelector?.('[data-book-import-form]')?.reset?.();
  syncSelectAll(content);
  setStatus(content?.querySelector?.('[data-book-export-status]'), '');
  if (!state.importResult && !state.importing && !state.refreshing) {
    setStatus(content?.querySelector?.('[data-book-import-status]'), '');
  }
}

export function enhanceBookTransfer(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument || globalThis.document;
  const dialog = document?.querySelector?.(DIALOG_SELECTOR);
  if (!dialog) return 0;
  let state = dialog.__creatorCrateBookTransferState;
  if (!state) {
    state = {
      document,
      window: document.defaultView || globalThis,
      dialog,
      importing: false,
      refreshing: false,
      refreshFailed: false,
      refreshUrl: '/notes',
      importResult: null,
    };
    dialog.__creatorCrateBookTransferState = state;
    dialog.addEventListener?.('close', () => discardTransferDraft(state));
    if (typeof state.window.MutationObserver === 'function' && state.document.body) {
      state.shelfObserver = new state.window.MutationObserver(() => syncExportOrderFromShelf(state));
      state.shelfObserver.observe(state.document.body, { childList: true, subtree: true });
    }
  }
  syncExportOrderFromShelf(state);
  bindContent(state, dialog.querySelector?.(CONTENT_SELECTOR));
  applyRetainedResult(state);
  bindRetry(state);
  return 1;
}
