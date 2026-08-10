export const DEFAULT_ASSET_PICKER_LIMIT = 25;
export const MAX_ASSET_PICKER_LIMIT = 100;

const CURSOR_VERSION = 1;

export class AssetPickerCursorError extends Error {
  constructor() {
    super('Invalid asset picker cursor.');
    this.name = 'AssetPickerCursorError';
    this.code = 'INVALID_CURSOR';
  }
}

export function normalizeAssetPickerQuery(query) {
  if (query === undefined) return '';
  if (typeof query !== 'string') {
    throw new TypeError('Asset picker query must be a string.');
  }
  return query;
}

export function normalizeAssetPickerLimit(limit) {
  if (limit === undefined) return DEFAULT_ASSET_PICKER_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('Asset picker limit must be a positive safe integer.');
  }
  return Math.min(limit, MAX_ASSET_PICKER_LIMIT);
}

export function encodeAssetPickerCursor(payload) {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...payload }), 'utf8').toString('base64url');
}

export function decodeAssetPickerCursor(cursor, scope) {
  if (cursor === undefined) return null;
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new AssetPickerCursorError();
  }

  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) {
      throw new AssetPickerCursorError();
    }

    const payload = JSON.parse(decoded);
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      payload.v !== CURSOR_VERSION ||
      payload.scope !== scope
    ) {
      throw new AssetPickerCursorError();
    }
    return payload;
  } catch (error) {
    if (error instanceof AssetPickerCursorError) throw error;
    throw new AssetPickerCursorError();
  }
}
