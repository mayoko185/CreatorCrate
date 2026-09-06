import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';

// Only Project -> Asset catalogue reconciliation lives here. The shared dropdown
// owns search, disclosure, keyboard interaction and selection synchronization.
export function enhanceNoteConnections(scope = globalThis.document) {
  let count = 0;
  scope.querySelectorAll('[data-note-connections]').forEach(host => {
    if (isEnhancementBound(host, 'noteConnectionsBound')) return;
    markEnhancementBound(host, 'noteConnectionsBound');
    count += 1;
    const document = host.ownerDocument;
    const projects = host.querySelector('#note-projects-form');
    const native = host.querySelector('#note-assets-native');
    const assets = host.querySelector('#note-assets-form');
    const wrapper = host.querySelector('[data-note-assets]');
    const retained = host.querySelector('[data-note-retained-assets]');
    const retainedOptions = host.querySelector('[data-note-retained-options]');
    const status = host.querySelector('[data-note-assets-status]');
    const setStatus = message => {
      status.textContent = message;
      status.hidden = !message;
    };
    const catalogue = new Map();
    const loaded = new Set();
    let generation = 0;
    let controller;
    const context = () => new Map(Array.from(projects.querySelectorAll('input[type="checkbox"]:checked'))
      .map(input => [input.value, input.getAttribute('data-project-archived') !== 'true']));
    const selectedIds = () => new Set([
      ...Array.from(native.options).filter(option => option.selected).map(option => option.value),
      ...Array.from(retainedOptions.querySelectorAll('input:checked')).map(input => input.value),
    ]);
    const remember = (input, label) => catalogue.set(input.value, {
      id: input.value, projectId: input.getAttribute('data-project-key')?.replace(/^project:/, ''), label,
      persisted: input.getAttribute('data-persisted') === 'true',
    });
    Array.from(native.options).forEach(option => remember(option, option.textContent));
    retainedOptions.querySelectorAll('input').forEach(input => remember(input, input.closest('label').querySelector('span').textContent));
    context().forEach((active, id) => { if (active) loaded.add(id); });

    function render(selected) {
      const current = context();
      wrapper.hidden = ![...current.values()].some(Boolean);
      if (wrapper.hidden) assets.open = false;
      native.replaceChildren();
      retainedOptions.replaceChildren();
      // Rebuild through the shared native-select adapter, avoiding stale option IDs.
      assets.querySelectorAll('.asset-filter-multiselect-option').forEach(row => row.remove());
      for (const asset of catalogue.values()) {
        if (current.get(asset.projectId) && loaded.has(asset.projectId)) {
          const option = document.createElement('option');
          option.value = asset.id;
          option.textContent = asset.label;
          option.selected = selected.has(asset.id);
          native.append(option);
        } else if (selected.has(asset.id) && asset.persisted) {
          const label = document.createElement('label');
          const input = document.createElement('input');
          input.type = 'checkbox'; input.name = 'assetIds[]'; input.value = asset.id;
          input.checked = true;
          const text = document.createElement('span'); text.textContent = asset.label;
          label.append(input, text);
          const row = document.createElement('div'); row.className = 'asset-filter-multiselect-option';
          row.append(label); retainedOptions.append(row);
        }
      }
      retained.hidden = retainedOptions.children.length === 0;
      syncCreatorCrateDropdownFromNative(native);
      const empty = assets.querySelector('.asset-filter-multiselect-empty:not([data-cc-dropdown-no-results])');
      if (empty) empty.hidden = native.options.length > 0;
    }

    projects.addEventListener('change', async event => {
      if (event.target.type !== 'checkbox') return;
      const version = ++generation;
      controller?.abort();
      controller = new AbortController();
      const selected = selectedIds();
      render(selected); // Drop newly selected assets from deselected Projects immediately.
      setStatus(native.options.length || wrapper.hidden ? '' : 'No assets available for the selected projects.');
      const pending = [...context()].filter(([id, active]) => active && !loaded.has(id));
      if (!pending.length) return;
      setStatus('Loading assets…');
      try {
        for (const [id] of pending) {
          let cursor = null;
          const rows = [];
          do {
            const params = new URLSearchParams({ projectId: id, limit: '25' });
            if (cursor) params.set('cursor', cursor);
            const response = await document.defaultView.fetch(`${host.dataset.assetsUrl}?${params}`, { signal: controller.signal });
            if (!response.ok) throw new Error('Asset catalogue request failed');
            const payload = await response.json();
            if (version !== generation) return;
            if (String(payload.project.id) !== id) throw new Error('Asset catalogue Project mismatch');
            if (payload.project.archived) break;
            rows.push(...payload.items.map(asset => ({
              id: String(asset.id), projectId: id,
              label: `${asset.filename}${asset.relativePath && asset.relativePath !== asset.filename ? ' (' + asset.relativePath + ')' : ''} — Project: ${payload.project.title}${asset.isPresent ? '' : ' (Missing)'}`,
            })));
            cursor = payload.nextCursor;
          } while (cursor);
          if (version !== generation) return;
          rows.forEach(asset => catalogue.set(asset.id, { ...asset, persisted: catalogue.get(asset.id)?.persisted || false }));
          loaded.add(id);
        }
        render(selectedIds());
        setStatus(native.options.length ? '' : 'No assets available for the selected projects.');
      } catch (error) {
        if (version !== generation || error.name === 'AbortError') return;
        setStatus('Assets could not be loaded. Reselect the Project to retry. Existing selections are retained.');
      }
    });
  });
  return count;
}
