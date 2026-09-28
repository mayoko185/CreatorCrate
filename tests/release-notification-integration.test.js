/**
 * WP4 — release notifications wired into the real application context:
 * Settings mounting/navigation, CSRF, Send Test through the runtime lane and
 * the real WP2 ntfy sender (fetch stubbed), scheduled delivery with release
 * links, and live-restore pause/drain/rebuild/disable behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplicationContext } from '../src/app-context.js';
import { createConfig } from '../src/config.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createBackupService } from '../src/services/backup-service.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { defaultReleaseNotificationPreferences } from '../src/services/release-notification-settings-service.js';
import { effectiveTimeZone } from '../src/services/release-notification-runtime.js';
import { extractCsrfToken } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const BASE = '/settings/release-notifications';
const CHANNELS = ['email', 'ntfy', 'gotify', 'webhook'];
const NTFY_TOKEN = 'tk_integration_secret_4471';
const ENV = {
  RELEASE_NOTIFICATIONS_BASE_URL: 'https://cc.example.test/app',
  RELEASE_NOTIFICATIONS_NTFY_URL: 'https://ntfy.example.test',
  RELEASE_NOTIFICATIONS_NTFY_TOPIC: 'releases',
  RELEASE_NOTIFICATIONS_NTFY_TOKEN: NTFY_TOKEN,
};

const local = (month, day, hours = 0, minutes = 0) => new Date(2026, month - 1, day, hours, minutes);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function flush(times = 20) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function okResponse(status = 200) {
  return { status, headers: { get: () => null }, body: { cancel: async () => {} } };
}

function form(overrides = {}) {
  return {
    enabled: '0',
    channels: [],
    emailRecipient: '',
    dateOnlyTime: '09:00',
    advanceEnabled: '0', advanceAmount: '1', advanceUnit: 'days',
    scheduledEnabled: ['0', '1'],
    overdueEnabled: ['0', '1'], overdueAmount: '1', overdueUnit: 'hours',
    repeatEnabled: '0', repeatAmount: '1', repeatUnit: 'days',
    ...overrides,
  };
}

function currentSettingsChildKeys(html) {
  return [...new Set([...html.matchAll(
    /<a\b(?=[^>]*\bdata-nav-key="(settings-[^"]+)")(?=[^>]*\baria-current="page")[^>]*>/g,
  )].map((match) => match[1]))];
}

describe('release notifications — application integration', () => {
  let tmpDir;
  let appDataRoot;
  let databasePath;
  let db;
  let backupService;
  let appContext;
  let agent;
  let fetchCalls;
  let fetchMode;

  function buildContext({ backupHooks } = {}) {
    backupService = createBackupService({
      appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR, ...(backupHooks ? { _hooks: backupHooks } : {}),
    });
    appContext = createApplicationContext({
      appName: 'CreatorCrate',
      appOpts: {
        appDataRoot,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        backupService,
        maintenanceState: { active: false },
        authState: { csrfPepper: ensureAuthEnablement(appDataRoot).csrfPepper },
        releaseNotifications: createConfig(ENV).releaseNotifications,
      },
    }, db);
    agent = request.agent(appContext.handleRequest);
  }

  async function csrf() {
    const page = await agent.get(BASE).expect(200);
    return extractCsrfToken(page.text);
  }

  function core() {
    return appContext.app.locals.releaseNotificationService;
  }

  function enableNtfy() {
    core().updateSettings({ ...defaultReleaseNotificationPreferences(), enabled: true, enabledChannels: ['ntfy'] });
  }

  function createRelease(plannedTime = '14:00') {
    const liveDb = appContext.db;
    const projectId = Number(liveDb.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, project_type, patreon_url)
      VALUES ('Project', 'project-' || abs(random()), '', '', 'tbd', 'images', NULL)
    `).run().lastInsertRowid);
    return Number(liveDb.prepare(`
      INSERT INTO releases (project_id, title, notes, planned_date, planned_time) VALUES (?, 'Release', '', '2026-06-10', ?)
    `).run(projectId, plannedTime).lastInsertRowid);
  }

  function deliveries(connection = appContext.db) {
    return connection.prepare('SELECT channel, state, failure_code FROM release_notification_deliveries').all();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(local(6, 1, 8));
    fetchCalls = [];
    fetchMode = 'auto';
    // The real WP2 ntfy sender binds globalThis.fetch when the runtime builds it.
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      const pending = deferred();
      fetchCalls.push({ url, init, body: JSON.parse(init.body), resolve: pending.resolve });
      if (fetchMode === 'auto') pending.resolve(okResponse());
      return pending.promise;
    }));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-notifications-'));
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    databasePath = path.join(appDataRoot, 'creatorcrate.db');
    db = openDatabase(databasePath);
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    try { closeDatabase(appContext.db); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mounts the Settings page with navigation, all four channels, runtime status, and timezone', async () => {
    buildContext();
    const res = await agent.get(BASE).expect(200);

    expect(res.text).toContain('Settings — Release Notifications');
    expect(currentSettingsChildKeys(res.text)).toEqual(['settings-release-notifications']);
    expect(res.text).toMatch(/<span class="app-nav-child-label">Release Notifications<\/span>/);
    for (const channel of CHANNELS) expect(res.text).toContain(`data-release-notification-channel="${channel}"`);
    expect(res.text).toContain('https://ntfy.example.test');
    expect(res.text).toContain(effectiveTimeZone());
    expect(res.text).not.toContain(NTFY_TOKEN);

    // Existing Settings pages are unaffected.
    const other = await agent.get('/settings/open-locally').expect(200);
    expect(currentSettingsChildKeys(other.text)).toEqual(['settings-open-locally']);
  });

  it('saves through the real app with CSRF enforced', async () => {
    buildContext();
    await agent.post(BASE).type('form').send(form({ enabled: ['0', '1'], channels: ['ntfy'] })).expect(403);
    expect(core().getSettings().enabled).toBe(false);

    const token = await csrf();
    const res = await agent.post(BASE).type('form')
      .send({ ...form({ enabled: ['0', '1'], channels: ['ntfy'] }), _csrf: token }).expect(302);
    expect(res.headers.location).toBe(`${BASE}?notice=saved`);
    expect(core().getSettings()).toMatchObject({ enabled: true, enabledChannels: ['ntfy'] });
  });

  it('routes Send Test through the runtime lane to the real sender without ledger rows', async () => {
    buildContext();
    const token = await csrf();
    await agent.post(`${BASE}/channels/ntfy/test`).type('form').send({}).expect(403);
    expect(fetchCalls).toHaveLength(0);

    const res = await agent.post(`${BASE}/channels/ntfy/test`).type('form').send({ _csrf: token }).expect(200);

    expect(res.text).toContain('Test notification accepted by ntfy.');
    expect(currentSettingsChildKeys(res.text)).toEqual(['settings-release-notifications']);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://ntfy.example.test/');
    expect(fetchCalls[0].body).toMatchObject({ topic: 'releases', title: 'Test notification' });
    expect(appContext.app.locals.releaseNotificationRecentResultService.getRecentResults().ntfy)
      .toMatchObject({ kind: 'test', state: 'accepted' });
    expect(deliveries()).toEqual([]);
    expect(res.text).not.toContain(NTFY_TOKEN);
  });

  it('delivers a due release on a scheduled cycle with a link built from the base URL', async () => {
    buildContext();
    enableNtfy();
    const releaseId = createRelease();
    vi.setSystemTime(local(6, 10, 14));
    // Request headers never influence externally sent links.
    await agent.get(BASE).set('X-Forwarded-Host', 'evil.example.test').set('X-Forwarded-Proto', 'http').expect(200);

    expect(appContext.releaseNotificationRuntime.runCycle()).toMatchObject({ materialized: 1, claimed: 1 });
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.click).toBe(`https://cc.example.test/app/releases/${releaseId}`);
    expect(deliveries()).toEqual([{ channel: 'ntfy', state: 'accepted', failure_code: null }]);
    expect(appContext.app.locals.releaseNotificationRecentResultService.getRecentResults().ntfy)
      .toMatchObject({ kind: 'release', state: 'accepted' });
  });

  it('cancels queued work promptly when a release is published or archived through the real routes', async () => {
    buildContext();
    enableNtfy();
    const published = createRelease();
    const archived = createRelease();
    vi.setSystemTime(local(6, 10, 14));
    const runtime = appContext.releaseNotificationRuntime;
    core().materializeDueOccurrences({ destinations: runtime.resolveDestinations(core().getSettings()) });
    expect(deliveries().map((row) => row.state)).toEqual(['pending', 'pending']);
    const token = await csrf();

    await agent.post(`/releases/${published}/publish`).type('form').send({ _csrf: token }).expect(302);
    await agent.post(`/releases/${archived}/archive`).type('form').send({ _csrf: token }).expect(302);

    // Cancelled at mutation time, before any cycle claims them.
    expect(deliveries().map((row) => row.failure_code).sort()).toEqual(['release_archived', 'release_published']);
    expect(deliveries().every((row) => row.state === 'cancelled')).toBe(true);
  });

  it('drains an in-flight send before a live restore, rebuilds services, and restores notifications disabled', async () => {
    buildContext();
    enableNtfy();
    createRelease();
    vi.setSystemTime(local(6, 10, 14));
    const runtime = appContext.releaseNotificationRuntime;
    // Backup captures enabled settings and an unsent delivery.
    core().materializeDueOccurrences({ destinations: runtime.resolveDestinations(core().getSettings()) });
    await backupService.createBackup(appContext.db);
    const [backup] = backupService.listBackups();

    const token = await csrf();
    const oldDb = appContext.db;
    const oldCore = core();
    const oldRecent = appContext.app.locals.releaseNotificationRecentResultService;

    fetchMode = 'manual';
    const testRequest = agent.post(`${BASE}/channels/ntfy/test`).type('form').send({ _csrf: token }).then((res) => res);
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));

    let restored = false;
    const restoreRequest = agent.post(`/settings/backups/${backup.filename}/restore`).type('form')
      .send({ _csrf: token }).then((res) => { restored = true; return res; });
    await flush();
    expect(restored).toBe(false);
    expect(runtime.isAdmitting()).toBe(false);
    expect(appContext.db).toBe(oldDb);
    expect(oldDb.open).toBe(true);
    // No new cycle or test is admitted while the restore waits.
    expect(runtime.runCycle()).toEqual({ skipped: true, reason: 'paused' });

    fetchCalls[0].resolve(okResponse());
    expect((await testRequest).text).toContain('Test notification accepted by ntfy.');
    const restoreRes = await restoreRequest;
    expect(restoreRes.headers.location).toBe('/settings/backups?notice=restore_success');

    expect(appContext.db).not.toBe(oldDb);
    expect(core()).not.toBe(oldCore);
    expect(appContext.app.locals.releaseNotificationRecentResultService).not.toBe(oldRecent);
    expect(runtime.isAdmitting()).toBe(true);
    const restoredSettings = core().getSettings();
    expect(restoredSettings).toMatchObject({ enabled: false, enabledChannels: ['ntfy'] });
    expect(deliveries()).toEqual([{ channel: 'ntfy', state: 'cancelled', failure_code: 'notifications_disabled' }]);

    // The restored ledger never replays.
    expect(runtime.runCycle()).toEqual({ skipped: true, reason: 'disabled' });
    await flush();
    expect(fetchCalls).toHaveLength(1);

    // Re-enabling starts a fresh prospective baseline: the already-due
    // release is not sent, a later one is.
    fetchMode = 'auto';
    vi.setSystemTime(local(6, 10, 14, 5));
    const enable = await agent.post(BASE).type('form')
      .send({ ...form({ enabled: ['0', '1'], channels: ['ntfy'] }), _csrf: token }).expect(302);
    expect(enable.headers.location).toBe(`${BASE}?notice=saved`);
    expect(core().getSettings().activation.activatedAt).toBe(local(6, 10, 14, 5).toISOString());
    runtime.runCycle();
    await flush();
    expect(fetchCalls).toHaveLength(1);

    createRelease('14:10');
    vi.setSystemTime(local(6, 10, 14, 10));
    runtime.runCycle();
    await flush();
    expect(fetchCalls).toHaveLength(2);
  });

  it('resumes the original runtime with notifications still enabled after a failed restore', async () => {
    buildContext({ backupHooks: { afterStagedRestorePrepared: () => { throw new Error('staging failed'); } } });
    enableNtfy();
    await backupService.createBackup(appContext.db);
    const [backup] = backupService.listBackups();
    const token = await csrf();

    const res = await agent.post(`/settings/backups/${backup.filename}/restore`).type('form')
      .send({ _csrf: token }).expect(302);

    expect(res.headers.location).toBe('/settings/backups?notice=restore_failed');
    expect(appContext.releaseNotificationRuntime.isAdmitting()).toBe(true);
    expect(core().getSettings()).toMatchObject({ enabled: true, enabledChannels: ['ntfy'] });
    await agent.post(`${BASE}/channels/ntfy/test`).type('form').send({ _csrf: token }).expect(200);
    expect(fetchCalls).toHaveLength(1);
  });
});
