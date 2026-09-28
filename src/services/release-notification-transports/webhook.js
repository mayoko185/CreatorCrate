import { endpointReason, HTTP_REQUEST_TIMEOUT_MS, parseEndpointUrl, postJson } from './http.js';
import {
  isIsoTimestamp,
  isSupportedPayload,
  isTestPayload,
  isValidToken,
  notReady,
  optionalText,
  permanentFailure,
  readDeliveryId,
  ready,
} from './shared.js';

export const WEBHOOK_SCHEMA_VERSION = 1;

function normalizeWebhookConfig(config = {}) {
  const endpoint = parseEndpointUrl(config.url, { allowQuery: true });
  const token = optionalText(config.token);
  const authConfigured = typeof token === 'string';
  if (endpoint.reason) return { reason: endpointReason(endpoint, 'endpoint'), authConfigured };
  if (token === undefined || (authConfigured && !isValidToken(token))) return { reason: 'invalid_token', authConfigured };
  return { endpoint: endpoint.url.href, token, authConfigured };
}

/**
 * Stable version-1 webhook body. Field names follow WP1's frozen payload
 * (dueAt, timeZone, release.url). Built from structured fields only; the
 * endpoint and credentials never appear in it. createdAt is the payload's
 * frozen creation instant, so every retry of a delivery (same
 * Idempotency-Key) carries an identical body.
 */
export function buildWebhookBody(payload, deliveryId) {
  const base = {
    schemaVersion: WEBHOOK_SCHEMA_VERSION,
    eventId: payload.eventId,
    deliveryId,
    type: payload.type,
    createdAt: payload.createdAt,
  };
  if (isTestPayload(payload)) {
    return { ...base, dueAt: null, release: null, project: null, schedule: null };
  }
  const { release, project, schedule } = payload;
  return {
    ...base,
    dueAt: payload.dueAt ?? null,
    release: { id: release.id, title: release.title, url: release.url ?? null },
    project: { id: project.id, title: project.title },
    schedule: {
      plannedDate: schedule.plannedDate,
      plannedTime: schedule.plannedTime ?? null,
      effectiveTime: schedule.effectiveTime,
      usedDefaultTime: schedule.usedDefaultTime === true,
      timeZone: schedule.timeZone,
      scheduledAt: schedule.scheduledAt,
    },
  };
}

/**
 * Constrained CreatorCrate JSON webhook: POST to the exact configured URL
 * with Idempotency-Key = deliveryId and optional bearer auth. No custom
 * headers, templates, or transformations. Receivers may ignore the
 * idempotency key; it is offered, not guaranteed.
 * config: { url, token? }.
 */
export function createWebhookSender(config, {
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = HTTP_REQUEST_TIMEOUT_MS,
} = {}) {
  const normalized = normalizeWebhookConfig(config ?? {});

  return Object.freeze({
    channel: 'webhook',

    getReadiness() {
      const options = { authConfigured: normalized.authConfigured };
      return normalized.reason ? notReady(normalized.reason, options) : ready(options);
    },

    async send(payload, context) {
      if (normalized.reason) return permanentFailure('invalid_configuration');
      const deliveryId = readDeliveryId(context);
      if (!deliveryId || !isSupportedPayload(payload) || !isIsoTimestamp(payload.createdAt)) {
        return permanentFailure('invalid_payload');
      }
      const headers = { 'Idempotency-Key': deliveryId };
      if (normalized.token) headers.Authorization = `Bearer ${normalized.token}`;
      return postJson({
        url: normalized.endpoint,
        body: buildWebhookBody(payload, deliveryId),
        headers,
        fetchImpl,
        timeoutMs,
      });
    },
  });
}
