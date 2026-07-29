import crypto from 'node:crypto';

// 256 bits of randomness, URL/cookie-safe encoding.
export function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Session identifiers are stored as HMAC(secret, token) rather than the raw
// token or a plain hash, so rotating SESSION_SECRET invalidates every
// previously issued session (see docs on the restore/secret-rotation
// contract) and a database leak alone never yields a usable cookie.
export function hashSessionToken(token, secret) {
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}
