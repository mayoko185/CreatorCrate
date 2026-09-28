import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import nunjucks from 'nunjucks';
import request from 'supertest';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createDisabledModeCsrfMiddleware } from '../src/middleware/csrf.js';
import { createReleaseNotificationSettingsRouter } from '../src/routes/release-notification-settings.js';
import { createReleaseNotificationService } from '../src/services/release-notification-service.js';
import { createReleaseNotificationRecentResultService } from '../src/services/release-notification-recent-result-service.js';
import { defaultReleaseNotificationPreferences } from '../src/services/release-notification-settings-service.js';
import { createSmtpSender } from '../src/services/release-notification-transports/smtp.js';
import { createNtfySender } from '../src/services/release-notification-transports/ntfy.js';
import { createGotifySender } from '../src/services/release-notification-transports/gotify.js';
import { createWebhookSender } from '../src/services/release-notification-transports/webhook.js';
import { buildShellModel } from '../src/shell/navigation.js';
import { formatIsoTimestamp, formatSqliteTimestamp, formatStoredTime } from '../src/util/date.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const BASE = '/settings/release-notifications';
const CHANNELS = ['email', 'ntfy', 'gotify', 'webhook'];
const ACCEPTED_BY = { email: 'SMTP', ntfy: 'ntfy', gotify: 'Gotify', webhook: 'webhook' };

const SECRETS = {
  smtpPassword: 'smtp-pass-7f3a91',
  smtpUsername: 'smtp-user-4410',
  ntfyToken: 'tk_ntfytoken0192',
  ntfyTopic: 'private-topic-8812',
  gotifyToken: 'AgotifyApp.9921',
  webhookPath: '/hooks/in/secretpath-5521',
  webhookQuery: 'sig=querysecret-6630',
  webhookToken: 'bearer-webhook-3381',
};
const WEBHOOK_URL = `https://hooks.example.test${SECRETS.webhookPath}?${SECRETS.webhookQuery}`;

/**
 * Builds the safe status the way the runtime integration is expected to:
 * readiness from each sender's configuration-only check, plus a summary of
 * non-secret facts. The Settings router only ever receives this object.
 */
function statusFromConfig({ recipient = 'me@example.test', ready = CHANNELS } = {}) {
  const smtpConfig = {
    host: 'smtp.example.test', port: 587, security: 'starttls',
    username: SECRETS.smtpUsername, password: SECRETS.smtpPassword,
    from: 'creatorcrate@example.test', to: recipient,
  };
  const senders = {
    email: createSmtpSender(ready.includes('email') ? smtpConfig : { ...smtpConfig, from: '' }),
    ntfy: createNtfySender(ready.includes('ntfy')
      ? { server: 'https://ntfy.example.test', topic: SECRETS.ntfyTopic, token: SECRETS.ntfyToken }
      : { server: 'https://ntfy.example.test', topic: '' }),
    gotify: createGotifySender(ready.includes('gotify')
      ? { server: 'https://gotify.example.test', token: SECRETS.gotifyToken }
      : { server: 'https://gotify.example.test' }),
    webhook: createWebhookSender(ready.includes('webhook') ? { url: WEBHOOK_URL, token: SECRETS.webhookToken } : {}),
  };
  return {
    email: {
      readiness: senders.email.getReadiness(),
      summary: { host: 'smtp.example.test', port: 587, security: 'starttls', sender: ready.includes('email') ? 'creatorcrate@example.test' : null },
    },
    ntfy: {
      readiness: senders.ntfy.getReadiness(),
      summary: { origin: 'https://ntfy.example.test', topicConfigured: ready.includes('ntfy'), tokenConfigured: ready.includes('ntfy') },
    },
    gotify: {
      readiness: senders.gotify.getReadiness(),
      summary: { origin: 'https://gotify.example.test', tokenConfigured: ready.includes('gotify') },
    },
    webhook: {
      readiness: senders.webhook.getReadiness(),
      summary: { origin: 'https://hooks.example.test', endpointConfigured: ready.includes('webhook'), tokenConfigured: ready.includes('webhook') },
    },
  };
}

function createRuntime({ ready = CHANNELS, timeZone = 'Pacific/Auckland', sendTest } = {}) {
  const runtime = {
    ready,
    getChannelStatus: vi.fn(({ emailRecipient } = {}) => statusFromConfig({
      recipient: emailRecipient ?? '', ready: runtime.ready,
    })),
    getEffectiveTimeZone: vi.fn(() => timeZone),
    sendTest: vi.fn(sendTest ?? (async () => ({ outcome: 'accepted' }))),
  };
  return runtime;
}

function checkbox(html, id) {
  return html.match(new RegExp(`<input[^>]+id="${id}"[^>]*>`))?.[0] || '';
}

function channelBlock(html, channel) {
  const start = html.indexOf(`data-release-notification-channel="${channel}"`);
  const next = CHANNELS.map((other) => html.indexOf(`data-release-notification-channel="${other}"`, start + 1))
    .filter((index) => index > start);
  const end = next.length > 0 ? Math.min(...next) : html.indexOf('release-notifications-timing-heading');
  return html.slice(start, end);
}

function prefs(overrides = {}) {
  return { ...defaultReleaseNotificationPreferences(), ...overrides };
}

function form(overrides = {}) {
  return {
    enabled: '0',
    channels: [],
    emailRecipient: 'me@example.test',
    dateOnlyTime: '09:00',
    advanceEnabled: '0', advanceAmount: '1', advanceUnit: 'days',
    scheduledEnabled: ['0', '1'],
    overdueEnabled: ['0', '1'], overdueAmount: '1', overdueUnit: 'hours',
    repeatEnabled: '0', repeatAmount: '1', repeatUnit: 'days',
    ...overrides,
  };
}

function countDeliveryRows(db) {
  return {
    occurrences: db.prepare('SELECT COUNT(*) FROM release_notification_occurrences').pluck().get(),
    deliveries: db.prepare('SELECT COUNT(*) FROM release_notification_deliveries').pluck().get(),
  };
}

describe('settings — Release Notifications HTTP', () => {
  let tmpDir;
  let db;
  let notificationService;
  let recentResults;
  let runtime;
  let agent;
  let csrfToken;
  let clock;

  async function mount(runtimeOptions = {}) {
    runtime = createRuntime(runtimeOptions);
    const app = express();
    const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, express: app, noCache: true });
    env.addGlobal('assetMode', 'test');
    env.addFilter('formatStoredTime', formatStoredTime);
    env.addFilter('formatSqliteTimestamp', formatSqliteTimestamp);
    env.addFilter('formatIsoTimestamp', formatIsoTimestamp);
    app.set('view engine', 'njk');
    app.use(express.urlencoded({ extended: true }));
    const csrf = createDisabledModeCsrfMiddleware({ cookieSecure: false, csrfPepper: 'release-notification-test-pepper' });
    app.use(csrf.exposeCsrfToken);
    app.use(csrf.requireCsrf);
    app.use((req, res, next) => {
      res.locals.shell = buildShellModel({ appName: 'CreatorCrate', path: req.originalUrl });
      res.locals.auth = { enabled: true, authenticated: true, username: 'operator' };
      res.locals.clockFormat = '24h';
      next();
    });
    app.use(BASE, createReleaseNotificationSettingsRouter({
      appName: 'CreatorCrate',
      releaseNotificationService: notificationService,
      recentResultService: recentResults,
      releaseNotificationRuntime: runtime,
      now: () => clock,
    }));
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).send(err.status === 404 ? 'Not found' : 'Server error');
    });
    agent = request.agent(app);
    const page = await agent.get(BASE).expect(200);
    csrfToken = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    return page;
  }

  function save(fields) {
    return agent.post(BASE).type('form').send({ ...fields, _csrf: csrfToken });
  }

  function sendTest(channel) {
    return agent.post(`${BASE}/channels/${channel}/test`).type('form').send({ _csrf: csrfToken });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-notification-settings-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    clock = new Date('2026-09-27T12:00:00.000Z');
    notificationService = createReleaseNotificationService({ db, now: () => clock });
    recentResults = createReleaseNotificationRecentResultService({ appMetaRepository: createAppMetaRepository(db) });
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('page', () => {
    it('renders the four channels independently with several selected at once', async () => {
      notificationService.updateSettings(prefs({ enabledChannels: ['email', 'gotify', 'webhook'] }));
      const page = await mount();

      expect(page.text).toContain('<h1 class="app-section-title">Settings — Release Notifications</h1>');
      for (const channel of CHANNELS) {
        expect(page.text).toContain(`data-release-notification-channel="${channel}"`);
        expect(page.text).toContain(`action="${BASE}/channels/${channel}/test"`);
      }
      expect(checkbox(page.text, 'release-notifications-channel-email')).toContain('checked');
      expect(checkbox(page.text, 'release-notifications-channel-ntfy')).not.toContain('checked');
      expect(checkbox(page.text, 'release-notifications-channel-gotify')).toContain('checked');
      expect(checkbox(page.text, 'release-notifications-channel-webhook')).toContain('checked');
      expect(page.text).not.toMatch(/<select[^>]+name="channels"/);
      expect(page.text).toContain('can be sent while this page is closed as long as the server is running');
      expect(page.text).toContain('releases that are already overdue are not sent');
    });

    it('keeps a selected but unready channel selected with its readiness warning', async () => {
      notificationService.updateSettings(prefs({ enabledChannels: ['gotify', 'ntfy'] }));
      const page = await mount({ ready: ['ntfy'] });

      const gotify = channelBlock(page.text, 'gotify');
      expect(checkbox(gotify, 'release-notifications-channel-gotify')).toContain('checked');
      expect(gotify).toContain('Not ready — Gotify token is missing');
      expect(gotify).toContain('Selected, but this channel will not send until its configuration is ready.');
      expect(gotify).toMatch(/<button[^>]+data-release-notification-test-button[^>]+disabled/);
      expect(channelBlock(page.text, 'ntfy')).toContain('<span class="status-badge status-badge--success">Ready</span>');
      expect(channelBlock(page.text, 'email')).toContain('Not ready — SMTP sender is not configured');
    });

    it('renders the channels as styled checkboxes inside the two-column channel grid', async () => {
      const page = await mount();

      expect(page.text).toContain('<div class="release-notification-channel-grid">');
      const grid = page.text.slice(page.text.indexOf('<div class="release-notification-channel-grid">'));
      for (const channel of CHANNELS) {
        const input = checkbox(page.text, `release-notifications-channel-${channel}`);
        expect(input).toContain('class="release-notification-channel-checkbox"');
        expect(input).toContain('type="checkbox"');
        expect(input).toContain('name="channels"');
        expect(input).toContain(`value="${channel}"`);
        expect(input).toContain('data-autosubmit="fetch"');
        expect(channelBlock(page.text, channel)).toMatch(
          new RegExp(`<label class="[^"]*release-notification-channel-choice[^"]*" for="release-notifications-channel-${channel}">`),
        );
        expect(grid).toContain(`data-release-notification-channel="${channel}"`);
      }
    });

    it('explains the webhook contract in a collapsed disclosure on the webhook channel only', async () => {
      const page = await mount();

      const webhook = channelBlock(page.text, 'webhook');
      const help = webhook.match(/<details[^>]*data-release-notification-webhook-help[^>]*>[\s\S]*?<\/details>/)?.[0] || '';
      expect(help).not.toBe('');
      expect(help).not.toMatch(/<details[^>]*\sopen/);
      for (const concept of [
        'POST', 'JSON', 'application/json', 'RELEASE_NOTIFICATIONS_WEBHOOK_URL', 'RELEASE_NOTIFICATIONS_WEBHOOK_TOKEN',
        'Authorization: Bearer', 'Idempotency-Key', 'eventId', 'deliveryId', 'notification.test', 'release.overdue_repeat',
      ]) {
        expect(help).toContain(concept);
      }
      for (const channel of ['email', 'ntfy', 'gotify']) {
        expect(channelBlock(page.text, channel)).not.toContain('data-release-notification-webhook-help');
      }
    });

    it('shows the effective timezone and a date-only example from the supplied runtime', async () => {
      notificationService.updateSettings(prefs({ dateOnlyTime: '07:30' }));
      const page = await mount({ timeZone: 'America/Denver' });

      expect(page.text).toContain('<span class="kv-value" data-release-notification-timezone>America/Denver</span>');
      expect(page.text).toMatch(/without a time is scheduled at \d{4}-\d{2}-\d{2} 07:30 \(America\/Denver\)/);
      expect(page.text).toContain('value="07:30"');
    });

    it('never renders secrets, even when the injected status carries them', async () => {
      await mount();
      const leaky = statusFromConfig();
      leaky.email.summary.password = SECRETS.smtpPassword;
      leaky.email.summary.username = SECRETS.smtpUsername;
      leaky.ntfy.summary.topic = SECRETS.ntfyTopic;
      leaky.ntfy.summary.token = SECRETS.ntfyToken;
      leaky.gotify.summary.origin = `https://gotify.example.test/?token=${SECRETS.gotifyToken}`;
      leaky.webhook.summary.origin = `https://user:${SECRETS.webhookToken}@hooks.example.test${SECRETS.webhookPath}?${SECRETS.webhookQuery}`;
      leaky.webhook.readiness = { ...leaky.webhook.readiness, reason: `Bearer ${SECRETS.webhookToken}` };
      runtime.getChannelStatus.mockReturnValue(leaky);

      const page = await agent.get(BASE).expect(200);

      expect(page.text).toContain('https://hooks.example.test');
      expect(page.text).toContain('smtp.example.test');
      for (const secret of Object.values(SECRETS)) {
        expect(page.text).not.toContain(secret);
      }
    });
  });

  describe('saving preferences', () => {
    it('saves all four channels through the core updateSettings with activation metadata', async () => {
      await mount();
      const update = vi.spyOn(notificationService, 'updateSettings');

      const res = await save(form({ enabled: ['0', '1'], channels: CHANNELS })).expect(302);

      expect(res.headers.location).toBe(`${BASE}?notice=saved`);
      expect(update).toHaveBeenCalledTimes(1);
      const settings = notificationService.getSettings();
      expect(settings.enabled).toBe(true);
      expect(settings.enabledChannels).toEqual(CHANNELS);
      for (const channel of CHANNELS) {
        expect(settings.activation.channels[channel]).toEqual({ generation: 1, activatedAt: clock.toISOString() });
      }
      const page = await agent.get(res.headers.location).expect(200);
      expect(page.text).toContain('Release notification settings saved.');
    });

    it('saves an arbitrary subset of channels', async () => {
      await mount();
      await save(form({ enabled: ['0', '1'], channels: ['gotify', 'ntfy'] })).expect(302);

      const settings = notificationService.getSettings();
      expect(settings.enabledChannels).toEqual(['ntfy', 'gotify']);
      expect(settings.activation.channels.email.generation).toBe(0);
      expect(settings.activation.channels.webhook.generation).toBe(0);
    });

    it('allows selecting unready channels while notifications are disabled', async () => {
      await mount({ ready: [] });
      await save(form({ channels: ['email', 'webhook'] })).expect(302);

      const settings = notificationService.getSettings();
      expect(settings.enabled).toBe(false);
      expect(settings.enabledChannels).toEqual(['email', 'webhook']);
    });

    it('rejects enabling with no selected channel using the core validation', async () => {
      await mount();
      const res = await save(form({ enabled: ['0', '1'] })).expect(422);

      expect(res.text).toContain('Select at least one channel to enable release notifications.');
      expect(notificationService.getSettings().enabled).toBe(false);
    });

    it('rejects enabling when every selected channel is unready without calling the core', async () => {
      await mount({ ready: ['ntfy'] });
      const update = vi.spyOn(notificationService, 'updateSettings');

      const res = await save(form({ enabled: ['0', '1'], channels: ['email', 'gotify'] })).expect(422);

      expect(res.text).toContain('need at least one selected channel that is ready');
      expect(update).not.toHaveBeenCalled();
      expect(notificationService.getSettings()).toMatchObject({ enabled: false, enabledChannels: [] });
      expect(checkbox(res.text, 'release-notifications-channel-email')).toContain('checked');
      expect(checkbox(res.text, 'release-notifications-channel-gotify')).toContain('checked');
    });

    it('evaluates email readiness against the submitted recipient', async () => {
      await mount({ ready: ['email'] });
      const res = await save(form({ enabled: ['0', '1'], channels: ['email'], emailRecipient: '' })).expect(422);

      expect(res.text).toContain('need at least one selected channel that is ready');
      expect(runtime.getChannelStatus).toHaveBeenLastCalledWith({ emailRecipient: null });
    });

    it('enables when one selected channel is ready while another stays unready', async () => {
      await mount({ ready: ['webhook'] });
      await save(form({ enabled: ['0', '1'], channels: ['gotify', 'webhook'] })).expect(302);

      const settings = notificationService.getSettings();
      expect(settings.enabled).toBe(true);
      expect(settings.enabledChannels).toEqual(['gotify', 'webhook']);

      const page = await agent.get(BASE).expect(200);
      expect(checkbox(page.text, 'release-notifications-channel-gotify')).toContain('checked');
      expect(channelBlock(page.text, 'gotify')).toContain('Not ready — Gotify token is missing');
    });

    it('does not block timing-only edits when channels later become unready', async () => {
      await mount();
      await save(form({ enabled: ['0', '1'], channels: ['ntfy'] })).expect(302);
      runtime.ready = [];

      await save(form({ enabled: ['0', '1'], channels: ['ntfy'], dateOnlyTime: '10:15' })).expect(302);
      expect(notificationService.getSettings().dateOnlyTime).toBe('10:15');

      const page = await agent.get(BASE).expect(200);
      expect(page.text).toContain('no selected channel is ready');
    });

    it('converts advance, overdue, and repeat durations to core minutes', async () => {
      await mount();
      await save(form({
        advanceEnabled: ['0', '1'], advanceAmount: '2', advanceUnit: 'hours',
        overdueAmount: '3', overdueUnit: 'days',
        repeatEnabled: ['0', '1'], repeatAmount: '90', repeatUnit: 'minutes',
      })).expect(302);

      const settings = notificationService.getSettings();
      expect(settings.advance).toEqual({ enabled: true, leadMinutes: 120 });
      expect(settings.scheduled).toEqual({ enabled: true });
      expect(settings.overdue).toEqual({ enabled: true, graceMinutes: 3 * 24 * 60 });
      expect(settings.overdueRepeat).toEqual({ enabled: true, intervalMinutes: 90 });

      const page = await agent.get(BASE).expect(200);
      expect(page.text).toMatch(/id="release-notifications-advance-amount"[^>]*value="2"/);
      expect(page.text).toMatch(/<option value="hours" selected>/);
    });

    it.each([
      ['advance', { advanceEnabled: ['0', '1'], advanceAmount: '2', advanceUnit: 'bogus' }, 'Advance reminder lead time', 'advance-amount', '2'],
      ['overdue', { overdueAmount: '3', overdueUnit: 'weeks' }, 'Overdue grace period', 'overdue-amount', '3'],
      ['repeat', { repeatEnabled: ['0', '1'], repeatAmount: '4', repeatUnit: '' }, 'Repeat interval', 'repeat-amount', '4'],
      ['advance (array)', { advanceEnabled: ['0', '1'], advanceAmount: '5', advanceUnit: ['hours', 'x'] }, 'Advance reminder lead time', 'advance-amount', '5'],
      ['advance (multi-value, valid last)', { advanceEnabled: ['0', '1'], advanceAmount: '2', advanceUnit: ['bogus', 'hours'] }, 'Advance reminder lead time', 'advance-amount', '2'],
      ['advance (multi-value, all valid)', { advanceEnabled: ['0', '1'], advanceAmount: '2', advanceUnit: ['hours', 'hours'] }, 'Advance reminder lead time', 'advance-amount', '2'],
      ['overdue (multi-value)', { overdueAmount: '3', overdueUnit: ['bogus', 'days'] }, 'Overdue grace period', 'overdue-amount', '3'],
      ['overdue (object)', { overdueAmount: '3', overdueUnit: { unit: 'days' } }, 'Overdue grace period', 'overdue-amount', '3'],
      ['repeat (multi-value)', { repeatEnabled: ['0', '1'], repeatAmount: '4', repeatUnit: ['days', 'minutes'] }, 'Repeat interval', 'repeat-amount', '4'],
    ])('rejects an unknown %s unit without saving or falling back to minutes', async (_field, overrides, label, amountId, amount) => {
      await mount();
      await save(form({ advanceAmount: '6', advanceUnit: 'hours' })).expect(302);
      const before = notificationService.getSettings();

      const res = await save(form(overrides)).expect(422);

      expect(res.text).toContain(`${label} unit must be minutes, hours, or days.`);
      expect(res.text).toMatch(new RegExp(`id="release-notifications-${amountId}"[^>]*value="${amount}"`));
      expect(notificationService.getSettings()).toEqual(before);
    });

    it.each(['advanceUnit', 'overdueUnit', 'repeatUnit'])('rejects a duplicated raw %s form field without saving', async (field) => {
      await mount();
      await save(form({ advanceAmount: '6', advanceUnit: 'hours' })).expect(302);
      const before = notificationService.getSettings();

      const fields = form({ advanceEnabled: ['0', '1'], repeatEnabled: ['0', '1'] });
      delete fields[field];
      const params = new URLSearchParams({ _csrf: csrfToken });
      for (const [key, value] of Object.entries(fields)) [].concat(value).forEach((item) => params.append(key, item));
      params.append(field, 'bogus');
      params.append(field, 'hours');
      await agent.post(BASE).type('form').send(params.toString()).expect(422);

      expect(notificationService.getSettings()).toEqual(before);
    });

    it('rejects a repeat reminder without overdue reminders', async () => {
      await mount();
      const res = await save(form({ overdueEnabled: '0', repeatEnabled: ['0', '1'] })).expect(422);

      expect(res.text).toContain('Repeat overdue reminders require overdue reminders.');
      expect(notificationService.getSettings().overdueRepeat.enabled).toBe(false);
    });

    it('rejects the scheduled plus zero-grace overdue duplicate', async () => {
      await mount();
      const res = await save(form({ overdueAmount: '0', overdueUnit: 'minutes' })).expect(422);

      expect(res.text).toContain('Overdue grace must be above zero while the scheduled notification is enabled.');
      expect(notificationService.getSettings().overdue.graceMinutes).toBe(60);
    });

    it('reports out-of-range durations in the units the form offers', async () => {
      await mount();
      const res = await save(form({ advanceEnabled: ['0', '1'], advanceAmount: '31', advanceUnit: 'days' })).expect(422);

      expect(res.text).toContain('Advance reminder lead time must be a whole number from 1 minute to 30 days.');
    });

    it('rejects an invalid date-only time and preserves every submitted value', async () => {
      await mount();
      const res = await save(form({
        channels: ['ntfy', 'webhook'],
        emailRecipient: 'draft@example.test',
        dateOnlyTime: '25:99',
        advanceEnabled: ['0', '1'], advanceAmount: '45', advanceUnit: 'minutes',
      })).expect(422);

      expect(res.text).toContain('Date-only notification time must be HH:MM.');
      expect(res.text).toContain('value="25:99"');
      expect(res.text).toContain('value="draft@example.test"');
      expect(res.text).toMatch(/id="release-notifications-advance-amount"[^>]*value="45"/);
      expect(checkbox(res.text, 'release-notifications-advance-enabled')).toContain('checked');
      expect(checkbox(res.text, 'release-notifications-channel-ntfy')).toContain('checked');
      expect(checkbox(res.text, 'release-notifications-channel-webhook')).toContain('checked');
      expect(notificationService.getSettings()).toMatchObject({ dateOnlyTime: '09:00', enabledChannels: [], emailRecipient: null });
    });

    it('requires the CSRF token', async () => {
      await mount();
      await agent.post(BASE).type('form').send(form({ channels: ['email'] })).expect(403);
      expect(notificationService.getSettings().enabledChannels).toEqual([]);
    });
  });

  describe('send test', () => {
    for (const channel of CHANNELS) {
      it(`sends a ${channel} test while disabled and unselected, recording only that channel`, async () => {
        notificationService.updateSettings(prefs({ emailRecipient: 'me@example.test' }));
        await mount();

        const res = await sendTest(channel).expect(200);

        expect(runtime.sendTest).toHaveBeenCalledTimes(1);
        expect(runtime.sendTest).toHaveBeenCalledWith(channel);
        expect(res.text).toContain(`Test notification accepted by ${ACCEPTED_BY[channel]}.`);
        expect(channelBlock(res.text, channel)).toContain(`Accepted by ${ACCEPTED_BY[channel]}`);
        const results = recentResults.getRecentResults();
        expect(results[channel]).toEqual({
          kind: 'test', at: clock.toISOString(), state: 'accepted', code: null, nextRetryAt: null,
        });
        for (const other of CHANNELS.filter((candidate) => candidate !== channel)) {
          expect(results[other]).toBeNull();
        }
        expect(notificationService.getSettings()).toMatchObject({ enabled: false, enabledChannels: [] });
      });
    }

    it('does not overwrite another channel\'s recent result', async () => {
      notificationService.updateSettings(prefs({ emailRecipient: 'me@example.test' }));
      await mount();
      recentResults.recordResult('ntfy', { kind: 'release', at: '2026-09-26T08:00:00.000Z', state: 'accepted' });

      await sendTest('email').expect(200);

      expect(recentResults.getRecentResults().ntfy).toMatchObject({ kind: 'release', state: 'accepted' });
    });

    it('does not invoke the gateway for an unready channel', async () => {
      notificationService.updateSettings(prefs({ enabledChannels: ['gotify'] }));
      await mount({ ready: ['email', 'ntfy', 'webhook'] });

      const res = await sendTest('gotify').expect(409);

      expect(runtime.sendTest).not.toHaveBeenCalled();
      expect(res.text).toContain('Test not sent — Gotify token is missing.');
      expect(recentResults.getRecentResults().gotify).toBeNull();
    });

    it('rejects unknown channels', async () => {
      await mount();
      await sendTest('sms').expect(404);
      await sendTest('__proto__').expect(404);
      expect(runtime.sendTest).not.toHaveBeenCalled();
    });

    it('shows a transient failure with its next retry, never the provider text', async () => {
      await mount({
        sendTest: async () => ({
          outcome: 'transient_failure',
          failureCode: 'provider_unavailable',
          nextRetryAt: '2026-09-27T12:05:00.000Z',
          message: `503 upstream token=${SECRETS.ntfyToken}`,
        }),
      });

      const res = await sendTest('ntfy').expect(200);
      const block = channelBlock(res.text, 'ntfy');

      expect(block).toContain('Retry scheduled');
      expect(block).toContain('The service was temporarily unavailable');
      expect(block).toMatch(/Next retry \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
      expect(res.text).not.toContain(SECRETS.ntfyToken);
      expect(recentResults.getRecentResults().ntfy).toMatchObject({ state: 'retry_scheduled', code: 'provider_unavailable' });
    });

    it('shows a permanent failure safely', async () => {
      notificationService.updateSettings(prefs({ emailRecipient: 'me@example.test' }));
      await mount({
        sendTest: async () => ({
          outcome: 'permanent_failure',
          failureCode: 'authentication_failed',
          response: `535 5.7.8 Authentication failed for ${SECRETS.smtpUsername}:${SECRETS.smtpPassword}`,
        }),
      });

      const res = await sendTest('email').expect(200);

      expect(res.text).toContain('Test notification failed: Authentication was rejected.');
      expect(channelBlock(res.text, 'email')).toContain('status-badge--error">Failed</span>');
      expect(res.text).not.toContain(SECRETS.smtpPassword);
      expect(res.text).not.toContain(SECRETS.smtpUsername);
    });

    it('reduces a throwing gateway to a fixed safe error', async () => {
      await mount({
        sendTest: async () => { throw new Error(`connect failed ${WEBHOOK_URL}`); },
      });

      const res = await sendTest('webhook').expect(200);

      expect(res.text).toContain('Test notification failed: An unexpected error occurred.');
      expect(res.text).not.toContain(SECRETS.webhookPath);
      expect(res.text).not.toContain(SECRETS.webhookQuery);
    });

    it('does not create release occurrences or deliveries', async () => {
      notificationService.updateSettings(prefs({ enabled: true, enabledChannels: CHANNELS, emailRecipient: 'me@example.test' }));
      await mount();
      const before = countDeliveryRows(db);

      for (const channel of CHANNELS) await sendTest(channel).expect(200);

      expect(countDeliveryRows(db)).toEqual(before);
      expect(before).toEqual({ occurrences: 0, deliveries: 0 });
    });

    it('requires the CSRF token', async () => {
      await mount();
      await agent.post(`${BASE}/channels/ntfy/test`).type('form').send({}).expect(403);
      expect(runtime.sendTest).not.toHaveBeenCalled();
    });
  });
});
