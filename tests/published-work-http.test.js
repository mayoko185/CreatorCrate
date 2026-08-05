import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { createReleaseService } from '../src/services/release-service.js';
import { evaluateReleaseReadiness } from '../src/services/release-readiness-policy.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Releases HTTP route', () => {
  let db;
  let app;
  let tmpDir;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-releases-page-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }

    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper } },
    );
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createProject(title) {
    const res = await agent
      .post('/projects')
      .send(`title=${encodeURIComponent(title)}`)
      .send('status=tbd')
      .send('priority=normal')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    return res.headers.location.replace('/projects/', '');
  }

  async function createRelease({ projectId, title, plannedDate = null, plannedTime = null, status = 'idea' }) {
    const requestBody = [
      `projectId=${projectId}`,
      `title=${encodeURIComponent(title)}`,
    ];
    if (plannedDate) requestBody.push(`plannedDate=${plannedDate}`);
    if (plannedTime) requestBody.push(`plannedTime=${plannedTime}`);
    requestBody.push('_csrf=' + encodeURIComponent(csrfToken));

    const res = await agent
      .post('/releases')
      .send(requestBody.join('&'))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const releaseId = Number(res.headers.location.replace('/releases/', ''));

    if (status !== 'idea') {
      const releaseService = createReleaseService({ db, evaluateReleaseReadiness });
      releaseService.updateRelease(releaseId, { status });
    }

    return { id: releaseId, location: res.headers.location };
  }

  function listTitles(html) {
    return [...html.matchAll(/<td><a href="\/releases\/\d+">([^<]+)<\/a><\/td>/g)]
      .map((match) => match[1]);
  }

  it('renders Releases as the release-record page and uses scheduling defaults', async () => {
    const projectId = await createProject('Release Context Project');
    await createRelease({ projectId, title: 'Context Release', plannedDate: '2026-08-15', plannedTime: '09:30' });

    const res = await agent.get('/releases').expect(200);

    expect(res.text).toContain('<title>CreatorCrate — Releases</title>');
    expect(res.text).toContain('<h1 class="app-section-title">Releases</h1>');
    expect(res.text).toContain('>Releases</span>');
    expect(res.text).not.toContain('Published Work');
    expect(res.text).toContain('<option value="planned" selected>Planned</option>');
    expect(res.text).toContain('<option value="asc" selected>Asc</option>');
    expect(res.text).toContain('Context Release');
    expect(res.text).toContain('Release Context Project');
  });

  it('lists past and future scheduled releases, excludes archived releases, and links each row to release detail', async () => {
    const projectId = await createProject('Schedule Context Project');
    const past = await createRelease({
      projectId,
      title: 'Past Release',
      plannedDate: '2020-01-01',
      plannedTime: '08:00',
    });
    const future = await createRelease({
      projectId,
      title: 'Future Release',
      plannedDate: '2099-12-31',
      plannedTime: '18:00',
    });
    const archived = await createRelease({
      projectId,
      title: 'Archived Release',
      plannedDate: '2025-06-01',
    });
    await agent
      .post(`${archived.location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await agent.get('/releases').expect(200);

    expect(res.text).toContain('Past Release');
    expect(res.text).toContain('Future Release');
    expect(res.text).not.toContain('Archived Release');
    expect(res.text).toContain(`href="${past.location}"`);
    expect(res.text).toContain(`href="${future.location}"`);
    expect(res.text).toContain('Schedule Context Project');
  });

  it('orders releases by scheduled date and time with unscheduled releases last', async () => {
    const projectId = await createProject('Ordering Context Project');
    await createRelease({ projectId, title: 'Later Same Day', plannedDate: '2026-08-15', plannedTime: '16:00' });
    await createRelease({ projectId, title: 'Earlier Same Day', plannedDate: '2026-08-15', plannedTime: '09:00' });
    await createRelease({ projectId, title: 'Earlier Date', plannedDate: '2026-08-01', plannedTime: '12:00' });
    await createRelease({ projectId, title: 'Unscheduled Release' });

    const res = await agent.get('/releases').expect(200);

    expect(listTitles(res.text)).toEqual([
      'Earlier Date',
      'Earlier Same Day',
      'Later Same Day',
      'Unscheduled Release',
    ]);
  });

  it('searches release records and preserves pagination', async () => {
    const projectId = await createProject('Searchable Project');
    await createRelease({ projectId, title: 'Findable Release', plannedDate: '2026-08-01' });
    await createRelease({ projectId, title: 'Other Release', plannedDate: '2026-08-02' });

    const search = await agent.get('/releases?search=Findable').expect(200);
    expect(search.text).toContain('Findable Release');
    expect(search.text).not.toContain('Other Release');
    expect(search.text).toContain('value="Findable"');

    for (let index = 0; index < 26; index += 1) {
      await createRelease({
        projectId,
        title: `Paged Release ${String(index).padStart(2, '0')}`,
        plannedDate: `2027-01-${String(index + 1).padStart(2, '0')}`,
      });
    }

    const pageTwo = await agent.get('/releases?search=Paged&page=2').expect(200);
    expect(pageTwo.text).toContain('Page 2 of 2');
    expect(pageTwo.text).toContain('Paged Release 25');
    expect(pageTwo.text).not.toContain('Paged Release 00');
  });

  it('keeps the release-management route available as a separate release-record surface', async () => {
    const projectId = await createProject('Management Surface Project');
    await createRelease({ projectId, title: 'Management Surface Release' });

    const res = await agent.get('/release-management').expect(200);

    expect(res.text).toContain('Management Surface Release');
    expect(res.text).toContain('<h1 class="app-section-title">Releases</h1>');
  });
});
