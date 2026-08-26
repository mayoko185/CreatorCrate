const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error', 'fatal']);
const KINDS = new Set(['activity', 'diagnostic']);
const LEVEL_RANK = new Map(LEVELS.map((level, index) => [level, index]));
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CONTEXT_DEPTH = 4;
const MAX_CONTEXT_ENTRIES = 100;
const MAX_STRING_LENGTH = 2_000;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|csrf|password|secret|session|token|watermark|(?:^|[_-])(?:request|body|headers?|options?)(?:[_-]|$)|(?:request|body|headers?|options?)(?:body|payload|data|headers?|options?)$)/i;
const SENSITIVE_TEXT = /(?:\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic|digest)\s+\S+|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}|\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|session(?:[ _-]?id)?|password|secret|credential)\b(?:\s*[:=]\s*|\s+[\"'(\[<]\s*)\S+|\b(?:cookie|set-cookie)\s*:\s*[^;\r\n]+)/i;
const GENERIC_SECRET_TEXT = /\b(?:token|csrf|auth(?:orization)?)\b\s*[:=]\s*\S+/i;
const STACK_SHAPED_TEXT = /^[^\S\r\n]*(?:[A-Za-z_$][\w$]*(?:Error|Exception)|Error|Exception)\b[^\r\n]*(?:\r?\n[^\S\r\n]*at\s+[^\r\n]+)+/i;
const ABSOLUTE_PATH = /(?:^|[\s"'`([{<=,:;])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))/;

function isSafeWatermarkId(key, value) {
  return key === 'watermarkId'
    && typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0;
}

export const APPLICATION_LOG_LEVELS = LEVELS;

function safeText(value, maximumLength = MAX_STRING_LENGTH) {
  if (typeof value !== 'string') return null;
  if (STACK_SHAPED_TEXT.test(value)) return '[redacted stack trace]';
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (!normalized) return null;
  if (SENSITIVE_TEXT.test(normalized) || GENERIC_SECRET_TEXT.test(normalized)) return '[redacted secret]';
  if (ABSOLUTE_PATH.test(normalized)) return '[redacted path]';
  return normalized.slice(0, maximumLength);
}

function safeError(value) {
  if (!value || typeof value !== 'object') return undefined;
  const name = safeText(typeof value.name === 'string' ? value.name : 'Error', 128) || 'Error';
  const message = safeText(typeof value.message === 'string' ? value.message : String(value), MAX_STRING_LENGTH)
    || 'Unknown error';
  const error = { name, message };
  if (typeof value.code === 'string' || typeof value.code === 'number') {
    error.code = safeText(String(value.code), 128) || undefined;
  }
  return error;
}

function sanitizeValue(value, depth = 0, state = { entries: 0 }) {
  if (state.entries >= MAX_CONTEXT_ENTRIES || depth > MAX_CONTEXT_DEPTH) return '[truncated]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[invalid number]';
  if (typeof value === 'string') return safeText(value) || '';
  if (value instanceof Error) return safeError(value);
  if (Array.isArray(value)) {
    const output = [];
    for (const item of value) {
      if (state.entries >= MAX_CONTEXT_ENTRIES) {
        output.push('[truncated]');
        break;
      }
      state.entries += 1;
      output.push(sanitizeValue(item, depth + 1, state));
    }
    return output;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    return '[unsupported value]';
  }

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (state.entries >= MAX_CONTEXT_ENTRIES) {
      output.truncated = '[truncated]';
      break;
    }
    state.entries += 1;
    const safeKey = safeText(key, 128);
    if (!safeKey) continue;
    output[safeKey] = SENSITIVE_KEY.test(safeKey) && !isSafeWatermarkId(safeKey, entry)
      ? '[redacted]'
      : sanitizeValue(entry, depth + 1, state);
  }
  return output;
}

function sanitizeContext(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value: '[invalid context]' };
  return sanitizeValue(value);
}

function validRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const level = input.level;
  const kind = input.kind;
  if (!LEVEL_RANK.has(level) || !KINDS.has(kind)) return null;
  const subsystem = safeText(input.subsystem, 64);
  const event = safeText(input.event, 128);
  const message = safeText(input.message, 4_096);
  if (!subsystem || !event || !message) return null;
  const projectId = input.projectId === undefined || input.projectId === null ? null : input.projectId;
  if (projectId !== null && (!Number.isSafeInteger(projectId) || projectId <= 0)) return null;
  return {
    level,
    kind,
    subsystem,
    event,
    message,
    projectId,
    correlationId: input.correlationId === undefined || input.correlationId === null
      ? null
      : safeText(input.correlationId, 128),
    context: {
      ...sanitizeContext(input.context),
      ...(input.error ? { error: safeError(input.error) } : {}),
    },
  };
}

/**
 * Process-local application logging boundary. It owns input validation,
 * redaction, persistence selection, and resilient sink failure handling.
 */
export function createApplicationLogger({ repository = null, persistDebug = false, console: consoleSink = console, now = Date.now } = {}) {
  let activeRepository = repository;
  const lastPruneAttemptAtMsByRepository = new WeakMap();
  let lastFallbackMessage = null;

  function fallback(err) {
    const message = safeError(err)?.message || 'Unknown persistence failure';
    if (message === lastFallbackMessage) return;
    lastFallbackMessage = message;
    try {
      consoleSink?.error?.(`[CreatorCrate] Application log persistence failed: ${message}`);
    } catch {
      // Logging must never affect the primary caller, even with a broken console.
    }
  }

  function shouldPersist(level) {
    return LEVEL_RANK.get(level) >= LEVEL_RANK.get(persistDebug ? 'debug' : 'info');
  }

  const logger = {
    log(input) {
      const record = validRecord(input);
      if (!record || !shouldPersist(record.level) || !activeRepository) return false;
      try {
        activeRepository.insert({ ...record, occurredAtMs: now() });
        logger.prune();
        return true;
      } catch (err) {
        fallback(err);
        return false;
      }
    },

    debug(input) { return logger.log({ ...input, level: 'debug' }); },
    info(input) { return logger.log({ ...input, level: 'info' }); },
    warn(input) { return logger.log({ ...input, level: 'warn' }); },
    error(input) { return logger.log({ ...input, level: 'error' }); },
    fatal(input) { return logger.log({ ...input, level: 'fatal' }); },

    getRepository() {
      return activeRepository;
    },
    rebindRepository(repositoryToBind) {
      activeRepository = repositoryToBind || null;
    },

    prune() {
      const nowMs = now();
      if (!activeRepository) return false;
      const lastPruneAttemptAtMs = lastPruneAttemptAtMsByRepository.get(activeRepository);
      if (lastPruneAttemptAtMs !== undefined && nowMs - lastPruneAttemptAtMs < DAY_MS) {
        return false;
      }
      lastPruneAttemptAtMsByRepository.set(activeRepository, nowMs);
      try {
        activeRepository.prune({ nowMs });
        return true;
      } catch (err) {
        fallback(err);
        return false;
      }
    },
  };

  return Object.freeze(logger);
}
