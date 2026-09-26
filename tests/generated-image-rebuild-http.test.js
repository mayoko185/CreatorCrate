import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { createPreviewService } from '../src/services/preview-service.js';
import { createProcessingConcurrencyService } from '../src/services/processing-concurrency-service.js';
import { createApplicationContext } from '../src/app-context.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { GENERATED_IMAGE_REBUILD_KEY } from '../src/data/generated-image-rebuild-repository.js';
import { ensureAuthEnablement, enableAuthState, readAuthEnablement } from '../src/auth/auth-state.js';
import { authenticate, getDisabledModeCsrf, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('generated-image rebuild Settings actions', () => {
  let root;
  let db;
  let app;
  let agent;
  let csrfToken;
  let replacementDb;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-image-rebuild-'));
    const projectsRoot = path.join(root, 'projects');
    const previewRoot = path.join(root, 'previews');
    fs.mkdirSync(projectsRoot);
    fs.mkdirSync(previewRoot);
    db = openDatabase(path.join(root, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(async () => {
    app.locals.generatedImageRebuildService.stop();
    await app.locals.generatedImageRebuildService.waitForIdle();
    if (replacementDb?.open) closeDatabase(replacementDb);
    replacementDb = null;
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const record = (db) => {
    const raw = db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(GENERATED_IMAGE_REBUILD_KEY);
    return raw ? JSON.parse(raw) : null;
  };

  it('queues only effective image Settings changes after the save and exposes durable status', async () => {
    await agent.post('/settings/defaults').type('form')
      .send({ clockFormat: '12h', _csrf: csrfToken }).expect(302);
    expect(record(db)).toBeNull();

    await agent.post('/settings/defaults').type('form')
      .send({ imagesPreviewWebpQuality: '70', _csrf: csrfToken }).expect(302);
    expect(record(db)).toMatchObject({ version: 1, mode: 'automatic',
      targetPolicy: { preview: { webpQuality: 70 } } });
    const status = await agent.get('/settings/defaults/generated-images/rebuild-status').expect(200);
    expect(status.body.runId).toBe(record(db).runId);
    await app.locals.generatedImageRebuildService.waitForIdle();
    expect(record(db).phase).toBe('completed');
  });

  it('provides a CSRF-protected manual action without changing image Settings', async () => {
    const page = await agent.get('/settings/defaults').expect(200);
    expect(page.text).toContain('form="generated-images-rebuild-form"');
    await agent.post('/settings/defaults/generated-images/rebuild').type('form').send({}).expect(403);
    const response = await agent.post('/settings/defaults/generated-images/rebuild').type('form')
      .send({ _csrf: csrfToken }).expect(302);
    expect(response.headers.location).toContain('generated_images_rebuild_queued');
    expect(record(db)).toMatchObject({ mode: 'manual', targetPolicy: {
      thumbnail: { format: 'webp' }, preview: { format: 'webp' },
    } });
    expect(db.prepare("SELECT value FROM app_meta WHERE key = 'images.preview.format'").pluck().get()).toBeUndefined();
  });

  it.each([
    ['idle', null, 'Generated images are up to date.', ''],
    ['running', { phase: 'running', runId: 'run-running', total: 10,
      succeeded: 3, skipped: 2, failed: 1 }, 'Rebuilding generated images in the background.', '6 of 10 checked'],
    ['completed_with_failures', { phase: 'completed_with_failures', runId: 'run-partial', total: 10,
      succeeded: 7, skipped: 2, failed: 1, failures: [{ assetId: 1, message: 'C:\\private\\detail' }] },
    'Rebuild finished, but some images could not be rebuilt.', '10 of 10 checked'],
    ['failed', { phase: 'failed', runId: 'run-failed', total: 10,
      succeeded: 2, skipped: 1, failed: 0, runnerError: 'C:\\private\\detail' },
    'Rebuild stopped before finishing.', '3 of 10 checked'],
  ])('server-renders the %s rebuild state in its own accessible card', async (_phase, status, message, progress) => {
    if (status) {
      db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(
        GENERATED_IMAGE_REBUILD_KEY, JSON.stringify({ version: 1, ...status }),
      );
    }
    const page = await agent.get('/settings/defaults').expect(200);
    const card = page.text.match(/<section id="defaults-generated-images-rebuild"[\s\S]*?<\/section>/)?.[0];
    expect(card).toContain('class="settings-section settings-defaults-section settings-defaults-section--compact"');
    // One padded body field holds status, help and the action row, directly beneath the header.
    expect(card).toMatch(/<\/h3>\s*<div class="field">\s*<div role="status"/);
    expect(card).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(card).toContain(message);
    if (progress) expect(card).toContain(progress);
    // Only the phase message is live; changing progress counts render outside the status region.
    const live = card.match(/<div role="status"[^>]*data-rebuild-status>([\s\S]*?)<\/div>/)?.[1];
    expect(live).toContain('data-rebuild-message');
    expect(live).toContain(message);
    expect(live).not.toContain('data-rebuild-details');
    if (progress) expect(live).not.toContain(progress);
    expect(card).toMatch(/<p class="help-text" data-rebuild-details/);
    expect(card).toContain('data-generated-images-rebuild-button');
    expect(card).toMatch(/<div class="form-actions settings-defaults-action-row">\s*<button type="submit" form="generated-images-rebuild-form" class="button button-secondary" data-generated-images-rebuild-button>Rebuild generated images<\/button>\s*<\/div>\s*<p class="field-error-message" role="alert" data-rebuild-action-error hidden><\/p>\s*<\/div>\s*<\/section>/);
    expect(card.match(/<p class="help-text">[\s\S]*?<\/p>/g)).toEqual([
      '<p class="help-text">Image-setting changes rebuild project thumbnails and previews in the background. Use this action to force a fresh rebuild with the current settings.</p>',
    ]);
    expect(card).not.toContain('C:\\private\\detail');
    expect(page.text.indexOf('id="defaults-thumbnail-generation"')).toBeLessThan(page.text.indexOf('id="defaults-preview-generation"'));
    expect(page.text.indexOf('id="defaults-preview-generation"')).toBeLessThan(page.text.indexOf('id="defaults-generated-images-rebuild"'));
  });

  it.each(['', '{bad json', '{"version":2,"runId":"untrusted","cursor":999,"mode":"manual"}'])(
    'repairs a corrupt durable rebuild marker during context construction', async (raw) => {
      app.locals.generatedImageRebuildService.stop();
      db.prepare("INSERT INTO app_meta (key, value) VALUES ('images.preview.webp_quality', '70')").run();
      db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(GENERATED_IMAGE_REBUILD_KEY, raw);
      const context = createApplicationContext({ appName: 'CreatorCrate',
        projectsRoot: path.join(root, 'projects'), previewRoot: path.join(root, 'previews'),
        appOpts: { authConfig: AUTH_CONFIG },
      }, db);
      app = context.app;
      const repaired = record(db);
      expect(repaired).toMatchObject({ version: 1, mode: 'automatic', phase: 'queued',
        previousPolicy: null, targetPolicy: { preview: { webpQuality: 70 } },
        reconcileAll: true, cursor: 0, attempted: 0, succeeded: 0, failed: 0, skipped: 0,
        failures: [] });
      expect(repaired.runId).toBeTruthy();
      expect(repaired.runId).not.toBe('untrusted');
      await context.generatedImageRebuildService.waitForIdle();
      expect(record(db).phase).toBe('completed');
    },
  );

  it('lets the same restore request drain every active rebuild asset and resume afterward', async () => {
    app.locals.generatedImageRebuildService.stop();
    db.prepare("INSERT INTO projects (id, title, slug, project_dir, status, project_type) VALUES (1, 'One', 'one', 'one', 'ready', 'images')").run();
    const insert = db.prepare(`INSERT INTO assets
      (id, project_id, relative_path, filename, extension, mime_type, is_present, size_bytes, modified_at)
      VALUES (?, 1, ?, ?, 'png', 'image/png', 1, 10, '2026-01-01')`);
    insert.run(1, 'one.png', 'one.png');
    insert.run(2, 'two.png', 'two.png');
    insert.run(3, 'three.png', 'three.png');
    let enter, release;
    const started = new Promise((resolve) => { enter = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const seen = [];
    let maintenanceEntered = false;
    let maintenanceSnapshot;
    let adoptionError;
    let adoptionCalled = false;
    let pauseRequested;
    const requested = new Promise((resolve) => { pauseRequested = resolve; });
    const previewService = { ensureTargetGeneration: async (_project, id) => {
      seen.push(id);
      if (id < 3 && seen.length <= 2) { if (seen.length === 2) enter(); await gate; }
      return { cacheState: 'regenerated' };
    } };
    const backupService = {
      hasActiveBackups: () => false,
      isRestoreInProgress: () => false,
      restoreBackup: async (_filename, liveDb, owner) => {
        maintenanceSnapshot = { liveDb, owner, seen: [...seen] };
        maintenanceEntered = true;
        replacementDb = openDatabase(':memory:');
        runMigrations(replacementDb, MIGRATIONS_DIR);
        replacementDb.prepare("INSERT INTO projects (id, title, slug, project_dir, status, project_type) VALUES (1, 'One', 'one', 'one', 'ready', 'images')").run();
        const replacementInsert = replacementDb.prepare(`INSERT INTO assets
          (id, project_id, relative_path, filename, extension, mime_type, is_present, size_bytes, modified_at)
          VALUES (?, 1, ?, ?, 'png', 'image/png', 1, 10, '2026-01-01')`);
        replacementInsert.run(1, 'one.png', 'one.png');
        replacementInsert.run(2, 'two.png', 'two.png');
        replacementInsert.run(3, 'three.png', 'three.png');
        replacementDb.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(
          GENERATED_IMAGE_REBUILD_KEY,
          db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(GENERATED_IMAGE_REBUILD_KEY),
        );
        return { db: replacementDb, filename: 'test.sqlite' };
      },
    };
    const context = createApplicationContext({ appName: 'CreatorCrate',
      projectsRoot: path.join(root, 'projects'), previewRoot: path.join(root, 'previews'),
      appOpts: { authConfig: AUTH_CONFIG, previewService, backupService, processingConcurrency: 3 },
    }, db, (deps, opts) => createApp(deps, { ...opts,
      beginReplacementAfterRebuild: (...args) => {
        pauseRequested();
        return opts.beginReplacementAfterRebuild(...args);
      },
      onDatabaseReplaced: (...args) => {
        adoptionCalled = true;
        try { return opts.onDatabaseReplaced(...args); } catch (error) { adoptionError = error; throw error; }
      },
    }));
    app = context.app;
    const originalApp = app;
    const auth = await authenticate(context.handleRequest);
    context.generatedImageRebuildService.queueManual();
    context.generatedImageRebuildService.signal();
    await started;
    const pending = auth.agent.post('/settings/backups/test.sqlite/restore').type('form')
      .send({ _csrf: auth.csrfToken }).then((response) => response);
    await requested;
    expect(maintenanceEntered).toBe(false);
    expect(seen).toEqual([1, 2]);
    release();
    const response = await pending;
    expect(response.status).toBe(302);
    expect(maintenanceEntered).toBe(true);
    expect(maintenanceSnapshot.liveDb).toBe(db);
    expect(maintenanceSnapshot.owner).toBeTruthy();
    expect(maintenanceSnapshot.seen).toEqual([1, 2]);
    expect(adoptionError).toBeUndefined();
    expect(adoptionCalled).toBe(true);
    expect(context.app).not.toBe(originalApp);
    expect(context.db).toBe(replacementDb);
    expect(response.headers.location).toBe('/settings/backups?notice=restore_success');
    expect(maintenanceEntered).toBe(true);
    app = context.app;
    await new Promise((resolve) => setImmediate(resolve));
    expect(context.app.locals.maintenanceState.active).toBe(false);
    await context.generatedImageRebuildService.waitForIdle();
    expect(record(replacementDb)).toMatchObject({ mode: 'manual', phase: 'completed', cursor: 3 });
    expect(record(db)).toMatchObject({ mode: 'manual', phase: 'running', cursor: 2 });
    expect(seen).toEqual([1, 2, 3]);
  });

  it.each([['enable', false], ['disable', false], ['enable', true]])(
    'drains the active rebuild for auth %s and cleans up after rebuild failure=%s', async (mode, failBuild) => {
      app.locals.generatedImageRebuildService.stop();
      db.prepare("INSERT INTO projects (id, title, slug, project_dir, status, project_type) VALUES (1, 'One', 'one', 'one', 'ready', 'images')").run();
      const insert = db.prepare(`INSERT INTO assets
        (id, project_id, relative_path, filename, extension, mime_type, is_present, size_bytes, modified_at)
        VALUES (?, 1, ?, ?, 'png', 'image/png', 1, 10, '2026-01-01')`);
      insert.run(1, 'one.png', 'one.png');
      insert.run(2, 'two.png', 'two.png');
      insert.run(3, 'three.png', 'three.png');
      const initialState = ensureAuthEnablement(root);
      if (mode === 'disable') {
        enableAuthState(root, { sessionSecret: 'a'.repeat(64), csrfPepper: initialState.csrfPepper });
      }
      const stateBefore = readAuthEnablement(root);
      let enter, release, pauseRequested;
      const started = new Promise((resolve) => { enter = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      const requested = new Promise((resolve) => { pauseRequested = resolve; });
      const seen = [];
      const previewService = { ensureTargetGeneration: async (_project, id) => {
        seen.push(id);
        if (id < 3 && seen.length <= 2) { if (seen.length === 2) enter(); await gate; }
        return { cacheState: 'regenerated' };
      } };
      let builds = 0;
      let context;
      context = createApplicationContext({ appName: 'CreatorCrate',
        projectsRoot: path.join(root, 'projects'), previewRoot: path.join(root, 'previews'),
        appOpts: { appDataRoot: root, authConfig: mode === 'disable' ? AUTH_CONFIG : null, processingConcurrency: 3,
          authSettings: { sessionTtlHours: 24, cookieSecure: false },
          authState: stateBefore, previewService },
      }, db, (deps, opts) => {
        builds++;
        if (builds === 2) {
          expect(context.app.locals.maintenanceState.active).toBe(true);
          expect(record(db)).toMatchObject({ phase: 'running', cursor: 2 });
          expect(seen).toEqual([1, 2]);
          if (failBuild) throw new Error('Injected auth graph failure');
        }
        return createApp(deps, { ...opts,
          beginReplacementAfterRebuild: async () => {
            pauseRequested();
            return opts.beginReplacementAfterRebuild();
          },
        });
      });
      app = context.app;
      const originalApp = app;
      const originalRunner = context.generatedImageRebuildService;
      const auth = mode === 'enable'
        ? await getDisabledModeCsrf(context.handleRequest, root)
        : await authenticate(context.handleRequest);
      context.generatedImageRebuildService.queueManual();
      context.generatedImageRebuildService.signal();
      await started;
      let settled = false;
      const pending = (mode === 'enable'
        ? auth.agent.post('/settings/security/enable').type('form').send({
          username: 'admin', password: 'CorrectHorseBatteryStaple',
          confirmPassword: 'CorrectHorseBatteryStaple', _csrf: auth.csrfToken,
        })
        : auth.agent.post('/settings/security/disable').type('form').send({
          currentPassword: 'CorrectHorseBatteryStaple', _csrf: auth.csrfToken,
        })).then((response) => { settled = true; return response; });
      await requested;
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(seen).toEqual([1, 2]);
      release();
      const response = await pending;
      app = context.app;
      if (failBuild) {
        expect(response.headers.location).toBe('/settings/security?notice=auth_transition_failed');
        expect(context.app).toBe(originalApp);
        expect(context.generatedImageRebuildService).toBe(originalRunner);
        expect(readAuthEnablement(root)).toEqual(stateBefore);
      } else {
        expect(response.headers.location).toBe(mode === 'enable'
          ? '/login?notice=authentication_enabled'
          : '/settings/security?notice=authentication_disabled');
        expect(context.app).not.toBe(originalApp);
        expect(context.generatedImageRebuildService).not.toBe(originalRunner);
        expect(readAuthEnablement(root).enabled).toBe(mode === 'enable');
      }
      await context.generatedImageRebuildService.waitForIdle();
      if (!failBuild) {
        originalRunner.signal(true);
        await originalRunner.waitForIdle();
      }
      expect(context.app.locals.maintenanceState.active).toBe(false);
      expect(record(db)).toMatchObject({ mode: 'manual', phase: 'completed', cursor: 3 });
      expect(seen).toEqual([1, 2, 3]);
      expect(builds).toBe(2);
    },
  );
});

describe('interactive routes while a manual rebuild is held in generation', () => {
  let root;
  let db;
  let app;

  afterEach(async () => {
    app?.locals.generatedImageRebuildService.stop();
    await app?.locals.generatedImageRebuildService.waitForIdle();
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('serves Project Assets, the Asset Viewer, and same-asset media without waiting for rebuild gates', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-image-rebuild-interactive-'));
    const projectsRoot = path.join(root, 'projects');
    const previewRoot = path.join(root, 'previews');
    fs.mkdirSync(path.join(projectsRoot, 'one'), { recursive: true });
    fs.mkdirSync(previewRoot);
    db = openDatabase(path.join(root, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    db.prepare("INSERT INTO projects (id, title, slug, project_dir, status, project_type) VALUES (1, 'One', 'one', 'one', 'ready', 'images')").run();
    const insert = db.prepare(`INSERT INTO assets
      (id, project_id, relative_path, filename, extension, mime_type, is_present, size_bytes, modified_at)
      VALUES (?, 1, ?, ?, 'png', 'image/png', 1, ?, ?)`);
    for (const id of [1, 2, 3]) {
      const name = `image-${id}.png`;
      const file = path.join(projectsRoot, 'one', name);
      fs.writeFileSync(file, await sharp({ create: { width: 320, height: 240, channels: 3,
        background: { r: 40 * id, g: 90, b: 160 } } }).png().toBuffer());
      const stat = fs.statSync(file);
      insert.run(id, name, name, stat.size, stat.mtime.toISOString());
    }

    const pool = createProcessingConcurrencyService({ concurrency: 4 });
    let gating = false;
    let gated = 0;
    let windowFull;
    const full = new Promise((resolve) => { windowFull = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const previewService = createPreviewService({ db, projectsRoot, previewRoot,
      processingConcurrencyService: pool,
      _hooks: { onStagingCreated: () => {
        if (!gating) return undefined;
        gated += 1;
        if (gated === 2) windowFull();
        return gate;
      } } });
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot },
      { authConfig: AUTH_CONFIG, previewService, processingConcurrencyService: pool });
    const { agent, csrfToken } = await authenticate(app);
    const published = {};
    for (const id of [1, 2, 3]) published[id] = fs.readFileSync((await previewService.getPreview(1, id)).path);

    gating = true;
    await agent.post('/settings/defaults/generated-images/rebuild').type('form')
      .send({ _csrf: csrfToken }).expect(302);
    // B = 2 at C = 4: assets 1 and 2 are held inside their force generations.
    await full;
    expect(gated).toBe(2);

    const assets = await agent.get('/projects/1/assets').expect(200);
    const urls = [...new Set(assets.text.match(/\/projects\/1\/assets\/\d+\/preview\?[^"]*/g))]
      .map((url) => url.replace(/&amp;/g, '&'));
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      const id = Number(url.match(/assets\/(\d+)\//)[1]);
      const media = await agent.get(url).buffer(true).expect(200);
      expect(media.body.equals(published[id])).toBe(true);
    }
    const viewer = await agent.get('/projects/1/assets/1').expect(200);
    const viewerPreview = viewer.text.match(/\/projects\/1\/assets\/1\/preview\?[^"]*/)[0].replace(/&amp;/g, '&');
    expect((await agent.get(viewerPreview).buffer(true).expect(200)).body.equals(published[1])).toBe(true);
    await agent.get('/projects/1/assets/1/thumbnail').expect(200);
    // Every interactive response above completed while both gates held.
    expect(gated).toBe(2);
    expect(record(db)).toMatchObject({ phase: 'running', cursor: 0 });

    release();
    await app.locals.generatedImageRebuildService.waitForIdle();
    expect(record(db)).toMatchObject({ mode: 'manual', phase: 'completed', succeeded: 3, failed: 0 });
  });

  function record(database) {
    return JSON.parse(database.prepare('SELECT value FROM app_meta WHERE key = ?').pluck()
      .get(GENERATED_IMAGE_REBUILD_KEY));
  }
});
