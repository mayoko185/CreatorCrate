import {
  creatorCrateDropdownSummaryForNativeSelect,
  initializeCreatorCrateDropdown,
  syncCreatorCrateDropdownFromNative,
} from './dropdowns.js';
import { enhanceNumberInputs } from './number-input.js';

let archiveEntryCounter = 0;

function entries(root) {
  return Array.from(root.querySelectorAll('[data-archive-entry]'));
}

function field(entry, name) {
  return entry.querySelector(`[data-archive-field="${name}"]`);
}

export function collectArchiveOptions(root) {
  const archives = entries(root).map((entry, index) => {
    const naming = root.querySelector(`[data-archive-naming="${entry.dataset.archiveEntry}"]`);
    const imageFormat = field(entry, 'imageFormat').value;
    const archive = {
      archiveFormat: field(entry, 'archiveFormat').value,
      imageFormat,
    };
    for (const name of ['setName', 'prefix', 'baseName']) {
      const value = field(name === 'baseName' ? naming : entry, name).value;
      if (value !== '') archive[name] = value;
    }
    if (imageFormat === 'webp') archive.lossless = field(entry, 'lossless').checked;
    if (imageFormat === 'jpeg' || (imageFormat === 'webp' && !archive.lossless)) {
      const input = field(entry, imageFormat === 'jpeg' ? 'jpegQuality' : 'webpQuality');
      const quality = Number(input.value);
      if (input.value === '' || !Number.isInteger(quality) || quality < 1 || quality > 100) {
        throw new Error(`Archive ${index + 1}: quality must be an integer from 1 to 100.`);
      }
      archive.quality = quality;
    }
    return archive;
  });
  if (!archives.length) throw new Error('Add at least one archive.');
  const options = { archives, replaceExistingArchives: root.querySelector('[data-archive-replace]').checked };
  const outputDirectory = root.querySelector('[data-processing-field="outputDirectory"]');
  if (outputDirectory?.value) options.outputDirectory = outputDirectory.value;
  return options;
}

export function setArchiveEditorFrozen(root, frozen) {
  if (root.__ccArchiveEditorFrozen === frozen) return;
  root.__ccArchiveEditorFrozen = frozen;
  const sections = root.querySelectorAll('[data-archive-create], [data-archive-advanced]');
  if (frozen) {
    root.__ccArchiveDisabledControls = new Map();
    sections.forEach((section) => {
      section.querySelectorAll('input, select, button').forEach((control) => {
        root.__ccArchiveDisabledControls.set(control, control.disabled);
        control.disabled = true;
      });
      section.querySelectorAll('[data-cc-dropdown]').forEach((dropdown) => { dropdown.open = false; });
      section.inert = true;
    });
  } else {
    sections.forEach((section) => { section.inert = false; });
    root.__ccArchiveDisabledControls?.forEach((disabled, control) => { control.disabled = disabled; });
    root.__ccArchiveDisabledControls = null;
    entries(root).forEach(syncImageSettings);
    renumberEntries(root);
  }
}

function announceConfigurationChange(root) {
  root.dispatchEvent(new CustomEvent('cc:archive-configuration-change', { bubbles: true }));
}

function cloneTemplate(root, selector, key) {
  const fragment = root.querySelector(selector).content.cloneNode(true);
  fragment.querySelectorAll('[id], [for], [aria-controls], [aria-labelledby], [aria-describedby]').forEach((element) => {
    ['id', 'for', 'aria-controls', 'aria-labelledby', 'aria-describedby'].forEach((attribute) => {
      if (!element.hasAttribute(attribute)) return;
      element.setAttribute(attribute, element.getAttribute(attribute).replaceAll('archive-entry', key));
    });
  });
  return fragment.firstElementChild;
}

function syncImageSettings(entry) {
  const format = field(entry, 'imageFormat').value;
  const lossless = field(entry, 'lossless').checked;
  entry.querySelector('[data-archive-jpeg-options]').hidden = format !== 'jpeg';
  entry.querySelector('[data-archive-webp-options]').hidden = format !== 'webp';
  field(entry, 'jpegQuality').disabled = format !== 'jpeg';
  field(entry, 'webpQuality').disabled = format !== 'webp' || lossless;
  field(entry, 'lossless').disabled = format !== 'webp';
  entry.querySelector('[data-archive-lossless-hint]').hidden = !lossless;
  enhanceNumberInputs(entry);
}

function syncNamingHints(root, entry) {
  const comic = ['cbz', 'cb7'].includes(field(entry, 'archiveFormat').value);
  field(entry, 'prefix').placeholder = comic ? 'archive_' : '';
  const naming = root.querySelector(`[data-archive-naming="${entry.dataset.archiveEntry}"]`);
  field(naming, 'baseName').placeholder = comic ? 'Project slug' : 'archive';
}

function renumberEntries(root) {
  const remaining = entries(root);
  remaining.forEach((entry, index) => {
    const label = `Archive ${index + 1}`;
    entry.querySelector('[data-archive-heading]').textContent = label;
    const remove = entry.querySelector('[data-archive-remove]');
    remove.setAttribute('aria-label', `Remove archive ${index + 1}`);
    remove.disabled = remaining.length === 1;
    remove.setAttribute('aria-disabled', String(remove.disabled));
    root.querySelector(`[data-archive-naming="${entry.dataset.archiveEntry}"] [data-archive-naming-heading]`).textContent = label;
  });
}

function focusArchiveFormat(entry) {
  creatorCrateDropdownSummaryForNativeSelect(field(entry, 'archiveFormat'))?.focus();
}

function addEntry(root, imageFormat = 'jpeg') {
  const key = `archive-config-${++archiveEntryCounter}`;
  const entry = cloneTemplate(root, '[data-archive-entry-template]', key);
  entry.dataset.archiveEntry = key;
  const naming = cloneTemplate(root, '[data-archive-naming-template]', key);
  naming.dataset.archiveNaming = key;
  root.querySelector('[data-archive-entries]').append(entry);
  root.querySelector('[data-archive-naming-list]').append(naming);
  field(entry, 'imageFormat').value = imageFormat;
  entry.querySelectorAll('[data-cc-dropdown]').forEach(initializeCreatorCrateDropdown);
  syncImageSettings(entry);
  syncNamingHints(root, entry);
  renumberEntries(root);
  return entry;
}

export function resetArchiveEditor(root) {
  root.querySelector('[data-archive-entries]').replaceChildren();
  root.querySelector('[data-archive-naming-list]').replaceChildren();
  root.querySelector('[data-archive-advanced]').open = false;
  root.querySelector('[data-archive-replace]').checked = false;
  root.querySelector('[data-archive-announcement]').textContent = '';
  addEntry(root);
}

export function initializeArchiveEditor(root) {
  if (root.dataset.processingOperation !== 'archive' || root.__ccArchiveEditorBound) return;
  root.__ccArchiveEditorBound = true;
  resetArchiveEditor(root);
  root.addEventListener('change', (event) => {
    const entry = event.target.closest('[data-archive-entry]');
    if (!entry) return;
    if (event.target.matches('[data-archive-field="imageFormat"], [data-archive-field="lossless"]')) {
      syncImageSettings(entry);
    }
    if (event.target.matches('[data-archive-field="archiveFormat"]')) syncNamingHints(root, entry);
    if (event.target.matches('select[data-archive-field]')) syncCreatorCrateDropdownFromNative(event.target);
  });
  root.addEventListener('click', (event) => {
    if (root.__ccArchiveEditorFrozen) return;
    if (event.target.closest('[data-archive-add]')) {
      const entry = addEntry(root);
      root.querySelector('[data-archive-announcement]').textContent = `Archive ${entries(root).length} added.`;
      focusArchiveFormat(entry);
      announceConfigurationChange(root);
    }
    const remove = event.target.closest('[data-archive-remove]');
    if (!remove) return;
    const current = entries(root);
    if (current.length <= 1) return;
    const entry = remove.closest('[data-archive-entry]');
    const index = current.indexOf(entry);
    const next = current[index + 1] || current[index - 1];
    root.querySelector(`[data-archive-naming="${entry.dataset.archiveEntry}"]`).remove();
    entry.remove();
    renumberEntries(root);
    root.querySelector('[data-archive-announcement]').textContent = `Archive ${index + 1} removed. ${current.length - 1} remaining.`;
    focusArchiveFormat(next);
    announceConfigurationChange(root);
  });
}
