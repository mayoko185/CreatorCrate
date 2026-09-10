export const PROJECT_OPTION_CATALOGUE_VERSION = 1;

const NAME_MAX = 100;
const VALUE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR_PATTERN = /^#[0-9A-F]{6}$/;
const RESERVED_VALUES = new Set(['all']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isProjectOptionCatalogueV1DocumentValid(document) {
  if (!isPlainObject(document) || document.version !== PROJECT_OPTION_CATALOGUE_VERSION
    || !Array.isArray(document.entries)) return false;

  const values = new Set();
  const labels = new Set();
  for (const entry of document.entries) {
    if (!isPlainObject(entry)
      || Object.keys(entry).length !== 3
      || !Object.hasOwn(entry, 'value')
      || !Object.hasOwn(entry, 'label')
      || !Object.hasOwn(entry, 'color')
      || typeof entry.value !== 'string'
      || !VALUE_PATTERN.test(entry.value)
      || RESERVED_VALUES.has(entry.value)
      || typeof entry.label !== 'string'
      || entry.label.length < 1
      || entry.label.length > NAME_MAX
      || entry.label !== entry.label.trim()
      || !COLOR_PATTERN.test(entry.color)
      || values.has(entry.value)
      || labels.has(entry.label.toLocaleLowerCase('en-US'))) return false;
    values.add(entry.value);
    labels.add(entry.label.toLocaleLowerCase('en-US'));
  }

  return true;
}

export function isProjectOptionCatalogueV1SerializedValid(serialized) {
  if (typeof serialized !== 'string') return false;
  try {
    return isProjectOptionCatalogueV1DocumentValid(JSON.parse(serialized));
  } catch {
    return false;
  }
}
