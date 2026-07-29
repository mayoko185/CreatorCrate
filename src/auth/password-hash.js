import crypto from 'node:crypto';

// Node's built-in scrypt (RFC 7914) — a maintained, memory-hard KDF shipped
// with the runtime itself, so no additional native dependency is needed on
// top of the ones the Docker image already builds (e.g. better-sqlite3).
const ALGO = 'scrypt';
const KEY_LEN = 64;
const DEFAULT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });
// scrypt requires an explicit maxmem override once N*r*128 exceeds Node's
// conservative 32MB default; 64MB comfortably covers the parameters above.
const MAX_MEM = 64 * 1024 * 1024;

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }
  const salt = crypto.randomBytes(16);
  const { N, r, p } = DEFAULT_PARAMS;
  const derivedKey = crypto.scryptSync(password, salt, KEY_LEN, { N, r, p, maxmem: MAX_MEM });
  return [ALGO, N, r, p, salt.toString('base64'), derivedKey.toString('base64')].join('$');
}

export function isValidPasswordHash(encoded) {
  if (typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 6) return false;
  const [algo, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  if (algo !== ALGO) return false;
  if (![nRaw, rRaw, pRaw].every((v) => /^[1-9]\d*$/.test(v))) return false;
  if (saltB64.length === 0 || hashB64.length === 0) return false;
  try {
    Buffer.from(saltB64, 'base64');
    Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  return true;
}

// Constant-time verification: derives a key with the salt/params embedded in
// `encoded` and compares it to the stored digest via crypto.timingSafeEqual,
// so response timing never leaks how much of the password matched.
export function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || !isValidPasswordHash(encoded)) return false;

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = encoded.split('$');
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');

  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
      maxmem: MAX_MEM,
    });
  } catch {
    return false;
  }

  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}
