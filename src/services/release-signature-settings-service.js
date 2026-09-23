import { randomUUID } from 'node:crypto';

export const RELEASE_SIGNATURES_KEY = 'releases.description_signatures';
const VERSION = 1;
const NAME_MAX = 100;
const BODY_MAX = 4000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ReleaseSignatureValidationError extends Error {
  constructor(errors) {
    super('Release signature validation failed');
    this.errors = errors;
    this.status = 422;
  }
}

export class ReleaseSignatureIntegrityError extends Error {
  constructor(cause) {
    super('Stored release signatures are invalid.', { cause });
  }
}

function invalid(errors) {
  throw new ReleaseSignatureValidationError(errors);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validateDocument(document) {
  if (!hasKeys(document, ['version', 'entries', 'defaultId'])
    || document.version !== VERSION || !Array.isArray(document.entries)
    || (document.defaultId !== null && typeof document.defaultId !== 'string')) {
    invalid({ document: 'Invalid release signature document.' });
  }
  const ids = new Set();
  for (const entry of document.entries) {
    if (!hasKeys(entry, ['id', 'name', 'body']) || typeof entry.id !== 'string'
      || !ID_PATTERN.test(entry.id) || ids.has(entry.id)
      || typeof entry.name !== 'string' || entry.name.trim() !== entry.name
      || entry.name.length < 1 || entry.name.length > NAME_MAX
      || typeof entry.body !== 'string' || entry.body.length > BODY_MAX) {
      invalid({ document: 'Invalid release signature entry.' });
    }
    ids.add(entry.id);
  }
  if (document.defaultId !== null && !ids.has(document.defaultId)) {
    invalid({ defaultId: 'Default signature must exist in the catalogue.' });
  }
  return document;
}

function validateInput(input) {
  if (!hasKeys(input, ['name', 'body'])) invalid({ signature: 'Name and body are required.' });
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const errors = {};
  if (!name || name.length > NAME_MAX) errors.name = `Name must be 1 to ${NAME_MAX} characters.`;
  if (typeof input.body !== 'string' || input.body.length > BODY_MAX) {
    errors.body = `Body must be text of at most ${BODY_MAX} characters.`;
  }
  if (Object.keys(errors).length) invalid(errors);
  return { name, body: input.body };
}

function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) invalid({ id: 'Invalid signature ID.' });
  return id;
}

export function createReleaseSignatureSettingsService({ db, appMetaRepository } = {}) {
  if (!db || typeof db.transaction !== 'function'
    || !appMetaRepository || typeof appMetaRepository.getValue !== 'function'
    || typeof appMetaRepository.setValue !== 'function') {
    throw new TypeError('Release signature settings require a database and app metadata repository.');
  }

  function read() {
    const stored = appMetaRepository.getValue(RELEASE_SIGNATURES_KEY);
    if (stored === undefined) return { version: VERSION, entries: [], defaultId: null };
    try {
      const document = validateDocument(JSON.parse(stored));
      return { ...document, entries: document.entries.map((entry) => ({ ...entry })) };
    } catch (cause) {
      throw new ReleaseSignatureIntegrityError(cause);
    }
  }

  function write(document) {
    validateDocument(document);
    appMetaRepository.setValue(RELEASE_SIGNATURES_KEY, JSON.stringify(document));
    return document;
  }

  const mutate = db.transaction((change) => write(change(read())));
  const save = (change) => mutate.immediate(change);

  return {
    getConfiguration: read,
    add(input) {
      const values = validateInput(input);
      return save((document) => ({ ...document, entries: [
        ...document.entries, { id: randomUUID(), ...values },
      ] }));
    },
    edit(id, input) {
      validateId(id);
      const values = validateInput(input);
      return save((document) => {
        if (!document.entries.some((entry) => entry.id === id)) invalid({ id: 'Signature does not exist.' });
        return { ...document, entries: document.entries.map((entry) => (
          entry.id === id ? { id, ...values } : entry
        )) };
      });
    },
    delete(id) {
      validateId(id);
      return save((document) => {
        if (!document.entries.some((entry) => entry.id === id)) invalid({ id: 'Signature does not exist.' });
        return { ...document, entries: document.entries.filter((entry) => entry.id !== id),
          defaultId: document.defaultId === id ? null : document.defaultId };
      });
    },
    reorder(orderedIds) {
      if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')
        || new Set(orderedIds).size !== orderedIds.length) {
        invalid({ orderedIds: 'Order must contain unique signature IDs.' });
      }
      return save((document) => {
        const entries = new Map(document.entries.map((entry) => [entry.id, entry]));
        if (orderedIds.length !== entries.size || orderedIds.some((id) => !entries.has(id))) {
          invalid({ orderedIds: 'Order must contain every current signature ID exactly once.' });
        }
        return { ...document, entries: orderedIds.map((id) => entries.get(id)) };
      });
    },
    setDefault(id) {
      if (id !== null) validateId(id);
      return save((document) => {
        if (id !== null && !document.entries.some((entry) => entry.id === id)) {
          invalid({ id: 'Default signature must exist in the catalogue.' });
        }
        return { ...document, defaultId: id };
      });
    },
  };
}
