const INTENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function isSocialPrepIntentToken(value) {
  return typeof value === 'string' && INTENT_TOKEN_PATTERN.test(value);
}

function cleanServerOrigin(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.pathname !== '/'
    || parsed.search || parsed.hash) return null;
  if (value !== parsed.origin && value !== `${parsed.origin}/`) return null;
  return parsed.origin;
}

/** Builds the deliberately minimal native-helper activation URI. */
export function buildSocialPrepUri({ origin, intent } = {}) {
  const serverOrigin = cleanServerOrigin(origin);
  if (serverOrigin === null) throw new TypeError('Social Preparation server origin must be a clean HTTP(S) origin.');
  if (!isSocialPrepIntentToken(intent)) throw new TypeError('Social Preparation intent must be a 43-character base64url token.');
  return `creatorcrate-social://prepare?v=1&server=${encodeURIComponent(serverOrigin)}&intent=${intent}`;
}
