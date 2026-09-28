import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { createNtfySender } from '../src/services/release-notification-transports/ntfy.js';
import { createGotifySender, GOTIFY_PRIORITY } from '../src/services/release-notification-transports/gotify.js';
import { createWebhookSender } from '../src/services/release-notification-transports/webhook.js';
import { parseEndpointUrl, parseRetryAfterMs } from '../src/services/release-notification-transports/http.js';
import { createTestNotificationPayload, isIsoTimestamp } from '../src/services/release-notification-transports/shared.js';
import { RETRY_AFTER_MAX_MS } from '../src/services/release-notification-service.js';

const SECRET = 'tk_SuperSecret123';

// Shape produced by WP1's buildPayload().
const PAYLOAD = Object.freeze({
  schemaVersion: 1,
  eventId: 'evt-1',
  type: 'release.overdue',
  createdAt: '2026-10-01T10:00:01.000Z',
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
const CONTEXT = Object.freeze({ deliveryId: 'dlv-1' });

let server;
let baseUrl;
let requests;
let respond;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), closed: false };
      res.on('close', () => { record.closed = true; });
      requests.push(record);
      respond(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  respond = (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":1}'); };
});

function replyWith(status, headers = {}, body = `upstream says ${SECRET}`) {
  respond = (req, res) => { res.writeHead(status, headers); res.end(body); };
}

const FACTORIES = { ntfy: createNtfySender, gotify: createGotifySender, webhook: createWebhookSender };

function configFor(name, origin) {
  return {
    ntfy: { server: origin, topic: 'releases', token: SECRET },
    gotify: { server: origin, token: SECRET },
    webhook: { url: `${origin}/hook/${SECRET}?key=${SECRET}`, token: SECRET },
  }[name];
}

const createSender = (name, options) => FACTORIES[name](configFor(name, baseUrl), options);

describe('shared HTTP helpers', () => {
  it('validates endpoint URLs without allowing userinfo or fragments', () => {
    expect(parseEndpointUrl('http://ntfy.lan:8080').url.href).toBe('http://ntfy.lan:8080/');
    expect(parseEndpointUrl('https://user:pw@ntfy.example.test')).toEqual({ reason: 'invalid' });
    expect(parseEndpointUrl('https://ntfy.example.test/#frag')).toEqual({ reason: 'invalid' });
    expect(parseEndpointUrl('ftp://ntfy.example.test')).toEqual({ reason: 'invalid' });
    expect(parseEndpointUrl('https://ntfy.example.test/?a=1', { allowQuery: false })).toEqual({ reason: 'invalid' });
    expect(parseEndpointUrl('  ')).toEqual({ reason: 'missing' });
  });

  it('parses Retry-After into a bounded hint', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    expect(parseRetryAfterMs('30', now)).toBe(30_000);
    expect(parseRetryAfterMs('Thu, 01 Oct 2026 00:02:00 GMT', now)).toBe(120_000);
    expect(parseRetryAfterMs('999999999', now)).toBe(RETRY_AFTER_MAX_MS);
    expect(parseRetryAfterMs('0', now)).toBeNull();
    expect(parseRetryAfterMs('-5', now)).toBeNull();
    expect(parseRetryAfterMs('soon', now)).toBeNull();
  });

  it.each([
    ['delta seconds', '90', 90_000],
    ['valid future IMF-fixdate', 'Thu, 01 Oct 2026 00:00:45 GMT', 45_000],
    ['far-future date is capped', 'Fri, 01 Jan 2027 00:00:00 GMT', RETRY_AFTER_MAX_MS],
    ['impossible 30 February', 'Mon, 30 Feb 2026 00:00:00 GMT', null],
    ['impossible day for month (normalizes to 1 Oct)', 'Thu, 31 Sep 2026 00:30:00 GMT', null],
    ['31 November', 'Tue, 31 Nov 2026 00:00:00 GMT', null],
    ['weekday disagrees with date', 'Mon, 01 Oct 2026 00:02:00 GMT', null],
    ['out-of-range time', 'Thu, 01 Oct 2026 24:00:00 GMT', null],
    ['non-GMT zone', 'Thu, 01 Oct 2026 00:02:00 UTC', null],
    ['malformed string', 'Thu, 1 Oct 2026 00:02:00 GMT', null],
    ['obsolete RFC 850 form', 'Thursday, 01-Oct-26 00:02:00 GMT', null],
    ['past date', 'Wed, 30 Sep 2026 23:59:00 GMT', null],
    ['negative delta', '-30', null],
  ])('Retry-After %s', (_label, header, expected) => {
    expect(parseRetryAfterMs(header, Date.parse('2026-10-01T00:00:00Z'))).toBe(expected);
  });

  const MAX_SECONDS = RETRY_AFTER_MAX_MS / 1000;
  it.each([
    ['one second', '1', 1_000],
    ['ordinary seconds', '120', 120_000],
    ['leading zeros', '0030', 30_000],
    ['exact maximum', String(MAX_SECONDS), RETRY_AFTER_MAX_MS],
    ['just above maximum', String(MAX_SECONDS + 1), RETRY_AFTER_MAX_MS],
    ['ten digits', '9999999999', RETRY_AFTER_MAX_MS],
    ['eleven digits', '10000000000', RETRY_AFTER_MAX_MS],
    ['extremely long digit string', '9'.repeat(400), RETRY_AFTER_MAX_MS],
    ['zero', '0', null],
    ['many zeros', '0000', null],
    ['negative', '-1', null],
    ['fraction', '1.5', null],
    ['exponent notation', '1e3', null],
    ['plus sign', '+30', null],
    ['malformed text', '30s', null],
  ])('Retry-After delta-seconds: %s', (_label, header, expected) => {
    expect(parseRetryAfterMs(header, Date.parse('2026-10-01T00:00:00Z'))).toBe(expected);
  });
});

describe('ntfy sender', () => {
  it('publishes the JSON form with topic, title, message, click, and bearer auth', async () => {
    const result = await createSender('ntfy').send(PAYLOAD, CONTEXT);
    expect(result).toEqual({ outcome: 'accepted' });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/');
    expect(request.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(request.headers['content-type']).toBe('application/json');
    const body = JSON.parse(request.body);
    expect(body).toEqual({
      topic: 'releases',
      title: 'Overdue: Autumn Zine',
      message: expect.stringContaining('Release: Autumn Zine'),
      click: 'https://cc.example.test/releases/123',
    });
    expect(body.message).toContain('Project: Zines');
    expect(body.message).toContain('2026-10-01 (no time set; using 09:00) (UTC)');
  });

  it('omits auth and click when not configured or supplied', async () => {
    const sender = createNtfySender({ server: `${baseUrl}/ntfy`, topic: 'releases' });
    const payload = { ...PAYLOAD, release: { ...PAYLOAD.release, url: null } };
    expect(await sender.send(payload, CONTEXT)).toEqual({ outcome: 'accepted' });
    expect(requests[0].url).toBe('/ntfy/');
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(requests[0].body)).not.toHaveProperty('click');
  });

  it('reports readiness without network I/O or secrets', () => {
    expect(createSender('ntfy').getReadiness()).toEqual({ ready: true, reason: null, authConfigured: true });
    expect(createNtfySender({ topic: 'x' }).getReadiness().reason).toBe('missing_server');
    expect(createNtfySender({ server: 'nope', topic: 'x' }).getReadiness().reason).toBe('invalid_server_url');
    expect(createNtfySender({ server: baseUrl }).getReadiness().reason).toBe('missing_topic');
    expect(createNtfySender({ server: baseUrl, topic: 'a/b' }).getReadiness().reason).toBe('invalid_topic');
    expect(createNtfySender({ server: baseUrl, topic: 'a' }).getReadiness()).toEqual({ ready: true, reason: null, authConfigured: false });
    expect(requests).toHaveLength(0);
  });
});

describe('Gotify sender', () => {
  it('posts title, message, and priority to /message with the application token header', async () => {
    const sender = createGotifySender({ server: `${baseUrl}/gotify/`, token: SECRET });
    expect(await sender.send(PAYLOAD, CONTEXT)).toEqual({ outcome: 'accepted' });
    const [request] = requests;
    expect(request.url).toBe('/gotify/message');
    expect(request.headers['x-gotify-key']).toBe(SECRET);
    expect(request.headers.authorization).toBeUndefined();
    const body = JSON.parse(request.body);
    expect(body).toEqual({ title: 'Overdue: Autumn Zine', message: expect.stringContaining('Project: Zines'), priority: GOTIFY_PRIORITY });
  });

  it('requires the application token', () => {
    expect(createGotifySender({ server: baseUrl }).getReadiness()).toEqual({ ready: false, reason: 'missing_token', authConfigured: false });
    expect(createGotifySender({ server: baseUrl, token: 'has space' }).getReadiness().reason).toBe('invalid_token');
    expect(createGotifySender({ token: SECRET }).getReadiness().reason).toBe('missing_server');
  });
});

describe('webhook sender', () => {
  it('posts the stable v1 schema with Idempotency-Key and bearer auth', async () => {
    const sender = createWebhookSender({ url: `${baseUrl}/hook/${SECRET}?key=${SECRET}`, token: SECRET });
    expect(await sender.send(PAYLOAD, CONTEXT)).toEqual({ outcome: 'accepted' });
    const [request] = requests;
    expect(request.url).toBe(`/hook/${SECRET}?key=${SECRET}`);
    expect(request.headers['idempotency-key']).toBe('dlv-1');
    expect(request.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request.body)).toStrictEqual({
      schemaVersion: 1,
      eventId: 'evt-1',
      deliveryId: 'dlv-1',
      type: 'release.overdue',
      createdAt: '2026-10-01T10:00:01.000Z',
      dueAt: '2026-10-01T10:00:00.000Z',
      release: { id: 123, title: 'Autumn Zine', url: 'https://cc.example.test/releases/123' },
      project: { id: 45, title: 'Zines' },
      schedule: {
        plannedDate: '2026-10-01',
        plannedTime: null,
        effectiveTime: '09:00',
        usedDefaultTime: true,
        timeZone: 'UTC',
        scheduledAt: '2026-10-01T09:00:00.000Z',
      },
    });
    expect(request.body).not.toContain(SECRET);
  });

  it('sends a test notification body with null release data', async () => {
    const sender = createWebhookSender({ url: `${baseUrl}/hook` });
    const payload = createTestNotificationPayload({ eventId: 'evt-test', createdAt: '2026-10-01T00:00:00.000Z' });
    expect(await sender.send(payload, { deliveryId: 'dlv-test' })).toEqual({ outcome: 'accepted' });
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(requests[0].body)).toStrictEqual({
      schemaVersion: 1,
      eventId: 'evt-test',
      deliveryId: 'dlv-test',
      type: 'notification.test',
      createdAt: '2026-10-01T00:00:00.000Z',
      dueAt: null,
      release: null,
      project: null,
      schedule: null,
    });
  });

  it('sends a byte-identical body on every retry of the same delivery', async () => {
    const sender = createWebhookSender({ url: `${baseUrl}/hook`, token: SECRET });
    replyWith(503);
    expect((await sender.send(PAYLOAD, CONTEXT)).outcome).toBe('transient_failure');
    replyWith(200);
    expect(await sender.send(PAYLOAD, CONTEXT)).toEqual({ outcome: 'accepted' });
    expect(requests).toHaveLength(2);
    const [first, retry] = requests;
    expect(retry.headers['idempotency-key']).toBe(first.headers['idempotency-key']);
    expect(retry.headers['idempotency-key']).toBe('dlv-1');
    expect(retry.body).toBe(first.body);
    expect(JSON.parse(retry.body)).toMatchObject({ eventId: 'evt-1', deliveryId: 'dlv-1', createdAt: PAYLOAD.createdAt });
  });

  it('gives each test payload its own timestamp, stable across its retries', async () => {
    const payload = createTestNotificationPayload({ eventId: 'evt-test' });
    expect(Date.parse(payload.createdAt)).not.toBeNaN();
    expect(payload.createdAt).toBe(new Date(payload.createdAt).toISOString());
    const other = createTestNotificationPayload({ eventId: 'evt-test-2', createdAt: '2026-10-02T00:00:00.000Z' });
    expect(other.createdAt).toBe('2026-10-02T00:00:00.000Z');
    expect(() => createTestNotificationPayload({ eventId: 'evt-x', createdAt: 'yesterday' })).toThrow();

    const sender = createWebhookSender({ url: `${baseUrl}/hook` });
    await sender.send(payload, { deliveryId: 'dlv-test' });
    await sender.send(payload, { deliveryId: 'dlv-test' });
    expect(requests[1].body).toBe(requests[0].body);
    expect(JSON.parse(requests[0].body).createdAt).toBe(payload.createdAt);
  });

  it.each([
    ['normal timestamp', '2026-10-01T10:00:01.000Z', true],
    ['leap day in a leap year', '2028-02-29T12:00:00.000Z', true],
    ['29 February in a non-leap year', '2026-02-29T10:00:00.000Z', false],
    ['30 February', '2026-02-30T10:00:00.000Z', false],
    ['31st of a 30-day month', '2026-04-31T10:00:00.000Z', false],
    ['month 13', '2026-13-01T10:00:00.000Z', false],
    ['hour 24', '2026-10-01T24:00:00.000Z', false],
    ['minute 60', '2026-10-01T10:60:00.000Z', false],
    ['second 60', '2026-10-01T10:00:60.000Z', false],
    ['malformed string', '2026-10-01 10:00:00Z', false],
  ])('validates createdAt calendar instants: %s', async (_label, createdAt, valid) => {
    expect(isIsoTimestamp(createdAt)).toBe(valid);
    if (valid) {
      expect(createTestNotificationPayload({ eventId: 'evt-x', createdAt }).createdAt).toBe(createdAt);
    } else {
      expect(() => createTestNotificationPayload({ eventId: 'evt-x', createdAt })).toThrow();
      const sender = createWebhookSender({ url: `${baseUrl}/hook` });
      expect(await sender.send({ ...PAYLOAD, createdAt }, CONTEXT))
        .toEqual({ outcome: 'permanent_failure', failureCode: 'invalid_payload' });
      expect(requests).toHaveLength(0);
    }
  });

  it('rejects a payload without a frozen createdAt', async () => {
    const sender = createWebhookSender({ url: `${baseUrl}/hook` });
    const { createdAt, ...unfrozen } = PAYLOAD;
    expect(await sender.send(unfrozen, CONTEXT)).toEqual({ outcome: 'permanent_failure', failureCode: 'invalid_payload' });
    expect(requests).toHaveLength(0);
  });

  it('requires a delivery id and never mutates the frozen payload', async () => {
    const sender = createWebhookSender({ url: `${baseUrl}/hook` });
    expect(await sender.send(PAYLOAD, {})).toEqual({ outcome: 'permanent_failure', failureCode: 'invalid_payload' });
    expect(requests).toHaveLength(0);
    expect(Object.isFrozen(PAYLOAD)).toBe(true);
  });

  it('reports readiness without echoing the endpoint', () => {
    const readiness = createWebhookSender({ url: `https://u:${SECRET}@hooks.example.test/x` }).getReadiness();
    expect(readiness).toEqual({ ready: false, reason: 'invalid_endpoint_url', authConfigured: false });
    expect(createWebhookSender({}).getReadiness().reason).toBe('missing_endpoint');
    expect(JSON.stringify(createSender('webhook').getReadiness())).not.toContain(SECRET);
  });
});

describe.each(Object.keys(FACTORIES))('%s failure classification', (name) => {
  const send = (timeoutMs) => createSender(name, timeoutMs ? { timeoutMs } : {}).send(PAYLOAD, CONTEXT);

  it.each([
    [408, {}, { outcome: 'transient_failure', failureCode: 'timeout' }],
    [429, { 'Retry-After': '120' }, { outcome: 'transient_failure', failureCode: 'rate_limited', retryAfterMs: 120_000 }],
    [503, { 'Retry-After': '30' }, { outcome: 'transient_failure', failureCode: 'provider_unavailable', retryAfterMs: 30_000 }],
    [500, {}, { outcome: 'transient_failure', failureCode: 'provider_unavailable' }],
    [400, {}, { outcome: 'permanent_failure', failureCode: 'rejected' }],
    [404, {}, { outcome: 'permanent_failure', failureCode: 'rejected' }],
    [401, {}, { outcome: 'permanent_failure', failureCode: 'authentication_failed' }],
  ])('HTTP %i', async (status, headers, expected) => {
    replyWith(status, headers);
    const result = await send();
    expect(result).toStrictEqual(expected);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('refuses redirects without forwarding credentials', async () => {
    let redirectedHits = 0;
    respond = (req, res) => {
      if (req.url === '/elsewhere') {
        redirectedHits += 1;
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(307, { Location: '/elsewhere' });
      res.end();
    };
    expect(await send()).toStrictEqual({ outcome: 'permanent_failure', failureCode: 'redirect_refused' });
    expect(redirectedHits).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it('aborts the underlying request at the deadline', async () => {
    respond = () => {}; // never answer
    expect(await send(100)).toStrictEqual({ outcome: 'transient_failure', failureCode: 'timeout' });
    await expect.poll(() => requests[0]?.closed).toBe(true);
  });

  it('classifies network errors without leaking the URL or token', async () => {
    const result = await FACTORIES[name](configFor(name, 'http://127.0.0.1:1')).send(PAYLOAD, CONTEXT);
    expect(result).toStrictEqual({ outcome: 'transient_failure', failureCode: 'network_error' });
  });

  it('returns invalid_configuration without sending when not ready', async () => {
    expect(await FACTORIES[name]({}).send(PAYLOAD, CONTEXT)).toStrictEqual({ outcome: 'permanent_failure', failureCode: 'invalid_configuration' });
    expect(requests).toHaveLength(0);
  });
});
