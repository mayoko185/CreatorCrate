const ABSOLUTE_WEB_URL_PATTERN = /^https?:\/\/[^\s/]/i;

export function isValidWebUrl(value) {
  if (!value) return true;
  if (typeof value !== 'string') return false;

  const trimmed = value.trim();
  if (!ABSOLUTE_WEB_URL_PATTERN.test(trimmed)) return false;

  try {
    const url = new URL(trimmed);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}
