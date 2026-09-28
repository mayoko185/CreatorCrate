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
  releaseUrl,
} from './shared.js';

const NTFY_TOPIC = /^[-_A-Za-z0-9]{1,64}$/;

function normalizeNtfyConfig(config = {}) {
  const server = parseEndpointUrl(config.server, { allowQuery: false });
  const token = optionalText(config.token);
  const authConfigured = typeof token === 'string';
  if (server.reason) return { reason: endpointReason(server, 'server'), authConfigured };
  const topic = optionalText(config.topic);
  if (!topic) return { reason: topic === undefined ? 'invalid_topic' : 'missing_topic', authConfigured };
  if (!NTFY_TOPIC.test(topic)) return { reason: 'invalid_topic', authConfigured };
  if (token === undefined || (authConfigured && !isValidToken(token))) return { reason: 'invalid_token', authConfigured };
  // JSON publishing posts to the server root (or its configured base path).
  const endpoint = new URL(server.url.href);
  if (!endpoint.pathname.endsWith('/')) endpoint.pathname += '/';
  return { endpoint: endpoint.href, topic, token, authConfigured };
}

/**
 * ntfy sender using the documented JSON publish form:
 * POST <server>/ with { topic, title, message, click? }.
 * config: { server, topic, token? }.
 */
export function createNtfySender(config, { fetch: fetchImpl = globalThis.fetch, timeoutMs = HTTP_REQUEST_TIMEOUT_MS } = {}) {
  const normalized = normalizeNtfyConfig(config ?? {});

  return Object.freeze({
    channel: 'ntfy',

    getReadiness() {
      const options = { authConfigured: normalized.authConfigured };
      return normalized.reason ? notReady(normalized.reason, options) : ready(options);
    },

    async send(payload) {
      if (normalized.reason) return permanentFailure('invalid_configuration');
      if (!isSupportedPayload(payload)) return permanentFailure('invalid_payload');
      const body = {
        topic: normalized.topic,
        title: formatTitle(payload),
        message: formatShortMessage(payload),
      };
      const click = releaseUrl(payload);
      if (click) body.click = click;
      const headers = normalized.token ? { Authorization: `Bearer ${normalized.token}` } : {};
      return postJson({ url: normalized.endpoint, body, headers, fetchImpl, timeoutMs });
    },
  });
}
