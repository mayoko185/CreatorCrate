/**
 * Phase 10.5C — Remaining release-page integration coverage.
 *
 * Focused Release, workflow, Calendar, asset-browser, and shared-component
 * suites own the historical consolidation contracts. This file retains the
 * distinct release-detail heading integration that is not covered elsewhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { getDisabledModeCsrf } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function countTags(html, tag) {
  const re = new RegExp(`<${tag}[\\s>]`, 'g');
  return (html.match(re) || []).length;
}

describe('Phase 10.5C: Release page visual consolidation', () => {
  let db;
  let tmpDir;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-105c-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper } },
    );
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('release detail has exactly one h1', async () => {
    const projectResponse = await agent
      .post('/projects')
      .send('title=Detail+H1+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const projectId = projectResponse.headers.location.replace('/projects/', '');

    const releaseResponse = await agent
      .post('/releases')
      .send(`projectId=${projectId}`)
      .send('title=H1+Detail+Release')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const detailResponse = await agent.get(releaseResponse.headers.location).expect(200);
    expect(countTags(detailResponse.text, 'h1')).toBe(1);
  });
});
