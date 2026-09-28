import { endpointReason, HTTP_REQUEST_TIMEOUT_MS, parseEndpointUrl, postJson } from './http.js';
import {
  formatShortMessage,
  formatTitle,
  isSupportedPayload,
  isValidToken,
  notReady,
  optionalText,
  permanentFailure,
  ready,
} from './shared.js';

/** Gotify "normal" band (4-7); high enough to notify on Android clients. */
export const GOTIFY_PRIORITY = 5;

function normalizeGotifyConfig(config = {}) {
  const server = parseEndpointUrl(config.server, { allowQuery: false });
  const token = optionalText(config.token);
  const authConfigured = typeof token === 'string';
  if (server.reason) return { reason: endpointReason(server, 'server'), authConfigured };
  if (token === null) return { reason: 'missing_token', authConfigured };
  if (!isValidToken(token)) return { reason: 'invalid_token', authConfigured };
  const endpoint = new URL(server.url.href);
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/message`;
  return { endpoint: endpoint.href, token, authConfigured };
}

/**
 * Gotify sender: POST <server>/message with { title, message, priority },
 * authenticated by the application token in the X-Gotify-Key header (never
 * the ?token= query form, which would place the secret in the URL).
 * config: { server, token }.
 */
export function createGotifySender(config, { fetch: fetchImpl = globalThis.fetch, timeoutMs = HTTP_REQUEST_TIMEOUT_MS } = {}) {
  const normalized = normalizeGotifyConfig(config ?? {});

  return Object.freeze({
    channel: 'gotify',

    getReadiness() {
      const options = { authConfigured: normalized.authConfigured };
      return normalized.reason ? notReady(normalized.reason, options) : ready(options);
    },

    async send(payload) {
      if (normalized.reason) return permanentFailure('invalid_configuration');
      if (!isSupportedPayload(payload)) return permanentFailure('invalid_payload');
      return postJson({
        url: normalized.endpoint,
        body: { title: formatTitle(payload), message: formatShortMessage(payload), priority: GOTIFY_PRIORITY },
        headers: { 'X-Gotify-Key': normalized.token },
        fetchImpl,
        timeoutMs,
      });
    },
  });
}
