import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createSocialPrepRepository } from '../src/data/social-prep-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createReleaseService } from '../src/services/release-service.js';
import { createSocialPrepService } from '../src/services/social-prep-service.js';
import { createSocialPrepSettingsService } from '../src/services/social-prep-settings-service.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('release Social Preparation publishing', () => {
  let app;
  let agent;
  let csrfToken;
  let db;
  let tmpDir;
  let projectsRoot;
  let socialPrepSettingsService;
  let failSocialInitialization;
  let initializedPlatforms;
  let observedPublishedDate;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-prep-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);

    const appMetaRepository = createAppMetaRepository(db);
    socialPrepSettingsService = createSocialPrepSettingsService({ appMetaRepository });
    const releaseService = createReleaseService({ db });
    const socialPrepRepository = createSocialPrepRepository(db);
    const baseSocialPrepService = createSocialPrepService({
      db,
      socialPrepRepository,
      socialPrepSettingsService,
      releaseService,
    });
    failSocialInitialization = false;
    initializedPlatforms = [];
    observedPublishedDate = null;
    const socialPrepService = {
      initializePlatformState(releaseId, platforms) {
        observedPublishedDate = releaseService.findRelease(releaseId).published_date;
        initializedPlatforms = platforms;
        if (failSocialInitialization) throw new Error('Social Preparation initialization failed');
        return baseSocialPrepService.initializePlatformState(releaseId, platforms);
      },
    };

    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      {
        appDataRoot,
        authState: { csrfPepper },
        releaseService,
        socialPrepSettingsService,
        socialPrepRepository,
        socialPrepService,
      },
    );
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createRelease({ title = 'Release social title', description = 'Release description body', notes = 'Release notes must not become a post' } = {}) {
    const project = await agent
      .post('/projects')
      .send(`_csrf=${encodeURIComponent(csrfToken)}`)
      .send('title=Social+Preparation+Project')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = Number(project.headers.location.replace('/projects/', ''));

    const release = await agent
      .post('/releases')
      .send(`_csrf=${encodeURIComponent(csrfToken)}`)
      .send(`projectId=${projectId}`)
      .send(`title=${encodeURIComponent(title)}`)
      .send(`description=${encodeURIComponent(description)}`)
      .send(`notes=${encodeURIComponent(notes)}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    return { projectId, releaseId: Number(release.headers.location.replace('/releases/', '')), releaseLocation: release.headers.location };
  }

  function addReleaseAsset(releaseId, projectId, filename, role, sortOrder, isPresent = 1) {
    const assetId = Number(db.prepare(`
      INSERT INTO assets (
        project_id, relative_path, filename, extension, mime_type, size_bytes,
        is_present, last_seen_at
      ) VALUES (?, ?, ?, '.png', 'image/png', 1, ?, datetime('now'))
      RETURNING id
    `).get(projectId, filename, filename, isPresent).id);
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(releaseId, assetId, role, sortOrder);
    return assetId;
  }

  function platformRows(releaseId) {
    return db.prepare('SELECT platform, status FROM release_social_platforms WHERE release_id = ? ORDER BY platform').all(releaseId);
  }

  it('supplies saved mixed target facts to the detail model while globally disabled without GET mutations', async () => {
    const { releaseId, releaseLocation } = await createRelease();
    socialPrepSettingsService.setPlatforms(['x']);
    const repository = app.locals.socialPrepRepository;
    repository.ensurePlatforms(releaseId, ['bluesky', 'x', 'patreon']);
    db.prepare(`UPDATE release_social_platforms SET status = 'failed', attempts = 2,
      prepared_at = '2029-01-01 00:00:00', message = 'PRIVATE_MESSAGE', detail_code = 'PRIVATE_CODE'
      WHERE release_id = ? AND platform = 'bluesky'`).run(releaseId);
    db.prepare("UPDATE release_social_platforms SET status = 'prepared', attempts = 1 WHERE release_id = ? AND platform = 'x'").run(releaseId);
    const before = repository.listPlatformsByReleaseId(releaseId);
    const changes = db.prepare('SELECT total_changes() AS n').get().n;
    const render = vi.spyOn(app, 'render').mockImplementation((view, model, callback) => {
      expect(view).toBe('releases/detail.njk');
      callback(null, JSON.stringify(model.socialPreparation));
    });
    try {
      const response = await agent.get(releaseLocation).expect(200);
      const model = JSON.parse(response.text);
      expect(model).toMatchObject({ globallyEnabled: false, configuredPlatforms: ['x'], targets: [
        { platform: 'patreon', status: 'pending', noPreparationRequested: true, absentFromCurrentConfiguration: true },
        { platform: 'x', status: 'prepared', preparationRequestCount: 1, absentFromCurrentConfiguration: false },
        { platform: 'bluesky', status: 'failed', preparationRequestCount: 2, firstPreparedAt: '2029-01-01 00:00:00', absentFromCurrentConfiguration: true },
      ] });
      expect(response.text).not.toMatch(/PRIVATE|message|detail_code|session|token|helper|posted|published/i);
      expect(repository.listPlatformsByReleaseId(releaseId)).toEqual(before);
      expect(db.prepare('SELECT total_changes() AS n').get().n).toBe(changes);
      expect(initializedPlatforms).toEqual([]);
    } finally {
      render.mockRestore();
    }
  });

  it('supplies no targets for an older release despite enabled current defaults, without initialization', async () => {
    const { releaseId, releaseLocation } = await createRelease();
    socialPrepSettingsService.setPlatforms(['patreon', 'x', 'bluesky']);
    socialPrepSettingsService.setEnabled(true);
    const changes = db.prepare('SELECT total_changes() AS n').get().n;
    const render = vi.spyOn(app, 'render').mockImplementation((_view, model, callback) => {
      callback(null, JSON.stringify(model.socialPreparation));
    });
    try {
      const response = await agent.get(releaseLocation).expect(200);
      expect(JSON.parse(response.text)).toEqual({ globallyEnabled: true, configuredPlatforms: ['patreon', 'x', 'bluesky'], targets: [] });
      expect(platformRows(releaseId)).toEqual([]);
      expect(initializedPlatforms).toEqual([]);
      expect(db.prepare('SELECT total_changes() AS n').get().n).toBe(changes);
    } finally {
      render.mockRestore();
    }
  });

  it('keeps the dialog and publication behavior unchanged while Social Preparation is disabled', async () => {
    const { releaseId, releaseLocation } = await createRelease();

    const detail = await agent.get(releaseLocation).expect(200);
    expect(detail.text).not.toContain('release-publish-social-preparation-heading');

    const published = await agent
      .post(`${releaseLocation}/publish`)
      .send(`_csrf=${encodeURIComponent(csrfToken)}`)
      .send('publishedDate=2026-08-01')
      .send('socialPlatforms=patreon')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(published.headers.location).toBe(releaseLocation);
    expect(platformRows(releaseId)).toEqual([]);
    expect(initializedPlatforms).toEqual([]);
  });

  it('renders configured platform previews from release content, preserves asset order, and distinguishes issues', async () => {
    socialPrepSettingsService.setEnabled(true);
    socialPrepSettingsService.setPlatforms(['patreon', 'x', 'bluesky']);
    const { projectId, releaseId, releaseLocation } = await createRelease();
    addReleaseAsset(releaseId, projectId, 'first-primary.png', 'primary', 0);
    addReleaseAsset(releaseId, projectId, 'second-attachment.png', 'attachment', 1);
    addReleaseAsset(releaseId, projectId, 'third-preview.png', 'preview', 2);
    const missingAssetId = addReleaseAsset(releaseId, projectId, 'fourth-missing.png', 'primary', 3, 0);

    const detail = await agent.get(releaseLocation).expect(200);
    const socialStart = detail.text.indexOf('id="release-publish-social-preparation-heading"');
    const socialEnd = detail.text.indexOf('id="release-publish-publication-heading"', socialStart);
    const social = detail.text.slice(socialStart, socialEnd);

    expect(social).toContain('name="socialPlatforms" type="checkbox" value="patreon" checked');
    expect(social).toContain('name="socialPlatforms" type="checkbox" value="x" checked');
    expect(social).toContain('Release social title');
    expect(social).toContain('Release description body');
    expect(social).toContain('<dt>Effective post text</dt>');
    expect(social).toContain('<dd>Release social title</dd>');
    expect(social).toContain('<dd class="description">Release description body</dd>');
    expect(social.match(/<dd class="description">Release social title\n\nRelease description body<\/dd>/g)).toHaveLength(2);
    expect(social).not.toContain('Release notes must not become a post');
    expect(social.indexOf('first-primary.png')).toBeLessThan(social.indexOf('second-attachment.png'));
    expect(social.match(/second-attachment\.png \(Attachment\)/g)).toHaveLength(3);
    expect(social.match(/third-preview\.png \(Preview\)/g)).toHaveLength(3);
    expect(social).not.toContain('role not supported');
    expect(social).not.toContain('Excluded assets');
    expect(social).not.toContain('No release assets are excluded for this platform.');
    expect(social).toContain(`Blocking:</strong> Included asset ${missingAssetId} is missing`);

    db.prepare('UPDATE releases SET description = ? WHERE id = ?').run('', releaseId);
    const emptyDescription = await agent.get(releaseLocation).expect(200);
    expect(emptyDescription.text).toContain('Warning:</strong> The release Description is empty. This is advisory only and does not prevent CreatorCrate publication.');
    expect(emptyDescription.text).toContain('X preview');
    expect(emptyDescription.text).toContain('Bluesky preview');
    expect(emptyDescription.text).toContain('>Release social title</dd>');
  });

  it('initializes only configured selected platforms after publication and adds the preparation marker', async () => {
    socialPrepSettingsService.setEnabled(true);
    socialPrepSettingsService.setPlatforms(['patreon', 'x']);
    const { releaseId, releaseLocation } = await createRelease();

    expect(platformRows(releaseId)).toEqual([]);
    const published = await agent
      .post(`${releaseLocation}/publish`)
      .send(`_csrf=${encodeURIComponent(csrfToken)}`)
      .send('publishedDate=2026-08-02')
      .send('socialPlatforms=x')
      .send('socialPlatforms=malicious')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(observedPublishedDate).toBe('2026-08-02');
    expect(initializedPlatforms).toEqual(['x', 'malicious']);
    expect(platformRows(releaseId)).toEqual([{ platform: 'x', status: 'pending' }]);
    expect(published.headers.location).toBe(`${releaseLocation}?prep=1`);
    expect(db.prepare('SELECT published_date FROM releases WHERE id = ?').get(releaseId).published_date).toBe('2026-08-02');
  });

  it('keeps the release published when Social Preparation initialization fails', async () => {
    socialPrepSettingsService.setEnabled(true);
    socialPrepSettingsService.setPlatforms(['bluesky']);
    failSocialInitialization = true;
    const { releaseId, releaseLocation } = await createRelease();

    const published = await agent
      .post(`${releaseLocation}/publish`)
      .send(`_csrf=${encodeURIComponent(csrfToken)}`)
      .send('publishedDate=2026-08-03')
      .send('socialPlatforms=bluesky')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(observedPublishedDate).toBe('2026-08-03');
    expect(db.prepare('SELECT published_date FROM releases WHERE id = ?').get(releaseId).published_date).toBe('2026-08-03');
    expect(platformRows(releaseId)).toEqual([]);
    expect(published.headers.location).toBe(releaseLocation);
  });
});
