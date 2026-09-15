import { describe, expect, it, vi } from 'vitest';
import { enhanceReleaseSocialPrepAutoLaunch } from '../src/static/creatorcrate.js';

const SESSION_1 = '11111111-1111-4111-8111-111111111111';
const SESSION_2 = '22222222-2222-4222-8222-222222222222';
const SESSION_3 = '33333333-3333-4333-8333-333333333333';
const INTENT = 'a'.repeat(43);

function activationUri({ version = '2', server = 'https://creatorcrate.test', intent = INTENT } = {}) {
  return `creatorcrate-social://prepare?v=${version}&server=${encodeURIComponent(server)}&intent=${intent}`;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeHarness({
  href = 'https://creatorcrate.test/releases/7',
  mode = 'activate',
  sessionId = null,
  platform = null,
  autoLaunch = false,
  responses = [{ status: 200, body: { ok: true, sessionId: SESSION_2, uri: activationUri() } }],
  launchError = null,
  includeHook = true,
} = {}) {
  const attributes = new Map([
    ['data-release-social-prep-companion', ''],
    ['data-action-mode', mode],
    ['data-activation-url', '/releases/7/social-prep/activate'],
    ['data-reissue-url', '/releases/7/social-prep/reissue'],
    ['data-csrf-token', 'csrf-token'],
  ]);
  if (sessionId) attributes.set('data-session-id', sessionId);
  if (platform) attributes.set('data-target-platform', platform);
  if (autoLaunch) attributes.set('data-auto-launch', 'true');
  const statusAttributes = new Map([['hidden', ''], ['role', 'status']]);
  const status = {
    textContent: '', hidden: true,
    setAttribute(name, value) { statusAttributes.set(name, String(value)); },
    getAttribute(name) { return statusAttributes.get(name) ?? null; },
    removeAttribute(name) { statusAttributes.delete(name); if (name === 'hidden') this.hidden = false; },
  };
  const listeners = new Map();
  const action = {
    textContent: mode === 'reissue' ? 'Retry opening companion' : mode === 'reprepare' ? 'Reopen publishing companion' : 'Open publishing companion',
    disabled: false,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeAttribute(name) { attributes.delete(`action-${name}`); },
    click() { return listeners.get('click')?.({ preventDefault() {} }); },
  };
  const element = {
    dataset: {}, ownerDocument: null,
    getAttribute(name) { return attributes.get(name) ?? null; },
    matches(selector) { return selector === '[data-release-social-prep-companion]'; },
    querySelector(selector) {
      if (selector === '[data-release-social-prep-companion-action]') return action;
      if (selector === '[data-release-social-prep-companion-status]') return status;
      return null;
    },
  };
  const windowObject = {
    location: {
      href,
      origin: new URL(href).origin,
      assign: vi.fn((uri) => {
        if (launchError) throw launchError;
        windowObject.protocolAttempts.push(uri);
      }),
    },
    history: {
      state: { preserved: true }, replacements: [],
      replaceState(state, title, url) {
        this.replacements.push({ state, title, url });
        windowObject.location.href = url;
      },
    },
    protocolAttempts: [],
  };
  const document = {
    nodeType: 9, defaultView: windowObject,
    querySelectorAll(selector) {
      return includeHook && selector === '[data-release-social-prep-companion]' ? [element] : [];
    },
    querySelector(selector) {
      return includeHook && selector === '[data-release-social-prep-companion]' ? element : null;
    },
  };
  element.ownerDocument = document;
  const queue = [...responses];
  const fetchRequest = vi.fn(async () => {
    const response = queue.shift();
    if (response?.promise) return response.promise;
    if (response instanceof Error) throw response;
    return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.body };
  });
  return { document, element, action, status, windowObject, fetchRequest };
}

async function settleLaunch() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('Release publishing companion handoff', () => {
  it('binds only the release-level companion action and is idempotent', () => {
    const page = makeHarness();
    expect(enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest })).toBe(1);
    expect(enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest })).toBe(0);
    expect(enhanceReleaseSocialPrepAutoLaunch(makeHarness({ includeHook: false }).document)).toBe(0);
  });

  it('uses authenticated CSRF activation, attempts the returned URI once, then retries the returned exact session', async () => {
    const firstUri = activationUri({ intent: 'b'.repeat(43) });
    const secondUri = activationUri({ intent: 'c'.repeat(43) });
    const page = makeHarness({ responses: [
      { status: 200, body: { ok: true, sessionId: SESSION_2, uri: firstUri } },
      { status: 200, body: { ok: true, sessionId: SESSION_3, uri: secondUri } },
    ] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();

    expect(page.fetchRequest).toHaveBeenNthCalledWith(1, '/releases/7/social-prep/activate', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-token' }, body: '{}',
    });
    expect(page.windowObject.protocolAttempts).toEqual([firstUri]);
    expect(page.action.textContent).toBe('Retry opening companion');
    expect(page.status.textContent).toBe('Opening publishing companion…');

    page.action.click();
    await settleLaunch();
    expect(page.fetchRequest).toHaveBeenNthCalledWith(2, '/releases/7/social-prep/reissue', expect.objectContaining({
      credentials: 'same-origin', body: JSON.stringify({ sessionId: SESSION_2 }),
    }));
    expect(page.windowObject.protocolAttempts).toEqual([firstUri, secondUri]);
  });

  it.each([
    ['the current HTTPS origin', 'https://creatorcrate.example/releases/7', 'https://creatorcrate.example'],
    ['the exact current non-default port', 'https://creatorcrate.example:8443/releases/7', 'https://creatorcrate.example:8443'],
  ])('accepts a server matching %s and creates Retry authority', async (_label, href, server) => {
    const uri = activationUri({ server });
    const page = makeHarness({ href, responses: [
      { status: 200, body: { ok: true, sessionId: SESSION_2, uri } },
      { status: 200, body: { ok: true, sessionId: SESSION_3, uri: activationUri({ server, intent: 'b'.repeat(43) }) } },
    ] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    expect(page.windowObject.protocolAttempts).toEqual([uri]);
    expect(page.action.textContent).toBe('Retry opening companion');

    page.action.click();
    await settleLaunch();
    expect(JSON.parse(page.fetchRequest.mock.calls[1][1].body)).toEqual({ sessionId: SESSION_2 });
  });

  it.each(['ready', 'prepared'])('uses fresh reprepare for %s and then exact-session reissue', async () => {
    const page = makeHarness({ mode: 'reprepare', responses: [
      { status: 200, body: { ok: true, sessionId: SESSION_2, uri: activationUri({ intent: 'b'.repeat(43) }) } },
      { status: 200, body: { ok: true, sessionId: SESSION_3, uri: activationUri({ intent: 'c'.repeat(43) }) } },
    ] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    expect(page.fetchRequest).toHaveBeenNthCalledWith(1, '/releases/7/social-prep/activate', expect.objectContaining({
      body: JSON.stringify({ reprepare: true }),
    }));
    page.action.click();
    await settleLaunch();
    expect(page.fetchRequest).toHaveBeenNthCalledWith(2, '/releases/7/social-prep/reissue', expect.objectContaining({
      body: JSON.stringify({ sessionId: SESSION_2 }),
    }));
  });

  it('submits the exact posted platform and binds independent controls', async () => {
    const x = makeHarness({ mode: 'reprepare', platform: 'x' });
    const patreon = makeHarness({ mode: 'reprepare', platform: 'patreon' });
    const responses = [
      { status: 200, body: { ok: true, sessionId: SESSION_2, uri: activationUri({ intent: 'b'.repeat(43) }), platforms: ['x'] } },
      { status: 409, body: { ok: false, error: { code: 'attempt_in_progress' } } },
    ];
    const fetchRequest = vi.fn(async () => {
      const response = responses.shift();
      return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.body };
    });
    const document = {
      nodeType: 9,
      defaultView: x.windowObject,
      querySelectorAll: () => [x.element, patreon.element],
    };
    x.element.ownerDocument = document;
    patreon.element.ownerDocument = document;

    expect(enhanceReleaseSocialPrepAutoLaunch(document, { fetchRequest })).toBe(2);
    x.action.click();
    await settleLaunch();
    patreon.action.click();
    await settleLaunch();

    expect(fetchRequest.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { platforms: ['x'], reprepare: true },
      { platforms: ['patreon'], reprepare: true },
    ]);
    expect(x.windowObject.protocolAttempts).toEqual([activationUri({ intent: 'b'.repeat(43) })]);
    expect(patreon.status.textContent).toBe('Publishing companion preparation is already active.');
  });

  it('replaces the old rendered session after every reissue and launches only each fresh URI', async () => {
    const firstUri = activationUri({ intent: 'b'.repeat(43) });
    const secondUri = activationUri({ intent: 'c'.repeat(43) });
    const page = makeHarness({ mode: 'reissue', sessionId: SESSION_1, responses: [
      { status: 200, body: { ok: true, sessionId: SESSION_2, uri: firstUri } },
      { status: 200, body: { ok: true, sessionId: SESSION_3, uri: secondUri } },
    ] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    page.action.click();
    await settleLaunch();
    expect(page.fetchRequest.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { sessionId: SESSION_1 }, { sessionId: SESSION_2 },
    ]);
    expect(page.windowObject.protocolAttempts).toEqual([firstUri, secondUri]);
  });

  it('WP6A auto-launch consumes only prep, preserves query/history, and leaves same-page Retry', async () => {
    const page = makeHarness({ href: 'https://creatorcrate.test/releases/7?foo=bar&prep=1#social', autoLaunch: true });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    await settleLaunch();
    expect(page.windowObject.history.replacements).toEqual([{
      state: { preserved: true }, title: '', url: 'https://creatorcrate.test/releases/7?foo=bar#social',
    }]);
    expect(page.fetchRequest).toHaveBeenCalledTimes(1);
    expect(page.action.textContent).toBe('Retry opening companion');
    expect(page.action.disabled).toBe(false);
  });

  it('a protocol exception still retains the new session and a usable Retry action', async () => {
    const page = makeHarness({ autoLaunch: true, href: 'https://creatorcrate.test/releases/7?prep=1', launchError: new Error('blocked'), responses: [
      { status: 200, body: { ok: true, sessionId: SESSION_2, uri: activationUri({ intent: 'b'.repeat(43) }) } },
      { status: 200, body: { ok: true, sessionId: SESSION_3, uri: activationUri({ intent: 'c'.repeat(43) }) } },
    ] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    await settleLaunch();
    expect(page.status.textContent).toBe('Could not open publishing companion.');
    expect(page.action.textContent).toBe('Retry opening companion');
    expect(page.action.disabled).toBe(false);
    page.action.click();
    await settleLaunch();
    expect(JSON.parse(page.fetchRequest.mock.calls[1][1].body)).toEqual({ sessionId: SESSION_2 });
  });

  it('updates Retry authority before dispatch and passes the exact original URI string', async () => {
    const exactUri = `creatorcrate-social://prepare?intent=${'e'.repeat(43)}&server=https%3A%2F%2Fcreatorcrate.test&v=2`;
    const page = makeHarness({ responses: [{ status: 200, body: { ok: true, sessionId: SESSION_2, uri: exactUri } }] });
    const launchProtocol = vi.fn((uri) => {
      expect(page.action.textContent).toBe('Retry opening companion');
      expect(uri).toBe(exactUri);
    });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest, launchProtocol });
    page.action.click();
    await settleLaunch();
    expect(launchProtocol).toHaveBeenCalledTimes(1);
  });

  it('keeps the URI and intent ephemeral and performs no status mutation after protocol dispatch', async () => {
    const page = makeHarness({ responses: [{
      status: 200,
      body: { ok: true, sessionId: SESSION_2, uri: activationUri({ intent: 'd'.repeat(43) }) },
    }] });
    Object.defineProperties(page.windowObject, {
      localStorage: { get() { throw new Error('localStorage must not be used'); } },
      sessionStorage: { get() { throw new Error('sessionStorage must not be used'); } },
    });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    expect(page.fetchRequest).toHaveBeenCalledTimes(1);
    expect(page.fetchRequest.mock.calls[0][0]).toBe('/releases/7/social-prep/activate');
    expect(JSON.stringify({ text: page.action.textContent, status: page.status.textContent, element: page.element.dataset }))
      .not.toContain('d'.repeat(43));
    expect(page.windowObject.protocolAttempts).toEqual([activationUri({ intent: 'd'.repeat(43) })]);
  });

  it('prevents duplicate concurrent clicks and disables only while the request is in flight', async () => {
    const pending = deferred();
    const page = makeHarness({ responses: [{ promise: pending.promise }] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    page.action.click();
    expect(page.fetchRequest).toHaveBeenCalledTimes(1);
    expect(page.action.disabled).toBe(true);
    pending.resolve({ ok: true, status: 200, json: async () => ({ ok: true, sessionId: SESSION_2, uri: activationUri() }) });
    await settleLaunch();
    expect(page.action.disabled).toBe(false);
    expect(page.windowObject.protocolAttempts).toHaveLength(1);
  });

  it('shows bounded active feedback for server 409 and makes no protocol attempt', async () => {
    const page = makeHarness({ responses: [{ status: 409, body: { ok: false, error: { code: 'attempt_in_progress' } } }] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    expect(page.status.textContent).toBe('Publishing companion preparation is already active.');
    expect(page.status.getAttribute('role')).toBe('alert');
    expect(page.windowObject.protocolAttempts).toHaveLength(0);
    expect(page.action.disabled).toBe(false);
  });

  it.each([
    ['HTTP failure', { status: 500, body: { ok: false } }],
    ['malformed success', { status: 200, body: { ok: true, uri: 'creatorcrate-social:no-session' } }],
  ])('shows bounded failure and no publication claim for %s', async (_label, response) => {
    const page = makeHarness({ responses: [response] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    expect(page.status.textContent).toBe('Could not open publishing companion.');
    expect(page.status.textContent).not.toMatch(/posted|published|upload complete|success/i);
    expect(page.windowObject.protocolAttempts).toHaveLength(0);
  });


  it.each([
    ['missing URI', undefined],
    ['non-string URI', 42],
    ['empty URI', ''],
    ['relative URI', '/some-relative-path'],
    ['HTTP URI', 'http://creatorcrate.test/'],
    ['HTTPS URI', 'https://example.com/'],
    ['JavaScript URI', 'javascript:alert(1)'],
    ['data URI', 'data:text/plain,unexpected'],
    ['wrong custom scheme', activationUri().replace('creatorcrate-social:', 'creatorcrate-open:')],
    ['malformed social URI', `creatorcrate-social:prepare?v=2&server=https%3A%2F%2Fcreatorcrate.test&intent=${INTENT}`],
    ['v1 URI', activationUri({ version: '1' })],
    ['future-version URI', activationUri({ version: '3' })],
    ['noncanonical version URI', activationUri({ version: '02' })],
    ['missing version', `creatorcrate-social://prepare?server=https%3A%2F%2Fcreatorcrate.test&intent=${INTENT}`],
    ['missing server', `creatorcrate-social://prepare?v=2&intent=${INTENT}`],
    ['missing intent', 'creatorcrate-social://prepare?v=2&server=https%3A%2F%2Fcreatorcrate.test'],
    ['malformed server encoding', `creatorcrate-social://prepare?v=2&server=https%3A%2F%2Fcreatorcrate.test%ZZ&intent=${INTENT}`],
  ])('rejects %s without navigating or creating Retry authority', async (_label, uri) => {
    const page = makeHarness({ responses: [{ status: 200, body: { ok: true, sessionId: SESSION_2, uri } }] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    page.action.click();
    await settleLaunch();
    expect(page.windowObject.protocolAttempts).toHaveLength(0);
    expect(page.fetchRequest).toHaveBeenCalledTimes(1);
    expect(page.action.textContent).toBe('Refresh page to retry');
    expect(page.action.disabled).toBe(true);
    expect(page.status.textContent).toBe('Could not open publishing companion.');
  });

  it.each([
    ['different hostname', 'https://creatorcrate.example/releases/7', 'https://another-host.example'],
    ['different subdomain', 'https://creatorcrate.example/releases/7', 'https://assets.creatorcrate.example'],
    ['different scheme', 'https://creatorcrate.example/releases/7', 'http://creatorcrate.example'],
    ['different explicit port', 'https://creatorcrate.example:7443/releases/7', 'https://creatorcrate.example:8443'],
    ['different default/effective port', 'https://creatorcrate.example/releases/7', 'https://creatorcrate.example:8443'],
    ['similar suffix domain', 'https://creatorcrate.example/releases/7', 'https://creatorcrate.example.evil.test'],
    ['otherwise valid foreign v2 URI', 'https://creatorcrate.example/releases/7', 'https://foreign.example:9443'],
  ])('rejects a valid-looking response with %s', async (_label, href, server) => {
    const page = makeHarness({
      href,
      responses: [{ status: 200, body: { ok: true, sessionId: SESSION_2, uri: activationUri({ server }) } }],
    });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    page.action.click();
    await settleLaunch();
    expect(page.windowObject.protocolAttempts).toHaveLength(0);
    expect(page.fetchRequest).toHaveBeenCalledTimes(1);
    expect(page.action.textContent).toBe('Refresh page to retry');
    expect(page.action.disabled).toBe(true);
    expect(page.status.textContent).toBe('Could not open publishing companion.');
    expect(page.status.textContent).not.toContain(server);
  });

  it.each([
    ['missing session', undefined],
    ['non-string session', 42],
    ['empty session', ''],
    ['whitespace session', '   '],
    ['non-UUID session', 'session-2'],
    ['non-v4 UUID', '22222222-2222-1222-8222-222222222222'],
    ['non-RFC variant UUID', '22222222-2222-4222-7222-222222222222'],
    ['uppercase UUID', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'.toUpperCase()],
  ])('rejects %s without navigating or retaining it', async (_label, invalidSessionId) => {
    const page = makeHarness({ responses: [{
      status: 200, body: { ok: true, sessionId: invalidSessionId, uri: activationUri() },
    }] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    page.action.click();
    await settleLaunch();
    expect(page.windowObject.protocolAttempts).toHaveLength(0);
    expect(page.fetchRequest).toHaveBeenCalledTimes(1);
    expect(page.action.textContent).toBe('Refresh page to retry');
    expect(page.action.disabled).toBe(true);
  });

  it('does not reuse an invalidated old session after a malformed successful reissue', async () => {
    const page = makeHarness({ mode: 'reissue', sessionId: SESSION_1, responses: [{
      status: 200, body: { ok: true, sessionId: 'malformed', uri: activationUri() },
    }] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    page.action.click();
    await settleLaunch();
    expect(JSON.parse(page.fetchRequest.mock.calls[0][1].body)).toEqual({ sessionId: SESSION_1 });
    expect(page.fetchRequest).toHaveBeenCalledTimes(1);
    expect(page.windowObject.protocolAttempts).toHaveLength(0);
    expect(page.action.textContent).toBe('Refresh page to retry');
    expect(page.action.disabled).toBe(true);
  });

  it('does not retain a foreign-origin replacement or reuse the invalidated session after reissue', async () => {
    const page = makeHarness({ mode: 'reissue', sessionId: SESSION_1, responses: [{
      status: 200,
      body: { ok: true, sessionId: SESSION_2, uri: activationUri({ server: 'https://foreign.example' }) },
    }] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    page.action.click();
    await settleLaunch();
    expect(JSON.parse(page.fetchRequest.mock.calls[0][1].body)).toEqual({ sessionId: SESSION_1 });
    expect(page.fetchRequest).toHaveBeenCalledTimes(1);
    expect(page.windowObject.protocolAttempts).toHaveLength(0);
    expect(page.action.textContent).toBe('Refresh page to retry');
    expect(page.action.disabled).toBe(true);
    expect(page.status.textContent).toBe('Could not open publishing companion.');
  });

  it('applies the same response validation to reprepare', async () => {
    const page = makeHarness({ mode: 'reprepare', responses: [{
      status: 200, body: { ok: true, sessionId: SESSION_2, uri: activationUri({ version: '1' }) },
    }] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    expect(JSON.parse(page.fetchRequest.mock.calls[0][1].body)).toEqual({ reprepare: true });
    expect(page.windowObject.protocolAttempts).toHaveLength(0);
    expect(page.action.textContent).toBe('Refresh page to retry');
    expect(page.action.disabled).toBe(true);
  });

  it('rejects a foreign-origin response from reprepare and remains refresh-only', async () => {
    const page = makeHarness({ mode: 'reprepare', responses: [{
      status: 200,
      body: { ok: true, sessionId: SESSION_2, uri: activationUri({ server: 'https://foreign.example' }) },
    }] });
    enhanceReleaseSocialPrepAutoLaunch(page.document, { fetchRequest: page.fetchRequest });
    page.action.click();
    await settleLaunch();
    page.action.click();
    await settleLaunch();
    expect(JSON.parse(page.fetchRequest.mock.calls[0][1].body)).toEqual({ reprepare: true });
    expect(page.fetchRequest).toHaveBeenCalledTimes(1);
    expect(page.windowObject.protocolAttempts).toHaveLength(0);
    expect(page.action.textContent).toBe('Refresh page to retry');
    expect(page.action.disabled).toBe(true);
    expect(page.status.textContent).toBe('Could not open publishing companion.');
  });
});
