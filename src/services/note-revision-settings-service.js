export const NOTE_REVISION_RETENTION_KEY = 'notes.revision_retention_count';
export const DEFAULT_NOTE_REVISION_RETENTION = 10;

export class NoteRevisionSettingsValidationError extends Error {
  constructor(errors) {
    super('Note revision settings validation failed');
    this.name = 'NoteRevisionSettingsValidationError';
    this.errors = errors;
    this.code = 'INVALID_REVISION_RETENTION';
  }
}

function invalidRetention() {
  throw new NoteRevisionSettingsValidationError({
    revisionRetention: 'Revision retention must be a positive safe integer.',
  });
}

function parseRetention(value) {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return value;
    return invalidRetention();
  }

  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return invalidRetention();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return invalidRetention();
  return parsed;
}

export function createNoteRevisionSettingsService({ appMetaRepository } = {}) {
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function'
    || typeof appMetaRepository.setValue !== 'function') {
    throw new Error('createNoteRevisionSettingsService requires an appMetaRepository dependency.');
  }

  function getRevisionRetentionSetting() {
    const stored = appMetaRepository.getValue(NOTE_REVISION_RETENTION_KEY);
    if (stored === undefined) {
      return { value: DEFAULT_NOTE_REVISION_RETENTION, isDefault: true };
    }
    return { value: parseRetention(stored), isDefault: false };
  }

  return {
    getRevisionRetention() {
      return getRevisionRetentionSetting().value;
    },

    getRevisionRetentionSetting,

    setRevisionRetention(value) {
      const retention = parseRetention(value);
      appMetaRepository.setValue(NOTE_REVISION_RETENTION_KEY, String(retention));
      return retention;
    },
  };
}
