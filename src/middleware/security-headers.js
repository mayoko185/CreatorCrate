const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function isStaticAsset(req) {
  return req.method === 'GET' && /\.[A-Za-z0-9]+$/.test(req.path);
}

function isNoStoreHtmlPath(req, authEnabled) {
  if (req.path === '/login') return true;
  if (req.path.startsWith('/settings')) return true;
  if (authEnabled && !isStaticAsset(req) && req.accepts(['html', 'json']) === 'html') return true;
  return false;
}

export function createSecurityHeadersMiddleware({ assetMode = 'production', hstsEnabled = false } = {}) {
  const csp = assetMode === 'development' ? DEVELOPMENT_CSP : CSP;
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (hstsEnabled) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  };
}

export function createCachePolicyMiddleware() {
  return (req, res, next) => {
    const authEnabled = !!res.locals.auth?.enabled;
    if (isNoStoreHtmlPath(req, authEnabled)) {
      res.setHeader('Cache-Control', 'private, no-store');
    }
    next();
  };
}

export const SECURITY_CSP = CSP;
export const DEVELOPMENT_SECURITY_CSP = DEVELOPMENT_CSP;
