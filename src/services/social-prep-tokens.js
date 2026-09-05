import crypto from 'node:crypto';

const TOKEN_BYTES = 32;

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Generates a 256-bit opaque capability token. */
export function generateIntentToken() {
  return generateToken();
}

/** Generates a 256-bit opaque media capability token. */
export function generateMediaToken() {
  return generateToken();
}

/** Returns the lowercase SHA-256 hex digest of a raw capability token. */
export function digestToken(raw) {
  if (typeof raw !== 'string') throw new TypeError('Social Preparation token must be a string.');
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}
