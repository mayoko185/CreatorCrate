import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import net from 'node:net';
import {
  buildSmtpMessage,
  buildSmtpTransportOptions,
  createSmtpSender,
  normalizeSmtpConfig,
  SMTP_TIMEOUTS_MS,
} from '../src/services/release-notification-transports/smtp.js';
import { createTestNotificationPayload } from '../src/services/release-notification-transports/shared.js';

const PASSWORD = 'pw-SuperSecret123';

const PAYLOAD = Object.freeze({
  schemaVersion: 1,
  eventId: 'evt-1',
  type: 'release.overdue',
  dueAt: '2026-10-01T10:00:00.000Z',
  release: Object.freeze({ id: 123, title: 'Autumn Zine', url: 'https://cc.example.test/releases/123' }),
  project: Object.freeze({ id: 45, title: 'Zines' }),
  schedule: Object.freeze({
    plannedDate: '2026-10-01',
    plannedTime: null,
    effectiveTime: '09:00',
    usedDefaultTime: true,
    timeZone: 'UTC',
    scheduledAt: '2026-10-01T09:00:00.000Z',
  }),
});

const BASE = Object.freeze({ host: 'smtp.example.test', security: 'tls', from: 'cc@example.test', to: 'me@example.test' });

describe('SMTP configuration readiness', () => {
  it('accepts a valid TLS configuration and defaults its port to 465', () => {
    expect(createSmtpSender(BASE).getReadiness()).toEqual({ ready: true, reason: null, authConfigured: false });
    expect(normalizeSmtpConfig(BASE).port).toBe(465);
  });

  it('defaults STARTTLS to port 587 and requires the upgrade', () => {
    const normalized = normalizeSmtpConfig({ ...BASE, security: 'starttls' });
    expect(normalized.port).toBe(587);
    const options = buildSmtpTransportOptions(normalized);
    expect(options).toMatchObject({ port: 587, secure: false, requireTLS: true, ignoreTLS: false, opportunisticTLS: false });
    expect(options.tls.rejectUnauthorized).toBe(true);
  });

  it('uses implicit TLS, bounded phase timeouts, and no protocol logging', () => {
    const options = buildSmtpTransportOptions(normalizeSmtpConfig({ ...BASE, username: 'u', password: PASSWORD }));
    expect(options).toMatchObject({
      secure: true,
      requireTLS: false,
      dnsTimeout: SMTP_TIMEOUTS_MS.dns,
      connectionTimeout: SMTP_TIMEOUTS_MS.connection,
      greetingTimeout: SMTP_TIMEOUTS_MS.greeting,
      socketTimeout: SMTP_TIMEOUTS_MS.socket,
      logger: false,
      debug: false,
      transactionLog: false,
      auth: { user: 'u', pass: PASSWORD },
    });
    expect(SMTP_TIMEOUTS_MS).toEqual({ dns: 5000, connection: 10000, greeting: 10000, socket: 15000 });
  });

  it('requires an explicit port for plain SMTP', () => {
    expect(createSmtpSender({ ...BASE, security: 'plain' }).getReadiness().reason).toBe('missing_port');
    expect(createSmtpSender({ ...BASE, security: 'plain', port: 25 }).getReadiness().ready).toBe(true);
    expect(createSmtpSender({ ...BASE, security: undefined }).getReadiness().reason).toBe('invalid_security');
  });

  it('requires username and password together', () => {
    expect(createSmtpSender({ ...BASE, username: 'u' }).getReadiness().reason).toBe('incomplete_auth');
    const readiness = createSmtpSender({ ...BASE, password: PASSWORD }).getReadiness();
    expect(readiness).toEqual({ ready: false, reason: 'incomplete_auth', authConfigured: false });
    expect(createSmtpSender({ ...BASE, username: 'u', password: PASSWORD }).getReadiness())
      .toEqual({ ready: true, reason: null, authConfigured: true });
  });

  it.each([
    [{ host: '' }, 'missing_host'],
    [{ host: 'smtp.example.test\r\nX: y' }, 'invalid_host'],
    [{ port: 70000 }, 'invalid_port'],
    [{ from: '' }, 'missing_sender'],
    [{ to: undefined }, 'missing_recipient'],
    [{ from: 'cc@example.test\r\nBcc: evil@example.test' }, 'invalid_sender'],
    [{ to: 'a@example.test, b@example.test' }, 'invalid_recipient'],
    [{ to: 'Me <me@example.test>' }, 'invalid_recipient'],
    [{ to: 'not-an-address' }, 'invalid_recipient'],
  ])('rejects %o as %s', (override, reason) => {
    const readiness = createSmtpSender({ ...BASE, ...override, password: PASSWORD, username: 'u' }).getReadiness();
    expect(readiness.reason).toBe(reason);
    expect(JSON.stringify(readiness)).not.toContain(PASSWORD);
  });
});

describe('SMTP message formatting', () => {
  it('formats a release notification as plain text', () => {
    const message = buildSmtpMessage(PAYLOAD, { from: 'cc@example.test', to: 'me@example.test' });
    expect(message).toMatchObject({ from: 'cc@example.test', to: 'me@example.test', subject: '[CreatorCrate] Overdue: Autumn Zine' });
    expect(message).not.toHaveProperty('html');
    expect(message).not.toHaveProperty('attachments');
    expect(message.text).toContain('Reason: Overdue');
    expect(message.text).toContain('Project: Zines (ID 45)');
    expect(message.text).toContain('Release: Autumn Zine (ID 123)');
    expect(message.text).toContain('Planned: 2026-10-01 (no time set; using 09:00)');
    expect(message.text).toContain('Time zone: UTC');
    expect(message.text).toContain('Scheduled instant: 2026-10-01T09:00:00.000Z');
    expect(message.text).toContain('Link: https://cc.example.test/releases/123');
  });

  it.each([
    ['release.advance', 'Upcoming'],
    ['release.scheduled', 'Scheduled'],
    ['release.overdue_repeat', 'Still overdue'],
  ])('labels %s as %s', (type, label) => {
    expect(buildSmtpMessage({ ...PAYLOAD, type }, {}).subject).toBe(`[CreatorCrate] ${label}: Autumn Zine`);
  });

  it('keeps release titles on one subject line', () => {
    const payload = { ...PAYLOAD, release: { ...PAYLOAD.release, title: 'Zine\r\nBcc: evil@example.test' } };
    expect(buildSmtpMessage(payload, {}).subject).toBe('[CreatorCrate] Overdue: Zine Bcc: evil@example.test');
  });

  it('clearly marks a test notification', () => {
    const message = buildSmtpMessage(createTestNotificationPayload({ eventId: 'evt-test' }), {});
    expect(message.subject).toBe('[CreatorCrate] Test notification');
    expect(message.text).toContain('CreatorCrate test notification');
    expect(message.text).toContain('No release is associated with this message.');
  });
});

describe('SMTP error normalization', () => {
  function senderFailingWith(error) {
    const createTransport = () => ({ sendMail: async () => { throw error; } });
    return createSmtpSender({ ...BASE, username: 'u', password: PASSWORD }, { createTransport });
  }

  function smtpError(code, responseCode) {
    const error = new Error(`failure for u:${PASSWORD} response=535 ${PASSWORD}`);
    error.code = code;
    if (responseCode) error.responseCode = responseCode;
    error.response = `${responseCode ?? ''} ${PASSWORD}`;
    return error;
  }

  it.each([
    [smtpError('ETIMEDOUT'), { outcome: 'transient_failure', failureCode: 'timeout' }],
    [smtpError('ESOCKET'), { outcome: 'transient_failure', failureCode: 'network_error' }],
    [smtpError('ECONNECTION'), { outcome: 'transient_failure', failureCode: 'network_error' }],
    [smtpError('EDNS'), { outcome: 'transient_failure', failureCode: 'dns_error' }],
    [smtpError('EENVELOPE', 451), { outcome: 'transient_failure', failureCode: 'smtp_temporary_failure' }],
    [smtpError('ECONNECTION', 421), { outcome: 'transient_failure', failureCode: 'provider_unavailable' }],
    [smtpError('EAUTH', 535), { outcome: 'permanent_failure', failureCode: 'authentication_failed' }],
    [smtpError('EENVELOPE', 550), { outcome: 'permanent_failure', failureCode: 'rejected' }],
    [smtpError('ETLS', 502), { outcome: 'permanent_failure', failureCode: 'tls_failed' }],
    [new Error(`boom ${PASSWORD}`), { outcome: 'transient_failure', failureCode: 'unexpected_error' }],
  ])('normalizes %o', async (error, expected) => {
    const result = await senderFailingWith(error).send(PAYLOAD);
    expect(result).toStrictEqual(expected);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it('does not attempt delivery with invalid configuration', async () => {
    let created = false;
    const sender = createSmtpSender({ ...BASE, to: '' }, { createTransport: () => { created = true; } });
    expect(await sender.send(PAYLOAD)).toStrictEqual({ outcome: 'permanent_failure', failureCode: 'invalid_configuration' });
    expect(created).toBe(false);
  });
});

describe('SMTP delivery against a local scripted server', () => {
  let server;
  let port;
  let session;
  let replies;

  beforeAll(async () => {
    server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      let inData = false;
      socket.write('220 fake.test ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              socket.write('250 2.0.0 queued\r\n');
            } else {
              session.data.push(line);
            }
            continue;
          }
          session.commands.push(line);
          const verb = line.split(/[ :]/)[0].toUpperCase();
          if (verb === 'EHLO') socket.write('250-fake.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
          else if (verb === 'QUIT') socket.end('221 bye\r\n');
          else if (verb === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
          else socket.write(`${replies[verb] ?? '250 OK'}\r\n`);
        }
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    session = { commands: [], data: [] };
    replies = {};
  });

  const plainConfig = () => ({ host: '127.0.0.1', port, security: 'plain', from: 'cc@example.test', to: 'me@example.test' });

  it('delivers one plain-text message to one recipient', async () => {
    expect(await createSmtpSender(plainConfig()).send(PAYLOAD)).toStrictEqual({ outcome: 'accepted' });
    expect(session.commands).toContain('MAIL FROM:<cc@example.test>');
    expect(session.commands.filter((command) => command.startsWith('RCPT'))).toEqual(['RCPT TO:<me@example.test>']);
    expect(session.commands.some((command) => command.startsWith('STARTTLS'))).toBe(false);
    const data = session.data.join('\n');
    expect(data).toContain('Subject: [CreatorCrate] Overdue: Autumn Zine');
    expect(data).toMatch(/Content-Type: text\/plain/i);
    expect(data).not.toMatch(/text\/html/i);
  });

  it('classifies a permanent recipient rejection', async () => {
    replies.RCPT = '550 5.1.1 no such user';
    expect(await createSmtpSender(plainConfig()).send(PAYLOAD)).toStrictEqual({ outcome: 'permanent_failure', failureCode: 'rejected' });
  });

  it('classifies a temporary rejection as transient', async () => {
    replies.RCPT = '451 4.3.0 try later';
    expect(await createSmtpSender(plainConfig()).send(PAYLOAD)).toStrictEqual({ outcome: 'transient_failure', failureCode: 'smtp_temporary_failure' });
  });

  it('classifies authentication failure without exposing the password', async () => {
    replies.AUTH = '535 5.7.8 authentication failed';
    const result = await createSmtpSender({ ...plainConfig(), username: 'u', password: PASSWORD }).send(PAYLOAD);
    expect(result).toStrictEqual({ outcome: 'permanent_failure', failureCode: 'authentication_failed' });
  });

  it('refuses to continue unencrypted when STARTTLS is unavailable', async () => {
    replies.STARTTLS = '502 5.5.1 not implemented';
    const result = await createSmtpSender({ ...plainConfig(), security: 'starttls' }).send(PAYLOAD);
    expect(result).toStrictEqual({ outcome: 'permanent_failure', failureCode: 'tls_failed' });
    expect(session.commands).toContain('STARTTLS');
    expect(session.commands.some((command) => command.startsWith('MAIL'))).toBe(false);
  });

  it('reports an unreachable server as a transient network error', async () => {
    const result = await createSmtpSender({ ...plainConfig(), port: 1 }).send(PAYLOAD);
    expect(result).toStrictEqual({ outcome: 'transient_failure', failureCode: 'network_error' });
  });
});
