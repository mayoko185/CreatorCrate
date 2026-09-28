import nodemailer from 'nodemailer';
import {
  accepted,
  formatPlainTextMessage,
  formatTitle,
  hasControlCharacters,
  isSupportedPayload,
  notReady,
  optionalText,
  permanentFailure,
  ready,
  transientFailure,
} from './shared.js';

export const SMTP_SECURITY_MODES = Object.freeze(['tls', 'starttls', 'plain']);
export const SMTP_DEFAULT_PORTS = Object.freeze({ tls: 465, starttls: 587 });

/** Per-phase protocol limits; Nodemailer enforces each by closing the socket. */
export const SMTP_TIMEOUTS_MS = Object.freeze({
  dns: 5 * 1000,
  connection: 10 * 1000,
  greeting: 10 * 1000,
  socket: 15 * 1000,
});

// One bare mailbox: no display name, list, whitespace, or header syntax.
const MAILBOX = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]{1,253}$/;
const HOSTNAME = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

function readMailbox(value, field) {
  const text = optionalText(value);
  if (text === null) return { reason: `missing_${field}` };
  if (text === undefined || hasControlCharacters(text) || text.length > 254 || !MAILBOX.test(text)) {
    return { reason: `invalid_${field}` };
  }
  return { address: text };
}

/**
 * Validate and normalize an in-memory SMTP configuration without network I/O.
 * Returns { reason, authConfigured } when not ready, otherwise the resolved
 * settings (including the default port for tls/starttls). The resolved
 * object holds the password and must stay internal; its host/port/from/to
 * match what WP1's computeDestinationIdentity('email', ...) expects.
 * config: { host, port?, security, username?, password?, from, to }.
 */
export function normalizeSmtpConfig(config = {}) {
  const username = optionalText(config.username);
  const password = typeof config.password === 'string' && config.password !== '' ? config.password : null;
  const authConfigured = typeof username === 'string' && password !== null;
  const fail = (reason) => ({ reason, authConfigured });

  const host = optionalText(config.host);
  if (host === null) return fail('missing_host');
  if (host === undefined || !HOSTNAME.test(host)) return fail('invalid_host');

  const security = config.security;
  if (!SMTP_SECURITY_MODES.includes(security)) return fail('invalid_security');

  let port = config.port ?? null;
  if (port === null) {
    // Plain SMTP is only for an explicitly configured trusted relay.
    if (security === 'plain') return fail('missing_port');
    port = SMTP_DEFAULT_PORTS[security];
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return fail('invalid_port');

  if (username === undefined || (typeof username === 'string' && hasControlCharacters(username))) {
    return fail('invalid_username');
  }
  if (config.password !== undefined && config.password !== null && typeof config.password !== 'string') {
    return fail('incomplete_auth');
  }
  if ((username === null) !== (password === null)) return fail('incomplete_auth');

  const from = readMailbox(config.from, 'sender');
  if (from.reason) return fail(from.reason);
  const to = readMailbox(config.to, 'recipient');
  if (to.reason) return fail(to.reason);

  return {
    reason: null,
    authConfigured,
    host,
    port,
    security,
    auth: authConfigured ? { user: username, pass: password } : null,
    from: from.address,
    to: to.address,
  };
}

/** Nodemailer transport options for a normalized config. Exported for tests. */
export function buildSmtpTransportOptions(normalized) {
  const options = {
    host: normalized.host,
    port: normalized.port,
    // tls: implicit TLS. starttls: upgrade is mandatory, never opportunistic.
    // plain: no TLS at all, for an explicitly configured trusted relay.
    secure: normalized.security === 'tls',
    requireTLS: normalized.security === 'starttls',
    ignoreTLS: normalized.security === 'plain',
    opportunisticTLS: false,
    tls: { rejectUnauthorized: true },
    dnsTimeout: SMTP_TIMEOUTS_MS.dns,
    connectionTimeout: SMTP_TIMEOUTS_MS.connection,
    greetingTimeout: SMTP_TIMEOUTS_MS.greeting,
    socketTimeout: SMTP_TIMEOUTS_MS.socket,
    // No protocol transcript: it would contain credentials and addresses.
    logger: false,
    debug: false,
    transactionLog: false,
  };
  if (normalized.auth) options.auth = { ...normalized.auth };
  return options;
}

/** Plain-text message for a payload. Exported for tests. */
export function buildSmtpMessage(payload, { from, to }) {
  return {
    from,
    to,
    subject: `[CreatorCrate] ${formatTitle(payload)}`,
    text: formatPlainTextMessage(payload),
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/**
 * Reduce a Nodemailer error to a safe outcome. Only the error code and the
 * numeric SMTP reply code are inspected; messages and server responses may
 * quote credentials or addresses and are never returned.
 */
export function classifySmtpError(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const reply = Number.isSafeInteger(error?.responseCode) ? error.responseCode : null;

  if (code === 'ETLS' || code === 'EREQUIRETLS') return permanentFailure('tls_failed');
  if (reply !== null && reply >= 400 && reply < 500) {
    return transientFailure(reply === 421 ? 'provider_unavailable' : 'smtp_temporary_failure');
  }
  if (reply !== null && reply >= 500 && reply < 600) {
    return permanentFailure(code === 'EAUTH' || reply === 530 || reply === 534 || reply === 535
      ? 'authentication_failed'
      : 'rejected');
  }
  switch (code) {
    case 'ETIMEDOUT': return transientFailure('timeout');
    case 'EDNS': return transientFailure('dns_error');
    case 'ECONNECTION':
    case 'ESOCKET': return transientFailure('network_error');
    case 'EPROTOCOL': return transientFailure('protocol_error');
    case 'EAUTH':
    case 'ENOAUTH': return permanentFailure('authentication_failed');
    case 'EENVELOPE':
    case 'EMESSAGE': return permanentFailure('rejected');
    case 'ECONFIG': return permanentFailure('invalid_configuration');
    default: return transientFailure('unexpected_error');
  }
}

/**
 * SMTP email sender. A new connection is opened per send (no pool).
 * `createTransport` is injectable for tests only.
 */
export function createSmtpSender(config, { createTransport = nodemailer.createTransport } = {}) {
  const normalized = normalizeSmtpConfig(config ?? {});
  let transport = null;

  return Object.freeze({
    channel: 'email',

    getReadiness() {
      const options = { authConfigured: normalized.authConfigured };
      return normalized.reason ? notReady(normalized.reason, options) : ready(options);
    },

    async send(payload) {
      if (normalized.reason) return permanentFailure('invalid_configuration');
      if (!isSupportedPayload(payload)) return permanentFailure('invalid_payload');
      try {
        transport ??= createTransport(buildSmtpTransportOptions(normalized));
        const info = await transport.sendMail(buildSmtpMessage(payload, normalized));
        const acceptedCount = Array.isArray(info?.accepted) ? info.accepted.length : 0;
        const rejectedCount = Array.isArray(info?.rejected) ? info.rejected.length : 0;
        return acceptedCount > 0 && rejectedCount === 0 ? accepted() : permanentFailure('rejected');
      } catch (error) {
        return classifySmtpError(error);
      }
    },
  });
}
