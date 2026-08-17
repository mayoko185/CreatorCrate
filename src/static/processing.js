/**
 * Processing actions: Convert, Workflow Prompt Editor, and Watermark dialogs
 * on /projects/:id/assets, plus the managed Watermark/scale-map dialogs they
 * link to. One cohesive enhancement module, following the data-attribute +
 * delegated-event conventions used throughout creatorcrate.js.
 *
 * Dialog open/close/focus/Escape/scroll all come from the existing
 * [data-app-dialog] framework (enhanceAppDialogs) — this module only wires
 * the processing-specific behavior inside each dialog body.
 */

const ROOT_SELECTOR = '[data-processing-root]';
const MANAGE_WATERMARKS_SELECTOR = '[data-processing-manage-watermarks]';
const MANAGE_SCALE_MAPS_SELECTOR = '[data-processing-manage-scale-maps]';
const ASSET_CHECKBOX_SELECTOR = '.asset-select-checkbox';
const OPERATION_PLAN_PATH = (projectId, operation) => `/projects/${projectId}/assets/processing/${operation}/plan`;
const OPERATION_APPLY_PATH = (projectId, operation) => `/projects/${projectId}/assets/processing/${operation}/apply`;

function isBound(element, key) {
  return element?.[`__ccProcessingBound_${key}`] === true;
}

function markBound(element, key) {
  if (element) element[`__ccProcessingBound_${key}`] = true;
}

function liveDocument(scope) {
  if (!scope) return globalThis.document || null;
  if (scope.nodeType === 9) return scope;
  return scope.ownerDocument || globalThis.document || null;
}

// ─── Fetch / envelope handling ──────────────────────────────────────────

class ProcessingRequestError extends Error {
  constructor(message, { field } = {}) {
    super(message);
    this.name = 'ProcessingRequestError';
    this.field = field;
  }
}

async function parseEnvelope(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new ProcessingRequestError('The server returned an unexpected response. Try again.');
  }
  if (!response.ok || payload?.ok !== true) {
    const message = payload?.error?.message || 'The request could not be completed.';
    throw new ProcessingRequestError(message, { field: payload?.error?.field });
  }
  return payload;
}

async function processingFetchJson(url, { method = 'POST', csrf, body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrf || '',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ProcessingRequestError('Could not reach the server. Check your connection and try again.');
  }
  return parseEnvelope(response);
}

async function processingFetchForm(url, { method = 'POST', csrf, formData } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-CSRF-Token': csrf || '' },
      body: formData,
    });
  } catch {
    throw new ProcessingRequestError('Could not reach the server. Check your connection and try again.');
  }
  return parseEnvelope(response);
}

// ─── Scope resolution (read live at Preview/Apply time — never cached) ─

function getSelectedAssetIds(document) {
  return Array.from(document.querySelectorAll(ASSET_CHECKBOX_SELECTOR))
    .filter((checkbox) => checkbox.checked && checkbox.name === 'selectedAssetIds')
    .map((checkbox) => Number(checkbox.value))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

function currentCategoryIdFromUrl(window) {
  const params = new window.URLSearchParams(window.location.search || '');
  const category = params.get('category');
  if (!category || category === 'all' || category === 'uncategorized') return null;
  const id = Number(category);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function resolveScope(root) {
  const document = liveDocument(root);
  const window = document?.defaultView || globalThis;
  const checked = root.querySelector('[data-processing-scope] input[type="radio"]:checked');
  const type = checked?.value;

  if (type === 'selected') {
    const assetIds = getSelectedAssetIds(document);
    if (assetIds.length === 0) {
      throw new ProcessingRequestError('Select at least one asset in the browser list to use this scope.');
    }
    return { type: 'selected', assetIds };
  }
  if (type === 'category') {
    const categoryId = currentCategoryIdFromUrl(window);
    if (!categoryId) throw new ProcessingRequestError('No concrete category is currently selected.');
    return { type: 'category', categoryId };
  }
  if (type === 'directory') {
    const relativePath = root.querySelector('[data-processing-directory]')?.value.trim() || '';
    const recursive = root.querySelector('[data-processing-recursive]')?.checked === true;
    return { type: 'directory', relativePath, recursive };
  }
  if (type === 'project') return { type: 'project' };
  throw new ProcessingRequestError('Choose a scope before continuing.');
}

function updateScopeDisplay(root) {
  const document = liveDocument(root);
  const window = document?.defaultView || globalThis;
  const selectedIds = getSelectedAssetIds(document);
  const countEl = root.querySelector('[data-processing-selected-count]');
  if (countEl) countEl.textContent = String(selectedIds.length);

  const selectedRadio = root.querySelector('[data-processing-scope-option="selected"]');
  const selectedHint = root.querySelector('[data-processing-selected-hint]');
  if (selectedRadio) {
    selectedRadio.disabled = selectedIds.length === 0;
    if (selectedIds.length === 0 && selectedRadio.checked) {
      selectedRadio.checked = false;
      const directoryOption = root.querySelector('[data-processing-scope-option="directory"]');
      if (directoryOption) directoryOption.checked = true;
    }
  }
  if (selectedHint) selectedHint.hidden = selectedIds.length > 0;

  const categoryId = currentCategoryIdFromUrl(window);
  const categoryWrap = root.querySelector('[data-processing-scope-category-wrap]');
  const categoryRadio = root.querySelector('[data-processing-scope-option="category"]');
  const categoryLabel = root.querySelector('[data-processing-category-label]');
  if (categoryWrap) {
    categoryWrap.hidden = !categoryId;
    if (categoryRadio) categoryRadio.disabled = !categoryId;
    if (categoryLabel) {
      const label = root.getAttribute('data-current-category-label');
      categoryLabel.textContent = label ? `Current category — ${label}` : 'Current category';
    }
  }
  if (!categoryId && categoryRadio?.checked) {
    categoryRadio.checked = false;
    const selectedOption = root.querySelector('[data-processing-scope-option="selected"]');
    if (selectedOption && !selectedOption.disabled) selectedOption.checked = true;
  }
}

// ─── Generic field serialization ────────────────────────────────────────

function readFieldValue(el) {
  const type = el.dataset.processingType;
  if (type === 'bool') return el.checked;
  if (type === 'list') {
    return Array.from(el.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);
  }
  const raw = el.value;
  if (type === 'int' || type === 'int-or-null') {
    if (raw === '' || raw === null || raw === undefined) return type === 'int-or-null' ? null : undefined;
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (type === 'float') {
    if (raw === '') return undefined;
    const parsed = parseFloat(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return raw;
}

function collectOptions(root) {
  const options = {};
  root.querySelectorAll('[data-processing-field]').forEach((el) => {
    const field = el.dataset.processingField;
    if (!field) return;
    const type = el.dataset.processingType;
    const omitIfEmpty = el.dataset.processingOmitIfEmpty === 'true';
    const value = readFieldValue(el);
    if (value === undefined) return;
    if (omitIfEmpty && value === '') return;
    if (type === 'list' && value.length === 0) return;
    options[field] = value;
  });
  return options;
}

function dispatchNativeChange(el) {
  const document = liveDocument(el);
  const EventCtor = document?.defaultView?.Event || globalThis.Event;
  el.dispatchEvent(new EventCtor('change', { bubbles: true }));
}

function resetFields(root) {
  root.querySelectorAll('[data-processing-field]').forEach((el) => {
    const type = el.dataset.processingType;
    if (type === 'bool') {
      el.checked = el.hasAttribute('data-processing-default-checked') || el.defaultChecked;
      return;
    }
    if (type === 'list') {
      el.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
      return;
    }
    if (el.tagName === 'SELECT') {
      const defaultOption = Array.from(el.options).find((option) => option.defaultSelected);
      el.value = defaultOption ? defaultOption.value : (el.options[0]?.value ?? '');
      dispatchNativeChange(el);
      return;
    }
    if (el.hasAttribute('value') && el.type === 'hidden') return; // fixed fields (e.g. mode)
    el.value = '';
  });
}

function applyOptionsToForm(root, config) {
  resetFields(root);
  root.querySelectorAll('[data-processing-field]').forEach((el) => {
    const field = el.dataset.processingField;
    if (!Object.hasOwn(config || {}, field)) return;
    const type = el.dataset.processingType;
    const value = config[field];
    if (type === 'bool') {
      el.checked = Boolean(value);
    } else if (type === 'list') {
      const set = new Set((value || []).map(String));
      el.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = set.has(cb.value); });
    } else if (el.tagName === 'SELECT') {
      el.value = value === null || value === undefined ? '' : String(value);
      dispatchNativeChange(el);
    } else {
      el.value = value === null || value === undefined ? '' : String(value);
    }
  });
}

// ─── Preview / Apply state ──────────────────────────────────────────────

function setBusy(root, busy) {
  root.__ccProcessingBusy = busy;
  root.querySelectorAll('[data-processing-preview], [data-processing-apply]').forEach((button) => {
    if (button.hasAttribute('data-processing-apply') && !root.__ccPreviewValid) return;
    button.disabled = busy;
    button.setAttribute('aria-disabled', String(busy));
  });
  const previewButton = root.querySelector('[data-processing-preview]');
  if (previewButton) previewButton.disabled = busy;
}

function invalidatePreview(root) {
  root.__ccPreviewValid = false;
  const applyButton = root.querySelector('[data-processing-apply]');
  if (applyButton) {
    applyButton.disabled = true;
    applyButton.setAttribute('aria-disabled', 'true');
    applyButton.classList.remove('button-danger');
  }
}

function setStatus(root, message) {
  const status = root.querySelector('[data-processing-status]');
  if (status) status.textContent = message || '';
}

function showError(root, message) {
  const error = root.querySelector('[data-processing-error]');
  if (!error) return;
  if (!message) {
    error.hidden = true;
    return;
  }
  error.hidden = false;
  const text = error.querySelector('[data-processing-error-text]');
  if (text) text.textContent = message;
}

function clearPlan(root) {
  const plan = root.querySelector('[data-processing-plan]');
  if (plan) plan.hidden = true;
  const result = root.querySelector('[data-processing-result]');
  if (result) result.hidden = true;
}

// ─── Plan rendering ──────────────────────────────────────────────────────

const COUNT_LABELS = {
  total: 'Total', eligible: 'Eligible', changed: 'Changed', unchanged: 'Unchanged',
  skipped: 'Skipped', conflicts: 'Conflicts', destructive: 'Destructive',
};
const MAX_RENDERED_ITEMS = 500;

function renderPlanCounts(root, counts) {
  const dl = root.querySelector('[data-processing-plan-counts]');
  if (!dl || !counts) return;
  dl.innerHTML = '';
  Object.entries(COUNT_LABELS).forEach(([key, label]) => {
    const value = counts[key];
    if (typeof value !== 'number' || (value === 0 && key !== 'total' && key !== 'eligible')) return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    dl.append(dt, dd);
  });
}

function renderDestructiveWarning(root, counts) {
  const warning = root.querySelector('[data-processing-plan-destructive]');
  const applyButton = root.querySelector('[data-processing-apply]');
  const destructive = counts?.destructive || 0;
  if (warning) {
    warning.hidden = destructive === 0;
    warning.textContent = destructive > 0
      ? `This plan includes ${destructive} destructive action${destructive === 1 ? '' : 's'} (such as deleting originals or watermark sources). Review before applying.`
      : '';
  }
  if (applyButton) applyButton.classList.toggle('button-danger', destructive > 0);
}

function planItemLine(item) {
  const parts = [];
  if (item.plannedDestination) parts.push(`→ ${item.plannedDestination}`);
  if (item.sourceAction && item.sourceAction !== 'keep') parts.push(`(${item.sourceAction} source)`);
  return parts.join(' ');
}

function renderPlanItems(root, items) {
  const list = root.querySelector('[data-processing-plan-items]');
  if (!list) return;
  list.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0) return;
  const document = liveDocument(root);
  const shown = items.slice(0, MAX_RENDERED_ITEMS);
  shown.forEach((item) => {
    const li = document.createElement('li');
    li.className = `processing-plan-item processing-plan-item--${item.status || 'unknown'}`;
    if (item.destructive) li.classList.add('processing-plan-item--destructive');
    const name = document.createElement('span');
    name.className = 'processing-plan-item-name';
    name.textContent = item.relativePath || item.filename || `Asset ${item.assetId ?? ''}`;
    const status = document.createElement('span');
    status.className = 'processing-plan-item-status';
    status.textContent = item.status || '';
    li.append(name, status);
    const detail = planItemLine(item);
    if (detail) {
      const detailEl = document.createElement('span');
      detailEl.className = 'processing-plan-item-detail';
      detailEl.textContent = detail;
      li.append(detailEl);
    }
    if (item.reason) {
      const reason = document.createElement('span');
      reason.className = 'processing-plan-item-reason';
      reason.textContent = item.reason;
      li.append(reason);
    }
    list.append(li);
  });
  if (items.length > MAX_RENDERED_ITEMS) {
    const more = document.createElement('li');
    more.className = 'processing-plan-item-more';
    more.textContent = `…and ${items.length - MAX_RENDERED_ITEMS} more.`;
    list.append(more);
  }
}

function renderPlan(root, plan) {
  const planEl = root.querySelector('[data-processing-plan]');
  if (!planEl) return;
  planEl.hidden = false;
  renderPlanCounts(root, plan.counts);
  renderDestructiveWarning(root, plan.counts);
  renderPlanItems(root, plan.items);
}

// ─── Result rendering ────────────────────────────────────────────────────

function resultLine(label, value) {
  return typeof value === 'number' && value > 0 ? `${label}: ${value}` : null;
}

function basename(relativePath) {
  if (typeof relativePath !== 'string') return '';
  return relativePath.split('/').pop();
}

function renderConvertResult(body, result) {
  const p = document.createElement('p');
  p.textContent = `Converted ${result.convertedCount} of ${result.requestedCount} asset${result.requestedCount === 1 ? '' : 's'} to ${String(result.format || '').toUpperCase()}.`;
  body.append(p);
}

function renderWorkflowResult(body, result) {
  [
    resultLine('Changed', result.changedCount),
    resultLine('Unchanged', result.unchangedCount),
    resultLine('No workflow metadata', result.noWorkflowAssetIds?.length),
    resultLine('No prompt change', result.noChangeAssetIds?.length),
  ].filter(Boolean).forEach((line) => {
    const p = document.createElement('p');
    p.textContent = line;
    body.append(p);
  });
}

function renderWatermarkResult(body, result) {
  const p = document.createElement('p');
  p.textContent = `Watermarked ${result.generatedCount} of ${result.requestedCount} asset${result.requestedCount === 1 ? '' : 's'}.`;
  body.append(p);
  if (result.deletedSourceAssetIds?.length) {
    const del = document.createElement('p');
    del.textContent = `Deleted ${result.deletedSourceAssetIds.length} source file${result.deletedSourceAssetIds.length === 1 ? '' : 's'}.`;
    body.append(del);
  }
  if (Array.isArray(result.artifacts) && result.artifacts.length > 0) {
    const heading = document.createElement('p');
    heading.textContent = 'Generated archives:';
    body.append(heading);
    const list = document.createElement('ul');
    result.artifacts.forEach((artifact) => {
      const li = document.createElement('li');
      li.textContent = `${basename(artifact.relativePath)} (${artifact.kind})`;
      list.append(li);
    });
    body.append(list);
  }
}

const RESULT_RENDERERS = {
  convert: renderConvertResult,
  'workflow-prompt': renderWorkflowResult,
  watermark: renderWatermarkResult,
};

function renderResult(root, operation, result) {
  const resultEl = root.querySelector('[data-processing-result]');
  const body = root.querySelector('[data-processing-result-body]');
  if (!resultEl || !body) return;
  body.innerHTML = '';
  resultEl.hidden = false;
  (RESULT_RENDERERS[operation] || (() => {}))(body, result || {});
}

// ─── Preset handling ─────────────────────────────────────────────────────

async function loadPresets(root) {
  const select = root.querySelector('[data-processing-preset-select]');
  if (!select) return;
  const operation = root.dataset.processingOperation;
  const projectId = root.dataset.projectId;
  try {
    const payload = await processingFetchJson(`/processing/presets?operationType=${encodeURIComponent(operation)}`, {
      method: 'GET',
      csrf: root.dataset.csrf,
    });
    root.__ccPresets = new Map((payload.presets || []).map((preset) => [String(preset.id), preset]));
    const current = select.value;
    Array.from(select.querySelectorAll('option:not(:first-child)')).forEach((option) => option.remove());
    (payload.presets || []).forEach((preset) => {
      const option = document.createElement('option');
      option.value = String(preset.id);
      option.textContent = preset.displayName;
      select.append(option);
    });
    if (root.__ccPresets.has(current)) select.value = current;
  } catch {
    // Presets remain unavailable; Custom is always usable.
  }
  void projectId;
}

function applyPreset(root, preset) {
  if (root.dataset.processingOperation === 'workflow-prompt') {
    applyWorkflowRulesToForm(root, 'positive', preset ? preset.config?.positive : null);
    applyWorkflowRulesToForm(root, 'negative', preset ? preset.config?.negative : null);
  } else {
    applyOptionsToForm(root, preset ? preset.config : {});
  }
  if (root.dataset.processingOperation === 'watermark') {
    const watermarkSelect = root.querySelector('#watermark-resource-select');
    const scaleMapSelect = root.querySelector('#watermark-scale-map-select');
    if (watermarkSelect) {
      watermarkSelect.value = preset?.watermarkId ? String(preset.watermarkId) : '';
    }
    if (scaleMapSelect) {
      scaleMapSelect.value = preset?.scaleMapId ? String(preset.scaleMapId) : '';
    }
    updateWatermarkThumb(root);
  }
  root.__ccDirty = false;
  const modifiedNote = root.querySelector('[data-processing-preset-modified]');
  if (modifiedNote) modifiedNote.hidden = true;
  invalidatePreview(root);
  clearPlan(root);
}

function bindPresetSelect(root) {
  const select = root.querySelector('[data-processing-preset-select]');
  if (!select || isBound(select, 'preset')) return;
  markBound(select, 'preset');
  select.addEventListener('change', () => {
    const preset = root.__ccPresets?.get(select.value) || null;
    applyPreset(root, preset);
  });
}

function bindDirtyTracking(root) {
  if (isBound(root, 'dirty')) return;
  markBound(root, 'dirty');
  root.addEventListener('input', (event) => {
    if (event.target.closest('[data-processing-preset-select]')) return;
    if (!event.target.closest('[data-processing-field], [data-processing-scope], [data-processing-directory], [data-processing-recursive], [data-processing-rule-row]')) return;
    root.__ccDirty = true;
    const select = root.querySelector('[data-processing-preset-select]');
    const modifiedNote = root.querySelector('[data-processing-preset-modified]');
    if (select?.value && modifiedNote) modifiedNote.hidden = false;
    invalidatePreview(root);
  });
  root.addEventListener('change', (event) => {
    if (event.target.closest('[data-processing-preset-select]')) return;
    if (!event.target.closest('[data-processing-field], [data-processing-scope], [data-processing-directory], [data-processing-recursive], [data-processing-rule-row]')) return;
    root.__ccDirty = true;
    const select = root.querySelector('[data-processing-preset-select]');
    const modifiedNote = root.querySelector('[data-processing-preset-modified]');
    if (select?.value && modifiedNote) modifiedNote.hidden = false;
    invalidatePreview(root);
  });
}

// ─── Watermark/scale-map resource selects (inside the Watermark dialog) ─

function watermarkOptionLabel(watermark) {
  return `${watermark.displayName} (${watermark.width}×${watermark.height})`;
}

async function loadWatermarkResourceSelects(root) {
  if (root.dataset.processingOperation !== 'watermark') return;
  const watermarkSelect = root.querySelector('#watermark-resource-select');
  const scaleMapSelect = root.querySelector('#watermark-scale-map-select');
  try {
    const payload = await processingFetchJson('/processing/watermarks', { method: 'GET', csrf: root.dataset.csrf });
    const current = watermarkSelect?.value;
    if (watermarkSelect) {
      Array.from(watermarkSelect.querySelectorAll('option:not(:first-child)')).forEach((option) => option.remove());
      (payload.watermarks || []).forEach((watermark) => {
        const option = document.createElement('option');
        option.value = String(watermark.id);
        option.textContent = watermarkOptionLabel(watermark);
        watermarkSelect.append(option);
      });
      if (current && Array.from(watermarkSelect.options).some((option) => option.value === current)) {
        watermarkSelect.value = current;
      } else if (current) {
        watermarkSelect.value = '';
        invalidatePreview(root);
      }
      updateWatermarkThumb(root);
    }
  } catch { /* watermark list stays as-is */ }

  try {
    const payload = await processingFetchJson('/processing/scale-maps', { method: 'GET', csrf: root.dataset.csrf });
    const current = scaleMapSelect?.value;
    if (scaleMapSelect) {
      Array.from(scaleMapSelect.querySelectorAll('option:not(:first-child)')).forEach((option) => option.remove());
      (payload.scaleMaps || []).forEach((scaleMap) => {
        const option = document.createElement('option');
        option.value = String(scaleMap.id);
        option.textContent = scaleMap.displayName;
        scaleMapSelect.append(option);
      });
      if (current && Array.from(scaleMapSelect.options).some((option) => option.value === current)) {
        scaleMapSelect.value = current;
      } else if (current) {
        scaleMapSelect.value = '';
        invalidatePreview(root);
      }
    }
  } catch { /* scale map list stays as-is */ }
}

function updateWatermarkThumb(root) {
  const select = root.querySelector('#watermark-resource-select');
  const thumb = root.querySelector('[data-processing-watermark-thumb]');
  const img = root.querySelector('[data-processing-watermark-thumb-img]');
  if (!select || !thumb || !img) return;
  const id = select.value;
  if (!id) {
    thumb.hidden = true;
    img.removeAttribute('src');
    return;
  }
  const label = select.options[select.selectedIndex]?.textContent || 'Watermark';
  img.src = `/processing/watermarks/${encodeURIComponent(id)}/image`;
  img.alt = `Watermark: ${label}`;
  thumb.hidden = false;
}

function bindWatermarkResourceSelect(root) {
  const select = root.querySelector('#watermark-resource-select');
  if (!select || isBound(select, 'thumb')) return;
  markBound(select, 'thumb');
  select.addEventListener('change', () => updateWatermarkThumb(root));
}

function bindDeleteSourceWarning(root) {
  const checkbox = root.querySelector('[data-processing-delete-source-toggle] input[type="checkbox"]');
  const warning = root.querySelector('[data-processing-delete-source-warning]');
  if (!checkbox || !warning || isBound(checkbox, 'warning')) return;
  markBound(checkbox, 'warning');
  const sync = () => { warning.hidden = !checkbox.checked; };
  checkbox.addEventListener('change', sync);
  sync();
}

// ─── Workflow rule rows ─────────────────────────────────────────────────

let ruleRowCounter = 0;

function syncRuleRowFields(row) {
  const type = row.querySelector('[data-processing-rule-type] input:checked')?.value || 'remove';
  const text = row.querySelector('[data-processing-rule-text]');
  const search = row.querySelector('[data-processing-rule-search]');
  const replacement = row.querySelector('[data-processing-rule-replacement]');
  const isReplace = type === 'replace';
  if (text) text.hidden = isReplace;
  if (search) search.hidden = !isReplace;
  if (replacement) replacement.hidden = !isReplace;
}

function createRuleRow(root, side) {
  const template = root.querySelector('[data-processing-rule-row-template]');
  const fragment = template.content.cloneNode(true);
  const row = fragment.querySelector('[data-processing-rule-row]');
  ruleRowCounter += 1;
  row.querySelectorAll('[data-processing-rule-type] input[type="radio"]').forEach((radio) => {
    radio.name = `rule-type-${side}-${ruleRowCounter}`;
  });
  row.querySelector('[data-processing-rule-type]').addEventListener('change', () => syncRuleRowFields(row));
  row.querySelector('[data-processing-remove-rule]').addEventListener('click', () => {
    row.remove();
    invalidatePreview(root);
    root.__ccDirty = true;
  });
  syncRuleRowFields(row);
  return row;
}

function bindRuleAdders(root) {
  root.querySelectorAll('[data-processing-add-rule]').forEach((button) => {
    if (isBound(button, 'add-rule')) return;
    markBound(button, 'add-rule');
    button.addEventListener('click', () => {
      const side = button.dataset.processingAddRule;
      const list = root.querySelector(`[data-processing-rules="${side}"] [data-processing-rule-list]`);
      if (!list) return;
      list.append(createRuleRow(root, side));
      root.__ccDirty = true;
      invalidatePreview(root);
    });
  });
}

function serializeRuleRow(row) {
  const type = row.querySelector('[data-processing-rule-type] input:checked')?.value || 'remove';
  if (type === 'replace') {
    return {
      type,
      search: row.querySelector('[data-processing-rule-search]')?.value ?? '',
      replacement: row.querySelector('[data-processing-rule-replacement]')?.value ?? '',
    };
  }
  return { type, text: row.querySelector('[data-processing-rule-text]')?.value ?? '' };
}

function collectWorkflowRules(root, side) {
  const rows = Array.from(root.querySelectorAll(`[data-processing-rules="${side}"] [data-processing-rule-row]`));
  return { rules: rows.map(serializeRuleRow) };
}

function applyWorkflowRulesToForm(root, side, ruleList) {
  const list = root.querySelector(`[data-processing-rules="${side}"] [data-processing-rule-list]`);
  if (!list) return;
  list.innerHTML = '';
  (ruleList?.rules || []).forEach((rule) => {
    const row = createRuleRow(root, side);
    const typeRadio = row.querySelector(`[data-processing-rule-type] input[value="${rule.type}"]`);
    if (typeRadio) typeRadio.checked = true;
    if (rule.type === 'replace') {
      const search = row.querySelector('[data-processing-rule-search]');
      const replacement = row.querySelector('[data-processing-rule-replacement]');
      if (search) search.value = rule.search ?? '';
      if (replacement) replacement.value = rule.replacement ?? '';
    } else {
      const text = row.querySelector('[data-processing-rule-text]');
      if (text) text.value = rule.text ?? '';
    }
    syncRuleRowFields(row);
    list.append(row);
  });
}

// ─── Payload assembly ────────────────────────────────────────────────────

function buildRequestBody(root) {
  const scope = resolveScope(root);
  const operation = root.dataset.processingOperation;
  const presetSelect = root.querySelector('[data-processing-preset-select]');
  const usePreset = Boolean(presetSelect?.value) && !root.__ccDirty;

  if (usePreset) {
    const body = { scope, presetId: Number(presetSelect.value) };
    if (operation === 'watermark') {
      const watermarkId = root.querySelector('#watermark-resource-select')?.value || '';
      const scaleMapId = root.querySelector('#watermark-scale-map-select')?.value || '';
      body.runtimeResources = {
        watermarkId: watermarkId ? Number(watermarkId) : null,
        scaleMapId: scaleMapId ? Number(scaleMapId) : null,
      };
    }
    return body;
  }

  if (operation === 'workflow-prompt') {
    return { scope, options: { positive: collectWorkflowRules(root, 'positive'), negative: collectWorkflowRules(root, 'negative') } };
  }
  return { scope, options: collectOptions(root) };
}

// ─── Preview / Apply ─────────────────────────────────────────────────────

async function runPreview(root) {
  if (root.__ccProcessingBusy) return;
  showError(root, '');
  clearPlan(root);
  let body;
  try {
    body = buildRequestBody(root);
  } catch (error) {
    showError(root, error.message);
    return;
  }
  setBusy(root, true);
  setStatus(root, 'Loading preview…');
  try {
    const payload = await processingFetchJson(
      OPERATION_PLAN_PATH(root.dataset.projectId, root.dataset.processingOperation),
      { csrf: root.dataset.csrf, body },
    );
    renderPlan(root, payload.plan);
    root.__ccPreviewValid = true;
    root.__ccLastPreviewBody = JSON.stringify(body);
    const applyButton = root.querySelector('[data-processing-apply]');
    if (applyButton) {
      applyButton.disabled = false;
      applyButton.setAttribute('aria-disabled', 'false');
    }
    setStatus(root, 'Preview ready.');
  } catch (error) {
    showError(root, error.message);
    setStatus(root, '');
  } finally {
    setBusy(root, false);
  }
}

async function runApply(root) {
  if (root.__ccProcessingBusy || !root.__ccPreviewValid) return;
  showError(root, '');
  let body;
  try {
    body = buildRequestBody(root);
  } catch (error) {
    showError(root, error.message);
    return;
  }
  setBusy(root, true);
  setStatus(root, 'Applying…');
  try {
    const payload = await processingFetchJson(
      OPERATION_APPLY_PATH(root.dataset.projectId, root.dataset.processingOperation),
      { csrf: root.dataset.csrf, body },
    );
    renderResult(root, root.dataset.processingOperation, payload.result);
    invalidatePreview(root);
    setStatus(root, 'Applied.');
  } catch (error) {
    showError(root, error.message);
    setStatus(root, '');
  } finally {
    setBusy(root, false);
  }
}

function bindPreviewApply(root) {
  const previewButton = root.querySelector('[data-processing-preview]');
  const applyButton = root.querySelector('[data-processing-apply]');
  const refreshButton = root.querySelector('[data-processing-refresh]');
  if (previewButton && !isBound(previewButton, 'preview')) {
    markBound(previewButton, 'preview');
    previewButton.addEventListener('click', () => runPreview(root));
  }
  if (applyButton && !isBound(applyButton, 'apply')) {
    markBound(applyButton, 'apply');
    applyButton.addEventListener('click', () => runApply(root));
  }
  if (refreshButton && !isBound(refreshButton, 'refresh')) {
    markBound(refreshButton, 'refresh');
    refreshButton.addEventListener('click', () => {
      const window = liveDocument(root)?.defaultView || globalThis;
      window.location.reload();
    });
  }
}

// ─── Dialog lifecycle ────────────────────────────────────────────────────

function resetDialogState(root) {
  invalidatePreview(root);
  clearPlan(root);
  showError(root, '');
  setStatus(root, '');
}

function onDialogOpen(root) {
  updateScopeDisplay(root);
  resetDialogState(root);
  loadPresets(root);
  loadWatermarkResourceSelects(root);
  if (root.dataset.processingOperation === 'workflow-prompt') ensureInitialWorkflowRow(root);
}

function bindDialogOpenTriggers(document) {
  if (isBound(document, 'openTriggers')) return;
  markBound(document, 'openTriggers');
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-dialog-open]');
    if (!trigger) return;
    const dialogId = trigger.getAttribute('data-dialog-open');
    const dialog = document.getElementById(dialogId);
    const root = dialog?.querySelector(ROOT_SELECTOR);
    if (root) onDialogOpen(root);
    const manageWatermarks = dialog?.querySelector(MANAGE_WATERMARKS_SELECTOR);
    if (manageWatermarks) loadManagedWatermarks(manageWatermarks);
    const manageScaleMaps = dialog?.querySelector(MANAGE_SCALE_MAPS_SELECTOR);
    if (manageScaleMaps) loadManagedScaleMaps(manageScaleMaps);
  });

  document.addEventListener('change', (event) => {
    if (!event.target.matches(ASSET_CHECKBOX_SELECTOR)) return;
    document.querySelectorAll(ROOT_SELECTOR).forEach((root) => updateScopeDisplay(root));
  });
}

// ─── Managed watermarks dialog ───────────────────────────────────────────

function watermarkRowMarkup(document, watermark) {
  const li = document.createElement('li');
  li.className = 'processing-resource-row';
  li.dataset.watermarkId = String(watermark.id);

  const img = document.createElement('img');
  img.className = 'processing-resource-thumb';
  img.src = `/processing/watermarks/${watermark.id}/image`;
  img.alt = `Watermark: ${watermark.displayName}`;
  li.append(img);

  const meta = document.createElement('span');
  meta.className = 'processing-resource-meta';
  meta.textContent = `${watermark.displayName} (${watermark.width}×${watermark.height})`;
  li.append(meta);

  const renameForm = document.createElement('form');
  renameForm.className = 'processing-rename-form';
  renameForm.setAttribute('data-processing-rename-watermark', String(watermark.id));
  const renameInput = document.createElement('input');
  renameInput.type = 'text';
  renameInput.value = watermark.displayName;
  renameInput.maxLength = 200;
  renameInput.setAttribute('aria-label', `Rename ${watermark.displayName}`);
  const renameButton = document.createElement('button');
  renameButton.type = 'submit';
  renameButton.className = 'button button-small';
  renameButton.textContent = 'Rename';
  renameForm.append(renameInput, renameButton);
  li.append(renameForm);

  const replaceLabel = document.createElement('label');
  replaceLabel.className = 'button button-small button-secondary';
  replaceLabel.textContent = 'Replace image';
  const replaceInput = document.createElement('input');
  replaceInput.type = 'file';
  replaceInput.accept = 'image/png';
  replaceInput.hidden = true;
  replaceInput.setAttribute('data-processing-replace-watermark', String(watermark.id));
  replaceLabel.append(replaceInput);
  li.append(replaceLabel);

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'button button-danger button-small';
  deleteButton.textContent = 'Delete';
  deleteButton.setAttribute('data-confirm', `Delete the managed watermark "${watermark.displayName}"? Generated project outputs remain, and any preset bound to it becomes unbound.`);
  deleteButton.setAttribute('data-processing-delete-watermark', String(watermark.id));
  li.append(deleteButton);

  return li;
}

async function loadManagedWatermarks(manageRoot) {
  const list = manageRoot.querySelector('[data-processing-watermark-list]');
  if (!list) return;
  try {
    const payload = await processingFetchJson('/processing/watermarks', { method: 'GET', csrf: manageRoot.dataset.csrf });
    const document = liveDocument(manageRoot);
    list.innerHTML = '';
    (payload.watermarks || []).forEach((watermark) => list.append(watermarkRowMarkup(document, watermark)));
    showError(manageRoot, '');
  } catch (error) {
    showError(manageRoot, error.message);
  }
}

function refreshWatermarkConsumers(manageRoot) {
  const document = liveDocument(manageRoot);
  document.querySelectorAll(ROOT_SELECTOR).forEach((root) => {
    if (root.dataset.processingOperation === 'watermark') loadWatermarkResourceSelects(root);
  });
}

function bindManagedWatermarksDialog(manageRoot) {
  if (isBound(manageRoot, 'manageWatermarks')) return;
  markBound(manageRoot, 'manageWatermarks');

  const addForm = manageRoot.querySelector('[data-processing-add-watermark-form]');
  addForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (manageRoot.__ccBusy) return;
    const nameInput = manageRoot.querySelector('#processing-add-watermark-name');
    const fileInput = manageRoot.querySelector('#processing-add-watermark-file');
    const file = fileInput?.files?.[0];
    if (!file) { showError(manageRoot, 'A PNG file is required.'); return; }
    const formData = new FormData();
    formData.set('displayName', nameInput.value);
    formData.set('file', file);
    manageRoot.__ccBusy = true;
    setStatus(manageRoot, 'Adding watermark…');
    try {
      await processingFetchForm('/processing/watermarks', { csrf: manageRoot.dataset.csrf, formData });
      nameInput.value = '';
      fileInput.value = '';
      await loadManagedWatermarks(manageRoot);
      refreshWatermarkConsumers(manageRoot);
      setStatus(manageRoot, 'Watermark added.');
    } catch (error) {
      showError(manageRoot, error.message);
      setStatus(manageRoot, '');
    } finally {
      manageRoot.__ccBusy = false;
    }
  });

  manageRoot.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-processing-rename-watermark]');
    if (!form) return;
    event.preventDefault();
    const id = form.getAttribute('data-processing-rename-watermark');
    const input = form.querySelector('input[type="text"]');
    try {
      await processingFetchJson(`/processing/watermarks/${id}/rename`, {
        csrf: manageRoot.dataset.csrf,
        body: { displayName: input.value },
      });
      await loadManagedWatermarks(manageRoot);
      refreshWatermarkConsumers(manageRoot);
    } catch (error) {
      showError(manageRoot, error.message);
    }
  });

  manageRoot.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-processing-replace-watermark]');
    if (!input) return;
    const id = input.getAttribute('data-processing-replace-watermark');
    const file = input.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.set('file', file);
    try {
      await processingFetchForm(`/processing/watermarks/${id}/replace`, { csrf: manageRoot.dataset.csrf, formData });
      await loadManagedWatermarks(manageRoot);
      refreshWatermarkConsumers(manageRoot);
      setStatus(manageRoot, 'Watermark image replaced. Existing generated files are not retroactively changed.');
    } catch (error) {
      showError(manageRoot, error.message);
    } finally {
      input.value = '';
    }
  });

  manageRoot.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-processing-delete-watermark]');
    if (!button) return;
    const id = button.getAttribute('data-processing-delete-watermark');
    const message = button.getAttribute('data-confirm');
    if (message && !liveDocument(manageRoot).defaultView.confirm(message)) return;
    try {
      await processingFetchJson(`/processing/watermarks/${id}/delete`, { csrf: manageRoot.dataset.csrf, body: {} });
      await loadManagedWatermarks(manageRoot);
      refreshWatermarkConsumers(manageRoot);
      setStatus(manageRoot, 'Watermark deleted.');
    } catch (error) {
      showError(manageRoot, error.message);
    }
  });
}

// ─── Managed scale maps dialog ───────────────────────────────────────────

function scaleMapRowMarkup(document, scaleMap) {
  const li = document.createElement('li');
  li.className = 'processing-resource-row';
  li.dataset.scaleMapId = String(scaleMap.id);

  const meta = document.createElement('span');
  meta.className = 'processing-resource-meta';
  const entryCount = Object.keys(scaleMap.definition || {}).length;
  meta.textContent = `${scaleMap.displayName} (${entryCount} resolution${entryCount === 1 ? '' : 's'})`;
  li.append(meta);

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.className = 'button button-small';
  editButton.textContent = 'Edit';
  editButton.setAttribute('data-processing-scale-map-edit', String(scaleMap.id));
  li.append(editButton);

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'button button-danger button-small';
  deleteButton.textContent = 'Delete';
  deleteButton.setAttribute('data-confirm', `Delete the scale map "${scaleMap.displayName}"?`);
  deleteButton.setAttribute('data-processing-scale-map-delete', String(scaleMap.id));
  li.append(deleteButton);

  return li;
}

async function loadManagedScaleMaps(manageRoot) {
  const list = manageRoot.querySelector('[data-processing-scale-map-list]');
  if (!list) return;
  try {
    const payload = await processingFetchJson('/processing/scale-maps', { method: 'GET', csrf: manageRoot.dataset.csrf });
    const document = liveDocument(manageRoot);
    manageRoot.__ccScaleMaps = new Map((payload.scaleMaps || []).map((scaleMap) => [String(scaleMap.id), scaleMap]));
    list.innerHTML = '';
    (payload.scaleMaps || []).forEach((scaleMap) => list.append(scaleMapRowMarkup(document, scaleMap)));
    showError(manageRoot, '');
  } catch (error) {
    showError(manageRoot, error.message);
  }
}

function refreshScaleMapConsumers(manageRoot) {
  const document = liveDocument(manageRoot);
  document.querySelectorAll(ROOT_SELECTOR).forEach((root) => {
    if (root.dataset.processingOperation === 'watermark') loadWatermarkResourceSelects(root);
  });
}

function scaleMapRow(document, width = '', height = '', scale = '') {
  const row = document.createElement('div');
  row.className = 'processing-scale-map-grid-row';
  const widthInput = document.createElement('input');
  widthInput.type = 'number'; widthInput.min = '1'; widthInput.step = '1'; widthInput.value = width;
  widthInput.setAttribute('aria-label', 'Width');
  const heightInput = document.createElement('input');
  heightInput.type = 'number'; heightInput.min = '1'; heightInput.step = '1'; heightInput.value = height;
  heightInput.setAttribute('aria-label', 'Height');
  const scaleInput = document.createElement('input');
  scaleInput.type = 'number'; scaleInput.min = '0'; scaleInput.step = 'any'; scaleInput.value = scale;
  scaleInput.setAttribute('aria-label', 'Scale');
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'button button-small button-secondary';
  removeButton.textContent = 'Remove';
  removeButton.addEventListener('click', () => row.remove());
  row.append(widthInput, heightInput, scaleInput, removeButton);
  return row;
}

function openScaleMapEditor(manageRoot, scaleMap) {
  const editor = manageRoot.querySelector('[data-processing-scale-map-editor]');
  const title = manageRoot.querySelector('[data-processing-scale-map-editor-title]');
  const nameInput = manageRoot.querySelector('[data-processing-scale-map-name]');
  const defaultInput = manageRoot.querySelector('[data-processing-scale-map-default]');
  const rows = manageRoot.querySelector('[data-processing-scale-map-rows]');
  if (!editor || !rows) return;
  const document = liveDocument(manageRoot);
  editor.hidden = false;
  editor.dataset.editingId = scaleMap ? String(scaleMap.id) : '';
  if (title) title.textContent = scaleMap ? `Edit ${scaleMap.displayName}` : 'New scale map';
  if (nameInput) nameInput.value = scaleMap?.displayName || '';
  rows.innerHTML = '';
  let defaultScale = '';
  Object.entries(scaleMap?.definition || {}).forEach(([key, scale]) => {
    if (key === 'default') { defaultScale = String(scale); return; }
    const [width, height] = key.split('x');
    rows.append(scaleMapRow(document, width, height, String(scale)));
  });
  if (defaultInput) defaultInput.value = defaultScale;
  if (!scaleMap) rows.append(scaleMapRow(document));
}

function collectScaleMapDefinition(manageRoot) {
  const rows = Array.from(manageRoot.querySelectorAll('[data-processing-scale-map-rows] .processing-scale-map-grid-row'));
  const definition = {};
  for (const row of rows) {
    const [widthInput, heightInput, scaleInput] = row.querySelectorAll('input');
    const width = widthInput.value.trim();
    const height = heightInput.value.trim();
    const scale = scaleInput.value.trim();
    if (!width && !height && !scale) continue;
    if (!/^[1-9]\d*$/.test(width) || !/^[1-9]\d*$/.test(height)) {
      throw new ProcessingRequestError('Each resolution row needs a positive integer width and height.');
    }
    const scaleValue = Number(scale);
    if (!Number.isFinite(scaleValue) || scaleValue <= 0) {
      throw new ProcessingRequestError('Each resolution row needs a scale greater than 0.');
    }
    definition[`${width}x${height}`] = scaleValue;
  }
  const defaultInput = manageRoot.querySelector('[data-processing-scale-map-default]');
  const defaultRaw = defaultInput?.value.trim();
  if (defaultRaw) {
    const defaultValue = Number(defaultRaw);
    if (!Number.isFinite(defaultValue) || defaultValue <= 0) {
      throw new ProcessingRequestError('Default scale must be greater than 0.');
    }
    definition.default = defaultValue;
  }
  return definition;
}

function bindManagedScaleMapsDialog(manageRoot) {
  if (isBound(manageRoot, 'manageScaleMaps')) return;
  markBound(manageRoot, 'manageScaleMaps');

  manageRoot.querySelector('[data-processing-scale-map-new]')?.addEventListener('click', () => {
    openScaleMapEditor(manageRoot, null);
  });
  manageRoot.querySelector('[data-processing-scale-map-add-row]')?.addEventListener('click', () => {
    const rows = manageRoot.querySelector('[data-processing-scale-map-rows]');
    rows?.append(scaleMapRow(liveDocument(manageRoot)));
  });
  manageRoot.querySelector('[data-processing-scale-map-cancel]')?.addEventListener('click', () => {
    const editor = manageRoot.querySelector('[data-processing-scale-map-editor]');
    if (editor) editor.hidden = true;
  });

  manageRoot.addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-processing-scale-map-edit]');
    if (editButton) {
      const id = editButton.getAttribute('data-processing-scale-map-edit');
      openScaleMapEditor(manageRoot, manageRoot.__ccScaleMaps?.get(id));
      return;
    }
    const deleteButton = event.target.closest('[data-processing-scale-map-delete]');
    if (deleteButton) {
      const id = deleteButton.getAttribute('data-processing-scale-map-delete');
      const message = deleteButton.getAttribute('data-confirm');
      if (message && !liveDocument(manageRoot).defaultView.confirm(message)) return;
      try {
        await processingFetchJson(`/processing/scale-maps/${id}/delete`, { csrf: manageRoot.dataset.csrf, body: {} });
        await loadManagedScaleMaps(manageRoot);
        refreshScaleMapConsumers(manageRoot);
        setStatus(manageRoot, 'Scale map deleted.');
      } catch (error) {
        showError(manageRoot, error.message);
      }
      return;
    }
    const saveButton = event.target.closest('[data-processing-scale-map-save]');
    if (saveButton) {
      const editor = manageRoot.querySelector('[data-processing-scale-map-editor]');
      const nameInput = manageRoot.querySelector('[data-processing-scale-map-name]');
      const editingId = editor?.dataset.editingId;
      let definition;
      try {
        definition = collectScaleMapDefinition(manageRoot);
      } catch (error) {
        showError(manageRoot, error.message);
        return;
      }
      try {
        if (editingId) {
          if (nameInput.value) {
            await processingFetchJson(`/processing/scale-maps/${editingId}/rename`, {
              csrf: manageRoot.dataset.csrf, body: { displayName: nameInput.value },
            });
          }
          await processingFetchJson(`/processing/scale-maps/${editingId}/replace`, {
            csrf: manageRoot.dataset.csrf, body: { definition },
          });
        } else {
          await processingFetchJson('/processing/scale-maps', {
            csrf: manageRoot.dataset.csrf, body: { displayName: nameInput.value, definition },
          });
        }
        if (editor) editor.hidden = true;
        await loadManagedScaleMaps(manageRoot);
        refreshScaleMapConsumers(manageRoot);
        setStatus(manageRoot, 'Scale map saved.');
      } catch (error) {
        showError(manageRoot, error.message);
      }
    }
  });
}

// ─── Public entry point ──────────────────────────────────────────────────

export function enhanceProcessingDialogs(scope = globalThis.document) {
  const document = liveDocument(scope);
  if (!document || typeof document.querySelectorAll !== 'function') return 0;

  bindDialogOpenTriggers(document);

  let count = 0;
  document.querySelectorAll(ROOT_SELECTOR).forEach((root) => {
    if (isBound(root, 'root')) { count += 1; return; }
    markBound(root, 'root');
    bindPresetSelect(root);
    bindDirtyTracking(root);
    bindPreviewApply(root);
    bindWatermarkResourceSelect(root);
    bindDeleteSourceWarning(root);
    bindRuleAdders(root);
    updateScopeDisplay(root);
    count += 1;
  });

  document.querySelectorAll(MANAGE_WATERMARKS_SELECTOR).forEach(bindManagedWatermarksDialog);
  document.querySelectorAll(MANAGE_SCALE_MAPS_SELECTOR).forEach(bindManagedScaleMapsDialog);

  return count;
}

// Exposed for the Workflow dialog's initial-empty-state convenience — one
// row per side so the dialog never opens with an empty, confusing list.
export function ensureInitialWorkflowRow(root) {
  ['positive', 'negative'].forEach((side) => {
    const list = root.querySelector(`[data-processing-rules="${side}"] [data-processing-rule-list]`);
    if (list && list.children.length === 0) list.append(createRuleRow(root, side));
  });
}

if (typeof document !== 'undefined') {
  const run = () => enhanceProcessingDialogs(document);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}
