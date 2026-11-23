import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { ensureAuthEnablement } from '../src/auth/auth-state.js';
import { extractCsrfToken, getDisabledModeCsrf } from './helpers/auth.js';
import { deriveDisabledModeCsrfToken } from '../src/middleware/csrf.js';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations, closeDatabase, registerSqlFunctions } from '../src/db.js';
import { formatProjectDirName } from '../src/storage/project-storage.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createReleaseRepository } from '../src/data/release-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createReleaseService } from '../src/services/release-service.js';
import { formatLocalDate, formatLocalTime } from '../src/util/date.js';
import { getLocalTodayIso } from '../src/util/date.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';
import { buildCreateReleaseFormModel } from '../src/routes/release-create-form.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

// B3-F2: a successful Manage Assets Save redirects to exactly /releases/:id
// carrying only its own opaque one-time confirmation ticket.
function expectReleaseAssetsSavedLocation(location, releaseId, label) {
  const url = new URL(location, 'http://localhost');
  expect(location.startsWith(`/releases/${releaseId}?assetsSaved=`), label).toBe(true);
  expect(url.pathname, label).toBe(`/releases/${releaseId}`);
  expect([...url.searchParams.keys()], label).toEqual(['assetsSaved']);
  expect(url.searchParams.get('assetsSaved'), label).toMatch(/^[A-Za-z0-9_-]{43}$/);
}

function countTags(html, tag) {
  const re = new RegExp(`<${tag}[\\s>]`, 'g');
  return (html.match(re) || []).length;
}

function hasClass(html, className) {
  const re = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`);
  return re.test(html);
}

function extractPageHeading(html) {
  return html.match(/<header class="page-heading">[\s\S]*?<\/header>/)?.[0] || '';
}

// A "← Label" text button in the page heading's left navigation group, with
// its hover/focus tooltip exposed as the link's accessible description.
function expectHeadingNavLink(html, { key, href, label, tooltip }) {
  const nav = extractPageHeading(html).match(/<nav class="page-heading-navigation page-heading-navigation--text" aria-label="Page navigation">[\s\S]*?<\/nav>/)?.[0] || '';
  const link = nav.match(new RegExp(
    `<a class="button button-secondary page-heading-lead page-heading-lead--text asset-tooltip asset-tooltip--left" href="${href}" aria-label="${label}" data-tooltip="${tooltip}" aria-describedby="page-heading-nav-${key}-tooltip">([\\s\\S]*?)<\\/a>`
  ));

  expect(link).not.toBeNull();
  expect(link[1]).toBe(`<span aria-hidden="true">←</span> ${label}`);
  expect(link[0]).not.toContain('title=');
  expect(nav).toContain(`<span id="page-heading-nav-${key}-tooltip" hidden>${tooltip}</span>`);
  return nav;
}

function expectProjectReturnLead(html, { href, title }) {
  const heading = extractPageHeading(html);
  expectHeadingNavLink(html, { key: 'project', href, label: 'Project', tooltip: 'Go to project details' });
  expect(heading).not.toContain('page-heading-lead--icon');
  expect(heading).not.toContain(`Back to main project page: ${title}`);
  expect(heading).not.toContain(`Project: ${title}`);
}

// Release Detail's left navigation: ← Project then ← Assets, where Assets is
// the project's asset page, never the release's Manage Assets page.
function expectReleaseDetailNav(html, { projectId, releaseLocation }) {
  expectProjectReturnLead(html, { href: `/projects/${projectId}`, title: '' });
  const nav = expectHeadingNavLink(html, { key: 'assets', href: `/projects/${projectId}/assets`, label: 'Assets', tooltip: 'Go to project assets' });
  expect(nav.indexOf(`href="/projects/${projectId}"`)).toBeLessThan(nav.indexOf(`href="/projects/${projectId}/assets"`));
  expect(nav).not.toContain(`${releaseLocation}/assets`);
  expect((nav.match(/<a\b/g) || [])).toHaveLength(2);
}

// Review & Publish is a primary text action whose tooltip is its description.
function expectReviewPublishAction(html, { href }) {
  const heading = extractPageHeading(html);
  const action = heading.match(new RegExp(
    `<a class="button button-small button-primary project-assets-heading-action asset-tooltip asset-tooltip--left"\\s+href="${href}" data-dialog-open="release-publish-dialog"\\s+aria-label="Review &amp; Publish" data-tooltip="Review &amp; Publish this release" aria-describedby="release-publish-action-tooltip">([\\s\\S]*?)<\\/a>\\s*<span id="release-publish-action-tooltip" hidden>Review &amp; Publish this release</span>`
  ));

  expect(action).not.toBeNull();
  expect(action[0]).not.toContain('title=');
  expect(action[1]).not.toContain('<svg');
  expect(action[1].trim()).toBe('Review &amp; Publish');
}

function extractReleasesResultsSection(html) {
  return html.match(/<section class="project-detail-section releases-results-section"[\s\S]*?<\/section>/)?.[0] || '';
}

function extractReleasesResultsBody(html) {
  return extractReleasesResultsSection(html).match(/<div class="project-detail-section-body">[\s\S]*<\/div>\s*<\/section>/)?.[0] || '';
}

function extractReleaseListRow(html, title) {
  return (html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || [])
    .find((row) => row.includes(`>${title}</a>`)) || '';
}

function extractTableCells(row) {
  return [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1]);
}

function extractSelectedAssetsSection(html) {
  return html.match(/<section class="asset-browser-layout" aria-label="Selected assets" data-selected-assets>[\s\S]*?<\/section>/)?.[0] || '';
}

function visibleText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sliceSelect(html, id) {
  const start = html.indexOf(`<select id="${id}"`);
  if (start < 0) return '';
  return html.slice(start, html.indexOf('</select>', start));
}

function optionValues(selectHtml) {
  return [...selectHtml.matchAll(/<option value="([^"]*)"/g)].map(([, value]) => value);
}

function installRecordLookupCounter(db) {
  const originalPrepare = db.prepare.bind(db);
  const counts = { release: 0, project: 0 };

  db.prepare = (sql, ...args) => {
    const statement = originalPrepare(sql, ...args);
    const normalizedSql = String(sql).replace(/\s+/g, ' ').trim();
    const lookup = normalizedSql.endsWith('FROM releases JOIN projects ON projects.id = releases.project_id WHERE releases.id = ?')
      ? 'release'
      : (normalizedSql.endsWith('FROM projects WHERE id = ?') ? 'project' : null);

    if (!lookup) return statement;

    return new Proxy(statement, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return (...statementArgs) => {
            counts[lookup] += 1;
            return target.get(...statementArgs);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  return {
    counts,
    reset() {
      counts.release = 0;
      counts.project = 0;
    },
    restorePrepare() {
      db.prepare = originalPrepare;
    },
  };
}

function expectReleaseFormSectionCards(html) {
  const cards = html.match(/<div class="settings-section(?: release-project-section| scheduling-section)?">\s*<h3>[^<]+<\/h3>/g) || [];
  expect(cards).toHaveLength(5);
  expect(html).toMatch(/<div class="settings-section release-project-section">\s*<h3>Project<\/h3>/);
  expect(html).toMatch(/<div class="settings-section">\s*<h3>Basic information<\/h3>/);
  expect(html).toMatch(/<div class="settings-section scheduling-section">\s*<h3>Scheduling<\/h3>/);
  expect(html).toMatch(/<h3>Scheduling<\/h3>[\s\S]*?<h3>Platforms<\/h3>[\s\S]*?<h3>Links<\/h3>/);
  expect(html).toMatch(/<div class="settings-section">\s*<h3>Links<\/h3>/);
  expect(html).not.toContain('class="form-section"');
}

function expectReleaseDialogSections(dialog, headings) {
  const found = [...dialog.matchAll(/<div class="settings-section[^"]*\bproject-edit-dialog-section\b[^"]*">\s*<h3>([^<]+)<\/h3>/g)].map(([, heading]) => heading);
  expect(found).toEqual(headings);
}

function extractReleaseProjectField(html) {
  return html.match(/<fieldset class="[^"]*asset-viewer-project-filter[^"]*">[\s\S]*?<\/fieldset>(?:\s*<span class="field-error-message" id="projectId-error">[\s\S]*?<\/span>)?/)?.[0] || '';
}

function extractReleaseFilterProjectField(html) {
  const dialog = html.match(/<dialog id="releases-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  return dialog.match(/<fieldset class="[^"]*releases-filter-field--project[^"]*"[^>]*>[\s\S]*?<\/fieldset>/)?.[0] || '';
}

// WP12: the Project Types multi-select of the combined dialog.
function extractReleaseFilterTypeField(html) {
  const dialog = html.match(/<dialog id="releases-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  return dialog.match(/<fieldset class="[^"]*releases-filter-field--type[^"]*"[^>]*>[\s\S]*?<\/fieldset>/)?.[0] || '';
}

// WP12: the authority JSON the combined dialog's explicit defaults transport reads.
function releasesDefaultsAuthority(html) {
  const json = html.match(/<script type="application\/json" data-releases-defaults-authority>([\s\S]*?)<\/script>/)?.[1];
  return json ? JSON.parse(json) : null;
}

function checkedValues(field, name) {
  return [...field.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, 'g'))]
    .map(([input]) => input)
    .filter((input) => /\schecked(?:\s|>|$)/.test(input))
    .map((input) => input.match(/value="([^"]*)"/)?.[1]);
}

function releaseProjectRadioInputs(html) {
  return extractReleaseProjectField(html).match(/<input[^>]*name="projectId"[^>]*type="radio"[^>]*>/g) || [];
}

function selectedProjectRadioValue(html) {
  const field = extractReleaseProjectField(html);
  if (!field) throw new Error('Release Project disclosure was not rendered.');
  return field.match(/<input[^>]*name="projectId"[^>]*type="radio"[^>]*value="([^"]+)"[^>]*checked(?:\s|>)/)?.[1];
}

function expectUniqueValidIdReferences(html) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
  const idSet = new Set(ids);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  const references = [...html.matchAll(/\b(?:for|aria-controls|aria-describedby|aria-labelledby)="([^"]+)"/g)]
    .flatMap(([, raw]) => raw.trim().split(/\s+/));

  expect(duplicateIds).toEqual([]);
  expect(references.every((reference) => idSet.has(reference))).toBe(true);
}

/**
 * Local flat-layout helper: resolve a project directory as a direct child
 * of PROJECTS_ROOT using the production directory-name primitive.
 * @param {string} projectsRoot
 * @param {string|number} projectId - Project id (string or number)
 * @param {string} slug - Project slug
 * @returns {string} Absolute path to the project directory
 */
function getProjectDir(projectsRoot, projectId, slug) {
  return path.join(projectsRoot, formatProjectDirName(Number(projectId), slug));
}

/**
 * Query release_assets junction table directly for a release.
 * Returns rows with asset_id, role, sort_order.
 */
function getReleaseAssets(db, releaseId) {
  return db.prepare('SELECT release_id, asset_id, role, sort_order, created_at FROM release_assets WHERE release_id = ? ORDER BY sort_order ASC, asset_id ASC').all(releaseId);
}

/** Set the owning project's workflow status for a release fixture. */
function setProjectStatusForReleaseTest(db, releaseLocation, projectStatus) {
  const releaseId = Number(releaseLocation.replace('/releases/', ''));
  const release = createReleaseRepository(db).findById(releaseId);
  db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(projectStatus, release.project_id);
  return createReleaseRepository(db).findById(releaseId);
}

/**
 * Helper: create a project, scan a file into it, create a release, and
 * select the scanned asset. Returns { projectId, releaseLocation, assetId }.
 */
async function setupPublishableRelease(agent, projectsRoot, db, csrfToken) {
  const projRes = await agent
    .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
    .send('title=Readiness+Test+Project')
    .send('status=tbd')
    .send('priority=normal')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .expect(302);
  const projectId = projRes.headers.location.replace('/projects/', '');

  const slug = 'readiness-test-project';
  const projectDir = getProjectDir(projectsRoot, projectId, slug);
  fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
  await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

  const assetRepo = createAssetRepository(db);
  const assets = assetRepo.findByProjectId(Number(projectId));
  const assetId = String(assets[0].id);

  const createRes = await agent
    .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
    .send(`projectId=${projectId}`)
    .send('title=Readiness+Test+Release')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .expect(302);
  const releaseLocation = createRes.headers.location;
  setProjectStatusForReleaseTest(db, releaseLocation, 'ready');

  // Select the asset
  await agent
    .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
    .send(`selectedAssetIds[]=${assetId}`)
    .send('roles[]=primary')
    .send('sortOrder[]=0')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .expect(302);

  return { projectId, releaseLocation, assetId };
}

/**
 * Insert a project row directly via SQL, bypassing the service/repository
 * layer so tests can construct rows the normal write paths cannot produce
 * (e.g. status='archived' with a NULL archived_at) and can pin updated_at
 * to a deterministic value for ordering-sensitive fixtures.
 */
function insertProjectDirect(db, overrides = {}) {
  const {
    title = 'Direct Project',
    slug = `direct-project-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    status = 'tbd',
    archivedAt = null,
    updatedAt = null,
  } = overrides;
  const row = db
    .prepare(
      `INSERT INTO projects (title, slug, description, notes, status, project_type, archived_at, updated_at)
       VALUES (?, ?, '', '', ?, 'images', ?, COALESCE(?, datetime('now')))
       RETURNING id`
    )
    .get(title, slug, status, archivedAt, updatedAt);
  return row.id;
}

function insertAssetDirect(db, projectId, filename, isPresent = 1) {
  return db.prepare(`
    INSERT INTO assets (
      project_id, relative_path, filename, extension, mime_type, size_bytes,
      is_present, last_seen_at
    )
    VALUES (?, ?, ?, 'png', 'image/png', 1, ?, datetime('now'))
    RETURNING id
  `).get(projectId, filename, filename, isPresent);
}

describe('release HTTP workflow', () => {
  let db;
  let app;
  let tmpDir;
  let projectsRoot;
  let appDataRoot;
  let releaseRepository;
  let recordLookupCounter;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    releaseRepository = createReleaseRepository(db);
    recordLookupCounter = installRecordLookupCounter(db);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    recordLookupCounter.restorePrepare();
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Edit Release saves name the Release link the form loaded: here, the one
  // stored when the request is built.
  function loadedReleaseLink(releaseIdOrUrl) {
    const id = Number(String(releaseIdOrUrl).split('?')[0].split('/').at(-1));
    return releaseRepository.findById(id)?.patreon_url ?? '';
  }

  function loadedReleaseLinkField(releaseUrl) {
    return 'expectedPatreonUrl=' + encodeURIComponent(loadedReleaseLink(releaseUrl));
  }

  async function createTestProject(title) {
    const res = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`title=${encodeURIComponent(title)}`)
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    return Number(res.headers.location.replace('/projects/', ''));
  }

  describe('release signature manager rendering', () => {
    function manager(html) {
      return html.match(/<dialog id="release-signatures-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    }

    function expectSiblingManager(html, releaseFormId) {
      const releaseFormStart = html.indexOf(`<form id="${releaseFormId}"`);
      const releaseFormEnd = html.indexOf('</form>', releaseFormStart);
      const managerStart = html.indexOf('<dialog id="release-signatures-dialog"');
      expect(releaseFormStart).toBeGreaterThanOrEqual(0);
      expect(releaseFormEnd).toBeGreaterThan(releaseFormStart);
      expect(managerStart).toBeGreaterThan(releaseFormEnd);
      expect(html.slice(releaseFormStart, releaseFormEnd)).toContain('data-dialog-open="release-signatures-dialog"');
      expect(html.match(/id="release-signatures-dialog"/g)).toHaveLength(1);
      expectUniqueValidIdReferences(html);
    }

    it('renders empty New Release hosts with a sibling manager, Add form, and No default', async () => {
      const projectId = await createTestProject('Signature Manager New');
      for (const [url, formId] of [['/releases', 'release-create-form'], [`/releases/new?projectId=${projectId}`, 'release-form']]) {
        const response = await agent.get(url).expect(200);
        const dialog = manager(response.text);
        expectSiblingManager(response.text, formId);
        expect(dialog).toContain('No signatures yet');
        expect(dialog).toContain('data-release-signature-add-form');
        expect(dialog).toMatch(/data-release-signature-add><span class="project-create-submit-icon" aria-hidden="true">[\s\S]*?<\/span>Add<\/button>/);
        expect(dialog).toMatch(/<dialog id="release-signatures-dialog" class="app-dialog project-form-dialog app-dialog--refined"/);
        expect(dialog).toContain('id="release-signatures-default-option-all"');
        expect(dialog).toMatch(/<option value="" selected>No default<\/option>/);
        expect(dialog).not.toContain('data-release-signature-item');
      }
    });

    it('renders ordered escaped entries and the saved default on New and Edit, including New Release validation rerenders', async () => {
      const projectId = await createTestProject('Signature Manager Edit');
      const service = app.locals.releaseSignatureSettingsService;
      const first = service.add({ name: 'First "<&>', body: 'line one\n</textarea><script>&' }).entries[0];
      const second = service.add({ name: 'Second', body: 'line two' }).entries[1];
      service.reorder([second.id, first.id]);
      const withoutDefault = manager((await agent.get('/releases').expect(200)).text);
      expect(withoutDefault).toMatch(/<option value="" selected>No default<\/option>/);
      expect(withoutDefault).not.toMatch(new RegExp(`<option value="${second.id}" selected>`));
      service.setDefault(first.id);

      const created = await agent.post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Signature+Manager+Edit')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const detailUrl = created.headers.location;
      const cases = [
        [await agent.get('/releases').expect(200), 'release-create-form'],
        [await agent.get(detailUrl).expect(200), 'release-edit-form'],
        [await agent.post('/releases').send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`projectId=${projectId}`).send('title=')
          .set('Content-Type', 'application/x-www-form-urlencoded').expect(422), 'release-form'],
      ];
      for (const [response, formId] of cases) {
        const dialog = manager(response.text);
        expectSiblingManager(response.text, formId);
        const releaseForm = response.text.slice(
          response.text.indexOf(`<form id="${formId}"`),
          response.text.indexOf('</form>', response.text.indexOf(`<form id="${formId}"`)) + 7,
        );
        const signatureField = releaseForm.slice(releaseForm.indexOf('data-release-signature-field'));
        const signatureSelect = signatureField.match(/<select[^>]*data-cc-dropdown-native-select[^>]*>[\s\S]*?<\/select>/)?.[0] || '';
        expect(releaseForm).toContain('data-release-signature-field');
        expect(signatureSelect).toContain('<option value="" selected>No signature</option>');
        expect(signatureSelect.indexOf(`value="${second.id}"`)).toBeLessThan(signatureSelect.indexOf(`value="${first.id}"`));
        expect(signatureSelect).toContain('First &quot;&lt;&amp;&gt;');
        expect(signatureSelect).not.toContain('line one');
        expect(dialog.indexOf(`data-signature-id="${second.id}"`)).toBeLessThan(dialog.indexOf(`data-signature-id="${first.id}"`));
        expect(dialog).toContain(`name="id" value="${first.id}"`);
        expect(dialog).toContain('value="First &quot;&lt;&amp;&gt;"');
        expect(dialog).toContain('line one\n&lt;/textarea&gt;&lt;script&gt;&amp;');
        expect(dialog).not.toContain('</textarea><script>');
        expect(dialog).toMatch(new RegExp(`<option value="${first.id}" selected>`));
        expect(dialog).toContain('data-release-signature-delete');
        expect(dialog).toContain('data-release-signature-handle');
        expect(dialog).toContain('data-release-signature-add-form');
      }
    });
  });

  describe('release form layout', () => {
    it('matches the Projects form section cards and places create actions in the page heading', async () => {
      const projectId = await createTestProject('Release Form Layout Project');
      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      const heading = extractPageHeading(res.text);

      expect(heading).toContain('<button class="button button-primary" type="submit" form="release-form">Create</button>');
      expect(heading).toContain(`<a class="button button-secondary" href="/projects/${projectId}">Cancel</a>`);
      expect(res.text).toContain('<form id="release-form"');
      const releaseForm = res.text.match(/<form id="release-form"[\s\S]*?<\/form>/)?.[0] || '';
      expect(releaseForm).not.toContain('class="form-actions"');
      expectReleaseFormSectionCards(res.text);
    });
  });

  // ─── Phase 7D-3: Release planning field wording ──────────────────────
  //
  // Release planning fields (planned_date, published_date, patreon_url)
  // describe an individual publication event. Help text must clarify this
  // distinction from project-level planning fields.

  describe('release form planning field wording', () => {
    /**
     * Extract the HTML of the .field container that contains an input with the
     * given id. Returns null if not found.
     */
    function getFieldContainer(html, inputId) {
      const inputRe = new RegExp(`<input[^>]*id="${inputId}"[^>]*>`);
      const inputMatch = inputRe.exec(html);
      if (!inputMatch) return null;
      const inputPos = inputMatch.index;
      const beforeInput = html.slice(0, inputPos);
      const fieldStart = beforeInput.lastIndexOf('<div class="field');
      if (fieldStart === -1) return null;
      const fromField = html.slice(fieldStart);
      let depth = 0;
      let endPos = 0;
      for (let i = 0; i < fromField.length; i++) {
        if (fromField.slice(i, i + 4) === '<div') { depth++; i += 3; }
        else if (fromField.slice(i, i + 5) === '</div') { depth--; i += 4; }
        if (depth === 0) { endPos = i + 6; break; }
      }
      return fromField.slice(0, endPos);
    }

    it('release form shows help text for planned date in the correct field container', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Release+Wording+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      const container = getFieldContainer(res.text, 'plannedDate');
      expect(container).not.toBeNull();
      expect(container).toContain('Target publication date for this release');
      expect(container).toMatch(/<input[^>]*id="plannedDate"[^>]*>/);
    });

    it('omits published date from the standalone New Release form', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Release+Wording+Pub')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      const container = getFieldContainer(res.text, 'publishedDate');
      expect(container).toBeNull();
      expect(res.text).toContain('data-release-create-fresh="true"');
    });

    it('release form keeps scheduled date and time in a single row', async () => {
      const projectId = await createTestProject('Scheduling Order Project');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      const schedulingMatch = res.text.match(/<div class="field-row scheduling-row">[\s\S]*?<\/div>\s*(?=<div class="settings-section">)/);
      expect(schedulingMatch).not.toBeNull();
      const schedulingRow = schedulingMatch[0];

      const dateMatch = schedulingRow.match(/<div class="field scheduling-field[^"]*"[^\u003e]*>\s*<label for="plannedDate">/);
      const timeMatch = schedulingRow.match(/<div class="field scheduling-field[^"]*"[^\u003e]*>\s*<label for="plannedTime">/);
      expect(dateMatch).not.toBeNull();
      expect(timeMatch).not.toBeNull();

      const datePos = schedulingRow.indexOf(dateMatch[0]);
      const timePos = schedulingRow.indexOf(timeMatch[0]);
      expect(datePos).toBeLessThan(timePos);

      expect(schedulingRow).toContain('id="plannedDate"');
      expect(schedulingRow).toContain('id="plannedTime"');
      expect(schedulingRow).not.toContain('id="publishedDate"');
      expect(schedulingRow).toContain('Target publication date for this release');
      expect(schedulingRow).toContain('Local time this release is scheduled to go live');
      expect(schedulingRow).not.toContain('When this release was published');
    });

    it('renders scheduling picker triggers and non-modal panels without changing native inputs', async () => {
      const projectId = await createTestProject('Date Picker Markup Project');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      const schedulingMatch = res.text.match(/<div class="field-row scheduling-row">[\s\S]*?<\/div>\s*(?=<div class="settings-section">)/);
      expect(schedulingMatch).not.toBeNull();
      const schedulingRow = schedulingMatch[0];

      // Native inputs remain the form source of truth.
      expect(schedulingRow).toMatch(/<input[^>]*type="date"[^>]*id="plannedDate"[^>]*name="plannedDate"[^>]*>/);
      expect(schedulingRow).toMatch(/<input[^>]*type="time"[^>]*id="plannedTime"[^>]*name="plannedTime"[^>]*>/);
      expect(schedulingRow).not.toContain('name="publishedDate"');

      // Each scheduling input gets an external, non-submitting trigger.
      expect(schedulingRow).toMatch(/<button[^>]*aria-controls="plannedDate-calendar"[^>]*>/);
      expect(schedulingRow).toMatch(/<button(?=[^>]*data-time-picker-trigger)(?=[^>]*aria-controls="plannedTime-picker")(?=[^>]*aria-haspopup="dialog")(?=[^>]*aria-label="Open time picker for scheduled time")[^>]*>/);
      expect(schedulingRow).not.toContain('aria-controls="publishedDate-calendar"');
      expect(schedulingRow.match(/<div class="picker-control">/g) || []).toHaveLength(2);
      expect(schedulingRow.match(/<div class="picker-input-row">/g) || []).toHaveLength(2);
      expect(schedulingRow.match(/<input class="picker-input"[^>]*>/g) || []).toHaveLength(2);
      const pickerRows = schedulingRow.match(/<div class="picker-input-row">[\s\S]*?<\/div>/g) || [];
      expect(pickerRows).toHaveLength(2);
      expect(pickerRows.every((row) => /<input class="picker-input"[^>]*>/.test(row)
        && /<button[^>]*class="picker-trigger[^\"]*"[^>]*>/.test(row))).toBe(true);
      const pickerTriggers = schedulingRow.match(/<button[^>]*class="picker-trigger[^"]*"[^>]*>/g) || [];
      expect(pickerTriggers).toHaveLength(2);
      expect(pickerTriggers.every((button) => /\btype="button"/.test(button))).toBe(true);
      expect(schedulingRow).toMatch(/<button[^>]*class="picker-trigger date-picker-trigger"[^>]*aria-controls="plannedDate-calendar"[^>]*>/);
      expect(schedulingRow).toMatch(/<button[^>]*class="picker-trigger time-picker-trigger"[^>]*data-time-picker-trigger[^>]*>/);
      expect(schedulingRow).not.toContain('aria-controls="publishedDate-calendar"');
      expect(schedulingRow).not.toContain('class="date-picker"');
      expect(schedulingRow).not.toContain('class="time-picker"');

      // Each date field gets a distinct panel bound to its input.
      expect(schedulingRow).toMatch(/<div[^>]*id="plannedDate-calendar"[^>]*data-date-picker-panel[^>]*data-date-picker-for="plannedDate"[^>]*>/);
      expect(schedulingRow).not.toContain('data-date-picker-for="publishedDate"');
      expect(schedulingRow).toMatch(/<div[^>]*id="plannedTime-picker"[^>]*class="date-picker-panel time-picker-panel"[^>]*role="dialog"[^>]*aria-label="Scheduled time picker"[^>]*hidden[^>]*data-time-picker-panel[^>]*data-time-picker-for="plannedTime"[^>]*>/);

      // Triggers are associated with a real dialog and initially collapsed.
      expect(schedulingRow).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*>/);

      // Panels are non-modal dialogs that start hidden.
      expect(schedulingRow).toMatch(/<div[^>]*role="dialog"[^>]*aria-label="Scheduled date calendar"[^>]*hidden[^>]*>/);
      expect(schedulingRow).not.toContain('aria-label="Published date calendar"');
      expect(schedulingRow).not.toContain('aria-modal="true"');
    });

    it('passes the saved clock format to create and edit time pickers', async () => {
      const projectId = await createTestProject('Clock Picker Markup Project');
      const release = releaseRepository.create({
        projectId, title: 'Clock Picker Release', description: '', notes: '',
        plannedDate: '2025-06-15', plannedTime: '13:05', patreonUrl: null, publishedDate: null,
      });

      for (const preference of ['12h', '24h']) {
        app.locals.clockFormatSettingsService.setClockFormat(preference);
        for (const path of [`/releases/new?projectId=${projectId}`, '/releases', `/releases/${release.id}`]) {
          const html = (await agent.get(path).expect(200)).text;
          expect(html).toMatch(new RegExp(`<div class="field scheduling-field [^"]*" data-dialog-field="plannedTime" data-time-picker-field data-clock-format="${preference}">`));
          expect(html).toMatch(/<input class="picker-input" type="time" id="plannedTime" name="plannedTime"/);
          if (path === `/releases/${release.id}`) expect(html).toContain('value="13:05"');
        }
      }
    });

    it('release form shows generic release-link help text in the correct field container', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Release+Wording+URL')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      const container = getFieldContainer(res.text, 'patreonUrl');
      expect(container).not.toBeNull();
      expect(container).toContain('<label class="sr-only" for="patreonUrl">Release link</label>');
      expect(container).toContain('Optional absolute HTTP or HTTPS URL for this release.');
      expect(container).toMatch(/<input[^>]*id="patreonUrl"[^>]*>/);
    });

    it('release form exposes generic HTTP(S) validation errors', async () => {
      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Release+Validation+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Invalid+Release+Link')
        .send('status=tbd')
        .send('patreonUrl=ftp%3A%2F%2Fexample.com%2Frelease')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain('Release link must be a valid absolute HTTP or HTTPS URL.');
      expect(res.text).not.toContain('Patreon URL must be a valid https://patreon.com link.');
    });

    it('release detail shows context labels in the correct dt/dd pairs', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Release+Detail+Wording')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Detail+Wording+Release')
        .send('status=tbd')
        .send('plannedDate=2025-12-01')
        .send('patreonUrl=https://patreon.com/release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      await agent.post(releaseLocation)
        .set('Accept', 'application/json')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(loadedReleaseLinkField(releaseLocation))
        .send('title=Detail+Wording+Release')
        .send('plannedDate=2025-12-01')
        .send('publishedDate=2025-12-15')
        .send('patreonUrl=https://patreon.com/release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(200);

      const res = await agent.get(releaseLocation).expect(200);

      // Planned date: <dt>Planned date</dt> ... <small>(release target)</small>
      const plannedDt = res.text.match(/<dt>Planned date<\/dt>\s*<dd>[^<]*(?:<small>\(release target\)<\/small>)[^<]*<\/dd>/);
      expect(plannedDt).not.toBeNull();

      // Published date: <dt>Published date</dt> ... <small>(release published)</small>
      const publishedDt = res.text.match(/<dt>Published date<\/dt>\s*<dd>[^<]*(?:<small>\(release published\)<\/small>)[^<]*<\/dd>/);
      expect(publishedDt).not.toBeNull();

      // Release link: <dt>Release link</dt> ... <small>(release link)</small>
      // Bounded pattern: cannot cross </dd>, <dt>, or opening <dd>
      const releaseLinkDt = res.text.match(/<dt>Release link<\/dt>\s*<dd>(?:(?!<\/dd>)(?!<dt>)(?!<dd>).)*<small>\(release link\)<\/small>(?:(?!<\/dd>)(?!<dt>)(?!<dd>).)*<\/dd>/);
      expect(releaseLinkDt).not.toBeNull();
    });
  });

  // ─── Release list (Phase 2B: moved to /releases) ────────────────

  it('release list renders', async () => {
    const res = await agent.get('/releases').expect(200);
    const resultsSection = extractReleasesResultsSection(res.text);
    const resultsBody = extractReleasesResultsBody(res.text);

    expect(res.text).toContain('Releases');
    expect(res.text).toContain('No releases');
    expect(resultsSection).toMatch(/^<section class="project-detail-section releases-results-section" aria-labelledby="releases-results-heading">\s*<h2 id="releases-results-heading">Release records<\/h2>\s*<div class="project-detail-section-body">/);
    expect(resultsBody).toContain('<p class="results-meta">0 releases found</p>');
    expect(resultsBody).toContain('<div class="empty-state">');
    expect(resultsBody).not.toContain('class="table-scroll releases-table-scroll"');
    expect(resultsBody).not.toContain('aria-label="Release list pages"');
  });

  it('release list shows releases from all projects', async () => {
    // Create a project first
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=List+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Create releases
    const releaseOne = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Release+One')
      .send('status=tbd')
      .send('plannedDate=2026-12-01')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    await agent
      .post(releaseOne.headers.location)
      .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseOne.headers.location))
      .send('title=Release+One')
      .send('publishedDate=2026-12-02')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(200);

    await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Release+Two')
      .send('status=planned')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await agent.get('/releases').expect(200);
    expect(res.text).toContain('Release One');
    expect(res.text).toContain('Release Two');
    const header = res.text.match(/<thead>[\s\S]*?<\/thead>/)?.[0] || '';
    const releaseOneRow = (res.text.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || [])
      .find((row) => row.includes('>Release One</a>')) || '';
    const resultsSection = extractReleasesResultsSection(res.text);
    const resultsBody = extractReleasesResultsBody(res.text);
    expect(header.match(/<th\b/g)).toHaveLength(8);
    expect(releaseOneRow.match(/<td\b/g)).toHaveLength(8);
    expect(header).toContain('<th>Social Posts</th>');
    expect(header).toMatch(/<th>Release status<\/th>\s*<th>Project status<\/th>/);
    expect(releaseOneRow).not.toContain('2026-12-02');
    expect(releaseOneRow).toContain('<span class="status-badge status-badge--success">Published</span>');
    expect(releaseOneRow).toContain(`href="/projects/${projectId}">List Test Project</a>`);
    expect(resultsSection).toMatch(/^<section class="project-detail-section releases-results-section" aria-labelledby="releases-results-heading">\s*<h2 id="releases-results-heading">Release records<\/h2>\s*<div class="project-detail-section-body">/);
    expect(resultsBody).toContain('class="table-scroll refined-table-scroll releases-table-scroll" tabindex="0" aria-label="Release list"');
    expect(resultsBody).toContain('class="data-table refined-table releases-table"');
    expect(resultsBody).toContain('<nav class="pagination" aria-label="Release list pages">');
    expect(resultsSection).not.toContain('releases-filter-dialog');
  });

  it('renders only numeric selected-asset counts while preserving an accessible missing-assets warning', async () => {
    const projectId = insertProjectDirect(db, { title: 'Asset Count Project' });
    const presentAssetIds = [
      insertAssetDirect(db, projectId, 'one.png').id,
      insertAssetDirect(db, projectId, 'two.png').id,
      insertAssetDirect(db, projectId, 'three.png').id,
    ];
    const missingAssetId = insertAssetDirect(db, projectId, 'missing.png', 0).id;
    const releaseInput = (title) => ({
      projectId,
      title,
      description: '',
      notes: '',
      plannedDate: null,
      plannedTime: null,
      patreonUrl: null,
      publishedDate: null,
    });

    releaseRepository.create(releaseInput('Zero Asset Release'));
    releaseRepository.createWithAssetSelections(releaseInput('One Asset Release'), [
      { assetId: presentAssetIds[0], role: 'primary', sortOrder: 0 },
    ]);
    releaseRepository.createWithAssetSelections(releaseInput('Multiple Asset Release'), [
      { assetId: presentAssetIds[1], role: 'primary', sortOrder: 0 },
      { assetId: presentAssetIds[2], role: 'attachment', sortOrder: 1 },
      { assetId: missingAssetId, role: 'attachment', sortOrder: 2 },
    ]);

    const res = await agent.get('/releases').expect(200);
    const header = res.text.match(/<thead>[\s\S]*?<\/thead>/)?.[0] || '';
    const headings = [...header.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
      .map((match) => visibleText(match[1]));
    const zeroCells = extractTableCells(extractReleaseListRow(res.text, 'Zero Asset Release'));
    const oneCells = extractTableCells(extractReleaseListRow(res.text, 'One Asset Release'));
    const multipleCells = extractTableCells(extractReleaseListRow(res.text, 'Multiple Asset Release'));

    expect(headings).toEqual(['Release Title', 'Project', 'Release status', 'Project status', 'Planned', 'Social Posts', 'Assets', '']);
    expect(headings.filter((heading) => heading === 'Assets')).toHaveLength(1);
    expect(zeroCells).toHaveLength(8);
    expect(oneCells).toHaveLength(8);
    expect(multipleCells).toHaveLength(8);
    expect(visibleText(zeroCells[2])).toBe('—');
    expect(visibleText(zeroCells[6])).toBe('0');
    expect(visibleText(oneCells[6])).toBe('1');
    expect(visibleText(oneCells[6])).not.toMatch(/\bassets?\b/i);
    expect(visibleText(multipleCells[6])).toBe('3 ⚠');
    expect(visibleText(multipleCells[6])).not.toMatch(/\bassets?\b/i);
    expect(multipleCells[6]).toMatch(/<span class="missing-indicator"\s+title="1 missing asset"\s+aria-label="1 missing asset">⚠<\/span>/);
  });

  it('renders release publication status separately from project and archive status', async () => {
    const projectId = insertProjectDirect(db, { title: 'Release Status Project' });
    const releaseInput = (title, publishedDate = null) => ({
      projectId,
      title,
      description: '',
      notes: '',
      plannedDate: null,
      plannedTime: null,
      patreonUrl: null,
      publishedDate,
    });
    releaseRepository.create(releaseInput('Unpublished Status Release'));
    const archivedPublished = releaseRepository.create(
      releaseInput('Archived Published Status Release', '2026-12-02'),
    );
    releaseRepository.archive(archivedPublished.id);

    const res = await agent.get('/releases?includeArchived=1').expect(200);
    const unpublishedCells = extractTableCells(
      extractReleaseListRow(res.text, 'Unpublished Status Release'),
    );
    const archivedCells = extractTableCells(
      extractReleaseListRow(res.text, 'Archived Published Status Release'),
    );

    expect(visibleText(unpublishedCells[2])).toBe('—');
    expect(archivedCells[2]).toContain(
      '<span class="status-badge status-badge--success">Published</span>',
    );
    expect(archivedCells[3]).toContain(
      '<span class="status-badge status-badge--neutral">Tbd</span>',
    );
    expect(archivedCells[7]).toContain(
      '<span class="status-badge status-badge--archived">Archived</span>',
    );
  });

  it('uses the saved clock format for scheduled list times and leaves missing times absent', async () => {
    const projectId = insertProjectDirect(db, { title: 'Clock List Project' });
    const input = (title, plannedTime) => ({
      projectId, title, description: '', notes: '', plannedDate: '2025-06-15',
      plannedTime, patreonUrl: null, publishedDate: null,
    });
    const timed = releaseRepository.create(input('Timed List Release', '13:05'));
    releaseRepository.create(input('Untimed List Release', null));

    for (const [preference, visible] of [['12h', '1:05 PM'], ['24h', '13:05']]) {
      app.locals.clockFormatSettingsService.setClockFormat(preference);
      const html = (await agent.get('/releases').expect(200)).text;
      expect(visibleText(extractTableCells(extractReleaseListRow(html, 'Timed List Release'))[4]))
        .toBe(`2025-06-15 ${visible}`);
      expect(visibleText(extractTableCells(extractReleaseListRow(html, 'Untimed List Release'))[4]))
        .toBe('2025-06-15');
      expect(releaseRepository.findById(timed.id).planned_time).toBe('13:05');
    }
  });

  it('formats release detail metadata while leaving date-only fields and stored values intact', async () => {
    const projectId = insertProjectDirect(db, { title: 'Timestamp Detail Project' });
    const release = releaseRepository.create({
      projectId, title: 'Timestamp Detail Release', description: '', notes: '',
      plannedDate: '2025-06-20', plannedTime: null, patreonUrl: null,
      publishedDate: '2025-06-21',
    });
    db.prepare('UPDATE releases SET created_at = ?, updated_at = ?, archived_at = ? WHERE id = ?')
      .run('2025-06-15 13:05:09', '2025-06-16 14:06:10', '2025-06-17 15:07:11', release.id);

    for (const [preference, created, updated, archived] of [
      ['12h', '1:05:09 PM', '2:06:10 PM', '3:07:11 PM'],
      ['24h', '13:05:09', '14:06:10', '15:07:11'],
    ]) {
      app.locals.clockFormatSettingsService.setClockFormat(preference);
      const html = (await agent.get(`/releases/${release.id}`).expect(200)).text;
      const details = html.match(/<dl class="detail-list release-detail-list">[\s\S]*?<\/dl>/)?.[0] || '';
      expect(details).toContain(`<dd>2025-06-15 ${created}</dd>`);
      expect(details).toContain(`<dd>2025-06-16 ${updated}</dd>`);
      expect(details).toContain(`<dd>2025-06-17 ${archived}</dd>`);
      expect(details).toContain('2025-06-20 <small>(release target)</small>');
      expect(details).toContain('2025-06-21 <small>(release published)</small>');
    }

    expect(db.prepare('SELECT created_at, updated_at, archived_at, planned_date, published_date FROM releases WHERE id = ?').get(release.id))
      .toEqual({ created_at: '2025-06-15 13:05:09', updated_at: '2025-06-16 14:06:10', archived_at: '2025-06-17 15:07:11', planned_date: '2025-06-20', published_date: '2025-06-21' });
  });

  it('release list ignores obsolete status filters without mapping them to project status', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Filter+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Idea+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const plannedRelease = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Planned+Release')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    setProjectStatusForReleaseTest(db, plannedRelease.headers.location, 'planned');

    const res = await agent.get('/releases?status=tbd').expect(200);
    expect(res.text).toContain('Idea Release');
    expect(res.text).toContain('Planned Release');
  });

  it('renders All as the default Schedule dropdown summary', async () => {
    const res = await agent.get('/releases').expect(200);

    expect(res.text).toMatch(/id="list-schedule-trigger"[^>]*aria-label="Schedule filter: All"[^>]*title="All"/);
    expect(res.text).toMatch(/id="list-schedule-trigger"[\s\S]*?<span data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">All<\/span>/);
  });

  it('renders exactly one selectable Schedule All option and clears an active Schedule filter', async () => {
    const defaultRes = await agent.get('/releases').expect(200);
    const defaultSchedule = defaultRes.text.match(/<fieldset[^>]*>[\s\S]*?<details[^>]*id="list-schedule"[^>]*>[\s\S]*?<\/fieldset>/)?.[0] || '';
    const allOptions = defaultSchedule.match(/<input[^>]*name="schedule"[^>]*value=""[^>]*>/g) || [];

    expect(allOptions).toHaveLength(1);
    expect(allOptions[0]).toContain('checked');

    const filteredRes = await agent.get('/releases?schedule=today').expect(200);
    const filteredSchedule = filteredRes.text.match(/<fieldset[^>]*>[\s\S]*?<details[^>]*id="list-schedule"[^>]*>[\s\S]*?<\/fieldset>/)?.[0] || '';
    expect(filteredSchedule).toContain('name="schedule" type="radio" value=""');
    expect(filteredSchedule).not.toMatch(/name="schedule"[^>]*value=""[^>]*checked/);
  });

  it('includes archived Releases only when includeArchived=1 and renders its checked state', async () => {
    const projectId = await createTestProject('Archived Releases Filter Project');
    const activeRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Visible Active Release')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const archivedRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Visible Archived Release')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    releaseRepository.archive(Number(archivedRes.headers.location.replace('/releases/', '')));

    const normal = await agent.get('/releases').expect(200);
    expect(normal.text).toContain('Visible Active Release');
    expect(normal.text).not.toContain('Visible Archived Release');
    expect(normal.text).not.toMatch(/id="list-includeArchived"[^>]*checked/);

    const archived = await agent.get('/releases?includeArchived=1').expect(200);
    expect(archived.text).toContain('Visible Active Release');
    expect(archived.text).toContain('Visible Archived Release');
    expect(archived.text).toMatch(/id="list-includeArchived"[^>]*checked/);

    const unarchived = await agent.get('/releases').expect(200);
    expect(unarchived.text).not.toContain('Visible Archived Release');
  });

  it('builds Reset Filters as the canonical Releases URL without explicit filter overrides', async () => {
    const res = await agent.get('/releases?search=needle&project=1&schedule=today&sort=title&order=desc&includeArchived=1&page=4&pageSize=50').expect(200);
    const filterDialog = res.text.match(/<dialog id="releases-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    // WP12: the controller's GET destination is the installed page's
    // authority; the native GET fallback form carries the URL page size as a
    // hidden field (a GET form's action query string would be replaced).
    const resetUrl = releasesDefaultsAuthority(res.text)?.resetFiltersUrl;
    const resetForm = filterDialog.match(/<form class="releases-filter-reset filters-defaults-reset-form" method="get" action="([^"]+)">([\s\S]*?)<\/form>/);

    expect(resetUrl).toBe('/releases?pageSize=50');
    expect(resetForm?.[1]).toBe('/releases');
    expect(resetForm?.[2]).toContain('<input type="hidden" name="pageSize" value="50">');
    expect(resetForm?.[2]).toContain('<button class="button button-primary" type="submit" data-releases-filters-reset>Reset filters</button>');
    expect(filterDialog).not.toContain('form.reset');

    const reset = await agent.get(resetUrl).expect(200);
    expect(reset.text).toMatch(/<input id="releases-search" name="search" type="search" value=""/);
    expect(reset.text).not.toMatch(/id="list-includeArchived"[^>]*checked/);
    expect(reset.text).toMatch(/id="list-schedule-trigger"[^>]*title="All"/);
    expect(reset.text).toContain('<input type="hidden" name="pageSize" value="50">');
  });

  // WP11/WP12: an unknown Project ID stays a restriction (it matches nothing),
  // so the combined dialog never claims "All projects" for it: it shows a
  // checked unavailable choice the user can clear, which survives the next
  // filter change instead of silently broadening the results.
  it('keeps a nonexistent selected Project as a checked unavailable restriction', async () => {
    const res = await agent.get('/releases?project=999999').expect(200);
    const projectField = extractReleaseFilterProjectField(res.text);

    expect(projectField).toContain('aria-label="Projects filter: Unavailable project (ID 999999)"');
    expect(projectField).toContain('data-cc-dropdown-summary-current class="asset-filter-multiselect-summary-current">Unavailable project (ID 999999)</span>');
    expect(projectField).toMatch(/name="project" type="checkbox" value="999999"[^>]*checked[^>]*data-releases-unavailable-project/);
    expect(checkedValues(projectField, 'project')).toEqual(['999999']);
    expect(res.text).toContain('0 releases found');
  });

  it('renders an active selected Project as the checked filter option', async () => {
    const activeProjectId = await createTestProject('Active selected project');
    const res = await agent.get(`/releases?project=${activeProjectId}`).expect(200);
    const projectField = extractReleaseFilterProjectField(res.text);

    expect(projectField).toMatch(new RegExp(`name="project" type="checkbox" value="${activeProjectId}"[^>]*checked`));
    expect(projectField).toContain('>Active selected project</span>');
    expect(projectField).toContain('aria-label="Projects filter: Active selected project"');
    expect(checkedValues(projectField, 'project')).toEqual([String(activeProjectId)]);
  });

  it('renders only the archived selected Project as a checked, submittable filter option', async () => {
    const archivedProjectId = insertProjectDirect(db, {
      title: 'Archived selected project',
      status: 'archived',
      archivedAt: '2024-01-01 00:00:00',
    });
    const otherArchivedProjectId = insertProjectDirect(db, {
      title: 'Other archived project',
      status: 'archived',
      archivedAt: '2024-01-02 00:00:00',
    });

    const res = await agent.get(`/releases?project=${archivedProjectId}&schedule=today`).expect(200);
    const projectField = extractReleaseFilterProjectField(res.text);

    expect(projectField).toMatch(new RegExp(`name="project" type="checkbox" value="${archivedProjectId}"[^>]*checked`));
    expect(projectField).toContain('>Archived selected project</span>');
    expect(projectField).toContain('aria-label="Projects filter: Archived selected project"');
    expect(checkedValues(projectField, 'project')).toEqual([String(archivedProjectId)]);
    expect(projectField).not.toContain(`value="${otherArchivedProjectId}"`);
    expect(projectField).not.toContain('Other archived project');
  });

  // WP12: Search is now a visible results control of the combined dialog; the
  // zero-result state keeps its recovery Reset.
  it('uses the filtered empty state for a zero-result search, shows it in the dialog Search and retains its recovery Reset', async () => {
    const projectId = await createTestProject('Legacy search project');
    await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Visible release')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await agent.get('/releases?search=no-match').expect(200);

    expect(res.text).toContain('No releases match the current filters');
    expect(res.text).toContain('Reset Filters');
    expect(res.text).toContain('data-releases-reset');
    expect(res.text).not.toContain('No releases yet');
    expect(res.text.match(/<input[^>]*name="search"[^>]*>/g)).toEqual([
      '<input id="releases-search" name="search" type="search" value="no-match" autocomplete="off" data-releases-search>',
    ]);
  });

  // ─── Create release ────────────────────────────────────────────────────────

  it('new-release form renders with project selection', async () => {
    // Create a project first
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=New+Release+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const res = await agent.get('/releases/new').expect(200);
    expect(res.text).toContain('Create Release');
    expect(res.text).toContain('New Release Test');
    expect(res.text).toMatch(/id="plannedDate"[^>]*value="\d{4}-\d{2}-\d{2}"/);
    expect(res.text).toMatch(/id="plannedTime"[^>]*value="\d{2}:\d{2}"/);
    expect(res.text).not.toContain('id="status"');

    const projectField = extractReleaseProjectField(res.text);
    expect(projectField).not.toBe('');
    expect(projectField).toContain('asset-filter-multiselect');
    expect(projectField).toContain('<legend class="sr-only">Project <span class="required" aria-label="required">*</span></legend>');
    expect(projectField).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(projectField).toContain('data-cc-dropdown-searchable');
    expect(projectField).toContain('data-cc-dropdown-type="searchable-single"');
    expect(projectField).toContain('asset-project-filter-disclosure');
    expect(projectField).not.toContain('data-asset-project-filter');
    expect(projectField).toContain('data-cc-dropdown-search');
    expect(projectField).toContain('data-cc-dropdown-option-list');
    expect(projectField).toContain('data-cc-dropdown-no-results');
    expect(projectField).toContain('id="release-project-filter-trigger" aria-controls="release-project-filter-options"');
    expect(projectField).toContain('id="release-project-filter-search"');
    expect(projectField).not.toMatch(/id="release-project-filter-search"[^>]*\bname=/);
    expect(projectField).toContain('role="radiogroup"');
    expect(projectField).toContain('name="projectId"');
    expect(projectField).toContain(`value="${projectId}"`);
    expect(projectField).toContain('>New Release Test</span>');
    expect(projectField).toContain('Select a project');
    expect(projectField).not.toMatch(/<summary[^>]*aria-describedby="projectId-error"/);
    expect(projectField).not.toMatch(/<summary[^>]*aria-invalid="true"/);
    expect(projectField).not.toContain('<select');
    expect(projectField).not.toMatch(/name="projectId"[^>]*value=""/);
    expect(projectField).not.toContain('All projects');
    expect(releaseProjectRadioInputs(res.text)).toHaveLength(1);
    expect(releaseProjectRadioInputs(res.text).every((radio) => /\brequired\b/.test(radio))).toBe(true);
    expect(selectedProjectRadioValue(res.text)).toBeUndefined();

    const css = (await agent.get('/creatorcrate.css').expect(200)).text;
    expect(css).toMatch(/\.project-form\s*>\s*\.release-project-section\s*\{[^}]*overflow:\s*visible/);
    expect(css).toMatch(/\.asset-viewer-project-filter\s+\.asset-project-filter-option-list\s*\{[\s\S]*?scrollbar-color:\s*var\(--border-strong\)\s+transparent/);
    expect(css).not.toContain('#release-project-filter .asset-project-filter-option-list');
  });

  describe('Edit Release JSON transport', () => {
    let projectCount;

    beforeEach(() => {
      projectCount = 0;
    });

    async function createEditableRelease(fields = {}) {
      projectCount += 1;
      const projectId = await createTestProject(projectCount === 1 ? 'Edit Transport Project' : `Edit Transport Project ${projectCount}`);
      const created = await agent.post('/releases').type('form')
        .send({ _csrf: csrfToken, projectId, title: 'Transport Release', ...fields })
        .expect(302);
      return { projectId, releaseId: Number(created.headers.location.split('/').at(-1)) };
    }

    function getEditModel(releaseId) {
      return agent.get(`/releases/${releaseId}/edit`).set('Accept', 'application/json');
    }

    function postEdit(releaseId, fields) {
      return agent.post(`/releases/${releaseId}`).set('Accept', 'application/json').type('form')
        .send({ _csrf: csrfToken, expectedPatreonUrl: loadedReleaseLink(releaseId), ...fields });
    }

    function selectedPlatforms(releaseId) {
      return app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId)
        .filter((row) => row.is_selected === 1).map((row) => row.platform);
    }

    it('loads the authoritative editable model, keeping saved unconfigured platforms, without applying the default signature', async () => {
      app.locals.socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
      const signatures = app.locals.releaseSignatureSettingsService;
      signatures.setDefault(signatures.add({ name: 'Default', body: 'Default signature body' }).entries[0].id);
      const { projectId, releaseId } = await createEditableRelease({
        plannedDate: '2031-05-06', plannedTime: '09:30', patreonUrl: 'https://example.com/r',
        selectedPlatformsPresent: '1', selectedPlatforms: 'x',
      });
      app.locals.socialPrepSettingsService.setPlatforms(['bluesky']);

      const res = await getEditModel(releaseId).expect(200).expect('Content-Type', /json/);
      expect(res.headers.vary).toMatch(/Accept/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        status: 'success',
        release: {
          id: releaseId,
          projectId,
          projectTitle: 'Edit Transport Project',
          title: 'Transport Release',
          plannedDate: '2031-05-06',
          plannedTime: '09:30',
          publishedDate: null,
          published: false,
          updatedAt: expect.any(String),
        },
        values: {
          title: 'Transport Release',
          description: '',
          notes: '',
          plannedDate: '2031-05-06',
          plannedTime: '09:30',
          publishedDate: '',
          patreonUrl: 'https://example.com/r',
          selectedPlatforms: ['x'],
        },
        platformOptions: [
          { value: 'x', label: 'X', configured: false },
          { value: 'bluesky', label: 'Bluesky', configured: true },
        ],
        unconfiguredSelectedPlatforms: ['x'],
        eligibility: { editable: true, archivable: true, deletable: true },
        actions: {
          update: `/releases/${releaseId}`,
          detail: `/releases/${releaseId}`,
          archive: `/releases/${releaseId}/archive`,
          delete: `/releases/${releaseId}/delete`,
        },
      });

      // Bookmarked /edit links redirect to the canonical Release Detail deep link.
      const html = await agent.get(`/releases/${releaseId}/edit`).expect(302);
      expect(html.headers.location).toBe(`/releases/${releaseId}?edit=1`);
    });

    it('reports published state and withholds the archive action for published releases', async () => {
      const { releaseId } = await createEditableRelease();
      db.prepare("UPDATE releases SET published_date = '2030-01-02' WHERE id = ?").run(releaseId);

      const res = await getEditModel(releaseId).expect(200);
      expect(res.body.release).toMatchObject({ published: true, publishedDate: '2030-01-02' });
      expect(res.body.values.publishedDate).toBe('2030-01-02');
      expect(res.body.eligibility).toEqual({ editable: true, archivable: false, deletable: true });
      expect(res.body.actions.archive).toBeNull();
    });

    it('returns JSON errors for missing, archived, and archived-project releases on load and save', async () => {
      for (const missing of ['999999', 'not-a-number']) {
        const load = await agent.get(`/releases/${missing}/edit`).set('Accept', 'application/json').expect(404);
        expect(load.body).toEqual({ status: 'error', code: 'RELEASE_NOT_FOUND', message: 'Release not found.' });
        const save = await postEdit(missing, { title: 'Nope' }).expect(404);
        expect(save.body.code).toBe('RELEASE_NOT_FOUND');
      }

      const archived = await createEditableRelease();
      db.prepare('UPDATE releases SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(archived.releaseId);
      expect((await getEditModel(archived.releaseId).expect(409)).body)
        .toMatchObject({ status: 'error', code: 'RELEASE_ARCHIVED' });
      const archivedSave = await postEdit(archived.releaseId, { title: 'Changed' }).expect(422);
      expect(archivedSave.body).toMatchObject({ status: 'error', code: 'RELEASE_ARCHIVED', errors: { general: expect.any(String) } });
      expect(releaseRepository.findById(archived.releaseId).title).toBe('Transport Release');

      const parentArchived = await createEditableRelease();
      db.prepare("UPDATE projects SET status = 'archived', archived_at = NULL WHERE id = ?").run(parentArchived.projectId);
      expect((await getEditModel(parentArchived.releaseId).expect(409)).body)
        .toMatchObject({ status: 'error', code: 'PROJECT_ARCHIVED' });
      expect((await postEdit(parentArchived.releaseId, { title: 'Changed' }).expect(422)).body.code)
        .toBe('PROJECT_ARCHIVED');
      expect(releaseRepository.findById(parentArchived.releaseId).title).toBe('Transport Release');
    });

    it('saves through the existing update path and returns the authoritative saved model without navigating', async () => {
      app.locals.socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
      const { releaseId } = await createEditableRelease();

      const res = await postEdit(releaseId, {
        returnTo: '/calendar',
        title: '  Saved Title  ',
        description: 'Body',
        notes: 'Notes',
        plannedDate: '2031-07-08',
        plannedTime: '18:45',
        patreonUrl: '',
        selectedPlatformsPresent: '1',
        selectedPlatforms: ['bluesky', 'x'],
      }).expect(200);

      const stored = releaseRepository.findById(releaseId);
      expect(res.body).toMatchObject({
        status: 'success',
        message: 'Release updated.',
        release: { id: releaseId, title: stored.title, plannedDate: '2031-07-08', plannedTime: '18:45' },
        values: {
          title: stored.title,
          description: 'Body',
          notes: 'Notes',
          plannedDate: '2031-07-08',
          plannedTime: '18:45',
          patreonUrl: '',
          selectedPlatforms: ['bluesky', 'x'],
        },
      });
      expect(res.headers.location).toBeUndefined();
      expect(selectedPlatforms(releaseId)).toEqual(['bluesky', 'x']);
    });

    it('returns structured field errors with the submitted draft and leaves the release unchanged', async () => {
      app.locals.socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
      const { releaseId } = await createEditableRelease({ selectedPlatformsPresent: '1', selectedPlatforms: 'x' });

      const invalid = await postEdit(releaseId, {
        title: '', notes: 'Draft notes', patreonUrl: 'not a url', selectedPlatformsPresent: '1', selectedPlatforms: ['bluesky'],
      }).expect(422);
      expect(invalid.body).toMatchObject({
        status: 'error',
        code: 'VALIDATION_FAILED',
        message: 'Fix the highlighted fields and try again.',
        errors: { title: expect.any(String), patreonUrl: expect.any(String) },
        values: { title: '', notes: 'Draft notes', patreonUrl: 'not a url', selectedPlatforms: ['bluesky'] },
      });
      // Fields the request did not carry are not reported as blank.
      expect(invalid.body.values).not.toHaveProperty('description');
      expect(releaseRepository.findById(releaseId).title).toBe('Transport Release');
      expect(selectedPlatforms(releaseId)).toEqual(['x']);

      const badPlatform = await postEdit(releaseId, {
        title: 'Valid', selectedPlatformsPresent: '1', selectedPlatforms: ['bluesky', 'invalid'],
      }).expect(422);
      expect(badPlatform.body.errors).toEqual({ selectedPlatforms: 'Select valid configured platforms.' });
      expect(badPlatform.body.values.selectedPlatforms).toEqual(['bluesky', 'invalid']);
      expect(releaseRepository.findById(releaseId).title).toBe('Transport Release');
    });

    it('rejects deselecting a platform under active preparation atomically and echoes the draft selection', async () => {
      app.locals.socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
      const { releaseId } = await createEditableRelease({ selectedPlatformsPresent: '1', selectedPlatforms: ['x', 'bluesky'] });
      const platformRepository = app.locals.socialPrepRepository;
      platformRepository.insertSession({ id: 'json-active-edit', releaseId, kind: 'initial', expiresAt: new Date('2030-01-01') });
      platformRepository.reassignPlatformsToSession('json-active-edit', ['x']);

      const blocked = await postEdit(releaseId, {
        title: 'Blocked Title', selectedPlatformsPresent: '1', selectedPlatforms: 'bluesky',
      }).expect(422);
      expect(blocked.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: { selectedPlatforms: 'Cannot deselect a platform while its preparation session is active.' },
        values: { title: 'Blocked Title', selectedPlatforms: ['bluesky'] },
      });
      expect(releaseRepository.findById(releaseId).title).toBe('Transport Release');
      expect(selectedPlatforms(releaseId)).toEqual(['bluesky', 'x']);
    });

    it('preserves a saved unconfigured platform on save and when the platform group is omitted', async () => {
      app.locals.socialPrepSettingsService.setPlatforms(['x']);
      const { releaseId } = await createEditableRelease({ selectedPlatformsPresent: '1', selectedPlatforms: 'x' });
      app.locals.socialPrepSettingsService.setPlatforms(['bluesky']);

      const kept = await postEdit(releaseId, { title: 'Kept', selectedPlatformsPresent: '1', selectedPlatforms: 'x' }).expect(200);
      expect(kept.body.values.selectedPlatforms).toEqual(['x']);
      expect(kept.body.unconfiguredSelectedPlatforms).toEqual(['x']);

      const omitted = await postEdit(releaseId, { title: '' }).expect(422);
      expect(omitted.body.values.selectedPlatforms).toEqual(['x']);
      await postEdit(releaseId, { title: 'Omitted' }).expect(200);
      expect(selectedPlatforms(releaseId)).toEqual(['x']);
    });

    it('distinguishes server failures from validation failures', async () => {
      const { releaseId } = await createEditableRelease();
      db.exec("CREATE TRIGGER fail_release_update BEFORE UPDATE ON releases BEGIN SELECT RAISE(ABORT, 'forced failure'); END;");

      const res = await postEdit(releaseId, { title: 'Will fail' }).expect(500);
      expect(res.body).toEqual({ status: 'error', code: 'SERVER_ERROR', message: 'Release update failed. Please try again.' });
    });

    it('requires a valid CSRF token for JSON saves', async () => {
      const { releaseId } = await createEditableRelease();

      const res = await agent.post(`/releases/${releaseId}`).set('Accept', 'application/json').type('form')
        .send({ title: 'No token' }).expect(403);
      expect(res.body).toEqual({ status: 'error', message: 'Invalid or missing CSRF token.' });
      const forged = await agent.post(`/releases/${releaseId}`).set('Accept', 'application/json').type('form')
        .send({ _csrf: 'forged', title: 'Forged token' }).expect(403);
      expect(forged.body.status).toBe('error');
      expect(releaseRepository.findById(releaseId).title).toBe('Transport Release');
    });

    it('refuses HTML form submissions before updating, redirecting or re-rendering an Edit dialog', async () => {
      const { releaseId } = await createEditableRelease();

      for (const fields of [
        { title: 'HTML Save', returnTo: '/calendar?month=2031-07' },
        { title: '' },
        { title: 'Platform change', selectedPlatformsPresent: '1', selectedPlatforms: 'x' },
      ]) {
        for (const accept of [null, 'text/html']) {
          const request = agent.post(`/releases/${releaseId}`).type('form');
          if (accept) request.set('Accept', accept);
          const res = await request.send({ _csrf: csrfToken, ...fields }).expect(406);
          expect(res.headers.location).toBeUndefined();
          expect(res.text).not.toContain('<form id="release-edit-form"');
          expect(res.text).not.toContain('<dialog id="release-edit-dialog"');
        }
      }
      expect(releaseRepository.findById(releaseId).title).toBe('Transport Release');
      expect(selectedPlatforms(releaseId)).toEqual([]);

      // The JSON save ignores a submitted returnTo and never redirects.
      const saved = await postEdit(releaseId, { title: 'JSON Save', returnTo: '/calendar?month=2031-07' }).expect(200);
      expect(saved.headers.location).toBeUndefined();
      expect(saved.body).toMatchObject({ status: 'success', release: { id: releaseId, title: 'JSON Save' } });
      expect(saved.body).not.toHaveProperty('returnTo');
    });

    it('renders the detail-hosted Edit dialog as the shared async dialog with field, error and message hooks in place', async () => {
      const { releaseId } = await createEditableRelease();
      const res = await agent.get(`/releases/${releaseId}?edit=1`).expect(200);
      const dialog = res.text.match(/<dialog id="release-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      // The deep link renders the dialog closed and marked for the async
      // controller, which loads and opens the release through JSON.
      expect(dialog).toContain(`data-dialog-async="true" data-release-edit-deep-link="${releaseId}"`);
      expect(dialog).not.toMatch(/<dialog id="release-edit-dialog"[^>]*open/);
      expect(dialog).toContain('data-dialog-pending-message="Saving release…"');
      expect(dialog).toContain('data-dialog-success-message="Release updated."');
      expect(dialog).toContain('data-dialog-error-message="Release could not be saved."');
      expect(dialog).toMatch(/<div class="error-summary" role="alert" data-dialog-error hidden><p data-dialog-error-text><\/p><\/div>/);
      for (const name of ['title', 'description', 'notes', 'plannedDate', 'plannedTime', 'publishedDate', 'patreonUrl', 'selectedPlatforms']) {
        expect(dialog).toContain(`data-dialog-field="${name}"`);
      }
      expect(dialog).toContain('data-dialog-error-ref="selectedPlatforms-error"');
      expect(dialog).toContain('id="release-description-signature"');
      expect(dialog).toContain('id="release-platforms"');
      expect(dialog).toMatch(/<button[^>]*type="submit" form="release-edit-form" data-dialog-submit>/);
      expect(dialog).not.toContain('data-release-create-fresh');
    });
  });

  describe('New Release dialog', () => {
    // The ordinary dialog posts with Accept: application/json and stays on
    // its host page; the server stays authoritative for every field.
    function postReleaseJson(fields) {
      return agent.post('/releases')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send({ _csrf: csrfToken, returnTo: '/releases?sort=title', selectedPlatformsPresent: '1', ...fields });
    }

    function releaseCount() {
      return db.prepare('SELECT COUNT(*) AS count FROM releases').get().count;
    }

    it('creates exactly one release as JSON with a View Release URL and fresh defaults', async () => {
      app.locals.socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
      const projectId = await createTestProject('Dialog JSON Project');
      const res = await postReleaseJson({
        projectId: String(projectId), title: 'Dialog Created', description: 'Body', notes: 'Notes',
        plannedDate: '2027-05-06', plannedTime: '09:30', patreonUrl: 'https://example.com/post',
        selectedPlatforms: ['x', 'bluesky'],
      }).expect(201);

      expect(res.headers.location).toBeUndefined();
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const rows = db.prepare('SELECT id, project_id, title, planned_date, planned_time, patreon_url FROM releases').all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        project_id: projectId, title: 'Dialog Created', planned_date: '2027-05-06', planned_time: '09:30',
        patreon_url: 'https://example.com/post',
      });
      expect(res.body).toEqual({
        status: 'success',
        message: 'Release “Dialog Created” created.',
        release: { id: rows[0].id, projectId, title: 'Dialog Created', url: `/releases/${rows[0].id}` },
        values: { projectId: '', title: '', notes: '', selectedPlatforms: [], patreonUrl: '' },
      });
      expect(app.locals.socialPrepRepository.listPlatformsByReleaseId(rows[0].id)
        .filter((row) => row.is_selected === 1).map((row) => row.platform).sort()).toEqual(['bluesky', 'x']);
    });

    it('creates an unscheduled release when No set release date wins over stale schedule fields', async () => {
      const projectId = await createTestProject('Dialog Undated Project');
      const res = await postReleaseJson({
        projectId: String(projectId), title: 'Dialog Undated', noSetReleaseDate: '1',
        retainedPlannedDate: '2027-01-02', retainedPlannedTime: '10:00', plannedDate: 'not-a-date',
      }).expect(201);

      const row = db.prepare('SELECT planned_date, planned_time FROM releases WHERE id = ?').get(res.body.release.id);
      expect(row).toEqual({ planned_date: null, planned_time: null });
    });

    it('refuses invalid input with field errors, keeps nothing and echoes no values', async () => {
      const projectId = await createTestProject('Dialog Invalid Project');
      const res = await postReleaseJson({
        projectId: String(projectId), title: '', plannedDate: '2027-02-31', patreonUrl: 'ftp://example.com',
      }).expect(422);

      expect(res.headers.location).toBeUndefined();
      expect(res.body.status).toBe('error');
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.message).toBe('Fix the highlighted fields and try again.');
      expect(Object.keys(res.body.errors)).toEqual(expect.arrayContaining(['title']));
      expect(res.body.values).toBeUndefined();
      expect(releaseCount()).toBe(0);
    });

    it('refuses a missing, archived or nonexistent project on the server', async () => {
      const archived = await createTestProject('Dialog Archived Project');
      db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(archived);

      for (const projectId of ['', String(archived), '999999']) {
        const res = await postReleaseJson({ projectId, title: 'Refused' }).expect(422);
        expect(res.body.errors.projectId).toEqual(expect.any(String));
      }
      expect(releaseCount()).toBe(0);
    });

    it('reports a failed write without internal details or a success payload', async () => {
      const projectId = await createTestProject('Dialog Failure Project');
      db.exec(`CREATE TRIGGER reject_release_insert BEFORE INSERT ON releases
        BEGIN SELECT RAISE(ABORT, 'internal sqlite detail'); END;`);
      const res = await postReleaseJson({ projectId: String(projectId), title: 'Never Saved' }).expect(500);

      expect(res.body).toEqual({
        status: 'error', code: 'SERVER_ERROR', message: 'Release creation failed. Please try again.', errors: {},
      });
      expect(res.text).not.toContain('internal sqlite detail');
      db.exec('DROP TRIGGER reject_release_insert');
      expect(releaseCount()).toBe(0);
    });

    it('keeps the standalone form redirect and rerender for HTML posts', async () => {
      const projectId = await createTestProject('Standalone Project');
      const created = await agent.post('/releases')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send({ _csrf: csrfToken, projectId: String(projectId), title: 'Standalone Release' })
        .expect(302);
      expect(created.headers.location).toMatch(/^\/releases\/\d+$/);

      const refused = await agent.post('/releases')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send({ _csrf: csrfToken, projectId: String(projectId), title: '' })
        .expect(422);
      expect(refused.headers['content-type']).toMatch(/text\/html/);
      expect(refused.text).toContain('<form id="release-form"');
      expect(releaseCount()).toBe(1);
    });

    it('keeps a saved unconfigured platform available only in its Edit dialog', async () => {
      app.locals.socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
      const projectId = await createTestProject('Legacy Platform Project');
      const created = await agent.post('/releases')
        .send({ _csrf: csrfToken, projectId, title: 'Legacy Release', selectedPlatformsPresent: '1', selectedPlatforms: 'x' })
        .set('Content-Type', 'application/x-www-form-urlencoded').expect(302);
      const releaseId = Number(created.headers.location.split('/').at(-1));
      app.locals.socialPrepSettingsService.setPlatforms(['bluesky']);

      const edit = await agent.get(`/releases/${releaseId}?edit=1`).expect(200);
      const editForm = edit.text.match(/<form id="release-edit-form"[\s\S]*?<\/form>/)?.[0] || '';
      expect(editForm).toMatch(/name="selectedPlatforms"[^>]*value="x"[^>]*checked/);
      const newPage = await agent.get('/releases').expect(200);
      const newForm = newPage.text.match(/<form id="release-create-form"[\s\S]*?<\/form>/)?.[0] || '';
      expect(newForm).not.toMatch(/name="selectedPlatforms"[^>]*value="x"/);

      const saveEdit = (fields) => agent.post(`/releases/${releaseId}`).set('Accept', 'application/json')
        .type('form').send({ _csrf: csrfToken, expectedPatreonUrl: loadedReleaseLink(releaseId), ...fields });
      const invalid = await saveEdit({ title: '', selectedPlatformsPresent: '1', selectedPlatforms: 'x' }).expect(422);
      expect(invalid.body.values.selectedPlatforms).toEqual(['x']);

      const edited = await saveEdit({ title: 'Edited Legacy Release', selectedPlatformsPresent: '1', selectedPlatforms: 'x' }).expect(200);
      expect(edited.body.platformOptions).toContainEqual(expect.objectContaining({ value: 'x', configured: false }));
      const platformRepository = app.locals.socialPrepRepository;
      expect(platformRepository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x').is_selected).toBe(1);

      platformRepository.insertSession({
        id: 'active-legacy-platform-edit', releaseId, kind: 'initial', expiresAt: new Date('2030-01-01'),
      });
      platformRepository.reassignPlatformsToSession('active-legacy-platform-edit', ['x']);
      const blocked = await saveEdit({ title: 'Blocked Legacy Edit', selectedPlatformsPresent: '1' }).expect(422);
      expect(blocked.body).toMatchObject({ code: 'VALIDATION_FAILED', values: { title: 'Blocked Legacy Edit', selectedPlatforms: [] } });
      expect(blocked.body.errors.selectedPlatforms).toBeTruthy();
      // The binder reports the error inside the Platforms field group, so the release link keeps its grid cell.
      const blockedForm = (await agent.get(`/releases/${releaseId}`).expect(200)).text
        .match(/<form id="release-edit-form"[\s\S]*?<\/form>/)?.[0] || '';
      expect(blockedForm).toMatch(/<div class="field-row release-distribution-row">\s*[\s\S]*?<div class="field release-platforms-field" data-dialog-field="selectedPlatforms" data-dialog-error-ref="selectedPlatforms-error">\s*<input type="hidden" name="selectedPlatformsPresent"[\s\S]*?<\/div>\s*<div class="field " data-dialog-field="patreonUrl">\s*<label for="patreonUrl">Release link<\/label>/);
      expect(releaseRepository.findById(releaseId).title).toBe('Edited Legacy Release');
      platformRepository.expireSession('active-legacy-platform-edit');

      await saveEdit({ title: 'Removed Legacy Platform', selectedPlatformsPresent: '1' }).expect(200);
      expect(platformRepository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x').is_selected).toBe(0);
      const afterRemoval = await agent.get(`/releases/${releaseId}?edit=1`).expect(200);
      const afterRemovalForm = afterRemoval.text.match(/<form id="release-edit-form"[\s\S]*?<\/form>/)?.[0] || '';
      expect(afterRemovalForm).not.toMatch(/name="selectedPlatforms"[^>]*value="x"/);
    });

    it('renders configured Platforms and preserves submitted choices across create and edit errors', async () => {
      app.locals.socialPrepSettingsService.setPlatforms(['patreon', 'x', 'bluesky']);
      const projectId = await createTestProject('Platform Form Project');
      const newPage = await agent.get('/releases').expect(200);
      const newForm = newPage.text.match(/<form id="release-create-form"[\s\S]*?<\/form>/)?.[0] || '';
      expect(newForm).toMatch(/<h3>Scheduling<\/h3>[\s\S]*?<legend>Platforms<\/legend>[\s\S]*?<label for="patreonUrl">Release link<\/label>/);
      expect(newForm).toContain('name="selectedPlatformsPresent" value="1"');
      expect(newForm).toContain('data-cc-dropdown-mode="multiple"');
      expect(newForm.match(/name="selectedPlatforms"/g)).toHaveLength(3);
      expect(newForm).not.toMatch(/name="selectedPlatforms"[^>]*checked/);

      const rejected = await agent.post('/releases')
        .send({ _csrf: csrfToken, projectId, title: '', selectedPlatformsPresent: '1', selectedPlatforms: ['patreon', 'x'] })
        .set('Content-Type', 'application/x-www-form-urlencoded').expect(422);
      const retryForm = rejected.text.match(/<form id="release-form"[\s\S]*?<\/form>/)?.[0] || '';
      expect(retryForm.match(/name="selectedPlatforms"[^>]*checked/g)).toHaveLength(2);

      const created = await agent.post('/releases')
        .send({ _csrf: csrfToken, projectId, title: 'Selected Release', selectedPlatformsPresent: '1', selectedPlatforms: ['patreon', 'x'] })
        .set('Content-Type', 'application/x-www-form-urlencoded').expect(302);
      const releaseId = Number(created.headers.location.split('/').at(-1));
      const edit = await agent.get(`/releases/${releaseId}?edit=1`).expect(200);
      const editForm = edit.text.match(/<form id="release-edit-form"[\s\S]*?<\/form>/)?.[0] || '';
      expect(editForm.match(/name="selectedPlatforms"[^>]*checked/g)).toHaveLength(2);

      const saveEdit = (fields) => agent.post(`/releases/${releaseId}`).set('Accept', 'application/json')
        .type('form').send({ _csrf: csrfToken, expectedPatreonUrl: loadedReleaseLink(releaseId), ...fields });
      const invalid = await saveEdit({ title: 'Attempted', selectedPlatformsPresent: '1', selectedPlatforms: ['bluesky', 'invalid'] }).expect(422);
      expect(invalid.body.values).toMatchObject({ title: 'Attempted', selectedPlatforms: ['bluesky', 'invalid'] });
      expect(invalid.body.errors.selectedPlatforms).toBeTruthy();
      expect(releaseRepository.findById(releaseId).title).toBe('Selected Release');

      await saveEdit({ title: 'Changed', selectedPlatformsPresent: '1', selectedPlatforms: 'bluesky' }).expect(200);
      let rows = app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId);
      expect(rows.filter((row) => row.is_selected).map((row) => row.platform)).toEqual(['bluesky']);
      const historical = await agent.get(`/releases/${releaseId}?edit=1`).expect(200);
      const historicalForm = historical.text.match(/<form id="release-edit-form"[\s\S]*?<\/form>/)?.[0] || '';
      expect(historicalForm).toMatch(/name="selectedPlatforms"[^>]*value="bluesky"[^>]*checked/);
      expect(historicalForm).not.toMatch(/name="selectedPlatforms"[^>]*value="patreon"[^>]*checked/);

      const platformRepository = app.locals.socialPrepRepository;
      platformRepository.insertSession({
        id: 'active-platform-edit', releaseId, kind: 'initial', expiresAt: new Date('2030-01-01'),
      });
      platformRepository.reassignPlatformsToSession('active-platform-edit', ['bluesky']);
      const blocked = await saveEdit({ title: 'Blocked metadata', selectedPlatformsPresent: '1' }).expect(422);
      expect(blocked.body.errors.selectedPlatforms).toBe('Cannot deselect a platform while its preparation session is active.');
      expect(blocked.body.values.title).toBe('Blocked metadata');
      expect(releaseRepository.findById(releaseId).title).toBe('Changed');
      platformRepository.expireSession('active-platform-edit');

      await saveEdit({ title: 'Cleared', selectedPlatformsPresent: '1' }).expect(200);
      rows = app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId);
      expect(rows.filter((row) => row.is_selected)).toEqual([]);
      await saveEdit({ title: 'Omitted platform fields' }).expect(200);
      expect(app.locals.socialPrepRepository.listPlatformsByReleaseId(releaseId)).toEqual(rows);

      const noSelection = await agent.post('/releases')
        .send({ _csrf: csrfToken, projectId, title: 'No platforms', selectedPlatformsPresent: '1' })
        .set('Content-Type', 'application/x-www-form-urlencoded').expect(302);
      const noSelectionId = Number(noSelection.headers.location.split('/').at(-1));
      expect(app.locals.socialPrepRepository.listPlatformsByReleaseId(noSelectionId)).toEqual([]);
    });
    it('keeps creation unpublished even when ordinary requests submit a published date', async () => {
      const projectId = await createTestProject('Unpublished Ordinary Release');
      const response = await agent.post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Unpublished+Ordinary')
        .send('publishedDate=2031-04-06')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const releaseId = Number(response.headers.location.split('/')[2]);
      expect(releaseRepository.findById(releaseId).published_date).toBeNull();
    });

    it('marks a standalone validation rerender as preserved', async () => {
      const response = await agent.post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(response.text).toContain('data-release-create-fresh="false"');
      expect(response.text).not.toContain('name="publishedDate"');
    });

    it('keeps published date on Edit Release without exposing a fresh-create flag', async () => {
      const projectId = await createTestProject('Edit Publication Field');
      const created = await agent.post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Edit+Publication+Field')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const detail = await agent.get(created.headers.location).expect(200);
      const editDialog = detail.text.match(/<dialog id="release-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      expect(editDialog).toContain('name="publishedDate"');
      expect(editDialog).not.toContain('data-release-create-fresh');
    });

    it('renders the heading trigger and the async create dialog on /releases', async () => {
      const res = await agent.get('/releases').expect(200);
      const dialog = res.text.match(/<dialog id="release-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      const headingNewRelease = extractPageHeading(res.text).match(/<a\b[^>]*href="\/releases\/new"[^>]*>[\s\S]*?<\/a>/)?.[0] || '';
      expect(headingNewRelease).toMatch(/^<a class="button button-primary dashboard-create-action" href="\/releases\/new" data-dialog-open="release-create-dialog" data-dialog-invocation><span class="project-create-submit-icon" aria-hidden="true">/);
      expect(headingNewRelease).toContain('<path d="M12 5v14M5 12h14"/>');
      expect(headingNewRelease).toMatch(/<\/span>New Release<\/a>$/);
      expect(headingNewRelease).not.toContain('project-assets-heading-action');
      expect(headingNewRelease).not.toContain('aria-label=');
      expect(dialog).not.toMatch(/<button[^>]*>\s*Cancel\s*<\/button>/);
      expect(dialog.match(/data-dialog-close/g)).toHaveLength(1);
      expect(dialog).toContain('<form id="release-create-form" method="post" action="/releases"');
      expect(dialog).toContain('data-dialog-form data-dialog-async="true"');
      expect(dialog).toContain('data-dialog-pending-message="Creating release…"');
      expect(dialog).toContain('data-dialog-network-error-message="Could not confirm whether the release was created. Check Releases before creating it again."');
      expect(dialog).toContain('<div class="error-summary" role="alert" data-dialog-error hidden><p data-dialog-error-text></p></div>');
      expect(dialog).toContain('<div class="release-details-project" data-dialog-field="projectId" data-dialog-error-ref="projectId-error">');
      expect(dialog).toContain('data-release-create-fresh="true"');
      expect(dialog).not.toContain('name="publishedDate"');
      expect(dialog).toContain('<input type="hidden" name="returnTo" value="/releases">');
      expect(dialog).not.toContain('data-dialog-return-location');
      expect(dialog).not.toContain('name="releaseCreateFlow"');
    });

    it('validates and normalizes the ordered Assets handoff without creating or losing its initial form state', async () => {
      const projectId = await createTestProject('Assets Handoff Project');
      const first = insertAssetDirect(db, projectId, 'handoff-first.png');
      const second = insertAssetDirect(db, projectId, 'handoff-second.png');
      app.locals.pageDefaultsService.saveDefault('releases', 'sort', 'title');
      app.locals.pageDefaultsService.saveDefault('releases', 'order', 'desc');

      const res = await agent
        .post(`/releases?new=assets&projectId=${projectId}`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds=${second.id}`)
        .send(`selectedAssetIds=${first.id}`)
        .send(`selectedAssetIds=${second.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(200);
      const dialog = res.text.match(/<dialog id="release-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      const selectedIds = [...dialog.matchAll(/name="selectedAssetIds" value="(\d+)"/g)]
        .map(([, id]) => Number(id));

      expect(res.headers.location).toBeUndefined();
      expect(dialog).toMatch(/<dialog id="release-create-dialog"[^>]*open/);
      expect(dialog).toMatch(new RegExp(`name="projectId"[^>]*value="${projectId}"[^>]*checked`));
      expect(dialog).toContain('value="Assets Handoff Project"');
      expect(dialog).toContain('name="releaseCreateFlow" value="selected-assets"');
      expect(dialog).toContain('data-release-create-fresh="true"');
      expect(dialog).not.toContain('name="publishedDate"');
      expect(selectedIds).toEqual([second.id, first.id]);
      expect(dialog).toContain('action="/releases"');
      expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toEqual([]);
    });

    it.each([
      ['external', 'https://evil.example/projects/1/assets'],
      ['protocol-relative', '//evil.example/projects/1/assets'],
      ['another project', null],
      ['unrelated local path', '/releases?view=list'],
    ])('rejects an %s selected-assets cancellation destination', async (_label, candidate) => {
      const projectId = await createTestProject(`Return Validation Project ${_label}`);
      const otherProjectId = await createTestProject(`Other Return Project ${_label}`);
      const asset = insertAssetDirect(db, projectId, `return-${_label.replaceAll(' ', '-')}.png`);
      const returnTo = candidate ?? `/projects/${otherProjectId}/assets?view=list`;

      const res = await agent
        .post(`/releases?new=assets&projectId=${projectId}`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds=${asset.id}`)
        .send('returnTo=' + encodeURIComponent(returnTo))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(200);
      const dialog = res.text.match(/<dialog id="release-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      expect(dialog).toContain('<input type="hidden" name="returnTo" value="/releases">');
      expect(dialog).not.toContain('data-dialog-return-location');
    });

    it('rejects direct handoffs with nonexistent projects and empty, foreign, missing, or non-positive asset selections', async () => {
      const projectId = await createTestProject('Assets Handoff Validation Project');
      const local = insertAssetDirect(db, projectId, 'local-handoff.png');
      const otherProjectId = await createTestProject('Assets Handoff Foreign Project');
      const foreign = insertAssetDirect(db, otherProjectId, 'foreign-handoff.png');
      const cases = [
        { targetProjectId: 999999, value: String(local.id), message: 'Project not found.' },
        { targetProjectId: projectId, value: '', message: 'At least one asset must be selected.' },
        { targetProjectId: projectId, value: String(foreign.id), message: 'does not belong to the specified project' },
        { targetProjectId: projectId, value: '999999', message: 'Asset 999999 not found' },
        { targetProjectId: projectId, value: '0', message: 'Asset IDs must be positive integers.' },
      ];

      for (const { targetProjectId, value, message } of cases) {
        const res = await agent
          .post(`/releases?new=assets&projectId=${targetProjectId}`)
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`selectedAssetIds=${value}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);
        const dialog = res.text.match(/<dialog id="release-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

        expect(dialog).toMatch(/<dialog id="release-create-dialog"[^>]*open/);
        expect(dialog).toContain('data-release-create-fresh="false"');
        expect(dialog).toContain(message);
        expect(dialog).toContain('name="releaseCreateFlow" value="selected-assets"');
        expect(dialog).not.toMatch(/name="selectedAssetIds"/);
        expect(dialog).toContain('Return to Project Assets and select valid assets before creating a release.');
        expect(dialog).toMatch(/data-dialog-submit disabled/);
        expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toEqual([]);
      }
    });

    it('keeps an empty rejected handoff in selected-assets mode on resubmit', async () => {
      const projectId = await createTestProject('Empty Handoff Resubmit Project');
      const rejected = await agent
        .post(`/releases?new=assets&projectId=${projectId}`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      const rejectedDialog = rejected.text.match(/<dialog id="release-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      expect(rejectedDialog).toContain('name="releaseCreateFlow" value="selected-assets"');
      expect(rejectedDialog).not.toMatch(/name="selectedAssetIds"/);

      const resubmitted = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('returnTo=%2Freleases')
        .send('releaseCreateFlow=selected-assets')
        .send(`projectId=${projectId}`)
        .send('title=Must+Not+Create')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      const resubmittedDialog = resubmitted.text.match(/<dialog id="release-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      expect(resubmittedDialog).toContain('name="releaseCreateFlow" value="selected-assets"');
      expect(resubmittedDialog).not.toMatch(/name="selectedAssetIds"/);
      expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toEqual([]);
    });

    it('returns controlled validation for a nested malformed direct handoff selection', async () => {
      const projectId = await createTestProject('Malformed Assets Handoff Project');

      const res = await agent
        .post(`/releases?new=assets&projectId=${projectId}`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('selectedAssetIds[0][]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain('Invalid asset selection format.');
      expect(res.text).toContain('name="releaseCreateFlow" value="selected-assets"');
      expect(res.text).not.toMatch(/name="selectedAssetIds"/);
      expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toEqual([]);
    });

    it('rejects missing or altered selected-assets flow markers instead of falling through to ordinary creation', async () => {
      const projectId = await createTestProject('Selected Flow Marker Tamper Project');
      const asset = insertAssetDirect(db, projectId, 'selected-flow-marker.png');
      const markerValues = [null, 'ordinary'];

      for (const marker of markerValues) {
        let request = agent
          .post('/releases')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('returnTo=%2Freleases')
          .send(`projectId=${projectId}`)
          .send('title=Must+Not+Create')
          .send(`selectedAssetIds=${asset.id}`);
        if (marker !== null) request = request.send(`releaseCreateFlow=${marker}`);

        const res = await request
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);
        const dialog = res.text.match(/<dialog id="release-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

        expect(dialog).toContain('Invalid release creation flow.');
        expect(dialog).toContain('name="releaseCreateFlow" value="selected-assets"');
        expect(dialog).not.toMatch(/name="selectedAssetIds"/);
        expect(dialog).toMatch(/data-dialog-submit disabled/);
        expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toEqual([]);
      }
    });

    it('rejects a direct handoff for an archived project', async () => {
      const projectId = insertProjectDirect(db, {
        title: 'Archived Assets Handoff Project',
        archivedAt: '2026-09-10 12:00:00',
      });
      const asset = insertAssetDirect(db, projectId, 'archived-handoff.png');

      const res = await agent
        .post(`/releases?new=assets&projectId=${projectId}`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds=${asset.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain('Cannot create release for archived project.');
      expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toEqual([]);
    });

    it('keeps the complete create contract in the dialog and standalone fallback with valid host-page IDs', async () => {
      await createTestProject('Release Dialog Contract Project');
      const [dialogRes, fallbackRes] = await Promise.all([
        agent.get('/releases').expect(200),
        agent.get('/releases/new').expect(200),
      ]);
      const dialog = dialogRes.text.match(/<dialog id="release-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      const requiredNames = ['projectId', 'title', 'description', 'notes', 'plannedDate', 'plannedTime', 'patreonUrl'];

      for (const name of requiredNames) {
        expect(dialog).toMatch(new RegExp(`name="${name}"`));
        expect(fallbackRes.text).toMatch(new RegExp(`name="${name}"`));
      }
      expect(dialog).not.toContain('name="publishedDate"');
      expect(fallbackRes.text).not.toContain('name="publishedDate"');
      expect(dialog).toContain('data-release-create-fresh="true"');
      expect(fallbackRes.text).toContain('data-release-create-fresh="true"');
      // Project moves into Release details, so its legend becomes the visible label.
      expect(dialog).not.toContain('<h3>Project</h3>');
      expect(dialog).toMatch(/<h3>Release details<\/h3>\s*<div class="[^"]*release-details-section-body">\s*<div class="release-details-project"[^>]*>[\s\S]*?<legend>Project <span class="required" aria-label="required">\*<\/span><\/legend>/);
      expect(dialog).not.toContain('<legend class="sr-only">Project ');
      expect(dialog).toMatch(/<textarea id="description"[^>]*rows="6"/);
      expect(dialog).toMatch(/<textarea id="notes"[^>]*rows="6"/);
      expect(dialog).toContain('<label for="patreonUrl">Release link</label>');
      expect(fallbackRes.text).toContain('<label class="sr-only" for="patreonUrl">Release link</label>');
      expect(fallbackRes.text).toContain('<legend class="sr-only">Project <span class="required" aria-label="required">*</span></legend>');
      expectReleaseFormSectionCards(fallbackRes.text);

      expect(dialog).toContain('class="app-dialog project-form-dialog app-dialog--refined"');
      expect(dialog).not.toContain('aria-describedby="release-create-description"');
      expect(dialog).not.toContain('Create a tracked release record.');
      expect(dialog).not.toContain('id="release-create-description"');
      expect(dialog).toContain('class="app-dialog-body project-edit-dialog-body"');
      expect(dialog).toContain('class="app-dialog-form project-form project-edit-dialog-form"');
      expect(dialog).toContain('id="release-create-project-trigger" aria-controls="release-create-project-options"');
      expect(dialog).not.toContain('data-release-dialog-compact-section');
      expect(fallbackRes.text).not.toContain('data-release-dialog-compact-section');
      expectReleaseDialogSections(dialog, ['Release details', 'Scheduling']);
      expect(dialog).not.toMatch(/<h3>(?:Project|Basic information|Platforms|Links)<\/h3>/);
      // Description keeps its signature controls; Platforms and the release link close Scheduling.
      expect(dialog).toMatch(/<div class="release-description-group">\s*<div class="field " data-dialog-field="description">\s*<label for="description">[\s\S]*?data-release-signature-field[\s\S]*?data-release-signature-status[^>]*><\/p>\s*<\/div>\s*<div class="field " data-dialog-field="notes">\s*<label for="notes">/);
      expect(dialog).toMatch(/<h3>Scheduling<\/h3>[\s\S]*?id="noSetReleaseDate"[\s\S]*?<div class="field-row release-distribution-row">[\s\S]*?name="selectedPlatformsPresent"[\s\S]*?<legend>Platforms<\/legend>[\s\S]*?<label for="patreonUrl">Release link<\/label>/);
      expectUniqueValidIdReferences(dialogRes.text);

      const css = (await agent.get('/creatorcrate.css').expect(200)).text;
      // Picker rows are the visible control; the native input inside stays
      // borderless. Refined pages share the rule through later selectors.
      expect(css).toMatch(/\.app-dialog \.scheduling-field \.picker-input-row input\.picker-input(?:,\s*[^{},]+)*\s*\{[^}]*border:\s*0;[^}]*box-shadow:\s*none;/);
    });

    it('re-renders a filtered Releases list with the exact invocation URL and submitted values after validation', async () => {
      const projectId = await createTestProject('Release Dialog Validation Project');
      const returnTo = `/releases?project=${projectId}&search=needle&sort=created&order=desc&page=2#releases-list`;
      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('returnTo=' + encodeURIComponent(returnTo))
        .send(`projectId=${projectId}`)
        .send('title=')
        .send('description=Keep+dialog+description')
        .send('notes=Keep+dialog+notes')
        .send('plannedDate=2031-04-05')
        .send('plannedTime=09%3A30')
        .send('publishedDate=2031-04-06')
        .send('patreonUrl=https%3A%2F%2Fexample.test%2Freleases%2Fkeep')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      const dialog = res.text.match(/<dialog id="release-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      expect(res.text).toContain('<h1 class="app-section-title">Releases</h1>');
      expect(dialog).toMatch(/<dialog id="release-create-dialog"[^>]*open/);
      expect(dialog).toContain('Keep dialog description');
      expect(dialog).toContain('Title is required');
      expect(dialog).toMatch(new RegExp(`name="projectId"[^>]*value="${projectId}"[^>]*checked`));
      expect(dialog).toContain('Keep dialog notes');
      expect(dialog).toMatch(/id="plannedDate"[^>]*value="2031-04-05"/);
      expect(dialog).toMatch(/id="plannedTime"[^>]*value="09:30"/);
      expect(dialog).not.toContain('id="publishedDate"');
      expect(dialog).toContain('data-release-create-fresh="false"');
      const createForm = dialog.match(/<form id="release-create-form"[^>]*>/)?.[0] || '';
      const resetValues = JSON.parse(createForm.match(/data-dialog-reset-values="([^"]+)"/)?.[1].replaceAll('&quot;', '"'));
      expect(resetValues.description).toBeUndefined();
      expect(resetValues.projectId).toBeUndefined();
      expect(dialog).toMatch(/id="patreonUrl"[^>]*value="https:\/\/example\.test\/releases\/keep"/);
      expect(dialog).toMatch(/id="title"[^>]*aria-describedby="title-error"[^>]*aria-invalid="true"/);
      expect(dialog).toContain(`name="returnTo" value="/releases?project=${projectId}&amp;search=needle&amp;sort=created&amp;order=desc&amp;page=2#releases-list" data-dialog-return-location`);
    });

    it('keeps the existing detail destination on a successful retry with Releases invocation metadata', async () => {
      const projectId = await createTestProject('Release Dialog Retry Project');
      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('returnTo=' + encodeURIComponent('/releases?sort=created&order=desc&page=2#releases-list'))
        .send(`projectId=${projectId}`)
        .send('title=Successful+Dialog+Retry')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toMatch(/^\/releases\/\d+$/);
    });

    it('keeps selected assets in the open dialog after validation failure', async () => {
      const projectId = await createTestProject('Release Dialog Asset Project');
      const asset = insertAssetDirect(db, projectId, 'dialog-selected.png');
      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('returnTo=%2Freleases')
        .send('releaseCreateFlow=selected-assets')
        .send(`projectId=${projectId}`)
        .send('title=')
        .send(`selectedAssetIds=${asset.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      const dialog = res.text.match(/<dialog id="release-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      expect(dialog).toMatch(/<dialog id="release-create-dialog"[^>]*open/);
      expect(dialog).toContain('name="releaseCreateFlow" value="selected-assets"');
      expect(dialog).toContain(`name="selectedAssetIds" value="${asset.id}"`);
      expect(dialog).toContain('data-release-create-fresh="false"');
    });

    it('preserves normalized selected-assets state and edited fields through a later validation rerender', async () => {
      const projectId = await createTestProject('Selected Rerender Project');
      const first = insertAssetDirect(db, projectId, 'selected-rerender-first.png');
      const second = insertAssetDirect(db, projectId, 'selected-rerender-second.png');
      const invalidTitle = 'x'.repeat(201);

      const invalid = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('returnTo=%2Freleases')
        .send('releaseCreateFlow=selected-assets')
        .send(`projectId=${projectId}`)
        .send(`title=${invalidTitle}`)
        .send('description=Operator+edited+description')
        .send(`selectedAssetIds=${second.id}`)
        .send(`selectedAssetIds=${first.id}`)
        .send(`selectedAssetIds=${second.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      const dialog = invalid.text.match(/<dialog id="release-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      const selectedIds = [...dialog.matchAll(/name="selectedAssetIds" value="(\d+)"/g)].map(([, id]) => Number(id));

      expect(dialog).toContain('name="releaseCreateFlow" value="selected-assets"');
      expect(dialog).toContain(`value="${invalidTitle}"`);
      expect(dialog).toContain('Operator edited description');
      expect(selectedIds).toEqual([second.id, first.id]);
      expect(dialog).not.toMatch(/data-dialog-submit disabled/);
      expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toEqual([]);

      const created = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('releaseCreateFlow=selected-assets')
        .send(`projectId=${projectId}`)
        .send('title=Operator+Edited+Title')
        .send(`selectedAssetIds=${second.id}`)
        .send(`selectedAssetIds=${first.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(created.headers.location).toMatch(/^\/releases\/\d+\/assets$/);
      expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toHaveLength(1);
    });

    it.each([
      'https://evil.example/releases',
      '//evil.example/releases',
      '/releases/%',
      '/projects?sort=title',
    ])('does not treat an invalid Release create invocation returnTo as a dialog host: %s', async (returnTo) => {
      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('returnTo=' + encodeURIComponent(returnTo))
        .send('title=')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain('<h1 class="app-section-title">Releases — Create Release</h1>');
      expect(res.text).toContain('<form id="release-form" method="post" action="/releases"');
      expect(res.text).not.toMatch(/<dialog id="release-create-dialog"[^>]*open/);
    });
  });

  // WP12: every Save / Reset defaults request carries the durable `releases`
  // defaults generation it was prepared from (missing/stale = 409).
  function withReleasesDefaultsGeneration(body) {
    return { ...body, defaultsGeneration: String(app.locals.pageDefaultsService.getMutationGeneration('releases')) };
  }

  function storedReleasesDefault(option) {
    return db.prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(PAGE_DEFAULT_DEFINITIONS.releases[option].key)?.value;
  }

  describe('/releases defaults and live-region markup', () => {

    it('renders one combined Filters & Defaults dialog with explicit-save defaults and no autosave', async () => {
      const res = await agent.get('/releases').expect(200);
      const displayControls = res.text.match(/<div class="asset-viewer-display-controls">[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';
      const filterDialog = res.text.match(/<dialog id="releases-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      const filterForm = filterDialog.match(/<form id="list-releases-filter"[\s\S]*?<\/form>/)?.[0] || '';
      const defaultsForm = filterDialog.match(/<form id="releases-defaults-form"[\s\S]*?<\/form>/)?.[0] || '';
      const footer = filterDialog.match(/<footer class="app-dialog-footer filters-defaults-footer">[\s\S]*?<\/footer>/)?.[0] || '';
      const createDialog = res.text.match(/<dialog id="release-create-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

      // One entry point, in the existing toolbar location; the separate
      // Defaults entry and dialog are retired.
      expect(displayControls).toContain('href="#releases-filter-dialog" aria-label="Filters &amp; Defaults"');
      expect(displayControls).toContain('data-dialog-open="releases-filter-dialog" data-tooltip="Filters &amp; Defaults"');
      expect(displayControls.match(/data-dialog-open=/g)).toHaveLength(1);
      expect(displayControls).not.toContain('data-releases-reset');
      expect(res.text).not.toContain('releases-defaults-dialog');
      expect(res.text).not.toContain('/releases?defaults=1');

      expect(filterDialog).toContain('class="app-dialog app-dialog--utility app-dialog--filters-defaults releases-filters-defaults" data-app-dialog');
      expect(filterDialog).toContain('aria-labelledby="releases-filter-dialog-title"');
      expect(filterDialog).toContain('<h2 id="releases-filter-dialog-title">Filters &amp; Defaults</h2>');
      expect(filterDialog).toContain('<p class="app-dialog-subtitle">Releases</p>');
      expect(filterDialog.match(/data-dialog-close/g)).toHaveLength(1);
      expect(filterDialog).toContain('data-dialog-close aria-label="Close Filters &amp; Defaults"');

      // Sections: Filters, then Sort options; no Miscellaneous/View/page size.
      const headings = [...filterDialog.matchAll(/<h3 id="[^"]+">([^<]+)<\/h3>/g)].map(([, heading]) => heading);
      expect(headings).toEqual(['Filters', 'Sort options']);
      expect(filterDialog).not.toContain('Miscellaneous');
      expect(filterDialog).not.toMatch(/name="view"/);
      expect(filterDialog).not.toMatch(/<(?:select|input)(?![^>]*type="hidden")[^>]*name="pageSize"/);
      const filtersSection = filterForm.match(/aria-labelledby="releases-filters-heading">[\s\S]*?<\/section>/)?.[0] || '';
      const sortSection = filterForm.match(/aria-labelledby="releases-sort-heading">[\s\S]*?<\/section>/)?.[0] || '';
      for (const name of ['search', 'project', 'type', 'schedule', 'includeArchived']) {
        expect(filtersSection).toMatch(new RegExp(`name="${name}"`));
        expect(sortSection).not.toMatch(new RegExp(`name="${name}"`));
      }
      for (const name of ['sort', 'order']) {
        expect(sortSection).toMatch(new RegExp(`name="${name}"`));
        expect(filtersSection).not.toMatch(new RegExp(`name="${name}"`));
      }
      expect(filtersSection).toContain('<label for="releases-search">Search</label>');
      expect(filtersSection).toContain('>Include archived</span>');
      expect(sortSection).toMatch(/id="list-sort-trigger"[^>]*aria-label="Sort by filter: Planned"/);
      expect(sortSection).toMatch(/id="list-order-trigger"[^>]*aria-label="Sort order filter: Ascending"/);
      // The results Search is the only named search input: the option-search
      // fields inside the dropdowns never join the GET.
      expect(filterForm.match(/<input[^>]*name="search"[^>]*>/g)).toHaveLength(1);
      expect(filterForm).not.toMatch(/id="release-(?:project|type)-filter-search"[^>]*\bname=/);
      expect(filterForm).not.toContain('page-defaults-grid');

      // The defaults form has no native mutation: no action, no saveable
      // fields, no generation/returnTo, no autosave marker.
      expect(defaultsForm).toContain('<form id="releases-defaults-form" method="dialog" class="filters-defaults-defaults-form"');
      expect(defaultsForm).toContain('data-dialog-form data-dialog-async="false" data-defaults-explicit-save novalidate');
      expect(defaultsForm).not.toContain('data-releases-defaults-autosave');
      expect(defaultsForm).not.toContain('data-autosubmit');
      expect(defaultsForm).not.toMatch(/name="(?:sort|order|defaultsGeneration|defaultsOperation|returnTo)"/);
      expect(defaultsForm).toContain('data-settings-fetch-save-status role="status" aria-live="polite" aria-atomic="true"');
      expect(defaultsForm).toContain('<p class="filters-defaults-saved-indicator" data-releases-defaults-indicator>No saved defaults.</p>');
      expect(res.text).not.toContain('data-releases-defaults-autosave');

      // Footer: exactly Save new defaults, Reset defaults, Reset filters in
      // that DOM order; Save/Reset defaults JS-only (disabled type=button).
      const footerButtons = [...footer.matchAll(/<button class="([^"]+)" type="([^"]+)"([^>]*)>([^<]+)<\/button>/g)]
        .map(([, classes, type, attributes, label]) => ({ classes, type, attributes, label }));
      expect(footerButtons.map(({ label }) => label)).toEqual(['Save new defaults', 'Reset defaults', 'Reset filters']);
      expect(footerButtons[0]).toMatchObject({ classes: 'button button-secondary', type: 'button' });
      expect(footerButtons[0].attributes).toContain('disabled data-releases-defaults-save');
      expect(footerButtons[1]).toMatchObject({ classes: 'button button-secondary', type: 'button' });
      expect(footerButtons[1].attributes).toContain('disabled data-releases-defaults-reset');
      expect(footerButtons[2]).toMatchObject({ classes: 'button button-primary', type: 'submit' });
      expect(footerButtons[2].attributes).toContain('data-releases-filters-reset');
      expect(footer).not.toMatch(/>\s*(?:Cancel|Apply|Done|Close)\s*</);
      expect(footer).toContain('<form class="releases-filter-reset filters-defaults-reset-form" method="get" action="/releases">');

      // The authority JSON lives inside the live region.
      const region = res.text.match(/<div data-releases-live-region>[\s\S]*?<section class="project-detail-section releases-results-section"/)?.[0] || '';
      expect(region).toContain('<script type="application/json" data-releases-defaults-authority>');
      expect(releasesDefaultsAuthority(res.text)).toMatchObject({
        page: 'releases',
        fields: ['sort', 'order'],
        multiFields: [],
        fallbacks: { sort: 'planned', order: 'asc' },
        defaults: { sort: 'planned', order: 'asc' },
        current: { sort: 'planned', order: 'asc' },
        saved: { sort: { stored: false, valid: false }, order: { stored: false, valid: false } },
        savedKeys: [],
        hasSavedDefaults: false,
        generation: 0,
        currentUrl: '/releases',
        resetFiltersUrl: '/releases',
      });

      expect(createDialog).not.toBe('');
      expect(createDialog).not.toContain('releases-filter-dialog');
      expect(res.text.match(/id="release-create-dialog"/g)).toHaveLength(1);
      expect(res.text.match(/id="releases-filter-dialog"/g)).toHaveLength(1);
      expectUniqueValidIdReferences(res.text);

      expect(res.text).toContain('data-releases-live-region');
      expect(res.text).toContain('data-releases-filter');
      expect(res.text).not.toContain('data-releases-view-link');
      expect(res.text).not.toContain('class="view-switcher"');
      expect(res.text).not.toContain('pageSize');

      const enhancedMarkup = res.text.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
      expect(enhancedMarkup).not.toContain('>Filter</button>');
      expect(enhancedMarkup).not.toContain('>Clear</a>');

      const css = (await agent.get('/creatorcrate.css').expect(200)).text;
      expect(css).toMatch(/\.app-dialog--filters-defaults\.releases-filters-defaults \.asset-viewer-project-filter\s*\{[^}]*z-index:\s*auto;/);
      expect(css).not.toContain('#releases-filter-dialog .page-defaults-grid');
      expect(css).not.toMatch(/\.asset-viewer-filters--releases\s*[,\{]/);
    });

    it('opens defaults=1 as the combined dialog without saved-default canonicalization', async () => {
      app.locals.pageDefaultsService.saveDefault('releases', 'sort', 'title');
      app.locals.pageDefaultsService.saveDefault('releases', 'order', 'desc');

      const res = await agent.get('/releases?defaults=1').expect(200);

      expect(res.headers.location).toBeUndefined();
      expect(res.text).toMatch(/<dialog id="releases-filter-dialog"[^>]*data-app-dialog[^>]*open/);
      expect(res.text).not.toContain('name="view"');
      const filterDialog = res.text.match(/<dialog id="releases-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(filterDialog).toContain('id="list-releases-filter"');
      expect(filterDialog).not.toContain('name="defaults"');
      expect(filterDialog).toContain('data-releases-defaults-indicator>Defaults saved.</p>');
      expect(releasesDefaultsAuthority(res.text)).toMatchObject({
        savedKeys: ['sort', 'order'], defaults: { sort: 'title', order: 'desc' }, current: { sort: 'title', order: 'desc' },
      });
    });

    it('serves the read-only defaults authority as JSON and redirects a typed URL to the dialog', async () => {
      app.locals.pageDefaultsService.saveDefault('releases', 'order', 'asc');
      const json = await agent.get('/releases/defaults').set('Accept', 'application/json').expect(200);
      expect(json.headers['cache-control']).toBe('no-store');
      expect(json.body).toMatchObject({
        status: 'success',
        authority: {
          page: 'releases',
          fields: ['sort', 'order'],
          // An explicitly saved fallback-equal value still reports saved.
          saved: { sort: { stored: false }, order: { stored: true, valid: true } },
          savedKeys: ['order'],
          generation: 0,
        },
      });
      expect(json.body.authority).not.toHaveProperty('current');

      const typed = await agent.get('/releases/defaults').set('Accept', 'text/html').expect(302);
      expect(typed.headers.location).toBe('/releases?defaults=1');
    });

    it('saves only Sort and Order through the fenced JSON transport with a correlated acknowledgement', async () => {
      app.locals.pageDefaultsService.saveDefault('projects', 'sort', 'title');
      const response = await agent
        .post('/releases/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(withReleasesDefaultsGeneration({
          _csrf: csrfToken,
          sort: 'title',
          order: 'desc',
          defaultsOperation: 'op-save-1',
          returnTo: '/releases?search=x&project=3&type=comic&schedule=today&includeArchived=1&pageSize=50',
          // Temporary filters are never saveable, even when sent.
          search: 'x',
          project: '3',
          type: 'comic',
          schedule: 'today',
          includeArchived: '1',
          pageSize: '50',
        }))
        .expect(200);

      expect(response.body).toMatchObject({
        status: 'success',
        values: { sort: 'title', order: 'desc' },
        operation: {
          id: 'op-save-1', kind: 'save', result: 'committed', committed: true, expectedGeneration: 0, generation: 1,
        },
        authority: {
          page: 'releases', generation: 1, savedKeys: ['sort', 'order'], defaults: { sort: 'title', order: 'desc' },
        },
      });
      expect(Object.keys(response.body.values).sort()).toEqual(['order', 'sort']);
      expect(storedReleasesDefault('sort')).toBe('title');
      expect(storedReleasesDefault('order')).toBe('desc');
      const releasesKeys = db.prepare("SELECT key FROM app_meta WHERE key LIKE 'page_defaults.releases.%'").all()
        .map(({ key }) => key).sort();
      expect(releasesKeys).toEqual([PAGE_DEFAULT_DEFINITIONS.releases.order.key, PAGE_DEFAULT_DEFINITIONS.releases.sort.key].sort());
      expect(app.locals.pageDefaultsService.getMutationGeneration('releases')).toBe(1);
      // Another page's saved defaults and generation are untouched.
      expect(app.locals.pageDefaultsService.resolve('projects', 'sort')).toBe('title');
      expect(app.locals.pageDefaultsService.getMutationGeneration('projects')).toBe(0);

      const bare = await agent.get('/releases').expect(302);
      expect(bare.headers.location).toBe('/releases?sort=title&order=desc');
      const bareRendered = await agent.get(bare.headers.location).expect(200);
      expect(bareRendered.text).toMatch(/id="list-sort-trigger"[^>]*aria-label="Sort by filter: Title"/);
      expect(bareRendered.text).toMatch(/id="list-order-trigger"[^>]*aria-label="Sort order filter: Descending"/);
    });

    it('rejects a missing or stale generation with a correlated 409 and writes nothing', async () => {
      const missing = await agent
        .post('/releases/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send({ _csrf: csrfToken, sort: 'title', order: 'desc', defaultsOperation: 'op-missing' })
        .expect(409);
      expect(missing.body).toMatchObject({
        status: 'error',
        code: 'DEFAULTS_GENERATION_CONFLICT',
        operation: { id: 'op-missing', kind: 'save', result: 'conflict', committed: false, expectedGeneration: null, generation: 0 },
        authority: { page: 'releases', generation: 0, savedKeys: [] },
      });

      await agent.post('/releases/defaults').set('Accept', 'application/json').type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, sort: 'updated', order: 'asc', defaultsOperation: 'op-first' }))
        .expect(200);
      const stale = await agent
        .post('/releases/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send({ _csrf: csrfToken, sort: 'title', order: 'desc', defaultsGeneration: '0', defaultsOperation: 'op-stale' })
        .expect(409);
      expect(stale.body.operation).toMatchObject({ id: 'op-stale', result: 'conflict', expectedGeneration: 0, generation: 1 });
      expect(storedReleasesDefault('sort')).toBe('updated');
      expect(storedReleasesDefault('order')).toBe('asc');

      // A native stale post re-renders Releases with the conflict, never a redirect.
      const native = await agent.post('/releases/defaults').type('form')
        .send({ _csrf: csrfToken, sort: 'title', order: 'desc', defaultsGeneration: '0' })
        .expect(409);
      expect(native.text).toMatch(/<dialog id="releases-filter-dialog"[^>]*open/);
      expect(native.text).toContain('Releases defaults changed since this page was loaded.');
      expect(storedReleasesDefault('sort')).toBe('updated');
    });

    // C2: a legacy Settings write of Releases Sort/Order advances the Releases
    // generation, so the authority a dialog reads afterwards is current and a
    // Save prepared before it is stale.
    it('treats a legacy Settings Releases write as a newer authority generation', async () => {
      const before = await agent.get('/releases/defaults').set('Accept', 'application/json').expect(200);
      expect(before.body.authority.generation).toBe(0);

      await agent.post('/settings/defaults').type('form')
        .send({ _csrf: csrfToken, releasesSort: 'title', releasesOrder: 'desc' })
        .expect(302);

      const after = await agent.get('/releases/defaults').set('Accept', 'application/json').expect(200);
      expect(after.body.authority).toMatchObject({ page: 'releases', generation: 1, savedKeys: ['sort', 'order'] });

      const stale = await agent.post('/releases/defaults').set('Accept', 'application/json').type('form')
        .send({ _csrf: csrfToken, sort: 'updated', order: 'asc', defaultsGeneration: '0', defaultsOperation: 'op-pre-legacy' })
        .expect(409);
      expect(stale.body.operation).toMatchObject({ id: 'op-pre-legacy', result: 'conflict', committed: false, generation: 1 });
      expect(storedReleasesDefault('sort')).toBe('title');
      expect(storedReleasesDefault('order')).toBe('desc');

      const bare = await agent.get('/releases').expect(302);
      expect(bare.headers.location).toBe('/releases?sort=title&order=desc');
    });

    it('keeps the native success redirect with a trusted notice for a fenced post', async () => {
      const response = await agent
        .post('/releases/defaults')
        .set('Accept', 'text/html')
        .type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, sort: 'title', order: 'desc' }))
        .expect(302);

      expect(response.headers.location)
        .toBe('/releases?sort=title&order=desc&notice=releases_defaults_saved');
      expect(storedReleasesDefault('sort')).toBe('title');

      const rendered = await agent.get(response.headers.location).expect(200);
      expect(rendered.headers.location).toBeUndefined();
      expect(rendered.text).toContain('Releases defaults saved successfully.');
      expect(rendered.text).toContain('data-releases-defaults-indicator>Defaults saved.</p>');
    });

    it('returns the generic JSON 422 contract without partial saves', async () => {
      await agent.post('/releases/defaults').set('Accept', 'application/json').type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, sort: 'planned', order: 'asc' }))
        .expect(200);

      const invalid = await agent
        .post('/releases/defaults')
        .set('Accept', 'application/json')
        .type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, sort: 'invalid', order: 'desc', defaultsOperation: 'op-invalid' }))
        .expect(422);
      expect(invalid.body).toMatchObject({
        status: 'error',
        values: { sort: 'invalid', order: 'desc' },
        operation: { id: 'op-invalid', kind: 'save', result: 'invalid', committed: false },
      });
      expect(storedReleasesDefault('sort')).toBe('planned');
      expect(storedReleasesDefault('order')).toBe('asc');
      expect(app.locals.pageDefaultsService.getMutationGeneration('releases')).toBe(1);
    });

    it('keeps a normal invalid defaults POST on the page with the combined dialog open and the field error', async () => {
      const invalid = await agent
        .post('/releases/defaults')
        .type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, sort: 'invalid', order: 'desc' }))
        .expect(422);

      expect(invalid.text).toMatch(/<dialog id="releases-filter-dialog"[^>]*open/);
      expect(invalid.text).toMatch(/data-releases-defaults-field-error="sort">Sort: [^<]+<\/p>/);
      expect(storedReleasesDefault('sort')).toBeUndefined();
    });

    it('rejects a Releases defaults POST without CSRF', async () => {
      await agent
        .post('/releases/defaults')
        .type('form')
        .send({ sort: 'planned', order: 'asc' })
        .expect(403);
      await agent
        .post('/releases/defaults/reset')
        .type('form')
        .send({ defaultsGeneration: '0' })
        .expect(403);
    });

    it('Reset defaults deletes only the Releases keys and keeps the temporary context in its refresh', async () => {
      app.locals.pageDefaultsService.saveDefault('releases', 'sort', 'title');
      app.locals.pageDefaultsService.saveDefault('releases', 'order', 'desc');
      app.locals.pageDefaultsService.saveDefault('projects', 'sort', 'title');
      app.locals.pageDefaultsService.saveDefault('assetViewer', 'sort', 'size');
      const projectsSortKey = PAGE_DEFAULT_DEFINITIONS.projects.sort.key;

      const reset = await agent
        .post('/releases/defaults/reset')
        .set('Accept', 'application/json')
        .type('form')
        .send(withReleasesDefaultsGeneration({
          _csrf: csrfToken,
          defaultsOperation: 'op-reset-1',
          returnTo: '/releases?search=%20needle%20&project=12&project=7&type=comic&schedule=today&includeArchived=1&sort=title&order=desc&page=3&pageSize=50',
        }))
        .expect(200);

      expect(reset.body).toMatchObject({
        status: 'success',
        operation: { id: 'op-reset-1', kind: 'resetDefaults', result: 'committed', committed: true, expectedGeneration: 0, generation: 1 },
        reset: { page: 'releases', scope: 'global', changed: true, deletedOptions: ['sort', 'order'] },
        refreshUrl: '/releases?search=needle&project=7&project=12&type=comic&schedule=today&includeArchived=1&pageSize=50',
        authority: { page: 'releases', generation: 1, savedKeys: [], defaults: { sort: 'planned', order: 'asc' } },
      });
      expect(storedReleasesDefault('sort')).toBeUndefined();
      expect(storedReleasesDefault('order')).toBeUndefined();
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(projectsSortKey)?.value).toBe('title');
      expect(app.locals.pageDefaultsService.resolve('assetViewer', 'sort')).toBe('size');

      // A no-op Reset (nothing saved) still advances the generation; a stale
      // request is rejected without deleting anything.
      const noop = await agent.post('/releases/defaults/reset').set('Accept', 'application/json').type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, defaultsOperation: 'op-reset-2' }))
        .expect(200);
      expect(noop.body).toMatchObject({ reset: { changed: false }, refreshUrl: '/releases', operation: { generation: 2 } });
      app.locals.pageDefaultsService.saveDefault('releases', 'sort', 'updated');
      const stale = await agent.post('/releases/defaults/reset').set('Accept', 'application/json').type('form')
        .send({ _csrf: csrfToken, defaultsGeneration: '1', defaultsOperation: 'op-reset-stale' })
        .expect(409);
      expect(stale.body.operation).toMatchObject({ kind: 'resetDefaults', result: 'conflict', generation: 2 });
      expect(storedReleasesDefault('sort')).toBe('updated');
    });

    it('Reset defaults keeps an exact-asset scope exactly as supplied, never widening it', async () => {
      const projectId = insertProjectDirect(db, { title: 'Reset Scope Owner' });
      const assetId = insertAssetDirect(db, projectId, 'reset-scope.png').id;
      const scoped = await agent.post('/releases/defaults/reset').set('Accept', 'application/json').type('form')
        .send(withReleasesDefaultsGeneration({
          _csrf: csrfToken,
          defaultsOperation: 'op-scope',
          returnTo: `/releases?asset=${assetId}&project=${projectId}&sort=title&page=2`,
        }))
        .expect(200);
      expect(scoped.body.refreshUrl).toBe(`/releases?asset=${assetId}&project=${projectId}`);

      const malformed = await agent.post('/releases/defaults/reset').set('Accept', 'application/json').type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, defaultsOperation: 'op-bad', returnTo: '/releases?asset=abc' }))
        .expect(200);
      // The GET itself rejects the scope (400) rather than listing everything.
      expect(malformed.body.refreshUrl).toBe('/releases?asset=abc');
      await agent.get(malformed.body.refreshUrl).expect(400);

      const foreign = await agent.post('/releases/defaults/reset').set('Accept', 'application/json').type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, defaultsOperation: 'op-foreign', returnTo: 'https://evil.example/releases?asset=1' }))
        .expect(200);
      expect(foreign.body.refreshUrl).toBe('/releases');
    });

    it('keeps Calendar navigation available from canonical Releases', async () => {
      const releases = await agent.get('/releases').expect(200);
      expect(releases.text).toContain('href="/calendar"');
    });
  });

  describe('/releases asset scope', () => {
    let projectId;
    let otherProjectId;
    let assetId;

    function createRelease(ownerId, title) {
      return releaseRepository.create({ projectId: ownerId, title, description: '', notes: '' });
    }

    function releaseTitles(html) {
      return [...extractReleasesResultsBody(html).matchAll(/<a href="\/releases\/\d+">([^<]+)<\/a>/g)]
        .map(([, title]) => title);
    }

    function filterDialog(html) {
      return html.match(/<dialog id="releases-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    }

    beforeEach(() => {
      projectId = insertProjectDirect(db, { title: 'Scope Owner' });
      otherProjectId = insertProjectDirect(db, { title: 'Scope Other' });
      assetId = insertAssetDirect(db, projectId, 'scoped-cover.png').id;
      const otherAssetId = insertAssetDirect(db, projectId, 'unrelated.png').id;
      for (const title of ['Alpha Member', 'Beta Member']) {
        releaseRepository.addReleaseAsset(createRelease(projectId, title).id, assetId, 'primary', 0);
      }
      const archived = createRelease(projectId, 'Archived Member');
      releaseRepository.addReleaseAsset(archived.id, assetId, 'primary', 0);
      releaseRepository.archive(archived.id);
      releaseRepository.addReleaseAsset(createRelease(projectId, 'Unrelated').id, otherAssetId, 'primary', 0);
      createRelease(otherProjectId, 'Other Project Release');
    });

    it('lists only releases containing the asset and shows a read-only scope', async () => {
      const res = await agent.get(`/releases?asset=${assetId}&sort=title&order=asc`).expect(200);

      expect(releaseTitles(res.text)).toEqual(['Alpha Member', 'Beta Member']);
      expect(res.text).toContain('2 releases found containing asset <strong>scoped-cover.png</strong>');
      const dialog = filterDialog(res.text);
      expect(dialog).toContain('data-releases-asset-scope');
      expect(dialog).toContain('include asset <strong>scoped-cover.png</strong> from Scope Owner.');
      expect(dialog).toContain(`<input type="hidden" name="asset" value="${assetId}">`);
      expect(dialog).not.toMatch(/<input(?![^>]*type="hidden")[^>]*name="asset"/);
    });

    it('rejects malformed, empty, unsafe, and repeated asset values instead of broadening', async () => {
      for (const value of ['', 'abc', '0', '-1', '01', '1.5', ' 1', '9007199254740993']) {
        const res = await agent.get(`/releases?asset=${encodeURIComponent(value)}`).expect(400);
        expect(res.text).not.toContain('Other Project Release');
      }
      await agent.get(`/releases?asset=${assetId}&asset=${assetId}`).expect(400);
      await agent.get(`/releases?asset[]=${assetId}`).expect(400);
    });

    it('returns 404 for a well-formed asset ID that does not exist', async () => {
      await agent.get('/releases?asset=999999').expect(404);
    });

    it('intersects the asset scope with project, search, and archived filters', async () => {
      const narrowed = await agent.get(`/releases?asset=${assetId}&project=${projectId}&search=Beta`).expect(200);
      expect(releaseTitles(narrowed.text)).toEqual(['Beta Member']);

      const incompatible = await agent.get(`/releases?asset=${assetId}&project=${otherProjectId}`).expect(200);
      expect(releaseTitles(incompatible.text)).toEqual([]);
      expect(incompatible.text).toContain('No releases match the current filters');
      expect(incompatible.text).toContain('data-releases-reset');

      const archived = await agent
        .get(`/releases?asset=${assetId}&project=${projectId}&includeArchived=1&sort=title&order=asc`)
        .expect(200);
      expect(releaseTitles(archived.text)).toEqual(['Alpha Member', 'Archived Member', 'Beta Member']);
    });

    it('keeps releases of an archived parent project reachable through the asset scope', async () => {
      db.prepare("UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?").run(projectId);

      const scoped = await agent.get(`/releases?asset=${assetId}&project=${projectId}&includeArchived=1`).expect(200);
      expect(releaseTitles(scoped.text).sort()).toEqual(['Alpha Member', 'Archived Member', 'Beta Member']);
      const scheduled = await agent.get(`/releases?asset=${assetId}&includeArchived=1&schedule=unscheduled`).expect(200);
      expect(releaseTitles(scheduled.text)).toEqual([]);

      const unscoped = await agent.get('/releases?includeArchived=1').expect(200);
      expect(releaseTitles(unscoped.text)).toEqual(['Other Project Release']);
    });

    it('preserves the scope through pagination and saved-default redirects, and Reset clears it', async () => {
      for (let i = 0; i < 3; i++) {
        releaseRepository.addReleaseAsset(createRelease(projectId, `Paged ${i}`).id, assetId, 'primary', 0);
      }
      const first = await agent.get(`/releases?asset=${assetId}&pageSize=2&sort=title&order=asc`).expect(200);
      expect(first.text).toContain('5 releases found');
      const nextHref = first.text.match(/<a class="button" href="([^"]+)">Next<\/a>/)?.[1]?.replace(/&amp;/g, '&');
      expect(new URL(nextHref, 'http://x').searchParams.get('asset')).toBe(String(assetId));
      const second = await agent.get(nextHref).expect(200);
      expect(releaseTitles(second.text)).toEqual(['Paged 0', 'Paged 1']);

      // WP12: Reset filters (the installed authority's GET destination) drops
      // the scope and keeps only the URL page size.
      expect(releasesDefaultsAuthority(first.text)?.resetFiltersUrl).toBe('/releases?pageSize=2');
      const reset = await agent.get('/releases?pageSize=2').expect(200);
      expect(filterDialog(reset.text)).not.toContain('name="asset"');
      expect(filterDialog(reset.text)).not.toContain('data-releases-asset-scope');

      app.locals.pageDefaultsService.saveDefault('releases', 'sort', 'title');
      const redirected = await agent.get(`/releases?asset=${assetId}&includeArchived=1`).expect(302);
      expect(new URL(redirected.headers.location, 'http://x').searchParams.get('asset')).toBe(String(assetId));
    });

    // WP12: the combined dialog saves through JSON (the page keeps its own
    // scoped location); the native scoped success redirect is still honoured
    // for a fenced post that carries the scope in its query.
    it('keeps the scope through a Defaults save without making it a saved default', async () => {
      const page = await agent.get(`/releases?asset=${assetId}&project=${projectId}&includeArchived=1&page=1`).expect(200);
      expect(releasesDefaultsAuthority(page.text)?.currentUrl)
        .toBe(`/releases?asset=${assetId}&project=${projectId}&includeArchived=1`);
      expect(page.text).not.toMatch(/<form id="releases-defaults-form"[^>]*action=/);
      const action = `/releases/defaults?asset=${assetId}&project=${projectId}&includeArchived=1`;

      const saved = await agent
        .post(action)
        .type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, sort: 'title', order: 'desc' }))
        .expect(302);
      expect(saved.headers.location).toBe(
        `/releases?asset=${assetId}&project=${projectId}&includeArchived=1&sort=title&order=desc&notice=releases_defaults_saved`,
      );
      expect(releaseTitles((await agent.get(saved.headers.location).expect(200)).text))
        .toEqual(['Beta Member', 'Archived Member', 'Alpha Member']);

      const bare = await agent.get('/releases').expect(302);
      expect(bare.headers.location).toBe('/releases?sort=title&order=desc');
      const unscoped = await agent.get(bare.headers.location).expect(200);
      expect(releasesDefaultsAuthority(unscoped.text)?.currentUrl).toBe('/releases?sort=title&order=desc');
      expect(filterDialog(unscoped.text)).not.toContain('name="asset"');

      await agent.post('/releases/defaults?asset=abc').type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, sort: 'planned', order: 'asc' })).expect(400);
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(PAGE_DEFAULT_DEFINITIONS.releases.sort.key).value).toBe('title');
    });
  });

  describe('/releases repeated Project and Project Type filters (WP11)', () => {
    let comicA;
    let comicB;
    let animation;
    let images;
    let archivedComic;

    function createTypedProject(title, projectType, overrides = {}) {
      const id = insertProjectDirect(db, { title, ...overrides });
      db.prepare('UPDATE projects SET project_type = ? WHERE id = ?').run(projectType, id);
      return id;
    }

    function createRelease(ownerId, title, plannedDate = null) {
      return releaseRepository.create({ projectId: ownerId, title, description: '', notes: '', plannedDate });
    }

    function releaseTitles(html) {
      return [...extractReleasesResultsBody(html).matchAll(/<a href="\/releases\/\d+">([^<]+)<\/a>/g)]
        .map(([, title]) => title);
    }

    function filterDialog(html) {
      return html.match(/<dialog id="releases-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    }

    function decodeHref(href) {
      return href?.replace(/&amp;/g, '&');
    }

    function paginationHref(html, label) {
      return decodeHref(html.match(new RegExp(`<a class="button" href="([^"]+)">${label}</a>`))?.[1]);
    }

    // WP12: Reset filters is the installed page authority's GET destination.
    function resetAction(html) {
      return releasesDefaultsAuthority(html)?.resetFiltersUrl;
    }

    function searchParamsOf(href) {
      return new URL(href, 'http://x').searchParams;
    }

    beforeEach(() => {
      comicA = createTypedProject('WP11 Comic A', 'comic');
      comicB = createTypedProject('WP11 Comic B', 'comic');
      animation = createTypedProject('WP11 Animation', 'animation');
      images = createTypedProject('WP11 Images', 'images');
      archivedComic = createTypedProject('WP11 Archived Comic', 'comic', {
        status: 'archived', archivedAt: '2025-01-01T00:00:00Z',
      });
      createRelease(comicA, 'CA One', '2000-01-01');
      createRelease(comicA, 'CA Two', '2999-01-01');
      createRelease(comicB, 'CB One');
      createRelease(animation, 'AN One', '2000-01-02');
      createRelease(images, 'IM One');
      createRelease(archivedComic, 'AC One');
    });

    it('keeps the legacy single-Project URL as one checked Project in the multi-select', async () => {
      const res = await agent.get(`/releases?project=${comicB}`).expect(200);
      expect(releaseTitles(res.text)).toEqual(['CB One']);
      const projectField = extractReleaseFilterProjectField(res.text);
      expect(projectField).toContain('WP11 Comic B');
      expect(checkedValues(projectField, 'project')).toEqual([String(comicB)]);
      expect(projectField).toContain('aria-label="Projects filter: WP11 Comic B"');
      expect(checkedValues(extractReleaseFilterTypeField(res.text), 'type')).toEqual(['']);
      expect(filterDialog(res.text)).not.toMatch(/<input type="hidden" name="type"/);
    });

    it('renders every selected Project checked with the N projects selected summary', async () => {
      const res = await agent.get(`/releases?project=${comicB}&project=${comicA}&project=${archivedComic}`).expect(200);
      const projectField = extractReleaseFilterProjectField(res.text);
      expect(checkedValues(projectField, 'project').sort())
        .toEqual([comicA, comicB, archivedComic].map(String).sort());
      expect(projectField).toContain('aria-label="Projects filter: 3 projects selected"');
      // Unrestricted Select all is the empty value, unchecked while any
      // individual Project is checked.
      expect(projectField).toMatch(/name="project" type="checkbox" value="" data-cc-dropdown-select-all(?![^>]*checked)[^>]*>/);
      // Options come from the backend (active + selected historical), never
      // from the current results page.
      for (const title of ['WP11 Comic A', 'WP11 Comic B', 'WP11 Animation', 'WP11 Images', 'WP11 Archived Comic']) {
        expect(projectField).toContain(`>${title}</span>`);
      }
    });

    it('ORs two Projects, ignoring duplicates and order, with canonical repeated values', async () => {
      const [low, high] = [comicA, animation].sort((a, b) => a - b);
      const first = await agent.get(`/releases?project=${high}&project=${low}&project=${high}&sort=title&order=asc`).expect(200);
      const second = await agent.get(`/releases?project=${low}&project=${high}&sort=title&order=asc`).expect(200);
      expect(releaseTitles(first.text)).toEqual(['AN One', 'CA One', 'CA Two']);
      expect(releaseTitles(second.text)).toEqual(releaseTitles(first.text));
      expect(first.text).toContain('3 releases found');

      const reset = resetAction(first.text);
      expect(reset).toBe('/releases');
      expect(checkedValues(extractReleaseFilterProjectField(first.text), 'project').sort())
        .toEqual([String(low), String(high)].sort());
      expect(decodeHref(releasesDefaultsAuthority(first.text)?.currentUrl))
        .toBe(`/releases?project=${low}&project=${high}&sort=title`);
    });

    it('keeps unknown Project IDs restrictive and drops malformed values individually', async () => {
      const unknown = await agent.get('/releases?project=999999').expect(200);
      expect(releaseTitles(unknown.text)).toEqual([]);
      expect(unknown.text).toContain('No releases match the current filters');

      const mixed = await agent.get(`/releases?project=999999&project=${images}`).expect(200);
      expect(releaseTitles(mixed.text)).toEqual(['IM One']);

      const malformed = await agent.get(`/releases?project=abc&project=${images}&project=1junk`).expect(200);
      expect(releaseTitles(malformed.text)).toEqual(['IM One']);

      // Established fallback: a lone malformed value is unrestricted.
      const loneMalformed = await agent.get('/releases?project=abc&sort=title&order=asc').expect(200);
      expect(releaseTitles(loneMalformed.text)).toEqual(['AN One', 'CA One', 'CA Two', 'CB One', 'IM One']);
    });

    it('keeps a selected historical (archived) Project in the options without listing its releases', async () => {
      const res = await agent.get(`/releases?project=${archivedComic}&project=${comicB}`).expect(200);
      expect(releaseTitles(res.text)).toEqual(['CB One']);
      const projectField = extractReleaseFilterProjectField(res.text);
      expect(projectField).toContain('WP11 Archived Comic');
      expect(projectField).toContain('WP11 Comic B');
      expect(projectField).not.toContain('999999');
    });

    it('filters one or more Project Types by catalogue value and drops stale values', async () => {
      // WP12: the visible Project Types multi-select is the one authority for
      // `type` (the WP11 hidden compatibility inputs are retired).
      const one = await agent.get('/releases?type=comic&sort=title&order=asc').expect(200);
      expect(releaseTitles(one.text)).toEqual(['CA One', 'CA Two', 'CB One']);
      const oneField = extractReleaseFilterTypeField(one.text);
      expect(checkedValues(oneField, 'type')).toEqual(['comic']);
      expect(filterDialog(one.text)).not.toMatch(/<input type="hidden" name="type"/);
      expect(filterDialog(one.text).match(/name="type"[^>]*value="comic"/g)).toHaveLength(1);

      const two = await agent.get('/releases?type=comic&type=animation&type=comic&sort=title&order=asc').expect(200);
      expect(releaseTitles(two.text)).toEqual(['AN One', 'CA One', 'CA Two', 'CB One']);
      const twoField = extractReleaseFilterTypeField(two.text);
      expect(checkedValues(twoField, 'type').sort()).toEqual(['animation', 'comic']);
      expect(twoField).toContain('aria-label="Project Types filter: 2 types selected"');
      // Options are the catalogue's stable values with their display labels.
      const catalogue = app.locals.projectOptionCatalogueService.getProjectTypeCatalogue();
      expect([...twoField.matchAll(/name="type" type="checkbox" value="([^"]+)"/g)].map(([, value]) => value))
        .toEqual(catalogue.map(({ value }) => value));

      const stale = await agent.get('/releases?type=no-such-type&type=Comic&sort=title&order=asc').expect(200);
      expect(releaseTitles(stale.text)).toEqual(['AN One', 'CA One', 'CA Two', 'CB One', 'IM One']);
      expect(checkedValues(extractReleaseFilterTypeField(stale.text), 'type')).toEqual(['']);
      expect(extractReleaseFilterTypeField(stale.text)).toContain('aria-label="Project Types filter: All types"');
    });

    it('ANDs Projects with Types and composes with search, schedule and include archived', async () => {
      const base = `project=${comicA}&project=${images}&type=comic&type=animation`;
      const combined = await agent.get(`/releases?${base}&sort=title&order=asc`).expect(200);
      expect(releaseTitles(combined.text)).toEqual(['CA One', 'CA Two']);

      const searched = await agent.get(`/releases?${base}&search=Two`).expect(200);
      expect(releaseTitles(searched.text)).toEqual(['CA Two']);

      const scheduled = await agent.get(`/releases?${base}&schedule=overdue`).expect(200);
      expect(releaseTitles(scheduled.text)).toEqual(['CA One']);

      const archivedRelease = releaseRepository.findPage({ search: 'CA Two', today: '2025-01-01' })[0];
      releaseRepository.archive(archivedRelease.id);
      const active = await agent.get(`/releases?${base}`).expect(200);
      expect(releaseTitles(active.text)).toEqual(['CA One']);
      const withArchived = await agent.get(`/releases?${base}&includeArchived=1&sort=title&order=asc`).expect(200);
      expect(releaseTitles(withArchived.text)).toEqual(['CA One', 'CA Two']);

      const empty = await agent.get(`/releases?project=${images}&type=comic`).expect(200);
      expect(releaseTitles(empty.text)).toEqual([]);
      expect(empty.text).toContain('No releases match the current filters');
    });

    it('treats a multi-Project or Type-only selection as active filters in the empty state', async () => {
      const multi = await agent.get(`/releases?project=${images}&project=999999&search=nomatch`).expect(200);
      expect(multi.text).toContain('No releases match the current filters');
      const multiOnly = await agent.get('/releases?project=999998&project=999999').expect(200);
      expect(multiOnly.text).toContain('No releases match the current filters');
      const typeOnly = await agent.get('/releases?type=wallpaper').expect(200);
      expect(typeOnly.text).toContain('No releases match the current filters');
    });

    it('agrees on count and pages and preserves every selection through pagination and sort', async () => {
      for (let i = 0; i < 3; i++) {
        createRelease(comicB, `CB Extra ${i}`);
        createRelease(images, `IM Extra ${i}`);
      }
      const query = `project=${comicB}&project=${comicA}&type=comic&type=animation&pageSize=2&sort=title&order=asc&search=C`;
      const first = await agent.get(`/releases?${query}`).expect(200);
      expect(first.text).toContain('6 releases found');
      expect(releaseTitles(first.text)).toEqual(['CA One', 'CA Two']);

      const nextHref = paginationHref(first.text, 'Next');
      const params = searchParamsOf(nextHref);
      expect(params.getAll('project')).toEqual([String(Math.min(comicA, comicB)), String(Math.max(comicA, comicB))]);
      expect(params.getAll('type')).toEqual(['animation', 'comic']);
      expect(params.get('pageSize')).toBe('2');
      expect(params.get('sort')).toBe('title');
      // `asc` is the Releases order fallback, so the canonical URL omits it.
      expect(params.has('order')).toBe(false);
      expect(params.get('search')).toBe('C');
      expect(params.get('page')).toBe('2');
      expect(nextHref).not.toContain('%2C');

      const second = await agent.get(nextHref).expect(200);
      expect(releaseTitles(second.text)).toEqual(['CB Extra 0', 'CB Extra 1']);
      const third = await agent.get(paginationHref(second.text, 'Next')).expect(200);
      expect(releaseTitles(third.text)).toEqual(['CB Extra 2', 'CB One']);
      expect(paginationHref(third.text, 'Next')).toBeUndefined();
      const previousParams = searchParamsOf(paginationHref(third.text, 'Previous'));
      expect(previousParams.getAll('project')).toHaveLength(2);
      expect(previousParams.getAll('type')).toEqual(['animation', 'comic']);

      // Out-of-range page clamps to the last filtered page.
      const clamped = await agent.get(`/releases?${query}&page=99`).expect(200);
      expect(releaseTitles(clamped.text)).toEqual(['CB Extra 2', 'CB One']);

      // Hidden page-size input and Reset keep page size but clear Project/Type.
      expect(filterDialog(first.text)).toContain('<input type="hidden" name="pageSize" value="2">');
      expect(resetAction(first.text)).toBe('/releases?pageSize=2');
    });

    it('preserves repeated selections through a saved-default redirect', async () => {
      app.locals.pageDefaultsService.saveDefault('releases', 'sort', 'title');
      const redirected = await agent.get(`/releases?project=${comicA}&project=${comicB}&type=comic`).expect(302);
      const params = searchParamsOf(redirected.headers.location);
      expect(params.getAll('project')).toEqual([String(Math.min(comicA, comicB)), String(Math.max(comicA, comicB))]);
      expect(params.getAll('type')).toEqual(['comic']);
      expect(params.get('sort')).toBe('title');
    });

    it('keeps exact-asset scope restrictive with repeated Projects and Types', async () => {
      const assetId = insertAssetDirect(db, comicA, 'wp11-scope.png').id;
      const member = releaseRepository.findPage({ search: 'CA One', today: '2025-01-01' })[0];
      releaseRepository.addReleaseAsset(member.id, assetId, 'primary', 0);
      const foreign = releaseRepository.findPage({ search: 'CB One', today: '2025-01-01' })[0];
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(foreign.id, assetId, 'attachment', 0);

      const oneProject = await agent.get(`/releases?asset=${assetId}&project=${comicA}`).expect(200);
      expect(releaseTitles(oneProject.text)).toEqual(['CA One']);
      const twoProjects = await agent.get(`/releases?asset=${assetId}&project=${comicA}&project=${comicB}`).expect(200);
      expect(releaseTitles(twoProjects.text)).toEqual(['CA One']);
      const otherProjects = await agent.get(`/releases?asset=${assetId}&project=${comicB}&project=${images}`).expect(200);
      expect(releaseTitles(otherProjects.text)).toEqual([]);
      const typed = await agent.get(`/releases?asset=${assetId}&type=comic&type=images`).expect(200);
      expect(releaseTitles(typed.text)).toEqual(['CA One']);
      const wrongType = await agent.get(`/releases?asset=${assetId}&type=images`).expect(200);
      expect(releaseTitles(wrongType.text)).toEqual([]);
      const scheduled = await agent.get(`/releases?asset=${assetId}&type=comic&schedule=overdue`).expect(200);
      expect(releaseTitles(scheduled.text)).toEqual(['CA One']);
      const upcoming = await agent.get(`/releases?asset=${assetId}&type=comic&schedule=upcoming`).expect(200);
      expect(releaseTitles(upcoming.text)).toEqual([]);

      db.prepare("UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?").run(comicA);
      const historical = await agent.get(`/releases?asset=${assetId}&project=${comicA}&project=${comicB}&type=comic&includeArchived=1`).expect(200);
      expect(releaseTitles(historical.text)).toEqual(['CA One']);

      await agent.get(`/releases?asset=abc&project=${comicA}&project=${comicB}`).expect(400);
      await agent.get(`/releases?asset=999999&type=comic`).expect(404);
    });

    it('carries repeated selections through an asset-scoped defaults save and its Reset defaults refresh', async () => {
      const assetId = insertAssetDirect(db, comicA, 'wp11-defaults.png').id;
      for (const title of ['CA One', 'CA Two']) {
        const release = releaseRepository.findPage({ search: title, today: '2025-01-01' })[0];
        releaseRepository.addReleaseAsset(release.id, assetId, 'primary', 0);
      }
      const [low, high] = [comicA, comicB].sort((a, b) => a - b);
      const page = await agent.get(`/releases?asset=${assetId}&project=${high}&project=${low}&type=comic&type=animation`).expect(200);
      const currentUrl = releasesDefaultsAuthority(page.text)?.currentUrl;
      expect(currentUrl).toBe(`/releases?asset=${assetId}&project=${low}&project=${high}&type=animation&type=comic`);
      const action = currentUrl.replace('/releases?', '/releases/defaults?');

      const saved = await agent.post(action).type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, sort: 'title', order: 'desc' })).expect(302);
      expect(saved.headers.location).toBe(
        `/releases?asset=${assetId}&project=${low}&project=${high}&type=animation&type=comic&sort=title&order=desc&notice=releases_defaults_saved`,
      );
      expect(releaseTitles((await agent.get(saved.headers.location).expect(200)).text)).toEqual(['CA Two', 'CA One']);
      // Only sort/order became saved defaults.
      const savedKeys = db.prepare("SELECT key FROM app_meta WHERE key LIKE 'page_defaults.releases.%'").all()
        .map(({ key }) => key).sort();
      expect(savedKeys).toEqual([PAGE_DEFAULT_DEFINITIONS.releases.order.key, PAGE_DEFAULT_DEFINITIONS.releases.sort.key].sort());

      // WP12 Reset defaults keeps the scope and every repeated selection.
      const reset = await agent.post('/releases/defaults/reset').set('Accept', 'application/json').type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, defaultsOperation: 'op-wp12', returnTo: saved.headers.location }))
        .expect(200);
      expect(reset.body.refreshUrl)
        .toBe(`/releases?asset=${assetId}&project=${low}&project=${high}&type=animation&type=comic`);
      expect(db.prepare("SELECT key FROM app_meta WHERE key LIKE 'page_defaults.releases.%'").all()).toEqual([]);
    });

    // C1-A: nested query keys (`project[1][]=2`) parse to ['1', ['2']]. A nested
    // entry must be dropped, never stringified into an extra selected Project.
    describe('nested Project query entries (C1-A)', () => {
      const enc = (key) => key.replace(/\[/g, '%5B').replace(/\]/g, '%5D');

      async function listed(query) {
        const res = await agent.get(`/releases?${query}&sort=title`).expect(200);
        return {
          titles: releaseTitles(res.text),
          text: res.text,
          checked: checkedValues(extractReleaseFilterProjectField(res.text), 'project'),
          currentUrl: releasesDefaultsAuthority(res.text)?.currentUrl,
        };
      }

      it('keeps legacy, repeated, duplicate and reordered flat Projects working', async () => {
        const [low, high] = [comicA, animation].sort((a, b) => a - b);
        const single = await listed(`project=${comicA}`);
        expect(single.titles).toEqual(['CA One', 'CA Two']);
        expect(single.currentUrl).toBe(`/releases?project=${comicA}&sort=title`);

        for (const query of [
          `project=${low}&project=${high}`,
          `project=${high}&project=${low}`,
          `project=${high}&project=${low}&project=${high}&project=${low}`,
        ]) {
          const result = await listed(query);
          expect(result.titles).toEqual(['AN One', 'CA One', 'CA Two']);
          expect(result.text).toContain('3 releases found');
          expect(result.currentUrl).toBe(`/releases?project=${low}&project=${high}&sort=title`);
        }
      });

      it('does not coerce the reviewed nested reproduction into a second Project', async () => {
        // Reviewed: project[0]=A&project[1][]=B previously returned A's and B's releases.
        const result = await listed(`${enc('project[0]')}=${comicA}&${enc('project[1][]')}=${animation}`);
        expect(result.titles).toEqual(['CA One', 'CA Two']);
        expect(result.titles).not.toContain('AN One');
        expect(result.text).toContain('2 releases found');
        expect(result.checked).toEqual([String(comicA)]);
        expect(result.currentUrl).toBe(`/releases?project=${comicA}&sort=title`);
      });

      it('drops nested arrays and objects carrying numeric-looking IDs alongside a valid scalar', async () => {
        for (const nested of [
          `${enc('project[1][]')}=${animation}`, // nested array
          `${enc('project[1][0]')}=${animation}`, // nested indexed array
          `${enc('project[1][x]')}=${animation}`, // nested object
        ]) {
          const result = await listed(`${enc('project[0]')}=${comicA}&${nested}`);
          expect(result.titles).toEqual(['CA One', 'CA Two']);
          expect(result.checked).toEqual([String(comicA)]);
          expect(result.currentUrl).toBe(`/releases?project=${comicA}&sort=title`);
        }
        // Repeated flat scalar plus a nested entry: the flat values alone remain.
        const [low, high] = [comicA, images].sort((a, b) => a - b);
        const mixed = await listed(`project=${high}&project=${low}&${enc('project[2][]')}=${animation}`);
        expect(mixed.titles).toEqual(['CA One', 'CA Two', 'IM One']);
        expect(mixed.titles).not.toContain('AN One');
        expect(mixed.currentUrl).toBe(`/releases?project=${low}&project=${high}&sort=title`);
      });

      it('keeps the malformed/unsafe policy and unknown-Project restriction with nested entries', async () => {
        // Unsafe and malformed scalars are dropped individually beside a valid one.
        const unsafe = await listed(`project=9007199254740993&project=1junk&project=${comicB}`);
        expect(unsafe.titles).toEqual(['CB One']);
        expect(unsafe.currentUrl).toBe(`/releases?project=${comicB}&sort=title`);
        // A valid but unknown ID stays restrictive; the nested entry cannot widen it.
        const unknown = await listed(`project=999999&${enc('project[1][]')}=${comicA}`);
        expect(unknown.titles).toEqual([]);
        expect(unknown.text).toContain('0 releases found');
        expect(unknown.currentUrl).toBe('/releases?project=999999&sort=title');
        // Only nested (malformed) entries: the established lone-malformed
        // fallback (no Project restriction), never the nested ID alone.
        const nestedOnly = await listed(`${enc('project[0][]')}=${animation}`);
        expect(nestedOnly.checked).toEqual(['']);
        expect(nestedOnly.currentUrl).toBe('/releases?sort=title');
      });
    });

    it('preserves the canonical temporary filters on a native defaults save without asset scope', async () => {
      createRelease(comicA, 'Match Comic', '2999-01-01');
      releaseRepository.archive(createRelease(comicA, 'Match Archived', '2999-01-01').id);
      createRelease(animation, 'Match Animation', '2999-01-02');
      createRelease(comicB, 'Match Other Project', '2999-01-02');
      createRelease(comicA, 'Match Unscheduled');
      createRelease(animation, 'Different Title', '2999-01-02');

      const context = new URLSearchParams([
        ['search', ' Match '], ['project', String(animation)], ['project', ''], ['project', String(comicA)],
        ['project', 'bad'], ['type', 'comic'], ['type', ''], ['type', 'animation'], ['type', 'unknown'],
        ['schedule', 'upcoming'], ['includeArchived', '1'], ['pageSize', '1'], ['page', '2'],
        ['sort', 'created'], ['order', 'asc'], ['notice', 'untrusted notice'],
      ]);
      const action = `/releases/defaults?${context}`;
      const form = new URLSearchParams(withReleasesDefaultsGeneration({
        _csrf: csrfToken, sort: 'title', order: 'desc', defaultsOperation: 'native-save',
        returnTo: 'https://example.invalid/releases?search=untrusted',
        search: 'ignore body search', project: String(comicB), asset: '12345', pageSize: '100',
      }));

      const missingGeneration = new URLSearchParams(form);
      missingGeneration.delete('defaultsGeneration');
      await agent.post(action).type('form').send(missingGeneration.toString()).expect(409);
      const invalidCsrf = new URLSearchParams(form);
      invalidCsrf.set('_csrf', 'invalid');
      await agent.post(action).type('form').send(invalidCsrf.toString()).expect(403);
      expect(app.locals.pageDefaultsService.getMutationGeneration('releases')).toBe(0);
      expect(storedReleasesDefault('sort')).toBeUndefined();
      expect(storedReleasesDefault('order')).toBeUndefined();

      const saved = await agent.post(action).set('Accept', 'text/html').type('form').send(form.toString()).expect(302);
      const expectedContext = `/releases?search=Match&project=${comicA}&project=${animation}&type=animation&type=comic`
        + '&schedule=upcoming&includeArchived=1';
      expect(saved.headers.location).toBe(
        expectedContext + '&pageSize=1&sort=title&order=desc&notice=releases_defaults_saved',
      );
      const followed = await agent.get(saved.headers.location).expect(200);
      expect(releaseTitles(followed.text)).toEqual(['Match Comic']);
      expect(followed.text).toContain('2 releases found');
      expect(followed.text).toContain('Releases defaults saved successfully.');
      expect(followed.text).not.toContain('untrusted notice');
      const next = paginationHref(followed.text, 'Next');
      expect(next).toBe(expectedContext + '&sort=title&order=desc&pageSize=1&page=2');
      expect(releaseTitles((await agent.get(next).expect(200)).text)).toEqual(['Match Animation']);

      expect(db.prepare("SELECT key, value FROM app_meta WHERE key LIKE 'page_defaults.releases.%' ORDER BY key").all())
        .toEqual([
          { key: PAGE_DEFAULT_DEFINITIONS.releases.order.key, value: 'desc' },
          { key: PAGE_DEFAULT_DEFINITIONS.releases.sort.key, value: 'title' },
        ]);
      expect(app.locals.pageDefaultsService.getMutationGeneration('releases')).toBe(1);
    });

    it('uses the Releases GET normalization for unsupported native defaults context', async () => {
      const action = '/releases/defaults?search=+++&project=99999&project=0&type=unknown'
        + '&schedule=unknown&includeArchived=true&pageSize=1junk&page=9';
      const saved = await agent.post(action).type('form').send(withReleasesDefaultsGeneration({
        _csrf: csrfToken, sort: 'planned', order: 'asc', defaultsOperation: 'native-normalization',
      })).expect(302);

      expect(saved.headers.location).toBe('/releases?project=99999&sort=planned&order=asc&notice=releases_defaults_saved');
      expect(releaseTitles((await agent.get(saved.headers.location).expect(200)).text)).toEqual([]);
    });

    // C1-B: the legacy native asset-scoped defaults POST redirects with the
    // canonical Project/Type selections, not the submitted duplicates/empties.
    it('normalizes repeated Project/Type selections in the legacy asset-scoped defaults redirect', async () => {
      const assetId = insertAssetDirect(db, comicA, 'c1b-defaults.png').id;
      for (const title of ['CA One', 'CA Two', 'IM One', 'AN One']) {
        const release = releaseRepository.findPage({ search: title, today: '2025-01-01' })[0];
        db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
          .run(release.id, assetId, 'attachment', 0);
      }
      const [low, high] = [comicA, images].sort((a, b) => a - b);
      const context = new URLSearchParams([
        ['asset', String(assetId)],
        ['project', String(high)], ['project', String(low)], ['project', String(high)],
        ['type', 'images'], ['type', ''], ['type', 'comic'], ['type', 'images'],
        ['search', 'One'], ['includeArchived', '1'], ['pageSize', '10'], ['page', '3'],
      ]);
      const saved = await agent.post(`/releases/defaults?${context.toString()}`).type('form')
        .send(withReleasesDefaultsGeneration({ _csrf: csrfToken, sort: 'title', order: 'desc' }))
        .expect(302);

      const location = saved.headers.location;
      expect(location).toBe(
        `/releases?asset=${assetId}&search=One&project=${low}&project=${high}&type=comic&type=images`
          + '&includeArchived=1&pageSize=10&sort=title&order=desc&notice=releases_defaults_saved',
      );
      const params = searchParamsOf(location);
      expect(params.getAll('asset')).toEqual([String(assetId)]);
      expect(params.getAll('project')).toEqual([String(low), String(high)]);
      expect(params.getAll('type')).toEqual(['comic', 'images']);
      expect(location).not.toMatch(/%2C|,/);
      expect(location).not.toMatch(/type=(&|$)/);

      // The resulting GET is the intended restricted subset: the exact asset
      // scope (its own Project only), the selected Projects/Types and Search
      // ('One') together leave CA One; foreign-Project links never leak in.
      const followed = await agent.get(location).expect(200);
      expect(releaseTitles(followed.text)).toEqual(['CA One']);
      expect(followed.text).toContain('1 release found containing asset <strong>c1b-defaults.png</strong>');

      // Only Sort and Order became saved defaults.
      const savedKeys = db.prepare("SELECT key FROM app_meta WHERE key LIKE 'page_defaults.releases.%'").all()
        .map(({ key }) => key).sort();
      expect(savedKeys).toEqual([PAGE_DEFAULT_DEFINITIONS.releases.order.key, PAGE_DEFAULT_DEFINITIONS.releases.sort.key].sort());
    });

    it('re-renders a failed New Release with the repeated list context', async () => {
      const returnTo = `/releases?project=${comicA}&project=${animation}&type=comic`;
      const res = await agent
        .post('/releases')
        .type('form')
        .send({ _csrf: csrfToken, projectId: String(comicA), title: '', returnTo })
        .expect(422);
      expect(releaseTitles(res.text).sort()).toEqual(['CA One', 'CA Two']);
      expect(checkedValues(extractReleaseFilterTypeField(res.text), 'type')).toEqual(['comic']);
      expect(checkedValues(extractReleaseFilterProjectField(res.text), 'project').sort())
        .toEqual([String(comicA), String(animation)].sort());
    });
  });

  describe('shared buildPageUrl array serialization (WP11)', () => {
    it('serializes scalar queries exactly like URLSearchParams(object) for legacy callers', async () => {
      const { buildPageUrl } = await import('../src/routes/releases.js');
      const scalar = { month: '2025-06', status: 'planned', weekStart: 'sunday', view: 'list', project: '7' };
      const pageUrl = buildPageUrl({ baseUrl: '/calendar', path: '/' }, scalar);
      expect(pageUrl({})).toBe(`/calendar?${new URLSearchParams(scalar).toString()}`);
      expect(pageUrl({ month: '2025-07' })).toBe('/calendar?month=2025-07&status=planned&weekStart=sunday&view=list&project=7');
      expect(pageUrl({ project: null, page: 1 })).toBe('/calendar?month=2025-06&status=planned&weekStart=sunday&view=list');
    });

    it('serializes arrays as repeated values and never comma-joins', async () => {
      const { buildPageUrl } = await import('../src/routes/releases.js');
      const pageUrl = buildPageUrl({ baseUrl: '/releases', path: '/' }, { project: ['7', '12'], type: ['comic', 'images'], search: 'a b&c' });
      expect(pageUrl({ page: 2 })).toBe('/releases?project=7&project=12&type=comic&type=images&search=a+b%26c&page=2');
      expect(pageUrl({ type: null })).toBe('/releases?project=7&project=12&search=a+b%26c');
      expect(pageUrl({ project: ['3'] })).toBe('/releases?project=3&type=comic&type=images&search=a+b%26c');
    });
  });

  it('new-release form ignores status defaults and query parameters', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Saved+New+Release+Default')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const saved = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
    expect(saved.text).not.toContain('id="status"');

    const explicit = await agent.get(`/releases/new?projectId=${projectId}&status=planned`).expect(200);
    expect(explicit.text).not.toContain('id="status"');
  });

  it('new-release form does not render a status field when stored status defaults are invalid', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Fallback+New+Release+Default')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const key = 'page_defaults.new_release.status';
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, 'cancelled');

    const invalid = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
    expect(invalid.text).not.toContain('id="status"');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key).value).toBe('cancelled');
  });

  it('failed create redisplays values without rendering the submitted status', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Failed+Create+Status')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');
    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=')
      .send('status=ready')
      .send('plannedDate=2026-12-01')
      .send('plannedTime=09:45')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).not.toContain('id="status"');
    expect(res.text).toContain('value="2026-12-01"');
    expect(res.text).toContain('value="09:45"');
  });

  it('successful create ignores a submitted status and persists no release status field', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Successful+Create+Status')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');
    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Submitted+Release+Status')
      .send('status=ready')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(res.headers.location.replace('/releases/', ''));
    expect(releaseRepository.findById(releaseId)).not.toHaveProperty('status');
  });

  it('valid create request redirects to detail', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Create+Redirect+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Test+Release')
      .send('description=A+test+release')
      .send('status=tbd')
      .send('plannedDate=2026-12-01')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    expect(res.headers.location).toMatch(/^\/releases\/\d+$/);
    expect(getReleaseAssets(db, Number(res.headers.location.replace('/releases/', '')))).toEqual([]);
  });

  describe('selected assets in normal create submission', () => {
    it('preserves submitted metadata, uses the selected project, attaches all assets, and deduplicates IDs', async () => {
      const projectId = await createTestProject('Selected Release Project');
      const first = insertAssetDirect(db, projectId, 'first.png');
      const second = insertAssetDirect(db, projectId, 'second.png');
      const title = 'Custom Selected Release';
      const notes = 'Notes remain exactly: line 1\nline 2 & <tag>';

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send(`title=${encodeURIComponent(title)}`)
        .send('releaseCreateFlow=selected-assets')
        .send('description=Selected+release+description')
        .send(`notes=${encodeURIComponent(notes)}`)
        .send('plannedDate=2026-12-01')
        .send('plannedTime=09:45')
        .send('publishedDate=2026-12-15')
        .send('patreonUrl=https%3A%2F%2Fexample.com%2Fselected-release')
        .send(`selectedAssetIds=${second.id}`)
        .send(`selectedAssetIds=${first.id}`)
        .send(`selectedAssetIds=${second.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const releaseId = Number(res.headers.location.split('/')[2]);
      expect(res.headers.location).toBe(`/releases/${releaseId}/assets`);
      expect(releaseRepository.findById(releaseId)).toMatchObject({
        project_id: projectId,
        title,
        description: 'Selected release description',
        notes,
        planned_date: '2026-12-01',
        planned_time: '09:45',
         published_date: null,
         patreon_url: 'https://example.com/selected-release',
       });
      expect(getReleaseAssets(db, releaseId).map(({ asset_id, role, sort_order }) => ({
        asset_id,
        role,
        sort_order,
      }))).toEqual([
        { asset_id: second.id, role: 'attachment', sort_order: 0 },
        { asset_id: first.id, role: 'attachment', sort_order: 1 },
      ]);
      expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toHaveLength(1);
    });

    describe('in-place JSON creation from Project Assets', () => {
      const postSelected = (fields) => {
        let request = agent.post('/releases').set('Accept', 'application/json')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('releaseCreateFlow=selected-assets');
        fields.forEach((field) => { request = request.send(field); });
        return request;
      };

      it('creates and associates in submitted order and returns authoritative links', async () => {
        const projectId = await createTestProject('Selected JSON Project');
        const first = insertAssetDirect(db, projectId, 'first.png');
        const second = insertAssetDirect(db, projectId, 'second.png');

        const res = await postSelected([
          `projectId=${projectId}`, 'title=JSON+Selected',
          `selectedAssetIds=${second.id}`, `selectedAssetIds=${first.id}`, `selectedAssetIds=${second.id}`,
        ]).expect(201);

        const releaseId = res.body.release.id;
        expect(res.body).toMatchObject({
          status: 'success',
          message: 'Release “JSON Selected” created with 2 assets.',
          release: { projectId, url: `/releases/${releaseId}`, manageAssetsUrl: `/releases/${releaseId}/assets` },
          values: { projectId: String(projectId), title: 'Selected JSON Project', notes: '', patreonUrl: '', selectedPlatforms: [] },
        });
        expect(getReleaseAssets(db, releaseId).map(({ asset_id }) => asset_id)).toEqual([second.id, first.id]);
      });

      it('refuses every invalid selection or project as JSON without creating anything', async () => {
        const projectId = await createTestProject('Selected JSON Validation');
        const present = insertAssetDirect(db, projectId, 'present.png');
        const missing = insertAssetDirect(db, projectId, 'missing.png', 0);
        const foreign = insertAssetDirect(db, await createTestProject('Selected JSON Foreign'), 'foreign.png');
        const archivedProjectId = await createTestProject('Selected JSON Archived');
        const archivedAsset = insertAssetDirect(db, archivedProjectId, 'archived.png');
        await agent.post(`/projects/${archivedProjectId}/archive`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
        const releaseTotal = () => db.prepare('SELECT COUNT(*) AS count FROM releases').get().count;
        const before = releaseTotal();

        const cases = [
          [[`projectId=${projectId}`, 'title=Empty'], 'At least one asset must be selected.'],
          [[`projectId=${projectId}`, 'title=Bad', 'selectedAssetIds=abc'], 'Asset IDs must be positive integers.'],
          [[`projectId=${projectId}`, 'title=Missing', `selectedAssetIds=${missing.id}`], `Asset ${missing.id} is currently missing`],
          [[`projectId=${projectId}`, 'title=Foreign', `selectedAssetIds=${foreign.id}`], `Asset ${foreign.id} does not belong`],
          [[`projectId=${projectId}`, 'title=Gone', 'selectedAssetIds=999999'], 'Update the selection on Project Assets'],
        ];
        for (const [fields, expected] of cases) {
          const res = await postSelected(fields).expect(422);
          expect(res.body).toMatchObject({ status: 'error', code: 'VALIDATION_FAILED' });
          expect(res.body.message).toContain(expected);
        }

        const invalidField = await postSelected([`projectId=${projectId}`, 'title=', `selectedAssetIds=${present.id}`]).expect(422);
        expect(invalidField.body.errors.title).toBeTruthy();
        const archived = await postSelected([`projectId=${archivedProjectId}`, 'title=Archived', `selectedAssetIds=${archivedAsset.id}`]).expect(422);
        expect(archived.body.errors.projectId).toBe('Cannot create release for archived project.');
        const noProject = await postSelected(['title=None', `selectedAssetIds=${present.id}`]).expect(422);
        expect(noProject.body.errors.projectId).toBeTruthy();

        expect(releaseTotal()).toBe(before);
      });

      it('answers an unexpected failure without backend detail', async () => {
        const projectId = await createTestProject('Selected JSON Failure');
        const asset = insertAssetDirect(db, projectId, 'asset.png');
        const stubbedApp = createApp(
          { appName: 'CreatorCrate', db, projectsRoot },
          {
            releaseService: {
              ...createReleaseService({ db }),
              createReleaseWithSelectedAssets() {
                throw new Error('SQLITE_BUSY secret path');
              },
            },
            appDataRoot,
            authState: { csrfPepper: ensureAuthEnablement(appDataRoot).csrfPepper },
          },
        );
        const { agent: stubbedAgent, csrfToken: stubbedCsrfToken } = await getDisabledModeCsrf(stubbedApp, appDataRoot);
        const res = await stubbedAgent.post('/releases').set('Accept', 'application/json')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send('_csrf=' + encodeURIComponent(stubbedCsrfToken))
          .send('releaseCreateFlow=selected-assets')
          .send(`projectId=${projectId}`)
          .send('title=Boom')
          .send(`selectedAssetIds=${asset.id}`)
          .expect(500);
        expect(res.body).toEqual({
          status: 'error', code: 'SERVER_ERROR', message: 'Release creation failed. Please try again.', errors: {},
        });
      });
    });

    it('returns controlled validation for empty, malformed, stale, missing, and cross-project selections', async () => {
      const projectId = await createTestProject('Selected Validation Project');
      const missing = insertAssetDirect(db, projectId, 'missing.png', 0);
      const otherProjectId = await createTestProject('Selected Foreign Project');
      const foreign = insertAssetDirect(db, otherProjectId, 'foreign.png');
      const cases = [
        { value: '', message: 'At least one asset must be selected.' },
        { value: 'not-an-id', message: 'Asset IDs must be positive integers.' },
        { value: '999999', message: 'Asset 999999 not found' },
        { value: String(missing.id), message: 'currently missing and cannot be selected' },
        { value: String(foreign.id), message: 'does not belong to the specified project' },
      ];

      for (const { value, message } of cases) {
        const res = await agent
          .post('/releases')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`projectId=${projectId}`)
          .send('title=Rejected+Selected+Release')
          .send('releaseCreateFlow=selected-assets')
          .send(`selectedAssetIds=${value}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).toContain(message);
        expect(res.text).toContain('name="releaseCreateFlow" value="selected-assets"');
        expect(res.text).not.toMatch(/name="selectedAssetIds"/);
        expect(res.text).toMatch(/data-dialog-submit disabled/);
        expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toEqual([]);
      }
    });

    it('rejects malformed selectedAssetIds shapes without creating a release', async () => {
      const projectId = await createTestProject('Malformed Selected Shape Project');

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Malformed+Selected+Shape+Release')
        .send('releaseCreateFlow=selected-assets')
        .send('selectedAssetIds[0][]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain('Invalid asset selection format.');
      expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toEqual([]);
    });
  });

  describe('No set release date create submission', () => {
    function postCreate(fields) {
      let req = agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken));
      for (const field of fields) req = req.send(field);
      return req.set('Content-Type', 'application/x-www-form-urlencoded');
    }

    function renderedScheduleValues(html) {
      return {
        plannedDate: html.match(/id="plannedDate" name="plannedDate" value="([^"]*)"/)?.[1],
        plannedTime: html.match(/id="plannedTime" name="plannedTime" value="([^"]*)"/)?.[1],
      };
    }

    it('persists NULL planned date/time and ignores stale or invalid schedule fields', async () => {
      const projectId = await createTestProject('Undated Release Project');

      const res = await postCreate([
        `projectId=${projectId}`,
        'title=Undated+Release',
        'noSetReleaseDate=1',
        'plannedDate=not-a-date',
        'plannedTime=99:99',
        'retainedPlannedDate=also-not-a-date',
        'retainedPlannedTime=25:61',
      ]).expect(302);

      const releaseId = Number(res.headers.location.split('/')[2]);
      expect(res.headers.location).toBe(`/releases/${releaseId}`);
      expect(releaseRepository.findById(releaseId)).toMatchObject({
        planned_date: null,
        planned_time: null,
      });
    });

    it('persists NULL planned date/time for selected-assets creation', async () => {
      const projectId = await createTestProject('Undated Selected Project');
      const asset = insertAssetDirect(db, projectId, 'undated.png');

      const res = await postCreate([
        `projectId=${projectId}`,
        'title=Undated+Selected+Release',
        'releaseCreateFlow=selected-assets',
        'noSetReleaseDate=1',
        'plannedDate=2026-12-01',
        'plannedTime=09:45',
        'retainedPlannedDate=2026-12-02',
        'retainedPlannedTime=10:15',
        `selectedAssetIds=${asset.id}`,
      ]).expect(302);

      const releaseId = Number(res.headers.location.split('/')[2]);
      expect(res.headers.location).toBe(`/releases/${releaseId}/assets`);
      expect(releaseRepository.findById(releaseId)).toMatchObject({
        planned_date: null,
        planned_time: null,
      });
      expect(getReleaseAssets(db, releaseId).map(({ asset_id }) => asset_id)).toEqual([asset.id]);
    });

    it('keeps explicit schedules when unchecked or when the field is not exactly "1"', async () => {
      const projectId = await createTestProject('Scheduled Release Project');

      for (const marker of [null, 'noSetReleaseDate=', 'noSetReleaseDate=on', 'noSetReleaseDate=true']) {
        const fields = [`projectId=${projectId}`, 'title=Scheduled+Release', 'plannedDate=2026-11-20', 'plannedTime=14:30'];
        if (marker) fields.push(marker);
        const res = await postCreate(fields).expect(302);
        const releaseId = Number(res.headers.location.split('/')[2]);
        expect(releaseRepository.findById(releaseId)).toMatchObject({
          planned_date: '2026-11-20',
          planned_time: '14:30',
        });
      }
    });

    it('still validates schedule fields when unchecked', async () => {
      const projectId = await createTestProject('Unchecked Invalid Schedule Project');

      const res = await postCreate([
        `projectId=${projectId}`,
        'title=Invalid+Schedule',
        'plannedDate=not-a-date',
      ]).expect(422);

      expect(res.text).toContain('Planned date must be a valid date (YYYY-MM-DD).');
      expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toEqual([]);
    });

    it('validation rerender keeps a checked submission undated', async () => {
      const projectId = await createTestProject('Undated Rerender Project');

      const res = await postCreate([
        `projectId=${projectId}`,
        'title=',
        'noSetReleaseDate=1',
        'plannedDate=2026-12-01',
        'plannedTime=09:45',
      ]).expect(422);

      expect(res.text).toContain('Title is required');
      expect(renderedScheduleValues(res.text)).toEqual({ plannedDate: '', plannedTime: '' });
      expect(selectedProjectRadioValue(res.text)).toBe(String(projectId));
      expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toEqual([]);
    });

    it('validation rerender keeps intentionally blank fields blank and explicit schedules intact', async () => {
      const projectId = await createTestProject('Blank Rerender Project');

      const blank = await postCreate([
        `projectId=${projectId}`,
        'title=',
        'plannedDate=',
        'plannedTime=',
      ]).expect(422);
      expect(renderedScheduleValues(blank.text)).toEqual({ plannedDate: '', plannedTime: '' });

      const explicit = await postCreate([
        `projectId=${projectId}`,
        'title=',
        'plannedDate=2026-11-20',
        'plannedTime=14:30',
      ]).expect(422);
      expect(renderedScheduleValues(explicit.text)).toEqual({ plannedDate: '2026-11-20', plannedTime: '14:30' });
    });

    function retainedDraftInputs(html) {
      return ['retainedPlannedDate', 'retainedPlannedTime'].map((name) => (
        html.match(new RegExp(`<input type="hidden" name="${name}"[^>]*>`))?.[0] || ''
      ));
    }

    function retainedDraft(html) {
      const [date, time] = retainedDraftInputs(html);
      if (!date || !time) return undefined;
      if (date.includes(' disabled') || time.includes(' disabled')) return null;
      return {
        plannedDate: date.match(/value="([^"]*)"/)?.[1],
        plannedTime: time.match(/value="([^"]*)"/)?.[1],
      };
    }

    it('checked validation rerender echoes the retained schedule draft as form state', async () => {
      const projectId = await createTestProject('Retained Draft Project');
      const rerender = (fields) => postCreate([`projectId=${projectId}`, 'title=', ...fields]).expect(422);

      const custom = await rerender(['noSetReleaseDate=1', 'retainedPlannedDate=2027-02-14', 'retainedPlannedTime=18:45']);
      expect(noSetDateCheckbox(custom.text)).toContain(' checked');
      expect(renderedScheduleValues(custom.text)).toEqual({ plannedDate: '', plannedTime: '' });
      expect(retainedDraft(custom.text)).toEqual({ plannedDate: '2027-02-14', plannedTime: '18:45' });
      expect(selectedProjectRadioValue(custom.text)).toBe(String(projectId));

      const blank = await rerender(['noSetReleaseDate=1', 'retainedPlannedDate=', 'retainedPlannedTime=']);
      expect(retainedDraft(blank.text)).toEqual({ plannedDate: '', plannedTime: '' });

      const partial = await rerender(['noSetReleaseDate=1', 'retainedPlannedDate=2027-02-14', 'retainedPlannedTime=']);
      expect(retainedDraft(partial.text)).toEqual({ plannedDate: '2027-02-14', plannedTime: '' });

      // No draft held, an incomplete draft, or an unchecked form renders the
      // fields disabled and empty.
      expect(retainedDraft((await rerender(['noSetReleaseDate=1'])).text)).toBeNull();
      expect(retainedDraft((await rerender(['noSetReleaseDate=1', 'retainedPlannedDate=2027-02-14'])).text)).toBeNull();
      const unchecked = await rerender(['plannedDate=2026-11-20', 'plannedTime=14:30', 'retainedPlannedDate=2027-02-14', 'retainedPlannedTime=18:45']);
      expect(retainedDraft(unchecked.text)).toBeNull();
      expect(renderedScheduleValues(unchecked.text)).toEqual({ plannedDate: '2026-11-20', plannedTime: '14:30' });
      retainedDraftInputs(unchecked.text).forEach((input) => expect(input).toContain('value=""'));

      // Values are escaped and length-capped.
      const hostile = await rerender(['noSetReleaseDate=1', `retainedPlannedDate=${encodeURIComponent('"><b>x')}`, `retainedPlannedTime=${'9'.repeat(100)}`]);
      expect(hostile.text).not.toContain('"><b>x');
      expect(retainedDraft(hostile.text)).toEqual({ plannedDate: '&quot;&gt;&lt;b&gt;x', plannedTime: '9'.repeat(32) });
      expect(releaseRepository.findByProjectId(projectId, { includeArchived: true })).toEqual([]);
    });

    it('selected-assets checked rerender echoes the retained draft and keeps its handoff', async () => {
      const projectId = await createTestProject('Retained Selected Project');
      const asset = insertAssetDirect(db, projectId, 'retained.png');

      const res = await postCreate([
        `projectId=${projectId}`,
        'title=',
        'releaseCreateFlow=selected-assets',
        'noSetReleaseDate=1',
        'retainedPlannedDate=2027-02-14',
        'retainedPlannedTime=',
        `selectedAssetIds=${asset.id}`,
      ]).expect(422);

      const createForm = res.text.match(/<form id="release-create-form"[\s\S]*?<\/form>/)?.[0] || '';
      expect(createForm).toContain(`name="selectedAssetIds" value="${asset.id}"`);
      expect(noSetDateCheckbox(createForm)).toContain(' checked');
      expect(retainedDraft(createForm)).toEqual({ plannedDate: '2027-02-14', plannedTime: '' });
    });

    function noSetDateCheckbox(html) {
      return html.match(/<input type="checkbox" id="noSetReleaseDate"[^>]*>/)?.[0] || '';
    }

    function scheduleDefaultsMarker(html, formId) {
      return html.match(new RegExp(`<form id="${formId}"[^>]*data-release-schedule-defaults="([^"]*)"`))?.[1];
    }

    it('renders the checkbox in the New Release scheduling section only, never in Edit Release', async () => {
      const projectId = await createTestProject('Checkbox Placement Project');
      const release = releaseRepository.create({ projectId, title: 'Checkbox edit release', description: '', notes: '' });

      const list = await agent.get('/releases').expect(200);
      const createForm = list.text.match(/<form id="release-create-form"[\s\S]*?<\/form>/)?.[0] || '';
      const scheduling = createForm.match(/<h3>Scheduling<\/h3>[\s\S]*?<div class="field-row release-distribution-row">/)?.[0] || '';
      expect(noSetDateCheckbox(scheduling)).toContain('name="noSetReleaseDate" value="1"');
      expect(noSetDateCheckbox(scheduling)).not.toContain('checked');
      expect(scheduling).toMatch(/<label class="field field--checkbox release-no-set-date-field" for="noSetReleaseDate">[\s\S]*?<span>No set release date<\/span>\s*<\/label>/);
      expect(scheduleDefaultsMarker(list.text, 'release-create-form')).toBe('fresh');

      expect(retainedDraft(createForm)).toBeNull();

      const standalone = await agent.get('/releases/new').expect(200);
      expect(noSetDateCheckbox(standalone.text)).toContain('name="noSetReleaseDate" value="1"');
      expect(retainedDraft(standalone.text)).toBeNull();
      const prefilledDraft = await agent.get('/releases/new?noSetReleaseDate=1&retainedPlannedDate=2027-02-14&retainedPlannedTime=18:45').expect(200);
      expect(retainedDraft(prefilledDraft.text)).toBeNull();
      expect(scheduleDefaultsMarker(standalone.text, 'release-form')).toBe('fresh');

      const detail = await agent.get(`/releases/${release.id}`).expect(200);
      const editForm = detail.text.match(/<form id="release-edit-form"[\s\S]*?<\/form>/)?.[0] || '';
      expect(editForm).toContain('name="plannedDate"');
      expect(editForm).not.toContain('noSetReleaseDate');
      expect(editForm).not.toContain('retainedPlanned');
      expect(editForm).not.toContain('data-release-schedule-defaults');
    });

    it('marks explicit prefills and validation drafts so the client keeps their schedules', async () => {
      const projectId = await createTestProject('Schedule Marker Project');

      const prefilled = await agent.get('/releases/new?plannedDate=2026-11-20&plannedTime=14:30').expect(200);
      expect(scheduleDefaultsMarker(prefilled.text, 'release-form')).toBe('keep');
      expect(renderedScheduleValues(prefilled.text)).toEqual({ plannedDate: '2026-11-20', plannedTime: '14:30' });

      const checked = await postCreate([`projectId=${projectId}`, 'title=', 'noSetReleaseDate=1']).expect(422);
      expect(scheduleDefaultsMarker(checked.text, 'release-form')).toBe('keep');
      expect(noSetDateCheckbox(checked.text)).toContain(' checked');

      const unchecked = await postCreate([`projectId=${projectId}`, 'title=', 'plannedDate=', 'plannedTime=']).expect(422);
      expect(scheduleDefaultsMarker(unchecked.text, 'release-form')).toBe('keep');
      expect(noSetDateCheckbox(unchecked.text)).not.toContain('checked');
    });

    it('keeps explicitly blank schedule query prefills instead of defaulting them', async () => {
      await createTestProject('Blank Prefill Project');
      const prefill = async (query) => {
        const res = await agent.get(`/releases/new?${query}`).expect(200);
        return { marker: scheduleDefaultsMarker(res.text, 'release-form'), values: renderedScheduleValues(res.text) };
      };

      expect(await prefill('plannedDate=2027-02-14&plannedTime=')).toEqual({
        marker: 'keep', values: { plannedDate: '2027-02-14', plannedTime: '' },
      });
      expect(await prefill('plannedDate=&plannedTime=18:45')).toEqual({
        marker: 'keep', values: { plannedDate: '', plannedTime: '18:45' },
      });
      expect(await prefill('plannedDate=&plannedTime=')).toEqual({
        marker: 'keep', values: { plannedDate: '', plannedTime: '' },
      });
      expect(await prefill('plannedDate=2026-11-20&plannedTime=14:30')).toEqual({
        marker: 'keep', values: { plannedDate: '2026-11-20', plannedTime: '14:30' },
      });

      // No scheduling fields at all: placeholders the client replaces.
      const fresh = await prefill('title=Fresh');
      expect(fresh.marker).toBe('fresh');
      expect(fresh.values.plannedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(fresh.values.plannedTime).toMatch(/^\d{2}:\d{2}$/);
    });

    it('exposes the checkbox state on the create form model for fresh and rerendered forms', () => {
      const projectService = { list: () => ({ rows: [] }), findById: () => null };
      const build = (values, isFreshCreate) => buildCreateReleaseFormModel({
        appName: 'CreatorCrate',
        projectService,
        values,
        isFreshCreate,
      });

      const fresh = build({}, true);
      expect(fresh.noSetReleaseDate).toBe(false);
      expect(fresh.values.noSetReleaseDate).toBe(false);
      expect(fresh.values.plannedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(fresh.values.plannedTime).toMatch(/^\d{2}:\d{2}$/);
      expect(fresh.scheduleDefaulted).toBe(true);
      expect(build({ plannedDate: '2026-11-20' }, true).scheduleDefaulted).toBe(false);
      expect(build({ plannedDate: '' }, true)).toMatchObject({ scheduleDefaulted: false, values: { plannedDate: '' } });
      expect(build({ noSetReleaseDate: '1' }, true).scheduleDefaulted).toBe(false);

      const checked = build({ noSetReleaseDate: '1', plannedDate: '2026-12-01', plannedTime: '09:45' }, false);
      expect(checked.noSetReleaseDate).toBe(true);
      expect(checked.values).toMatchObject({ noSetReleaseDate: true, plannedDate: '', plannedTime: '' });
      expect(checked.scheduleDefaulted).toBe(false);
      expect(checked.values.retainedSchedule).toBeNull();
      expect(checked.resetValues.noSetReleaseDate).toBe(false);
      expect(checked.resetValues.retainedSchedule).toBeNull();

      const retained = build({ noSetReleaseDate: '1', retainedPlannedDate: '2027-02-14', retainedPlannedTime: '' }, false);
      expect(retained.values.retainedSchedule).toEqual({ plannedDate: '2027-02-14', plannedTime: '' });
      expect(retained.values).not.toHaveProperty('retainedPlannedDate');
      expect(retained.values).not.toHaveProperty('retainedPlannedTime');
      expect(build({ noSetReleaseDate: '1', retainedPlannedDate: '2027-02-14', retainedPlannedTime: '' }, true)
        .values.retainedSchedule).toBeNull();
      expect(checked.resetValues.plannedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it('invalid create request rerenders with values and errors', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Error+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=')
      .send('status=invalid')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Title is required');
  });

  it('missing project returns error', async () => {
    await createTestProject('Missing Project Error Baseline');
    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('projectId=99999')
      .send('title=Orphan+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Project not found');
    const projectField = extractReleaseProjectField(res.text);
    // field-error is a real class token, not template text left in the class.
    expect(projectField).toMatch(/<fieldset class="[^"]*asset-viewer-project-filter field-error"/);
    expect(projectField).not.toContain('{%');
    expect(projectField).toContain('id="projectId-error"');
    expect(projectField).toMatch(/name="projectId"[^>]*aria-describedby="projectId-error"[^>]*aria-invalid="true"/);
    expect(projectField).toMatch(/<summary[^>]*aria-describedby="projectId-error"[^>]*aria-invalid="true"/);
    expect(selectedProjectRadioValue(res.text)).toBeUndefined();
  });

  it('malformed projectId is rejected', async () => {
    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('projectId=1junk')
      .send('title=Bad+Id+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).toContain('Project is required');
  });

  // ─── Release detail ───────────────────────────────────────────────────────

  it('release detail renders', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Detail+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Detail+View+Test')
      .send('status=tbd')
      .send('plannedDate=2026-12-01')
      .send('description=Detail+description')
      .send('notes=Detail+notes')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const location = createRes.headers.location;
    const res = await agent.get(location).expect(200);
    expect(res.text).toContain('Detail View Test');
    expect(res.text).toContain('Edit');
    expect(res.text).toContain(`aria-label="Manage Assets" data-tooltip="Manage Assets"`);
    expectProjectReturnLead(res.text, { href: `/projects/${projectId}`, title: 'Detail Test Project' });
    expectReleaseDetailNav(res.text, { projectId, releaseLocation: location });
    expect(res.text).toContain(`<dd><a href="/projects/${projectId}">Detail Test Project</a></dd>`);
    expect(res.text).not.toMatch(/>Back to Project<\/a>/);
    expect(res.text).toContain(`<nav class="project-detail-action-toolbar" aria-label="Release actions">`);
    expectReviewPublishAction(res.text, { href: `${location}/publish` });
    expect(res.text).not.toContain('Readiness');
    expect(res.text).not.toContain('panel--readiness');

    const summaryStart = res.text.indexOf('<div class="project-detail-summary">');
    const actionMetaStart = res.text.indexOf('<div class="project-detail-meta">', summaryStart);
    const detailsStart = res.text.indexOf('<section class="project-detail-info project-detail-section">', summaryStart);
    const descriptionStart = res.text.indexOf('<h2>Description</h2>', summaryStart);
    const notesStart = res.text.indexOf('<h2>Notes</h2>', summaryStart);
    const selectedAssetsStart = res.text.indexOf('<section class="asset-browser-layout" aria-label="Selected assets" data-selected-assets>', summaryStart);
    const mainEnd = res.text.indexOf('</main>');
    const editDialogStart = res.text.indexOf('<dialog id="release-edit-dialog"');
    const publishDialogStart = res.text.indexOf('<dialog id="release-publish-dialog"');
    const details = res.text.match(/<section class="project-detail-info project-detail-section">[\s\S]*?<\/section>/)?.[0] || '';
    const selectedAssets = extractSelectedAssetsSection(res.text);

    expect(summaryStart).toBeGreaterThan(0);
    expect(actionMetaStart).toBeGreaterThan(summaryStart);
    expect(res.text.indexOf('<nav class="project-detail-action-toolbar" aria-label="Release actions">', actionMetaStart)).toBeGreaterThan(actionMetaStart);
    expect(detailsStart).toBeGreaterThan(actionMetaStart);
    expect(descriptionStart).toBeGreaterThan(detailsStart);
    expect(notesStart).toBeGreaterThan(descriptionStart);
    expect(selectedAssetsStart).toBeGreaterThan(notesStart);
    expect(res.text).not.toContain('<h2>Assets</h2>');
    expect(details).toMatch(/<div class="project-detail-meta">[\s\S]*?<dl class="detail-list release-detail-list">/);
    expect(details).not.toContain('<dt>Project status</dt>');
    expect(details.lastIndexOf('<dt>Selected assets</dt>')).toBeGreaterThan(details.lastIndexOf('<dt>Updated</dt>'));
    expect(details).toMatch(/<dt>Selected assets<\/dt>\s*<dd>0<\/dd>/);
    expect((details.match(/<dt>Selected assets<\/dt>/g) || [])).toHaveLength(1);
    expect(res.text).not.toContain('<h2>Selected Assets</h2>');
    expect(res.text).not.toContain('<h2>Release Assets</h2>');
    expect(selectedAssets).toMatch(/^<section class="asset-browser-layout" aria-label="Selected assets" data-selected-assets>\s*<div class="asset-browser-content">/);
    expect(selectedAssets).not.toContain('project-detail-section-body');
    expect(selectedAssets).not.toMatch(/<h[1-6]\b[^>]*>\s*(?:Selected Assets|Release Assets)\s*<\/h[1-6]>/i);
    expect(selectedAssets).toMatch(/<div class="asset-viewer-display-controls">[\s\S]*?<nav class="view-switcher" aria-label="Asset display">/);
    expect(selectedAssets).toContain('class="view-switcher-option view-switcher-option--icon asset-tooltip asset-tooltip--right"');
    expect(selectedAssets).toMatch(/aria-current="page"[\s\S]*aria-label="Grid view" title="Grid view" data-tooltip="Grid view"/);
    expect(selectedAssets).toContain('aria-label="List view" title="List view" data-tooltip="List view"');
    expect(selectedAssets).toContain('<p class="results-meta">0 selected assets</p>');
    expect(selectedAssets.indexOf('class="asset-viewer-display-controls"')).toBeLessThan(selectedAssets.indexOf('<p class="results-meta">'));
    expect(selectedAssets.indexOf('<p class="results-meta">')).toBeLessThan(selectedAssets.indexOf('class="empty-state"'));
    expect(selectedAssets).toContain('No assets selected');
    expect(editDialogStart).toBeGreaterThan(mainEnd);
    expect(publishDialogStart).toBeGreaterThan(mainEnd);
  });

  it('release detail renders the associated project status and shows Ready for a ready project', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Ready+Project+Status+Detail')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Ready+Project+Release')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));
    db.prepare("UPDATE projects SET status = 'ready' WHERE id = ?").run(projectId);

    const res = await agent.get(createRes.headers.location).expect(200);
    const currentStatus = res.text.match(/<dt>Project Status<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/)?.[1] || '';
    expect(currentStatus).toMatch(/<span class="status-badge project-option-badge project-status-badge status-badge--active"[^>]*>Ready<\/span>/);
    expect(currentStatus).not.toContain('>Tbd<');
    expect(releaseRepository.findById(releaseId).project_status).toBe('ready');
  });

  it('missing release returns 404', async () => {
    await agent.get('/releases/9999').expect(404);
  });

  it('invalid release id returns 404', async () => {
    await agent.get('/releases/abc').expect(404);
  });

  it('release detail places icon actions below the project lead navigation', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Heading+Action+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('projectId=' + projectId)
      .send('title=Heading+Action+Release')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const releaseLocation = createRes.headers.location;
    const releaseId = Number(releaseLocation.replace('/releases/', ''));

    const res = await agent.get(releaseLocation).expect(200);
    const headingMatch = res.text.match(/<header class="page-heading">[\s\S]*?<\/header>/);
    const actionsMatch = res.text.match(/<nav class="project-detail-action-toolbar" aria-label="Release actions">[\s\S]*?<\/nav>/);
    expect(headingMatch).not.toBeNull();
    expect(actionsMatch).not.toBeNull();
    expectProjectReturnLead(res.text, { href: `/projects/${projectId}`, title: 'Heading Action Project' });
    expectReleaseDetailNav(res.text, { projectId, releaseLocation });
    expectReviewPublishAction(res.text, { href: `/releases/${releaseId}/publish` });
    expect(actionsMatch[0]).toContain('href="/releases/' + releaseId + '/assets" aria-label="Manage Assets" data-tooltip="Manage Assets"');
    expect(actionsMatch[0]).toContain('href="/releases/' + releaseId + '?edit=1" data-release-edit-id="' + releaseId + '" aria-label="Edit release" data-tooltip="Edit release"');
    expect(res.text).not.toContain('data-dialog-open="release-edit-dialog"');
    expect(actionsMatch.index).toBeGreaterThan(headingMatch.index + headingMatch[0].length);
  });

  it('release detail hides Manage Assets from icon actions when the release is published or archived', async () => {
    const { projectId: publishedProjectId, releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
    await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('publishedDate=2025-06-15')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const published = await agent.get(releaseLocation).expect(200);
    const publishedActions = published.text.match(/<nav class="project-detail-action-toolbar" aria-label="Release actions">[\s\S]*?<\/nav>/)?.[0] || '';
    expect(publishedActions).not.toContain('Manage Assets');
    expect(publishedActions).toContain('?edit=1');
    expectReleaseDetailNav(published.text, { projectId: publishedProjectId, releaseLocation });

    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Heading+Archived+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');
    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Heading+Archived+Release')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    await agent
      .post(createRes.headers.location + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    const archived = await agent.get(createRes.headers.location).expect(200);
    const archivedHeading = archived.text.match(/<header class="page-heading">[\s\S]*?<\/header>/)?.[0] || '';
    expect(archivedHeading).not.toContain('Manage Assets');
    expectReleaseDetailNav(archived.text, { projectId, releaseLocation: createRes.headers.location });
  });

  it('shared card hover and focus styles apply to release detail and release asset cards', async () => {
    const styleRes = await request(app).get('/creatorcrate.css').expect(200);
    const css = styleRes.text;
    // The established shared grid-card hover/focus treatment is un-gated by the
    // selectable attribute so it also applies to read-only release detail cards.
    expect(css).toMatch(/\.asset-card:hover,[\s\S]*?\.asset-card:focus-within\s*\{[\s\S]*?background:\s*var\(--surface-hover\)[\s\S]*?border-color:\s*var\(--border-strong\)[\s\S]*?box-shadow:\s*var\(--shadow-md\)/);
    expect(css).toMatch(/\.asset-card:focus-within\s*\{[\s\S]*?outline:\s*2px solid var\(--focus-ring\)/);
    // List cards already share the :hover / :focus-within treatment.
    expect(css).toMatch(/\.asset-list-card:hover\s*\{[\s\S]*?background:\s*var\(--surface-hover\)/);
    expect(css).toMatch(/\.asset-list-card:focus-within\s*\{[\s\S]*?outline:\s*2px solid var\(--focus-ring\)/);
  });

  describe('publish dialog rendering contract', () => {
    it('formats release asset timestamps from the saved clock preference', async () => {
      const { releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      db.prepare('UPDATE assets SET modified_at = ?, last_seen_at = ? WHERE id = ?')
        .run('2026-08-01T13:05:42.000Z', '2026-08-01 13:05:42', assetId);
      // Both release List contexts show the formatted Modified value that the
      // row's information card shows, never the stored ISO string.
      const date = new Date('2026-08-01T13:05:42.000Z');
      for (const preference of ['12h', '24h']) {
        app.locals.clockFormatSettingsService.setClockFormat(preference);
        const expected = `${formatLocalDate(date)} ${formatLocalTime(date, preference)}`;
        const detail = await agent.get(`${releaseLocation}?view=list&publish=1`).expect(200);
        const assets = await agent.get(`${releaseLocation}/assets?view=list`).expect(200);
        for (const html of [detail.text, assets.text]) {
          expect(html).toMatch(new RegExp(`asset-list-cell--modified[^"]*">\\s*<dt>Modified</dt>\\s*<dd>${expected}</dd>`));
          expect(html).toContain(`<dt>Modified</dt><dd>${expected}</dd>`);
          expect(html).not.toMatch(/asset-list-cell--modified[^"]*">\s*<dt>Modified<\/dt>\s*<dd>2026-08-01T/);
        }
      }

      // A missing timestamp keeps the muted dash in both contexts.
      db.prepare('UPDATE assets SET modified_at = NULL WHERE id = ?').run(assetId);
      for (const url of [`${releaseLocation}?view=list`, `${releaseLocation}/assets?view=list`]) {
        const res = await agent.get(url).expect(200);
        expect(res.text).toMatch(/asset-list-cell--modified[^"]*">\s*<dt>Modified<\/dt>\s*<dd><span class="dashboard-muted">—<\/span><\/dd>/);
      }
      db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?').run('2026-08-01T13:05:42.000Z', assetId);

      const publish = await agent.get(`${releaseLocation}/publish`).expect(302);
      expect(publish.headers.location).toBe(`${releaseLocation}?publish=1`);
      expect(db.prepare('SELECT modified_at, last_seen_at FROM assets WHERE id = ?').get(assetId))
        .toEqual({ modified_at: '2026-08-01T13:05:42.000Z', last_seen_at: '2026-08-01 13:05:42' });
    });

    it('keeps the Review & Publish trigger as a primary text action with a fallback href and dialog contract', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      const res = await agent.get(releaseLocation).expect(200);
      expectReviewPublishAction(res.text, { href: `${releaseLocation}/publish` });
      expect(res.text).toContain('<dialog id="release-publish-dialog" class="app-dialog project-form-dialog app-dialog--refined"');
      expect(res.text).toContain('<div class="app-dialog-body project-edit-dialog-body">');
      expect(res.text).toContain('<form id="release-publish-form" method="post" action="' + releaseLocation + '/publish" class="app-dialog-form project-form project-edit-dialog-form"');
      expect(res.text).toMatch(/<form id="release-publish-form"[^>]*data-dialog-reset-on-close/);
      expect(res.text).toMatch(/<form id="release-publish-form"[^>]*>[\s\S]*?<section class="settings-section project-edit-dialog-section release-publish-summary-section" aria-labelledby="release-publish-summary-heading">/);
      expect(res.text).toContain('<section class="settings-section project-edit-dialog-section" data-release-dialog-compact-section aria-labelledby="release-publish-assets-heading">');
      expect(res.text).toContain('<section class="settings-section project-edit-dialog-section" data-release-dialog-compact-section aria-labelledby="release-publish-publication-heading">');
      expect(res.text).toContain('Selected release assets for publication');
      expect(res.text).toContain('<div class="table-scroll" tabindex="0" aria-label="Selected release assets for publication">');
      expect(res.text).toContain('<table class="data-table">');
      expect(res.text).toMatch(/<div class="field scheduling-field\s*" data-dialog-field="publishedDate" data-date-picker-field>\s*<label for="release-publish-date">/);
      expect(res.text).toMatch(/<input[^>]*class="picker-input"[^>]*type="date"[^>]*id="release-publish-date"[^>]*name="publishedDate"[^>]*data-date-picker-input/);
      expect(res.text).toMatch(/<button[^>]*class="picker-trigger date-picker-trigger"[^>]*aria-controls="release-publish-date-calendar"[^>]*aria-label="Open calendar for publication date"/);
      expect(res.text).toMatch(/<div[^>]*id="release-publish-date-calendar"[^>]*data-date-picker-panel[^>]*data-date-picker-for="release-publish-date"[^>]*>/);
      expect(res.text).toContain('<footer class="app-dialog-footer">');
    });

    it('uses the established wide dialog sizing without changing generic, responsive, or table-overflow behavior', async () => {
      const style = await request(app).get('/creatorcrate.css').expect(200);
      const css = style.text;

      expect(css).toMatch(/#project-edit-dialog,[\s\S]*?#project-create-dialog,[\s\S]*?#release-create-dialog,[\s\S]*?#release-edit-dialog,[\s\S]*?#release-publish-dialog\s*\{[\s\S]*?width:\s*min\(51rem,\s*calc\(100vw\s*-\s*2rem\)\);[\s\S]*?max-width:\s*calc\(100vw\s*-\s*2rem\)/);
      expect(css).toMatch(/\.app-dialog\s*\{[\s\S]*?width:\s*min\(32rem,\s*calc\(100vw\s*-\s*2rem\)\)/);
      expect(css).toMatch(/@media\s*\(max-width:\s*540px\)\s*\{[\s\S]*?\.app-dialog\s*\{[\s\S]*?width:\s*calc\(100vw\s*-\s*1rem\)/);
      expect(css).toMatch(/\.table-scroll\s*\{[\s\S]*?overflow-x:\s*auto;[\s\S]*?max-width:\s*100%/);
    });

    it('redirects the publish GET to the open detail dialog and preserves review data and local-date prefill', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      const redirect = await agent.get(`${releaseLocation}/publish`).expect(302);
      expect(redirect.headers.location).toBe(`${releaseLocation}?publish=1`);

      const detail = await agent.get(redirect.headers.location).expect(200);
      expect(detail.text).toMatch(/<dialog id="release-publish-dialog"[^>]*open/);
      expect(detail.text).toContain('Primary');
      expect(detail.text).toMatch(new RegExp(`<input[^>]*id="release-publish-date"[^>]*value="${getLocalTodayIso()}"[^>]*data-date-picker-input`));
      expect(detail.text).toContain('aria-controls="release-publish-date-calendar"');
      expect(detail.text).not.toContain('panel--readiness');
    });

    it('reopens the detail-hosted dialog with submitted values and errors after publish validation fails', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      const res = await agent
        .post(`${releaseLocation}/publish`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=not-a-date')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/<dialog id="release-publish-dialog" class="app-dialog project-form-dialog app-dialog--refined"[^>]*open/);
      expect(res.text).toContain('<div class="app-dialog-body project-edit-dialog-body">');
      expect(res.text).toContain('<section class="settings-section project-edit-dialog-section" data-release-dialog-compact-section aria-labelledby="release-publish-assets-heading">');
      expect(res.text).toContain('<section class="settings-section project-edit-dialog-section" data-release-dialog-compact-section aria-labelledby="release-publish-publication-heading">');
      expect(res.text).toMatch(/<div class="field scheduling-field field-error" data-dialog-field="publishedDate" data-date-picker-field>/);
      expect(res.text).toMatch(/<input[^>]*id="release-publish-date"[^>]*name="publishedDate"[^>]*value="not-a-date"[^>]*aria-describedby="release-publish-date-help release-publish-date-error"[^>]*aria-invalid="true"[^>]*data-date-picker-input/);
      const publishForm = res.text.match(/<form id="release-publish-form"[^>]*>/)?.[0] || '';
      const resetValues = JSON.parse(publishForm.match(/data-dialog-reset-values="([^"]+)"/)?.[1].replaceAll('&quot;', '"'));
      expect(resetValues.publishedDate).toBe(getLocalTodayIso());
      expect(res.text).toContain('id="release-publish-date-error"');
      expect(res.text).toContain('Published date must be a valid date');
      expect(res.text).toContain('Selected release assets for publication');
    });
  });

  // ─── Release form Cancel link (Phase 2D regression coverage) ──────────────
  //
  // Phase 2C changed release-form Cancel behavior but shipped without direct
  // automated coverage. These tests pin the exact destinations for every
  // Cancel scenario, and prove a malformed projectId cannot build an unsafe
  // href on the create form.

  describe('release form Cancel link', () => {
    it('create form Cancel points to /projects/:id with a valid project context', async () => {
      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+With+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);
      expect(res.text).toContain(`<a class="button button-secondary" href="/projects/${projectId}">Cancel</a>`);
    });

    it('create form Cancel falls back to /releases without project context', async () => {
      // A bare "Cancel" from an in-progress release-record form falls back
      // to canonical Releases without project context.
      await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+No+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/releases/new').expect(200);
      expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
    });

    // ─── Phase 2F: projectId is validated and normalized before it ever
    // reaches selectedProjectId or the Cancel href. Malformed, nonexistent,
    // and archived values must all fall back to the no-context behavior —
    // no project preselected, Cancel → /releases.

    describe.each([
      ['non-numeric', 'abc'],
      ['zero', '0'],
      ['negative', '-1'],
      ['trailing garbage', '1abc'],
      ['float', '1.5'],
      ['whitespace-only', '%20%20'],
    ])('malformed projectId (%s: %s)', (_label, rawValue) => {
      it('renders the form with no project preselected and Cancel to /releases', async () => {
        await agent
          .post('/projects')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('title=Cancel+Malformed+Baseline')
          .send('status=tbd')
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);

        const res = await agent.get(`/releases/new?projectId=${rawValue}`).expect(200);

        expect(res.text).not.toMatch(/href="\/projects\/[^"]*"[^>]*>Cancel<\/a>/);
        expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
        expect(selectedProjectRadioValue(res.text)).toBeUndefined();
        expect(res.text).not.toContain('Something went wrong');
      });
    });

    it('repeated projectId query parameters are treated as absent context', async () => {
      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Repeated+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      // Express parses repeated query keys into an array (req.query.projectId
      // becomes ['1', '2']), which must not be treated as a valid single id.
      const res = await agent
        .get(`/releases/new?projectId=${projectId}&projectId=999`)
        .expect(200);

      expect(res.text).not.toMatch(/href="\/projects\/[^"]*"[^>]*>Cancel<\/a>/);
      expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
      expect(selectedProjectRadioValue(res.text)).toBeUndefined();
    });

    it('create form Cancel does not build an unsafe href from a malformed projectId', async () => {
      await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Malformed+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .get('/releases/new?projectId=' + encodeURIComponent('"><script>alert(1)</script>'))
        .expect(200);

      // A malformed (non-integer) projectId is normalized to absent context,
      // so it never reaches the href at all — not merely escaped within it.
      expect(res.text).not.toContain('<script>alert(1)</script>');
      expect(selectedProjectRadioValue(res.text)).toBeUndefined();
      expect(res.text).not.toMatch(/href="\/projects\/[^"]*"[^>]*>Cancel<\/a>/);
      expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
    });

    it('nonexistent projectId is treated as absent context', async () => {
      await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Nonexistent+Baseline')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get('/releases/new?projectId=999999').expect(200);

      expect(res.text).not.toMatch(/href="\/projects\/[^"]*"[^>]*>Cancel<\/a>/);
      expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
      expect(selectedProjectRadioValue(res.text)).toBeUndefined();
    });

    it('archived projectId is not accepted as active release-creation context', async () => {
      // A baseline active project keeps the form reachable after the target
      // project is archived (the route 422s when zero active projects exist).
      await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Archived+Baseline')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Archived+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await agent
        .post(`/projects/${projectId}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);

      expect(res.text).not.toContain(`href="/projects/${projectId}"`);
      expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
      expect(res.text).not.toMatch(new RegExp(`name="projectId"[^>]*value="${projectId}"[^>]*checked`));
      expect(res.text).not.toContain('Cancel Archived Project');
    });

    it('valid active projectId preselects the correct project and no other', async () => {
      const projARes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Select+Correct+Project+A')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectAId = projARes.headers.location.replace('/projects/', '');

      const projBRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Select+Correct+Project+B')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectBId = projBRes.headers.location.replace('/projects/', '');

      const res = await agent.get(`/releases/new?projectId=${projectAId}`).expect(200);

      expect(res.text).toMatch(new RegExp(`name="projectId"[^>]*value="${projectAId}"[^>]*checked`));
      expect(res.text).not.toMatch(new RegExp(`name="projectId"[^>]*value="${projectBId}"[^>]*checked`));
      expect(releaseProjectRadioInputs(res.text).filter((radio) => /\bchecked\b/.test(radio))).toHaveLength(1);
      expect(res.text).toContain(`<a class="button button-secondary" href="/projects/${projectAId}">Cancel</a>`);
      expect(res.text).not.toContain('>Back to Project</a>');
    });

    it('edit fallback redirects to the release detail dialog', async () => {
      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Edit+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Cancel+Edit+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      const res = await agent.get(`${releaseLocation}/edit`).expect(302);
      expect(res.headers.location).toBe(`${releaseLocation}?edit=1`);
    });

    // ─── Phase 2F review fix: inconsistent archive rows ──────────────────
    //
    // A project row can disagree between its two archive indicators
    // (status='archived' with archived_at still NULL). Such a row is not
    // excluded by projectService.list({ includeArchived: false }), which
    // only filters on archived_at, so it must be filtered locally with
    // isActiveProject before the selector is rendered — it must not appear
    // as an option at all, selected or not.

    it('inconsistent row (status=archived, archived_at=NULL) is not an option, not selected, and Cancel falls back', async () => {
      // A baseline active project keeps the form reachable (the route 422s
      // when zero active projects remain after local filtering).
      await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Inconsistent+Archived+Baseline')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const inconsistentId = insertProjectDirect(db, {
        title: 'Inconsistent Archived Row',
        status: 'archived',
        archivedAt: null,
      });

      const res = await agent.get(`/releases/new?projectId=${inconsistentId}`).expect(200);

      expect(res.text).not.toContain(`value="${inconsistentId}"`);
      expect(res.text).not.toContain('Inconsistent Archived Row');
      expect(selectedProjectRadioValue(res.text)).toBeUndefined();
      expect(res.text).not.toContain(`href="/projects/${inconsistentId}"`);
      expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
    });

    it('inconsistent row (status=archived, archived_at=NULL) is rejected by POST release creation', async () => {
      const inconsistentId = insertProjectDirect(db, {
        title: 'Inconsistent Archived POST Row',
        status: 'archived',
        archivedAt: null,
      });

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${inconsistentId}`)
        .send('title=Should+Not+Create')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain('Cannot create release for archived project.');
    });

    // ─── Phase 2F review fix: valid project beyond the 100-option page ───

    it('valid active project outside the first 100 options is added to the selector and preselected', async () => {
      const TOTAL = 101;
      let targetId;
      for (let i = 0; i < TOTAL; i++) {
        // Strictly decreasing updated_at so ordering (DESC) is deterministic;
        // the last-inserted row (i = TOTAL - 1) is the oldest and therefore
        // ranked 101st — outside the LIMIT 100 page.
        const updatedAt = `2024-01-01 00:00:${String(TOTAL - i).padStart(2, '0')}`;
        const id = insertProjectDirect(db, {
          title: `Beyond Limit Project ${i}`,
          status: 'tbd',
          updatedAt,
        });
        if (i === TOTAL - 1) targetId = id;
      }

      const res = await agent.get(`/releases/new?projectId=${targetId}`).expect(200);

      const radioMatches = res.text.match(new RegExp(`<input[^>]*name="projectId"[^>]*type="radio"[^>]*value="${targetId}"[^>]*>`, 'g')) || [];
      expect(radioMatches).toHaveLength(1);
      expect(radioMatches[0]).toContain('checked');
      expect(res.text).toContain(`<a class="button button-secondary" href="/projects/${targetId}">Cancel</a>`);

      // At most 101 project options: 100 from the filtered page plus the one
      // directly appended beyond-100 project. No duplicates, no overcount.
      expect(releaseProjectRadioInputs(res.text).length).toBeLessThanOrEqual(101);
    });

    it('a full original page containing a locally-filtered archived-status row still finds and appends a valid active project beyond the page', async () => {
      // 99 active rows ranked 1-99, one archived-status row (archived_at
      // NULL) at rank 100 — still counted by the unfiltered DB query, so the
      // original page is full (100 rows), even though local filtering drops
      // it to 99 active options. The valid target sits at rank 101, outside
      // the LIMIT 100 window, and must still be found via direct lookup.
      for (let i = 0; i < 99; i++) {
        const updatedAt = `2024-01-01 00:00:${String(99 - i).padStart(2, '0')}`;
        insertProjectDirect(db, { title: `Full Page Active ${i}`, status: 'tbd', updatedAt });
      }
      insertProjectDirect(db, {
        title: 'Full Page Inconsistent Archived',
        status: 'archived',
        archivedAt: null,
        updatedAt: '2024-01-01 00:00:00',
      });
      const targetId = insertProjectDirect(db, {
        title: 'Full Page Beyond Target',
        status: 'tbd',
        updatedAt: '2023-12-31 23:59:59',
      });

      const res = await agent.get(`/releases/new?projectId=${targetId}`).expect(200);

      const radioMatches = res.text.match(new RegExp(`<input[^>]*name="projectId"[^>]*type="radio"[^>]*value="${targetId}"[^>]*>`, 'g')) || [];
      expect(radioMatches).toHaveLength(1);
      expect(radioMatches[0]).toContain('checked');
      expect(res.text).not.toContain('Full Page Inconsistent Archived');
      expect(res.text).toContain(`<a class="button button-secondary" href="/projects/${targetId}">Cancel</a>`);

      const selectedProjectRadios = releaseProjectRadioInputs(res.text).filter((radio) => /\bchecked\b/.test(radio));
      expect(selectedProjectRadios).toHaveLength(1);
    });

    it('an archived project outside the first 100 options is not appended to the selector', async () => {
      for (let i = 0; i < 99; i++) {
        const updatedAt = `2024-02-01 00:00:${String(99 - i).padStart(2, '0')}`;
        insertProjectDirect(db, { title: `Archived Beyond Filler ${i}`, status: 'tbd', updatedAt });
      }
      insertProjectDirect(db, {
        title: 'Archived Beyond Filler Full',
        status: 'tbd',
        updatedAt: '2024-02-01 00:00:00',
      });
      const archivedBeyondId = insertProjectDirect(db, {
        title: 'Archived Beyond Target',
        status: 'archived',
        archivedAt: '2024-01-01 00:00:00',
        updatedAt: '2024-01-31 23:59:59',
      });

      const res = await agent.get(`/releases/new?projectId=${archivedBeyondId}`).expect(200);

      expect(res.text).not.toContain(`value="${archivedBeyondId}"`);
      expect(res.text).not.toContain('Archived Beyond Target');
      expect(selectedProjectRadioValue(res.text)).toBeUndefined();
      expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
    });

    it('a nonexistent project outside the first 100 options is not appended to the selector', async () => {
      for (let i = 0; i < 100; i++) {
        const updatedAt = `2024-03-01 00:00:${String(100 - i).padStart(2, '0')}`;
        insertProjectDirect(db, { title: `Nonexistent Beyond Filler ${i}`, status: 'tbd', updatedAt });
      }

      const res = await agent.get('/releases/new?projectId=999999').expect(200);

      expect(selectedProjectRadioValue(res.text)).toBeUndefined();
      expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
    });

    // ─── Phase 2F review fix: numerically unsafe projectId values ────────

    describe.each([
      ['just above MAX_SAFE_INTEGER', '9007199254740993'],
      ['far larger digit string', '99999999999999999999999999'],
    ])('numerically unsafe projectId (%s: %s)', (_label, rawValue) => {
      it('renders the form with no project selected and Cancel to /releases', async () => {
        await agent
          .post('/projects')
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('title=Unsafe+Integer+Baseline')
          .send('status=tbd')
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);

        const res = await agent.get(`/releases/new?projectId=${rawValue}`).expect(200);

        expect(selectedProjectRadioValue(res.text)).toBeUndefined();
        expect(res.text).not.toContain(`/projects/${rawValue}`);
        expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
        expect(res.text).not.toContain('Something went wrong');
      });
    });
  });

  // ─── Phase 2F: POST /releases validation-error re-render shares the same
  // project-context resolution as GET /releases/new ─────────────────────────
  //
  // A 422 re-render must never be less safe than the GET form: options must
  // exclude archived projects (by either indicator), selectedProjectId must
  // be a validated active project id or null (never raw/malformed req.body),
  // and Cancel must follow the same active/inactive rule.

  describe('POST /releases validation-error re-render project context', () => {
    it('malformed projectId: no malformed Cancel href, Cancel falls back, no option selected', async () => {
      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('projectId=1abc')
        .send('title=Malformed+Context+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).not.toMatch(/href="\/projects\/[^"]*"[^>]*>Cancel<\/a>/);
      expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
      expect(res.text).not.toMatch(/<input[^>]*name="projectId"[^>]*type="radio"[^>]*value="\d+"[^>]*checked/);
    });

    it('numerically unsafe projectId: 422, safe fallback, rounded value not rendered or selected', async () => {
      const unsafeValue = '9007199254740993';
      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${unsafeValue}`)
        .send('title=Unsafe+Integer+Context+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).not.toMatch(/<input[^>]*name="projectId"[^>]*type="radio"[^>]*value="\d+"[^>]*checked/);
      expect(res.text).not.toContain(`/projects/${unsafeValue}`);
      expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
    });

    it('status=archived, archived_at=NULL project: not an option, Cancel falls back, archived message preserved', async () => {
      const inconsistentId = insertProjectDirect(db, {
        title: 'POST Inconsistent Archived Row',
        status: 'archived',
        archivedAt: null,
      });

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${inconsistentId}`)
        .send('title=Should+Not+Create')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toContain('Cannot create release for archived project.');
      expect(res.text).not.toContain(`value="${inconsistentId}"`);
      expect(res.text).not.toContain('POST Inconsistent Archived Row');
      expect(selectedProjectRadioValue(res.text)).toBeUndefined();
      expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
    });

    it('archived_at-set project: not an option, Cancel falls back', async () => {
      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=POST+Archived+At+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      await agent
        .post(`/projects/${projectId}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Should+Not+Create+Either')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).not.toContain(`value="${projectId}"`);
      expect(res.text).not.toContain('POST Archived At Project');
      expect(selectedProjectRadioValue(res.text)).toBeUndefined();
      expect(res.text).toContain('<a class="button button-secondary" href="/releases">Cancel</a>');
    });

    it('valid active project: preselected on re-render, Cancel to /projects/:id, other fields preserved', async () => {
      const projRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=POST+Valid+Active+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=') // triggers an unrelated (title required) validation error
        .send('description=Keep+This+Description')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(new RegExp(`name="projectId"[^>]*value="${projectId}"[^>]*checked`));
      expect(res.text).toContain(`<a class="button button-secondary" href="/projects/${projectId}">Cancel</a>`);
      expect(res.text).toContain('Keep This Description');
      expect(res.text).toContain('Title is required');
    });

    it('valid active project outside the first 100 options: added exactly once and selected, Cancel to /projects/:id', async () => {
      const TOTAL = 101;
      let targetId;
      for (let i = 0; i < TOTAL; i++) {
        const updatedAt = `2024-04-01 00:00:${String(TOTAL - i).padStart(2, '0')}`;
        const id = insertProjectDirect(db, {
          title: `POST Beyond Limit Project ${i}`,
          status: 'tbd',
          updatedAt,
        });
        if (i === TOTAL - 1) targetId = id;
      }

      const res = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${targetId}`)
        .send('title=') // triggers an unrelated (title required) validation error
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      const radioMatches = res.text.match(new RegExp(`<input[^>]*name="projectId"[^>]*type="radio"[^>]*value="${targetId}"[^>]*>`, 'g')) || [];
      expect(radioMatches).toHaveLength(1);
      expect(radioMatches[0]).toContain('checked');
      expect(releaseProjectRadioInputs(res.text).filter((radio) => /\bchecked\b/.test(radio))).toHaveLength(1);
      expect(res.text).toContain(`<a class="button button-secondary" href="/projects/${targetId}">Cancel</a>`);
    });
  });

  // ─── Edit release ─────────────────────────────────────────────────────────

  it('edit fallback opens a prefilled detail-hosted dialog without opening publish', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Edit+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Before+Edit')
      .send('description=Existing+description')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const releaseLocation = createRes.headers.location;

    const redirect = await agent.get(`${releaseLocation}/edit`).expect(302);
    expect(redirect.headers.location).toBe(`${releaseLocation}?edit=1`);

    const res = await agent.get(redirect.headers.location).expect(200);
    const editDialog = res.text.match(/<dialog id="release-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    expect(editDialog).not.toMatch(/<dialog id="release-edit-dialog"[^>]*open/);
    expect(editDialog).toContain(`data-release-edit-deep-link="${releaseLocation.split('/').at(-1)}"`);
    expect(editDialog).toContain('<dialog id="release-edit-dialog" class="app-dialog project-form-dialog app-dialog--refined"');
    expect(editDialog).toContain('class="app-dialog-body project-edit-dialog-body"');
    expect(editDialog).toContain(`<form id="release-edit-form" method="post" action="${releaseLocation}" class="app-dialog-form project-form project-edit-dialog-form"`);
    expect(editDialog).toContain('class="settings-section project-form-section project-edit-dialog-section release-details-section"');
    expect(editDialog).toContain('class="release-form-section-body project-form-section-body project-edit-dialog-section-body release-details-section-body"');
    expect(editDialog).toContain('class="field-row scheduling-row"');
    expect(editDialog).not.toContain('data-release-dialog-compact-section');
    expectReleaseDialogSections(editDialog, ['Release details', 'Scheduling']);
    expect(editDialog).not.toMatch(/<h3>(?:Project|Basic information|Platforms|Links)<\/h3>/);
    expect(editDialog).not.toContain('name="projectId"');
    expect(editDialog).not.toContain('release-details-project');
    expect(editDialog).toMatch(/<h3>Scheduling<\/h3>[\s\S]*?id="plannedDate"[\s\S]*?id="plannedTime"[\s\S]*?id="publishedDate"[\s\S]*?<legend>Platforms<\/legend>[\s\S]*?<label for="patreonUrl">Release link<\/label>/);
    expect(editDialog).not.toContain('name="noSetReleaseDate"');
    expect(editDialog).toContain('aria-describedby="release-edit-description"');
    expect(editDialog).toContain('<section class="settings-section project-edit-dialog-section project-actions project-edit-dialog-actions" aria-labelledby="release-actions-heading">');
    const css = (await agent.get('/creatorcrate.css').expect(200)).text;
    expect(css).toMatch(/#release-edit-dialog,\s*#release-publish-dialog\s*\{[^}]*width:\s*min\(51rem,\s*calc\(100vw - 2rem\)\)/);
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*\.project-form-dialog \.scheduling-row[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(editDialog).toContain('value="Before Edit"');
    expect(editDialog).not.toMatch(/<button[^>]*>\s*Cancel\s*<\/button>/);
    expect(editDialog.match(/data-dialog-close/g)).toHaveLength(1);
    expect(editDialog).toContain('Existing description');
    expect(editDialog).toContain('Save changes');
    expect(editDialog).not.toMatch(/name="projectId"/);
    expect(editDialog).not.toContain('data-dialog-return-location');
    expect(res.text).not.toMatch(/<dialog id="release-publish-dialog"[^>]*open/);
  });

  it('redirects a legacy Calendar-invoked /edit link to the canonical deep link without returnTo', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
    const returnTo = '/calendar?month=2026-07&filter=planned#release-19';

    const entry = await agent
      .get(`${releaseLocation}/edit?returnTo=${encodeURIComponent(returnTo)}`)
      .expect(302);
    const hosted = new URL(entry.headers.location, 'http://creatorcrate.local');
    expect(hosted.pathname).toBe(releaseLocation);
    expect(hosted.searchParams.get('edit')).toBe('1');
    expect(hosted.searchParams.has('returnTo')).toBe(false);
    expect(entry.headers.location).toBe(`${releaseLocation}?edit=1`);

    // Editing stays on Release Detail; nothing returns to Calendar.
    const res = await agent.get(`${releaseLocation}?edit=1&returnTo=${encodeURIComponent(returnTo)}`).expect(200);
    expect(res.text).not.toMatch(/<dialog id="release-edit-dialog"[^>]*open/);
    expect(res.text).toContain('data-release-edit-deep-link=');
    expect(res.text).not.toContain('data-dialog-return-location');
  });

  it('keeps a Calendar-originated JSON Release save local, ignoring a submitted returnTo', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
    const returnTo = '/calendar?month=2026-07&filter=planned#release-19';

    const res = await agent
      .post(releaseLocation)
      .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseLocation))
      .send('title=Updated+from+Calendar')
      .send('returnTo=' + encodeURIComponent(returnTo))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(200)
      .expect('Content-Type', /json/);

    expect(res.headers.location).toBeUndefined();
    expect(res.body).toMatchObject({ status: 'success', message: 'Release updated.', values: { title: 'Updated from Calendar' } });
    expect(JSON.stringify(res.body)).not.toContain('/calendar');
  });

  it('answers a Calendar-originated Release edit validation failure with structured JSON, not a rerendered dialog', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
    const releaseId = Number(releaseLocation.replace('/releases/', ''));
    const before = releaseRepository.findById(releaseId);
    const returnTo = '/calendar?month=2026-07&filter=planned#release-19';

    const res = await agent
      .post(releaseLocation)
      .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseLocation))
      .send('title=')
      .send('description=Submitted+description')
      .send('returnTo=' + encodeURIComponent(returnTo))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422)
      .expect('Content-Type', /json/);

    expect(res.headers.location).toBeUndefined();
    expect(res.body).toMatchObject({
      status: 'error',
      code: 'VALIDATION_FAILED',
      errors: { title: expect.any(String) },
      values: { title: '', description: 'Submitted description' },
    });
    expect(res.body.values).not.toHaveProperty('returnTo');
    expect(releaseRepository.findById(releaseId).title).toBe(before.title);
  });

  it('answers a Release edit server error with JSON only, and refuses an HTML post before updating', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
    const releaseId = Number(releaseLocation.replace('/releases/', ''));
    const before = releaseRepository.findById(releaseId);
    const baseReleaseService = createReleaseService({ db });
    let updateCalls = 0;
    const stubbedApp = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      {
        releaseService: {
          ...baseReleaseService,
          updateRelease() {
            updateCalls += 1;
            throw new Error('simulated update failure');
          },
        },
        appDataRoot,
        authState: { csrfPepper: ensureAuthEnablement(appDataRoot).csrfPepper },
      },
    );
    const { agent: stubbedAgent, csrfToken: stubbedCsrfToken } = await getDisabledModeCsrf(stubbedApp, appDataRoot);
    const submit = () => stubbedAgent
      .post(releaseLocation)
      .send('_csrf=' + encodeURIComponent(stubbedCsrfToken))
      .send('title=Still+submitted')
      .send('description=Submitted+after+failure')
      .send('returnTo=' + encodeURIComponent('/calendar?month=2026-07'))
      .set('Content-Type', 'application/x-www-form-urlencoded');

    const res = await submit().set('Accept', 'application/json').expect(500).expect('Content-Type', /json/);
    expect(res.body).toEqual({ status: 'error', code: 'SERVER_ERROR', message: 'Release update failed. Please try again.' });
    expect(updateCalls).toBe(1);

    const html = await submit().expect(406);
    expect(html.headers.location).toBeUndefined();
    expect(html.text).not.toContain('<dialog id="release-edit-dialog"');
    expect(updateCalls).toBe(1);
    expect(releaseRepository.findById(releaseId).title).toBe(before.title);
  });

  it.each([
    ['external', 'https://example.com/calendar?month=2026-07'],
    ['protocol-relative', '//example.com/calendar?month=2026-07'],
    ['unrelated local path', '/releases?month=2026-07'],
  ])('ignores an %s Release edit return destination', async (_label, returnTo) => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    const entry = await agent
      .get(`${releaseLocation}/edit?returnTo=${encodeURIComponent(returnTo)}`)
      .expect(302);
    expect(entry.headers.location).toBe(`${releaseLocation}?edit=1`);

    const hosted = await agent.get(entry.headers.location).expect(200);
    expect(hosted.text).not.toContain('data-dialog-return-location');

    const saved = await agent
      .post(releaseLocation)
      .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseLocation))
      .send('title=Safely+Updated')
      .send('returnTo=' + encodeURIComponent(returnTo))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(200);
    expect(saved.headers.location).toBeUndefined();
    expect(saved.body.values.title).toBe('Safely Updated');
  });

  it('normal release detail includes but does not open the Edit dialog', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    const res = await agent.get(releaseLocation).expect(200);
    expect(res.text).toContain('<dialog id="release-edit-dialog"');
    expect(res.text).not.toMatch(/<dialog id="release-edit-dialog"[^>]*open/);
  });

  it('existing release editing does not expose a release-owned status field', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Existing+Release+Status')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Stored+Release+Status')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    setProjectStatusForReleaseTest(db, createRes.headers.location, 'planned');

    const redirect = await agent.get(`${createRes.headers.location}/edit`).expect(302);
    const res = await agent.get(redirect.headers.location).expect(200);
    expect(res.text).not.toContain('id="status"');
    expect(releaseRepository.findById(Number(createRes.headers.location.replace('/releases/', ''))).project_status)
      .toBe('planned');
  });

  it('failed existing-release edits ignore the submitted status', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Failed+Edit+Status')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Editable+Release+Status')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const releaseId = createRes.headers.location.replace('/releases/', '');

    const res = await agent
      .post(`/releases/${releaseId}`)
      .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(`/releases/${releaseId}`))
      .send('title=')
      .send('status=ready')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', errors: { title: expect.stringContaining('Title is required') }, values: { title: '' } });
    expect(res.body.values).not.toHaveProperty('status');

    // The page keeps the one closed Edit dialog with its Archive/Delete actions.
    const detail = await agent.get(`/releases/${releaseId}`).expect(200);
    const editDialog = detail.text.match(/<dialog id="release-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
    const editForm = editDialog.match(/<form id="release-edit-form"[\s\S]*?<\/form>/)?.[0] || '';
    expect(editDialog).not.toMatch(/<dialog id="release-edit-dialog"[^>]*open/);
    expect(editDialog).toContain('<dialog id="release-edit-dialog" class="app-dialog project-form-dialog app-dialog--refined"');
    expect(editDialog).toContain('class="app-dialog-body project-edit-dialog-body"');
    expect(editForm).toContain('class="app-dialog-form project-form project-edit-dialog-form"');
    expect(editForm).toContain('class="field-row scheduling-row"');
    expect(editDialog).toMatch(new RegExp(`action="/releases/${releaseId}/archive"`));
    expect(editDialog).toMatch(new RegExp(`action="/releases/${releaseId}/delete"`));
    expect(editForm).not.toMatch(/action="\/releases\/\d+\/(?:archive|delete)"/);
    expect(detail.text).not.toContain('id="status"');
    expect(releaseRepository.findById(Number(releaseId))).not.toHaveProperty('status');
  });

  it('valid update saves through JSON and stays on the requesting page', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Update+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Old+Title')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await agent
      .post(createRes.headers.location)
      .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(createRes.headers.location))
      .send('title=New+Title')
      .send('status=planned')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toMatchObject({ status: 'success', release: { title: 'New Title' } });
    expect(releaseRepository.findById(Number(createRes.headers.location.replace('/releases/', ''))))
      .not.toHaveProperty('status');

    const detail = await agent.get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('New Title');
  });

  // ─── Publish ───────────────────────────────────────────────────────────────

  it('publish action sets published_date and redirects', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    const res = await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toBe(releaseLocation);

    const detail = await agent.get(releaseLocation).expect(200);
    expect(detail.text).toContain('Published');
  });

  it('cannot publish already published release', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toContain('already published');
  });

  // ─── Archive ──────────────────────────────────────────────────────────────

  it('archive action sets archived_at and redirects', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Archive+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=To+Archive')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const res = await agent
      .post(`${createRes.headers.location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(res.headers.location).toBe(createRes.headers.location);

    const detail = await agent.get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('Archived');
    expectProjectReturnLead(detail.text, { href: `/projects/${projectId}`, title: 'Archive Test Project' });
    expectReleaseDetailNav(detail.text, { projectId, releaseLocation: createRes.headers.location });
  });

  it('cannot archive already archived release', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Double+Archive+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Double+Archive')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    await agent
      .post(`${createRes.headers.location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const res = await agent
      .post(`${createRes.headers.location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toMatch(/archived and cannot be modified/);
  });

  // ─── Asset selection ──────────────────────────────────────────────────────

  it('asset selection page renders project assets', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Asset+Selection+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Scan to create assets
    await agent
      .post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Asset+Selection+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    db.prepare("UPDATE projects SET status = 'ready' WHERE id = ?").run(projectId);

    const res = await agent
      .get(`${createRes.headers.location}/assets`)
      .expect(200);
    expect(res.text).toContain('Asset Selection Release');
    expectProjectReturnLead(res.text, { href: `/projects/${projectId}`, title: 'Asset Selection Project' });
    expectHeadingNavLink(res.text, { key: 'release', href: createRes.headers.location, label: 'Release', tooltip: 'Go to release details' });
    expect(res.text).not.toContain('Back to Release');
    expect(res.text).not.toContain('Project status:');
    expect(res.text).toContain('<span class="status-badge status-badge--active">Ready</span>');
  });

  it('asset selection requires assets from correct project', async () => {
    const proj1Res = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Project+One')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId1 = proj1Res.headers.location.replace('/projects/', '');

    const proj2Res = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Project+Two')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId2 = proj2Res.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId1}`)
      .send('title=Cross+Project+Test')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Verify the release is associated with project 1
    const detail = await agent.get(createRes.headers.location).expect(200);
    expect(detail.text).toContain('Project One');
  });

  it('asset selection form submission with explicit fields saves selections', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Asset+Form+Test+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Create a file and scan
    const projectDir = getProjectDir(projectsRoot, projectId, 'asset-form-test-project');
    fs.writeFileSync(path.join(projectDir, 'file1.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'file2.txt'), 'txt');

    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    // Get the actual asset ID from the database
    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const firstAssetId = String(assets[0].id);

    // Create a release
    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Asset+Form+Test+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submit asset selection using the new explicit format
    const submitRes = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${firstAssetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Successful saves return to the corresponding release detail page.
    expectReleaseAssetsSavedLocation(submitRes.headers.location, releaseId);

    // Verify exact junction-table rows
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ asset_id: Number(firstAssetId), role: 'primary', sort_order: 0 });
  });

  it('rejects malformed asset IDs with 422', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Malformed+Asset+ID+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'malformed-asset-id-test');
    fs.writeFileSync(path.join(projectDir, 'mid.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Malformed+Asset+ID+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with malformed asset ID (e.g., "1x")
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[]=1x')
      .send('roles[1x]=primary')
      .send('sortOrder[1x]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toContain('Invalid');

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('publish does not require a ready project status', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Publish+Ready+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Create release with tbd status
    const tbdRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Idea+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const publishRes = await agent
      .post(`${tbdRes.headers.location}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
    expect(publishRes.headers.location).toBe(tbdRes.headers.location);
    expect(db.prepare('SELECT published_date FROM releases WHERE id = ?').get(
      Number(tbdRes.headers.location.replace('/releases/', ''))
    ).published_date).toBeTruthy();
  });

  // ─── Error rendering safety ───────────────────────────────────────────────

  it('error responses contain no absolute filesystem paths', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=No+Path+Release+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const res = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);
    expect(res.text).not.toMatch(/[A-Z]:\\/);
  });

  // ─── Phase 5 release-readiness: regression coverage ────────────────────────

  it('asset selection form accepts a no-JS submission (only selectedAssetIds sent)', async () => {
    // Simulates a browser submission without JavaScript: the role and sortOrder
    // fields are disabled for newly-checked rows, so the browser never sends
    // them. The server must accept this and apply sensible defaults rather
    // than rejecting the submission.
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=NoJS+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Create a file and scan
    const projectDir = getProjectDir(projectsRoot, projectId, 'no-js-asset-test');
    fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'b.txt'), 'txt');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const firstAssetId = String(assets[0].id);
    const secondAssetId = String(assets[1].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=NoJS+Asset+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submission with ONLY selectedAssetIds — no roles[], no sortOrder[].
    // The browser renumbers arrays after excluding disabled controls, so the
    // server receives an array of asset ids and no role/sortOrder values.
    const submitRes = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${firstAssetId}`)
      .send(`selectedAssetIds[]=${secondAssetId}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expectReleaseAssetsSavedLocation(submitRes.headers.location, releaseId);

    // Both assets should be selected with the default role (attachment) and
    // normalized contiguous sort order. The route must not have thrown.
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe('attachment');
    expect(rows[0].sort_order).toBe(0);
    expect(rows[1].role).toBe('attachment');
    expect(rows[1].sort_order).toBe(1);
  });

  it('asset selection form accepts a partial-JS submission (selectedAssetIds plus one role)', async () => {
    // Realistic case: a user enables JS for some rows but not others. The
    // browser renumbers arrays after excluding disabled controls. The server
    // must still accept the submission.
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=PartialJS+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'partial-js-asset-test');
    fs.writeFileSync(path.join(projectDir, 'one.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'two.txt'), 'txt');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    const firstAssetId = String(assets[0].id);
    const secondAssetId = String(assets[1].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=PartialJS+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Two selected, but only one role / sortOrder pair. The second selected
    // asset will fall back to defaults. This mirrors what the browser sends
    // when the second row's role/sortOrder are disabled.
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${firstAssetId}`)
      .send(`selectedAssetIds[]=${secondAssetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=7')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(2);
    // Ordered by sort_order ASC, asset_id ASC — second asset has sort_order 0 so it comes first
    expect(rows[0]).toMatchObject({ asset_id: Number(secondAssetId), role: 'attachment', sort_order: 0 });
    expect(rows[1]).toMatchObject({ asset_id: Number(firstAssetId), role: 'primary', sort_order: 7 });
  });

  it('asset validation failure preserves submitted selections in the re-rendered form', async () => {
    // The 422 response must re-render the assets form with the SUBMITTED
    // selections (asset ids + roles + sort orders) so the user does not lose
    // their input — it must NOT load the persisted selections from the DB.
    //
    // We trigger a 422 by submitting a cross-project asset. To make the
    // preservation visible, the release already has a PERSISTED selection
    // (asset A as primary) and the user submits a DIFFERENT selection
    // (asset A as preview, plus a cross-project asset). The 422 must render
    // the form with "preview" selected, NOT "primary" — proving the form
    // reflects the submission, not the persisted state.
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Preserve+Selection+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    // Sibling project — used to create a cross-project asset id.
    const proj2Res = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Other+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const otherProjectId = proj2Res.headers.location.replace('/projects/', '');

    const mainDir = getProjectDir(projectsRoot, projectId, 'preserve-selection-test');
    fs.writeFileSync(path.join(mainDir, 'main.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const otherDir = getProjectDir(projectsRoot, otherProjectId, 'other-project');
    fs.writeFileSync(path.join(otherDir, 'other.png'), 'png');
    await agent.post(`/projects/${otherProjectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const mainAssets = assetRepo.findByProjectId(Number(projectId));
    const otherAssets = assetRepo.findByProjectId(Number(otherProjectId));
    expect(mainAssets.length).toBeGreaterThan(0);
    expect(otherAssets.length).toBeGreaterThan(0);
    const mainAssetId = mainAssets[0].id;
    const otherAssetId = otherAssets[0].id;

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Preserve+Selection+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a baseline selection: asset A as primary, sort order 0.
    // This is what the user sees if the route falls back to the DB on
    // validation failure — the regression we are guarding against.
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${mainAssetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0]).toMatchObject({ asset_id: mainAssetId, role: 'primary', sort_order: 0 });

    // Now submit a DIFFERENT selection: change the role to "preview" and
    // add a cross-project asset. This must produce a 422 from the service.
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${mainAssetId}`)
      .send(`selectedAssetIds[]=${otherAssetId}`)
      .send('roles[]=preview')
      .send('roles[]=attachment')
      .send('sortOrder[]=5')
      .send('sortOrder[]=9')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    // Validation error must be present
    expect(res.text).toMatch(/does not belong to the release/i);

    // The re-rendered cards must reflect the SUBMITTED role ("preview"), not
    // the PERSISTED role ("primary"). This is the regression assertion.
    expect(res.text).toMatch(/<option value="preview" selected/);
    expect(res.text).not.toMatch(/<option value="primary" selected/);

    // The submitted main asset must be checked.
    expect(res.text).toMatch(new RegExp(`id="release-asset-select-${mainAssetId}"[\\s\\S]*?\\bchecked\\b`));

    // Persisted rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  // ─── Phase 6D: duplicate rejection, form-state preservation, DB assertions ──

  it('renders submitted membership and a separate persisted baseline after selection validation fails', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Duplicate+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'duplicate-asset-test');
    fs.writeFileSync(path.join(projectDir, 'draft.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'persisted.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets).toHaveLength(2);
    const draftAssetId = String(assets.find((asset) => asset.filename === 'draft.png').id);
    const persistedAssetId = String(assets.find((asset) => asset.filename === 'persisted.png').id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Duplicate+Asset+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${persistedAssetId}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    // Duplicate draft membership triggers 422 without changing the persisted
    // baseline. The rendered selection must still reflect the submission, in
    // the All assets filter context the save was submitted from.
    const res = await agent
      .post(createRes.headers.location + '/assets?selection=all')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${draftAssetId}`)
      .send(`selectedAssetIds[]=${draftAssetId}`)
      .send('roles[]=primary')
      .send('roles[]=attachment')
      .send('sortOrder[]=0')
      .send('sortOrder[]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/duplicate/i);
    expect(res.text).toMatch(new RegExp(`id="release-asset-select-${draftAssetId}"[^>]*\\bchecked\\b`));
    const persistedCheckbox = res.text.match(new RegExp(`<input[^>]*id="release-asset-select-${persistedAssetId}"[^>]*>`))?.[0] || '';
    expect(persistedCheckbox).not.toContain('checked');
    expect(res.text).toContain(`data-release-assets-persisted-id value="${persistedAssetId}"`);
    expect(res.text).not.toContain(`data-release-assets-persisted-id value="${draftAssetId}"`);
    expect(res.text).toContain(`<form id="release-assets-form" method="post" action="/releases/${releaseId}/assets?selection=all"`);
    expect(res.text).not.toContain('data-release-assets-selection-notice');

    // Validation does not mutate the persisted membership.
    const rows = getReleaseAssets(db, releaseId);
    expect(rows.map((row) => String(row.asset_id))).toEqual([persistedAssetId]);
  });

  it('rejects duplicate string IDs with 422', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Dup+String+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'dup-string-test');
    fs.writeFileSync(path.join(projectDir, 'dupstr.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Dup+String+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submit same ID twice as string values
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send(`selectedAssetIds[]=${assetId}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/duplicate/i);

    // No junction rows were written
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(0);
  });

  it('rejects nested array selectedAssetIds safely', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Nested+Array+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'nested-array-test');
    fs.writeFileSync(path.join(projectDir, 'nested.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Nested+Array+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with a nested array value (malformed)
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      // Express extended parsing: selectedAssetIds[0][]=1 produces nested array
      .send('selectedAssetIds[0][]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects object selectedAssetIds safely', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Object+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'object-asset-test');
    fs.writeFileSync(path.join(projectDir, 'obj.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Object+Asset+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Submit with an object value (numeric keys, valid shape) — the route
    // normalizes it to an array and then the duplicate detection catches it.
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[0]=${assetId}`)
      .send(`selectedAssetIds[1]=${assetId}`)
      .send('roles[0]=primary')
      .send('roles[1]=attachment')
      .send('sortOrder[0]=0')
      .send('sortOrder[1]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/duplicate/i);

    // No junction rows were written
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(0);
  });

  it('rejects blank selectedAssetIds safely', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Blank+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'blank-asset-test');
    fs.writeFileSync(path.join(projectDir, 'blank.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Blank+Asset+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with blank asset ID
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[]=')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects non-integer asset IDs safely', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=NonInt+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'non-int-asset-test');
    fs.writeFileSync(path.join(projectDir, 'ni.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=NonInt+Asset+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with float string
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[]=1.5')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects negative asset IDs safely', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Neg+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'neg-asset-test');
    fs.writeFileSync(path.join(projectDir, 'neg.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Neg+Asset+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[]=-1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects zero asset IDs safely', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Zero+Asset+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'zero-asset-test');
    fs.writeFileSync(path.join(projectDir, 'zero.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Zero+Asset+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('single selected asset + invalid role → 422 and checkbox remains selected', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Single+Asset+Role+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'single-asset-role-test');
    fs.writeFileSync(path.join(projectDir, 'single.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Single+Asset+Role+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a baseline selection
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds=${assetId}`)
      .send('roles[0]=primary')
      .send('sortOrder[0]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit one valid asset with the obsolete source role — triggers 422
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds=${assetId}`)
      .send('roles[0]=source')
      .send('sortOrder[0]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    // The checkbox for the submitted asset must remain checked
    expect(res.text).toMatch(new RegExp(`id="release-asset-select-${assetId}"[\\s\\S]*?\\bchecked\\b`));

    // Persisted rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('multiple selected assets + one validation error → all valid selections remain checked', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Multi+Asset+Preserve+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'multi-asset-preserve-test');
    fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'b.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const assetId1 = String(assets[0].id);
    const assetId2 = String(assets[1].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Multi+Asset+Preserve+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a baseline selection
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId1}`)
      .send(`selectedAssetIds[]=${assetId2}`)
      .send('roles[]=primary')
      .send('roles[]=attachment')
      .send('sortOrder[]=0')
      .send('sortOrder[]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(2);

    // Submit two valid assets with an invalid role on the second — triggers 422
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId1}`)
      .send(`selectedAssetIds[]=${assetId2}`)
      .send('roles[]=primary')
      .send('roles[]=invalid-role')
      .send('sortOrder[]=0')
      .send('sortOrder[]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    // Both submitted checkboxes must remain checked
    expect(res.text).toMatch(new RegExp(`id="release-asset-select-${assetId1}"[\\s\\S]*?\\bchecked\\b`));
    expect(res.text).toMatch(new RegExp(`id="release-asset-select-${assetId2}"[\\s\\S]*?\\bchecked\\b`));

    // Persisted rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('intentional clear (no selectedAssetIds) succeeds and removes all rows', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Empty+Selection+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'empty-selection-test');
    fs.writeFileSync(path.join(projectDir, 'clear.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Empty+Selection+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(getReleaseAssets(db, releaseId)).toHaveLength(1);

    // Submit with no selectedAssetIds at all — should succeed (empty = clear)
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expectReleaseAssetsSavedLocation(res.headers.location, releaseId);

    // All junction rows must be removed
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(0);
  });

  it('empty scalar selectedAssetIds= clears all selections', async () => {
    // Regression: selectedAssetIds= as an empty scalar string must be treated
    // as an intentional clear, not a malformed submission.
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Empty+Scalar+Clear+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'empty-scalar-clear-test');
    fs.writeFileSync(path.join(projectDir, 'esc.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Empty+Scalar+Clear+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(getReleaseAssets(db, releaseId)).toHaveLength(1);

    // Submit with selectedAssetIds= (empty scalar) — must succeed and clear
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds=')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expectReleaseAssetsSavedLocation(res.headers.location, releaseId);

    // All junction rows must be removed
    const rows = getReleaseAssets(db, releaseId);
    expect(rows).toHaveLength(0);
  });

  it('rejects null selectedAssetIds with 415 and preserves rows', async () => {
    // Regression: null must be treated as malformed, not as an intentional clear.
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Null+Asset+Reject+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'null-asset-reject-test');
    fs.writeFileSync(path.join(projectDir, 'null.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Null+Asset+Reject+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with null via JSON body. JSON is not a Save encoding (B-F2R7):
    // it is refused before the draft is read, never treated as a clear.
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send({ selectedAssetIds: null, _csrf: csrfToken })
      .set('Content-Type', 'application/json')
      .expect(415);

    expect(res.text).toContain('Unsupported asset selection request format.');

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('malformed object/nested values are rejected safely', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Malformed+Object+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'malformed-object-test');
    fs.writeFileSync(path.join(projectDir, 'm1.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'm2.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const assetId1 = String(assets[0].id);
    const assetId2 = String(assets[1].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Malformed+Object+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId1}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0].asset_id).toBe(Number(assetId1));

    // Submit with selectedAssetIds as an object with numeric keys (extended
    // parsing quirk: selectedAssetIds[0]=1 → { '0': '1' }). The route
    // normalizes this to an array via normalizeSelectedAssetIds.
    // Use a cross-project asset to trigger a validation error (422).
    const proj2Res = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Other+Malformed+Project')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const otherProjectId = proj2Res.headers.location.replace('/projects/', '');
    const otherProjectDir = getProjectDir(projectsRoot, otherProjectId, 'other-malformed-project');
    fs.writeFileSync(path.join(otherProjectDir, 'other.png'), 'png');
    await agent.post(`/projects/${otherProjectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const otherAssets = assetRepo.findByProjectId(Number(otherProjectId));
    expect(otherAssets.length).toBeGreaterThan(0);
    const otherAssetId = String(otherAssets[0].id);

    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[0]=${assetId1}`)
      .send(`selectedAssetIds[1]=${otherAssetId}`)
      .send('roles[0]=primary')
      .send('roles[1]=attachment')
      .send('sortOrder[0]=0')
      .send('sortOrder[1]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    // The object shape is normalized to an array, then the cross-project
    // asset triggers a validation error. The key point is 422, not 500.
    expect(res.text).toMatch(/does not belong/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects selectedAssetIds[foo][bar]=1 (nested object with non-numeric keys) and preserves rows', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Nested+Obj+Key+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'nested-obj-key-test');
    fs.writeFileSync(path.join(projectDir, 'nok.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Nested+Obj+Key+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with selectedAssetIds[foo][bar]=1 — nested object with non-numeric keys
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[foo][bar]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects selectedAssetIds[foo]=1 (non-numeric key) and preserves rows', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=NonNumeric+Key+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'non-numeric-key-test');
    fs.writeFileSync(path.join(projectDir, 'nnk.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=NonNumeric+Key+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with selectedAssetIds[foo]=1 — non-numeric key
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('selectedAssetIds[foo]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('rejects mixed flat and nested values and preserves rows', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Mixed+Nested+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'mixed-nested-test');
    fs.writeFileSync(path.join(projectDir, 'mn.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Mixed+Nested+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection first
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Submit with mixed flat and nested values — one valid scalar and one nested
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('selectedAssetIds[0][]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/invalid/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);
  });

  it('archived release rejection preserves persisted rows', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Archived+Preserve+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'archived-preserve-test');
    fs.writeFileSync(path.join(projectDir, 'ap.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Archived+Preserve+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Archive the release
    await agent
      .post(`${createRes.headers.location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    // Attempt to modify assets on the archived release
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=preview')
      .send('sortOrder[]=5')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/archived/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);

    // GET the assets page — no bulk-selection checkboxes, no Save asset selection
    const assetsPage = await agent
      .get(`${createRes.headers.location}/assets`)
      .expect(200);
    // The entire bulk-selection form must be absent in read-only scope
    const checkboxRegex = /<input type="checkbox" name="selectedAssetIds\[\]" value="(\d+)"[^>]*class="asset-checkbox"[^>]*>/g;
    let match;
    let checkboxCount = 0;
    while ((match = checkboxRegex.exec(assetsPage.text)) !== null) {
      checkboxCount++;
    }
    expect(checkboxCount).toBe(0);
    // Save asset selection button must not be present
    expect(assetsPage.text).not.toMatch(/type="submit"[^>]*>Save asset selection/);
  });

  it('archived parent rejection preserves persisted rows', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Archived+Parent+Preserve')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'archived-parent-preserve');
    fs.writeFileSync(path.join(projectDir, 'app.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThan(0);
    const assetId = String(assets[0].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Archived+Parent+Preserve+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist a selection
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=primary')
      .send('sortOrder[]=0')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(1);

    // Archive the parent project
    await agent
      .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    // Attempt to modify assets — parent is archived
    const res = await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${assetId}`)
      .send('roles[]=preview')
      .send('sortOrder[]=5')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(422);

    expect(res.text).toMatch(/archived/i);

    // Original rows must remain unchanged
    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toEqual(beforeRows);

    // GET the assets page — no bulk-selection checkboxes, no Save asset selection
    const assetsPage = await agent
      .get(`${createRes.headers.location}/assets`)
      .expect(200);
    // The entire bulk-selection form must be absent in read-only scope
    const checkboxRegex = /<input type="checkbox" name="selectedAssetIds\[\]" value="(\d+)"[^>]*class="asset-checkbox"[^>]*>/g;
    let match;
    let checkboxCount = 0;
    while ((match = checkboxRegex.exec(assetsPage.text)) !== null) {
      checkboxCount++;
    }
    expect(checkboxCount).toBe(0);
    // Save asset selection button must not be present
    expect(assetsPage.text).not.toMatch(/type="submit"[^>]*>Save asset selection/);
  });

  it('replacement removes only intentionally deselected rows', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Replacement+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const projectDir = getProjectDir(projectsRoot, projectId, 'replacement-test');
    fs.writeFileSync(path.join(projectDir, 'keep.png'), 'png');
    fs.writeFileSync(path.join(projectDir, 'remove.png'), 'png');
    await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

    const assetRepo = createAssetRepository(db);
    const assets = assetRepo.findByProjectId(Number(projectId));
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const keepAssetId = String(assets[0].id);
    const removeAssetId = String(assets[1].id);

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Replacement+Release')
      .send('status=tbd')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const releaseId = Number(createRes.headers.location.replace('/releases/', ''));

    // Persist two selections
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${keepAssetId}`)
      .send(`selectedAssetIds[]=${removeAssetId}`)
      .send('roles[]=primary')
      .send('roles[]=attachment')
      .send('sortOrder[]=0')
      .send('sortOrder[]=1')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const beforeRows = getReleaseAssets(db, releaseId);
    expect(beforeRows).toHaveLength(2);

    // Submit with only the first asset — the second should be removed
    await agent
      .post(createRes.headers.location + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`selectedAssetIds[]=${keepAssetId}`)
      .send('roles[]=preview')
      .send('sortOrder[]=5')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const afterRows = getReleaseAssets(db, releaseId);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]).toMatchObject({ asset_id: Number(keepAssetId), role: 'preview', sort_order: 5 });
  });

  it('publish preserves an explicit publishedDate submitted with the publish form', async () => {
    // Simulates the detail page's publish button sending a hidden
    // publishedDate field — the route must honor it.
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    const res = await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('publishedDate=2025-12-15')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    expect(res.headers.location).toBe(releaseLocation);

    const detail = await agent.get(releaseLocation).expect(200);
    expect(detail.text).toContain('2025-12-15');
  });

  it('publishedDate set during metadata editing becomes the publication state', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    await agent
      .post(releaseLocation)
      .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseLocation))
      .send('title=Publishable+Release')
      .send('publishedDate=2025-08-20')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(200);

    const releaseId = Number(releaseLocation.replace('/releases/', ''));
    expect(db.prepare('SELECT published_date FROM releases WHERE id = ?').get(releaseId)).toEqual({
      published_date: '2025-08-20',
    });

    const publishReview = await agent.get(`${releaseLocation}/publish`).expect(302);
    expect(publishReview.headers.location).toBe(releaseLocation);
  });

  it('publish uses today when neither the form nor the release has a publishedDate', async () => {
    // The default-to-today path must still work for releases that were never
    // given a date.
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    const today = getLocalTodayIso();
    await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);

    const detail = await agent.get(releaseLocation).expect(200);
    expect(detail.text).toContain(today);
  });

  // ─── Publish path regression tests ──────────────────────────────────────

  it('direct POST with zero assets succeeds without a policy payload', async () => {
    const projRes = await agent
      .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send('title=Zero+Asset+Publish+Test')
      .send('status=tbd')
      .send('priority=normal')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    const projectId = projRes.headers.location.replace('/projects/', '');

    const createRes = await agent
      .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(`projectId=${projectId}`)
      .send('title=Zero+Asset+Publish')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .expect(302);
    setProjectStatusForReleaseTest(db, createRes.headers.location, 'ready');

    // Direct POST with no assets selected — no independent publish invariant
    // rejects this state.
    const res = await agent
      .post(`${createRes.headers.location}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    expect(res.headers.location).toBe(createRes.headers.location);
    expect(db.prepare('SELECT published_date FROM releases WHERE id = ?').get(
      Number(createRes.headers.location.replace('/releases/', ''))
    ).published_date).toBeTruthy();
  });

  it('direct POST with a missing selected asset succeeds', async () => {
    const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    // Mark the selected asset as missing
    const assetRepo = createAssetRepository(db);
    assetRepo.markMissingByProjectIdAndPathNotIn(Number(projectId), []);

    const res = await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    expect(res.headers.location).toBe(releaseLocation);
    expect(db.prepare('SELECT published_date FROM releases WHERE id = ?').get(
      Number(releaseLocation.replace('/releases/', ''))
    ).published_date).toBeTruthy();
  });

  it('fully publishable release succeeds via POST', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);
  });

  it('archived release publish rejection remains intact', async () => {
    const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

    // Archive the release
    await agent
      .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(302);

    // Publish must be rejected
    const res = await agent
      .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .expect(422);
    expect(res.text).toMatch(/archived/i);
  });

  // ─── Phase 6B regression: archived parent gates release mutation controls ──
  //
  // When the parent project is archived the release detail and assets pages
  // must hide the Edit, Archive, Publish, and Manage Assets affordances.
  // The release stays visible (read-only workspace) and the route layer
  // additionally rejects POSTs to the mutation endpoints. The combination
  // prevents users from triggering operations that the service would reject.

  describe('archived parent project gates release mutation controls', () => {
    it('release detail hides Edit, Archive, Publish, and Manage Assets when parent project is archived', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Gated+Controls+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Gated+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      // Archive the parent project. The release stays active in the DB.
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const detail = await agent.get(releaseLocation).expect(200);
      // Read-only notice must be present.
      expect(detail.text).toMatch(/read-only/i);
      // Mutation controls must be hidden.
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/edit"/);
      expect(detail.text).not.toMatch(/action="\/releases\/\d+\/archive"/);
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/assets"/);
      expect(detail.text).toMatch(/<div class="project-detail-summary">[\s\S]*?<section class="project-detail-info project-detail-section">[\s\S]*?<h2>Release details<\/h2>[\s\S]*?<div class="project-detail-section-body">/);
    });

    it('release detail still exposes editable controls for an active project (regression)', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      const detail = await agent.get(releaseLocation).expect(200);
      // Mutation controls are visible.
      expect(detail.text).toMatch(/href="\/releases\/\d+\?edit=1"/);
      expect(detail.text).toMatch(/action="\/releases\/\d+\/archive"/);
      expect(detail.text).toMatch(/href="\/releases\/\d+\/assets"/);
    });

    it('treats a legacy status-only archived parent as read-only across affordances and direct actions', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

      db.prepare("UPDATE projects SET status = 'archived', archived_at = NULL WHERE id = ?").run(projectId);

      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toMatch(/read-only/i);
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/edit"/);
      expect(detail.text).not.toMatch(/action="\/releases\/\d+\/archive"/);
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/publish"/);
      expect(detail.text).not.toMatch(/href="\/releases\/\d+\/assets"/);

      const assetsPage = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(assetsPage.text).toMatch(/read-only/i);
      expect(assetsPage.text).not.toContain('class="release-assets-form"');
      expect(assetsPage.text).not.toContain('class="asset-select-checkbox"');

      const editRedirect = await agent.get(`${releaseLocation}/edit`).expect(302);
      const publishRedirect = await agent.get(`${releaseLocation}/publish`).expect(302);
      expect(editRedirect.headers.location).toBe(releaseLocation);
      expect(publishRedirect.headers.location).toBe(releaseLocation);

      await agent
        .post(releaseLocation)
        .set('Accept', 'application/json')
        .type('form')
        .send({ title: 'Must Not Change', _csrf: csrfToken })
        .expect(422);
      await agent
        .post(`${releaseLocation}/publish`)
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(422);

      expect(db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId)).toEqual(beforeRelease);
      expect(db.prepare('SELECT status, archived_at FROM projects WHERE id = ?').get(projectId)).toEqual({
        status: 'archived',
        archived_at: null,
      });
    });

    it('release detail exposes Review & Publish for an eligible non-ready project', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      setProjectStatusForReleaseTest(db, releaseLocation, 'planned');

      const detail = await agent.get(releaseLocation).expect(200);
      expectReviewPublishAction(detail.text, { href: `${releaseLocation}/publish` });
    });

    it('asset selection page hides Save and disables inputs when parent project is archived', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Gated+Assets+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const projectDir = getProjectDir(projectsRoot, projectId, 'gated-assets-project');
      fs.writeFileSync(path.join(projectDir, 'gated.png'), 'png');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Gated+Asset+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      // Archive the parent project.
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const assets = await agent
        .get(`${releaseLocation}/assets`)
        .expect(200);
      // Read-only notice must be present.
      expect(assets.text).toMatch(/read-only/i);
      // Save asset selection button must not be rendered.
      expect(assets.text).not.toMatch(/type="submit"[^>]*>Save asset selection/);
      // The unified picker is omitted entirely in read-only scope.
      expect(assets.text).not.toContain('class="release-assets-form"');
      expect(assets.text).not.toContain('class="asset-select-checkbox"');
    });

    it('active project asset selection page has enabled checkboxes and Save button (regression)', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Active+Assets+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const projectDir = getProjectDir(projectsRoot, projectId, 'active-assets-project');
      fs.writeFileSync(path.join(projectDir, 'active.png'), 'png');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Active+Asset+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      const assets = await agent
        .get(`${releaseLocation}/assets?selection=all`)
        .expect(200);
      // Each picker checkbox must NOT contain disabled.
      const checkboxRe = /<input[^>]*id="release-asset-select-\d+"[^>]*class="asset-select-checkbox"[^>]*>/g;
      let match;
      let count = 0;
      while ((match = checkboxRe.exec(assets.text)) !== null) {
        count++;
        expect(match[0]).not.toContain('disabled');
      }
      expect(count).toBeGreaterThan(0);
      // Save asset selection button must exist and not be disabled.
      const saveForm = assets.text.match(/<form id="release-assets-form"[^>]*>[\s\S]*?<\/form>/);
      expect(saveForm).not.toBeNull();
      expect(saveForm[0]).toContain('method="post"');
      expect(saveForm[0]).toContain(`action="${releaseLocation}/assets?selection=all"`);
      const saveMatch = saveForm[0].match(/<button[^>]*>Save asset selection<\/button>/);
      expect(saveMatch).not.toBeNull();
      expect(saveMatch[0]).toContain('type="submit"');
      expect(saveMatch[0]).not.toContain('disabled');
    });

    it('POST /releases/:id update returns 422 when parent project is archived', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Update+Reject+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Update+Reject+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await agent.post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      // The update POST must be rejected with 422 because the parent project
      // is archived. The error page must surface the rejection reason.
      const res = await agent
        .post(createRes.headers.location)
        .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(createRes.headers.location))
        .send('title=New+Title')
        .send('status=planned')
        .set('Content-Type', 'application/x-www-form-urlencoded');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ status: 'error', code: expect.stringMatching(/^(?:RELEASE|PROJECT)_ARCHIVED$/) });
      expect(res.body.message).toMatch(/archived/i);
    });

    it('POST /releases/:id/publish renders release detail when parent project is archived', async () => {
      const { releaseLocation, projectId, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

      await agent.post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded');
      expect(res.status).toBe(422);
      expect(res.text).toContain('Readiness Test Release');
      expect(res.text).toContain('Readiness Test Project');
      expect(res.text).toContain('asset.png');
      // Archived parent renders read-only detail — no readiness panel, no error-box
      expect(res.text).not.toContain('class="readiness-panel"');
      expect(res.text).not.toContain('class="error-box"');
      expect(res.text).toContain('parent project is archived');
      expect(res.text).toMatch(/Project \d+ is archived and cannot be modified\./);
      expect(db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId)).toEqual(beforeRelease);
      expect(getReleaseAssets(db, releaseId)).toMatchObject([
        { asset_id: Number(assetId), role: 'primary', sort_order: 0 },
      ]);
    });

    it('POST /releases/:id/archive returns 422 when parent project is archived', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Archive+Reject+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Archive+Reject+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await agent.post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent
        .post(`${createRes.headers.location}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded');
      expect(res.status).toBe(422);
      expect(res.text).toMatch(/archived/i);
    });

    it('POST /releases/:id/assets returns 422 when parent project is archived', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Asset+Reject+Archived')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const projectDir = getProjectDir(projectsRoot, projectId, 'asset-reject-archived');
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      expect(assets.length).toBeGreaterThan(0);
      const assetId = String(assets[0].id);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Asset+Reject+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await agent.post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent
        .post(`${createRes.headers.location}/assets`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded');
      expect(res.status).toBe(422);
      expect(res.text).toMatch(/archived/i);
    });
  });

  // ─── Phase 7C-2: Explicit Missing Asset Selection Removal ─────────────────

  describe('missing asset removal', () => {
    /**
     * Helper: create a project, scan a file, create a release, select the asset,
     * then mark it missing. Returns { releaseLocation, assetId, assetRepo }.
     */
    async function setupMissingAsset() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Missing+Remove+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'missing-remove-test';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Missing+Remove+Release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      setProjectStatusForReleaseTest(db, releaseLocation, 'ready');

      // Select the asset
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Mark the asset as missing
      assetRepo.markMissingByProjectIdAndPathNotIn(Number(projectId), []);

      return { releaseLocation, assetId: Number(assetId), projectId: Number(projectId), assetRepo };
    }

    it('missing selection remains visible without a Remove action on detail page', async () => {
      const { releaseLocation } = await setupMissingAsset();

      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toContain('Missing');
      expect(res.text).not.toContain('/remove');
      expect(res.text).not.toContain('Remove this missing asset');
    });

    it('present selection does not show corrective Remove action', async () => {
      const { releaseLocation, projectId } = await setupMissingAsset();
      // Restore the asset to present
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      assetRepo.restorePresent(Number(projectId), [assets[0].relative_path]);

      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toContain('Present');
      // The Remove button is rendered as a form with action containing '/remove'
      expect(res.text).not.toContain('/remove');
    });

    it('forged POST cannot remove a present selected asset', async () => {
      const { releaseLocation, assetId, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Add a second present asset with a distinctive role and sort order
      const slug = 'readiness-test-project';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'second-asset.txt'), 'second content');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const secondAsset = allAssets.find((a) => a.id !== Number(assetId));
      // Select both assets with distinctive roles and sort orders
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send(`selectedAssetIds[]=${secondAsset.id}`)
        .send('roles[]=primary')
        .send('roles[]=preview')
        .send('sortOrder[]=0')
        .send('sortOrder[]=10')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Snapshot: complete ordered junction rows
      const beforeJunction = getReleaseAssets(db, releaseId);
      // Snapshot: complete asset rows for both assets
      const beforeAsset1 = db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(assetId));
      const beforeAsset2 = db.prepare('SELECT * FROM assets WHERE id = ?').get(secondAsset.id);
      // Snapshot: filesystem state for both files
      const file1Path = path.join(projectDir, 'asset.png');
      const file2Path = path.join(projectDir, 'second-asset.txt');
      const beforeFile1Exists = fs.existsSync(file1Path);
      const beforeFile2Exists = fs.existsSync(file2Path);
      const beforeFile1Content = beforeFile1Exists ? fs.readFileSync(file1Path, 'utf-8') : null;
      const beforeFile2Content = beforeFile2Exists ? fs.readFileSync(file2Path, 'utf-8') : null;
      const beforeFile1Size = beforeFile1Exists ? fs.statSync(file1Path).size : null;
      const beforeFile2Size = beforeFile2Exists ? fs.statSync(file2Path).size : null;

      // Attempt to remove the first (present) asset
      await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);

      // Assert: junction rows are unchanged
      expect(getReleaseAssets(db, releaseId)).toEqual(beforeJunction);
      // Assert: both asset rows are unchanged
      expect(db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(assetId))).toEqual(beforeAsset1);
      expect(db.prepare('SELECT * FROM assets WHERE id = ?').get(secondAsset.id)).toEqual(beforeAsset2);
      // Assert: both files still exist
      expect(fs.existsSync(file1Path)).toBe(true);
      expect(fs.existsSync(file2Path)).toBe(true);
      // Assert: file contents are unchanged
      expect(fs.readFileSync(file1Path, 'utf-8')).toBe(beforeFile1Content);
      expect(fs.readFileSync(file2Path, 'utf-8')).toBe(beforeFile2Content);
      // Assert: file sizes are unchanged
      expect(fs.statSync(file1Path).size).toBe(beforeFile1Size);
      expect(fs.statSync(file2Path).size).toBe(beforeFile2Size);
      // Assert: no other selection was removed or altered (junction length unchanged)
      expect(getReleaseAssets(db, releaseId)).toHaveLength(2);
    });

    it('POST removes exactly one junction-table row', async () => {
      const { releaseLocation, assetId, projectId } = await setupMissingAsset();

      // Add a second present asset to verify only the missing one is removed
      const slug = 'missing-remove-test';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'second.png'), 'png');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const secondAsset = allAssets.find((a) => a.id !== assetId);
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send(`selectedAssetIds[]=${secondAsset.id}`)
        .send('roles[]=primary')
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .send('sortOrder[]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Mark the first asset as missing again
      assetRepo.markMissingByProjectIdAndPathNotIn(Number(projectId), ['second.png']);

      const beforeRows = getReleaseAssets(db, Number(releaseLocation.replace('/releases/', '')));
      expect(beforeRows).toHaveLength(2);

      await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const afterRows = getReleaseAssets(db, Number(releaseLocation.replace('/releases/', '')));
      expect(afterRows).toHaveLength(1);
      expect(afterRows[0]).toMatchObject({ asset_id: secondAsset.id, role: 'attachment', sort_order: 1 });
    });

    it('archived scope hides Remove controls and rejects direct POST', async () => {
      const { releaseLocation, assetId } = await setupMissingAsset();

      // Archive the release
      await agent
        .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Detail page must not show Remove form (check for the form action URL)
      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).not.toContain('/remove');

      // Direct POST must be rejected
      await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
    });

    it('malformed IDs return 404', async () => {
      await agent
        .post('/releases/abc/assets/1/remove')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(404);

      await agent
        .post('/releases/1/assets/abc/remove')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(404);
    });

    it('no GET mutation route exists', async () => {
      await agent
        .get('/releases/1/assets/1/remove')
        .expect(404);
    });
  });

  // ─── Phase 7D-1: Release URLs built from normalized allow-listed filters ──
  //
  // Generated release URLs must not retain unknown parameters, invalid values,
  // or malformed inputs from req.query. Only normalized, allow-listed filter
  // values may appear in pagination, view-switching, and page-size links.

  describe('release calendar URL construction', () => {
    /**
     * Parse query parameters from a URL string (handles HTML-escaped &amp;).
     */
    function parseQuery(url) {
      const qIdx = url.indexOf('?');
      if (qIdx === -1) return {};
      // Unescape HTML entities before parsing
      const search = url.slice(qIdx + 1).replace(/&amp;/g, '&');
      const params = new URLSearchParams(search);
      const obj = {};
      for (const [k, v] of params) {
        obj[k] = v;
      }
      return obj;
    }

    it('calendar navigation does not inherit unsupported release state', async () => {
      const res = await agent
        .get('/calendar?unsupported=publishable')
        .expect(200);

      // Calendar nav links must not contain unsupported release state
      const prevMatch = res.text.match(/<a\s[^>]*href="(\/calendar\?[^"]*)"[^>]*>← Previous<\/a>/);
      expect(prevMatch).not.toBeNull();
      const prevQuery = parseQuery(prevMatch[1]);
      expect(prevQuery.unsupported).toBeUndefined();
      // Calendar nav must not contain list/board filters
      expect(prevQuery.view).toBeUndefined();
      expect(prevQuery.status).toBeUndefined();
      expect(prevQuery.project).toBeUndefined();
      expect(prevQuery.schedule).toBeUndefined();
      expect(prevQuery.includeArchived).toBeUndefined();
      expect(prevQuery.sort).toBeUndefined();
      expect(prevQuery.order).toBeUndefined();
      expect(prevQuery.pageSize).toBeUndefined();
      expect(prevQuery.unsupported).toBeUndefined();
      // Calendar nav must not contain page state
      expect(prevQuery.page).toBeUndefined();
      // Only month should be present
      expect(prevQuery.month).toBeDefined();
      expect(Object.keys(prevQuery).length).toBe(1);

      // Next link must have the same properties
      const nextMatch = res.text.match(/<a\s[^>]*href="(\/calendar\?[^"]*)"[^>]*>Next →<\/a>/);
      expect(nextMatch).not.toBeNull();
      const nextQuery = parseQuery(nextMatch[1]);
      expect(nextQuery.unsupported).toBeUndefined();
      expect(nextQuery.view).toBeUndefined();
      expect(nextQuery.status).toBeUndefined();
      expect(nextQuery.project).toBeUndefined();
      expect(nextQuery.schedule).toBeUndefined();
      expect(nextQuery.includeArchived).toBeUndefined();
      expect(nextQuery.sort).toBeUndefined();
      expect(nextQuery.order).toBeUndefined();
      expect(nextQuery.pageSize).toBeUndefined();
      expect(nextQuery.page).toBeUndefined();
      expect(nextQuery.month).toBeDefined();
      expect(Object.keys(nextQuery).length).toBe(1);
    });
  });

  // ─── Phase 8-1: Published release asset-selection lock (HTTP) ──────
  //
  // Forged direct POSTs to the asset-selection and removal routes must
  // return controlled 422 and leave the junction rows unchanged.

  describe('published release HTTP asset-selection lock', () => {
    async function setupPublishedRelease(app, db, projectsRoot) {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      // Publish the release
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      return { projectId, releaseLocation, assetId };
    }

    it('rejects bulk asset POST with controlled 422 for a published release', async () => {
      const { releaseLocation, assetId } = await setupPublishedRelease(app, db, projectsRoot);
      const before = getReleaseAssets(db, Number(releaseLocation.replace('/releases/', '')));

      const res = await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/locked/i);
      const after = getReleaseAssets(db, Number(releaseLocation.replace('/releases/', '')));
      expect(after).toEqual(before);
    });

    it('rejects single removal POST with controlled 422 for a published release', async () => {
      const { releaseLocation, assetId } = await setupPublishedRelease(app, db, projectsRoot);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const before = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/locked/i);
      const after = getReleaseAssets(db, releaseId);
      expect(after).toEqual(before);
    });

    it('rejects missing-asset corrective removal with 422 for a published release', async () => {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish the release
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Delete the asset file from disk
      const slug = 'readiness-test-project';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.unlinkSync(path.join(projectDir, 'asset.png'));

      // Run the real project scan so the asset becomes is_present = 0
      await agent
        .post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Snapshot the complete ordered release_assets rows
      const beforeJunction = getReleaseAssets(db, releaseId);
      // Snapshot the asset record
      const assetRepo = createAssetRepository(db);
      const beforeAsset = assetRepo.findById(Number(assetId));

      // POST the corrective removal route
      const res = await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      // Assert: ReleasePublishedError or its controlled message renders
      expect(res.text).toMatch(/locked/i);

      // Assert: the selected missing asset remains selected
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterJunction).toEqual(beforeJunction);

      // Assert: asset presence remains missing
      const afterAsset = assetRepo.findById(Number(assetId));
      expect(afterAsset.is_present).toBe(0);

      // Assert: no asset record is deleted
      expect(afterAsset).toEqual(beforeAsset);
    });
  });

  // ─── Phase 8-1: Scan regression — published release asset metadata ──
  //
  // A later scan may update assets.is_present or other live asset metadata
  // without changing release_id, asset_id, role, or sort_order in the
  // release_assets junction table.

  describe('published release scan regression', () => {
    it('scan updates asset presence without changing junction rows for a published release', async () => {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish the release
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Snapshot junction rows before scan
      const beforeJunction = getReleaseAssets(db, releaseId);

      // Remove the asset file from disk to trigger a scan change
      const slug = 'readiness-test-project';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.unlinkSync(path.join(projectDir, 'asset.png'));

      // Scan — should succeed and detect the removal
      await agent
        .post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      // Junction rows must be exactly unchanged
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterJunction).toEqual(beforeJunction);

      // Asset presence must have been updated by the scan
      const assetRepo = createAssetRepository(db);
      const asset = assetRepo.findById(Number(assetId));
      expect(asset.is_present).toBe(0);
    });
  });

  // ─── Phase 8-2: Published and Archived Release Lifecycle Presentation ──
  //
  // Published releases show a publication summary, locked-selection wording,
  // and no asset mutation controls. Archived releases (or releases in archived
  // projects) are read-only: edit redirects, POST returns 422, and mutation
  // controls are hidden.

  describe('published release detail presentation', () => {
    async function setupPublishedRelease() {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      return { projectId, releaseLocation, assetId };
    }

    it('shows publication summary instead of Needs attention', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toMatch(/Publication summary/);
      expect(res.text).not.toMatch(/Needs attention/);
      expect(res.text).toMatch(/<div class="project-detail-summary">[\s\S]*?<div class="project-detail-meta">[\s\S]*?<nav class="project-detail-action-toolbar" aria-label="Release actions">/);
      expect(res.text).toMatch(/<section class="project-detail-section release-publication-summary">\s*<h2>Publication summary<\/h2>[\s\S]*?<div class="project-detail-section-body">/);
      expect(res.text).not.toContain('<section class="panel panel--summary project-detail-section">');
      expect(res.text).toMatch(/<div class="project-detail-meta">[\s\S]*?<span class="status-badge status-badge--success">Published<\/span>[\s\S]*?<\/div>[\s\S]*?<dl class="detail-list release-detail-list">/);
      expect(res.text).not.toContain('<dt>Project status</dt>');
    });

    it('shows published date in the publication summary', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toMatch(/Published date/);
      expect(res.text).toMatch(/2025-06-15/);
    });

    it('shows one selected-assets card collection without a redundant heading', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      const section = extractSelectedAssetsSection(res.text);
      expect(section).toContain('<p class="results-meta">1 selected asset</p>');
      expect(section).toContain('<ul class="asset-grid" role="listbox" aria-label="Selected release assets">');
      expect(section).not.toContain('<table class="data-table">');
      expect(res.text).not.toContain('<h2>Selected Assets</h2>');
      expect(res.text).not.toContain('<h2>Release Assets</h2>');
    });

    it('shows selected assets in sort_order ASC, asset_id ASC order', async () => {
      const { releaseLocation, projectId } = await setupPublishedRelease();
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const rows = getReleaseAssets(db, releaseId);
      // Verify the database order
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].sort_order === rows[i - 1].sort_order) {
          expect(rows[i].asset_id).toBeGreaterThan(rows[i - 1].asset_id);
        } else {
          expect(rows[i].sort_order).toBeGreaterThanOrEqual(rows[i - 1].sort_order);
        }
      }

      const res = await agent.get(releaseLocation).expect(200);
      const section = extractSelectedAssetsSection(res.text);
      const renderedIds = [...section.matchAll(/<article[^>]*data-asset-id="(\d+)"/g)]
        .map((match) => Number(match[1]));
      expect(renderedIds).toEqual(rows.map((row) => row.asset_id));
    });

    it('shows locked-selection wording', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toMatch(/asset selection is locked/i);
    });

    it('shows present/missing state and scan caveat', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toMatch(/Present/);
      expect(res.text).toMatch(/not performing a live filesystem check/);
    });

    it('published metadata edit succeeds (title, description, notes, dates, patreon)', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent
        .post(releaseLocation)
        .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseLocation))
        .send('title=Updated+Published+Title')
        .send('description=Updated+description')
        .send('notes=Updated+notes')
        .send('status=published')
        .send('plannedDate=2025-07-01')
        .send('publishedDate=2025-06-20')
        .send('patreonUrl=https://patreon.com/updated')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(200);
      expect(res.headers.location).toBeUndefined();

      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain('Updated Published Title');
      expect(detail.text).toContain('Updated description');
      expect(detail.text).toContain('Updated notes');
      expect(detail.text).toContain('2025-07-01');
      expect(detail.text).toContain('2025-06-20');
      expect(detail.text).toContain('patreon.com/updated');
    });

    it('published status remains unchanged after metadata edit', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      await agent
        .post(releaseLocation)
        .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseLocation))
        .send('title=Status+Check')
        .send('status=published')
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(200);

      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toMatch(/Published/);
    });

    it('submitted status is ignored during published metadata edit', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent
        .post(releaseLocation)
        .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseLocation))
      .send('title=Status+Change+Attempt')
      .send('status=ready')
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(200);
      expect(res.headers.location).toBeUndefined();
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      expect(db.prepare('SELECT published_date, title FROM releases WHERE id = ?').get(releaseId)).toEqual({
        published_date: '2025-06-15',
        title: 'Status Change Attempt',
      });
    });

    it('published asset page is read-only (no Save asset selection button)', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation + '/assets').expect(200);
      expect(res.text).not.toMatch(/Save asset selection/);
      expect(res.text).toMatch(/locked and read-only/);
    });

    it('published detail hides Review & Publish action', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).not.toMatch(/\/publish/);
    });

    it('published detail keeps Edit while its dialog retains Delete but not Archive', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(`${releaseLocation}?edit=1`).expect(200);
      const editDialog = res.text.match(/<dialog id="release-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(res.text).toMatch(/\/releases\/\d+\?edit=1/);
      expect(editDialog).toContain('data-release-edit-deep-link=');
      expect(editDialog).not.toMatch(/action="\/releases\/\d+\/archive"/);
      expect(editDialog).toMatch(new RegExp(`action="${releaseLocation}/delete"`));
    });

    it('published detail hides Manage Assets link', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).not.toMatch(/Manage Assets/);
    });
  });

  // ─── Phase 8 archived published detail hides published-only notices ──
  //
  // When a published release is archived (or its parent is archived), the
  // archived scope takes precedence. Published-only notices, Publication
  // Summary, and "asset selection locked" wording must not appear.

  describe('archived published release detail hides published-only notices', () => {
    async function setupArchivedPublishedRelease() {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      // Publish
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      // Archive the release
      await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      return { projectId, releaseLocation, releaseId, assetId };
    }

    async function setupArchivedParentPublishedRelease() {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      // Publish
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      // Archive the parent project
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      return { projectId, releaseLocation, releaseId, assetId };
    }

    it('archived published detail hides Publication summary', async () => {
      const { releaseLocation } = await setupArchivedPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      // Archived notice appears
      expect(res.text).toMatch(/archived and read-only/);
      // Published-only notices must NOT appear
      expect(res.text).not.toMatch(/Publication summary/);
      expect(res.text).not.toMatch(/asset selection is locked/);
      expect(res.text).not.toMatch(/Needs attention/);
      // Historical status/date preserved
      expect(res.text).toMatch(/published/);
      expect(res.text).toMatch(/2025-06-15/);
    });

    it('archived-parent published detail hides Publication summary', async () => {
      const { releaseLocation } = await setupArchivedParentPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      // Archived notice appears
      expect(res.text).toMatch(/parent project is archived/);
      // Published-only notices must NOT appear
      expect(res.text).not.toMatch(/Publication summary/);
      expect(res.text).not.toMatch(/asset selection is locked/);
      expect(res.text).not.toMatch(/Needs attention/);
      // Historical status/date preserved
      expect(res.text).toMatch(/published/);
      expect(res.text).toMatch(/2025-06-15/);
    });

    it('archived published asset page hides published-only notice', async () => {
      const { releaseLocation } = await setupArchivedPublishedRelease();
      const res = await agent.get(releaseLocation + '/assets').expect(200);
      // Archived notice appears
      expect(res.text).toMatch(/archived/);
      // Published-only notice must NOT appear
      expect(res.text).not.toMatch(/locked and read-only/);
    });

    it('archived-parent published asset page hides published-only notice', async () => {
      const { releaseLocation } = await setupArchivedParentPublishedRelease();
      const res = await agent.get(releaseLocation + '/assets').expect(200);
      // Archived notice appears
      expect(res.text).toMatch(/archived/);
      // Published-only notice must NOT appear
      expect(res.text).not.toMatch(/locked and read-only/);
    });
  });

  describe('archived release lifecycle', () => {
    async function setupArchivedRelease() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Archived+Lifecycle+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Archived+Lifecycle+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      return { projectId, releaseLocation, releaseId };
    }

    it('archived detail exposes no mutation controls', async () => {
      const { releaseLocation } = await setupArchivedRelease();
      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).not.toMatch(/\/releases\/\d+\/edit/);
      expect(res.text).not.toMatch(/\/archive/);
      expect(res.text).not.toMatch(/Manage Assets/);
      expect(res.text).not.toMatch(/\/publish/);
      expect(res.text).not.toMatch(/Remove/);
    });

    it('archived GET edit redirects to detail', async () => {
      const { releaseLocation } = await setupArchivedRelease();
      const res = await agent.get(releaseLocation + '/edit').expect(302);
      expect(res.headers.location).toBe(releaseLocation);
    });

    it('archived release metadata POST returns 422 and preserves row', async () => {
      const { releaseLocation, releaseId } = await setupArchivedRelease();
      const before = releaseRepository.findById(releaseId);

      const res = await agent
        .post(releaseLocation)
        .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseLocation))
        .send('title=Should+Not+Change')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.body).toMatchObject({ status: 'error', code: expect.stringMatching(/^(?:RELEASE|PROJECT)_ARCHIVED$/) });
      expect(res.body.message).toMatch(/archived/i);
      const after = releaseRepository.findById(releaseId);
      expect(after.title).toBe(before.title);
    });

    it('archived asset POST preserves junction rows', async () => {
      const { releaseLocation, releaseId } = await setupArchivedRelease();
      const before = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('selectedAssetIds[]=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      const after = getReleaseAssets(db, releaseId);
      expect(after).toEqual(before);
    });

    it('archive POST on archived release returns 422 with the detail view', async () => {
      const { releaseLocation } = await setupArchivedRelease();
      const res = await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      expect(res.text).toMatch(/archived and cannot be modified/);
      // Must render detail.njk, not publish.njk
      expect(res.text).not.toMatch(/Review &amp; Publish/);
      expect(res.text).not.toMatch(/Publishable/);
      // No readiness panel
      expect(res.text).not.toMatch(/Needs attention/);
      expect(res.text).not.toMatch(/Publication summary/);
      // No Publish form
      expect(res.text).not.toMatch(/\/publish/);
    });

    it('publish POST on archived release returns 422 with the detail view', async () => {
      const { releaseLocation } = await setupArchivedRelease();
      const res = await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      expect(res.text).toMatch(/archived/);
      // Must render detail.njk, not publish.njk
      expect(res.text).not.toMatch(/Review &amp; Publish/);
      expect(res.text).not.toMatch(/Publishable/);
      // No readiness panel
      expect(res.text).not.toMatch(/Needs attention/);
      expect(res.text).not.toMatch(/Publication summary/);
      // No Publish form
      expect(res.text).not.toMatch(/\/publish/);
    });
  });

  describe('archived-parent release lifecycle', () => {
    async function setupArchivedParentRelease() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Archived+Parent+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Archived+Parent+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Archive the parent project using the dedicated archive route
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      return { projectId, releaseLocation, releaseId };
    }

    it('archived-parent GET edit redirects to detail', async () => {
      const { releaseLocation } = await setupArchivedParentRelease();
      const res = await agent.get(releaseLocation + '/edit').expect(302);
      expect(res.headers.location).toBe(releaseLocation);
    });

    it('archived-parent metadata POST returns 422 and preserves row', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentRelease();
      const before = releaseRepository.findById(releaseId);

      const res = await agent
        .post(releaseLocation)
        .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseLocation))
        .send('title=Should+Not+Change')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.body).toMatchObject({ status: 'error', code: expect.stringMatching(/^(?:RELEASE|PROJECT)_ARCHIVED$/) });
      expect(res.body.message).toMatch(/archived/i);
      const after = releaseRepository.findById(releaseId);
      expect(after.title).toBe(before.title);
    });

    it('archived-parent asset POST preserves junction rows', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentRelease();
      const before = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('selectedAssetIds[]=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      const after = getReleaseAssets(db, releaseId);
      expect(after).toEqual(before);
    });

    it('archived-parent archive POST returns 422 with the detail view', async () => {
      const { releaseLocation } = await setupArchivedParentRelease();
      const res = await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      expect(res.text).toMatch(/archived/);
      // Must render detail.njk, not publish.njk
      expect(res.text).not.toMatch(/Review &amp; Publish/);
      expect(res.text).not.toMatch(/Publishable/);
      // No readiness panel
      expect(res.text).not.toMatch(/Needs attention/);
      expect(res.text).not.toMatch(/Publication summary/);
      // No Publish form
      expect(res.text).not.toMatch(/\/publish/);
    });

    it('archived-parent publish POST returns 422 with the detail view', async () => {
      const { releaseLocation } = await setupArchivedParentRelease();
      const res = await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(422);
      expect(res.text).toMatch(/archived/);
      // Must render detail.njk, not publish.njk
      expect(res.text).not.toMatch(/Review &amp; Publish/);
      expect(res.text).not.toMatch(/Publishable/);
      // No readiness panel
      expect(res.text).not.toMatch(/Needs attention/);
      expect(res.text).not.toMatch(/Publication summary/);
      // No Publish form
      expect(res.text).not.toMatch(/\/publish/);
    });
  });

  describe('archived release behavior remains intact', () => {
    it('archived release detail is read-only and has no publication summary', async () => {
      const projectId = await createTestProject('Archived Readiness Project');
      const createRes = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Archived Readiness Release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      await agent
        .post(`${releaseLocation}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(releaseLocation).expect(200);
      expect(res.text).toMatch(/archived and read-only/i);
      expect(res.text).not.toMatch(/Publication summary/);
      expect(res.text).toMatch(/<div class="project-detail-summary">[\s\S]*?<section class="project-detail-info project-detail-section">[\s\S]*?<h2>Release details<\/h2>[\s\S]*?<div class="project-detail-section-body">/);
      expect(res.text).not.toContain('<nav class="project-detail-action-toolbar" aria-label="Release actions">');
    });
  });

  // ─── Phase 8-3: Publication Review and Finalization Submission ──────────
  //
  // The direct Publish action is replaced with a server-rendered review flow.
  // GET /releases/:id/publish renders the review page; POST performs the
  // authoritative publish. The service remains the single source of truth.

  describe('publication review page (Phase 8-3)', () => {
    it('publishable ready GET returns 200', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const res = await agent
        .get(`${releaseLocation}?publish=1`)
        .expect(200);
      expect(res.text).toContain('Review &amp; Publish');
    });

    it('blocked-ready GET returns 200', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Blocked+Ready+Review+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Blocked+Ready+Review')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      setProjectStatusForReleaseTest(db, createRes.headers.location, 'ready');

      const res = await agent
        .get(`${createRes.headers.location}?publish=1`)
        .expect(200);
      expect(res.text).toContain('Review &amp; Publish');
      expect(res.text).toContain('No assets selected');
    });

    it('GET performs no database or junction mutation', async () => {
      const { releaseLocation, projectId, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      await agent
        .get(`${releaseLocation}?publish=1`)
        .expect(200);

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('ordered assets, roles, and order render', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const res = await agent
        .get(`${releaseLocation}?publish=1`)
        .expect(200);

      // Role renders
      expect(res.text).toContain('Primary');
      // Numeric order renders
      expect(res.text).toContain('0');
    });

    describe('lifecycle eligibility', () => {
      const NON_READY_PROJECT_STATUSES = [
        { projectStatus: 'tbd', label: 'tbd' },
        { projectStatus: 'planned', label: 'planned' },
        { projectStatus: 'in-progress', label: 'in-progress' },
      ];

      for (const { projectStatus, label } of NON_READY_PROJECT_STATUSES) {
        it(`GET review opens when project status is ${label}`, async () => {
          const projRes = await agent
            .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
            .send('title=Lifecycle+Redirect+Test')
            .send('status=tbd')
            .send('priority=normal')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .expect(302);
          const projectId = projRes.headers.location.replace('/projects/', '');

          let releaseLocation;
          let releaseId;

          const createRes = await agent
            .post('/releases')
            .send('_csrf=' + encodeURIComponent(csrfToken))
            .send(`projectId=${projectId}`)
            .send(`title=Lifecycle+Redirect+${label}`)
            .send('status=ready')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .expect(302);
          releaseLocation = createRes.headers.location;
          releaseId = Number(releaseLocation.replace('/releases/', ''));
          setProjectStatusForReleaseTest(db, releaseLocation, projectStatus);

          const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

          const res = await agent
            .get(`${releaseLocation}?publish=1`)
            .expect(200);

          expect(res.text).toContain('Review &amp; Publish');
          // No mutation
          const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
          expect(afterRelease).toEqual(beforeRelease);
        });
      }

      it('GET redirects for archived release', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        await agent
          .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);

        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

        const res = await agent
          .get(`${releaseLocation}/publish`)
          .expect(302);

        expect(res.headers.location).toBe(releaseLocation);
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        expect(afterRelease).toEqual(beforeRelease);
      });

      it('GET redirects for archived parent project', async () => {
        const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        await agent
          .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);

        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);

        const res = await agent
          .get(`${releaseLocation}/publish`)
          .expect(302);

        expect(res.headers.location).toBe(releaseLocation);
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        expect(afterRelease).toEqual(beforeRelease);
      });
    });

    it('malformed/unknown IDs return 404', async () => {
      await agent
        .get('/releases/abc/publish')
        .expect(404);

      await agent
        .get('/releases/99999/publish')
        .expect(404);
    });

    describe('route-neighbor coverage', () => {
      it('GET /releases/:id still renders detail', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const res = await agent
          .get(releaseLocation)
          .expect(200);
        expect(res.text).toContain('Readiness Test Release');
      });

      it('GET /releases/:id/edit redirects to the detail-hosted edit dialog', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const res = await agent
          .get(`${releaseLocation}/edit`)
          .expect(302);
        expect(res.headers.location).toBe(`${releaseLocation}?edit=1`);
      });

      it('GET /releases/:id/assets uses the project lead and compact asset sections', async () => {
        const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        recordLookupCounter.reset();
        const res = await agent
          .get(releaseLocation + '/assets')
        .expect(200);

        expect(recordLookupCounter.counts).toEqual({ release: 1, project: 1 });
        expect(res.text).toContain('— Assets');
        expect(res.text).not.toContain('Back to Project');
        const heading = res.text.match(/<header class="page-heading">[\s\S]*?<\/header>/)?.[0] || '';
        const releaseAssetsContent = res.text.slice(res.text.indexOf('<section data-release-assets-live-region>'));
        const headingActions = heading.match(/<div class="page-heading-actions">[\s\S]*?<\/div>/)?.[0] || '';
        expectProjectReturnLead(res.text, { href: `/projects/${projectId}`, title: 'Readiness Test Project' });
        const releaseNav = expectHeadingNavLink(res.text, { key: 'release', href: releaseLocation, label: 'Release', tooltip: 'Go to release details' });
        expect((releaseNav.match(/<a\b/g) || [])).toHaveLength(2);
        expect(heading).toMatch(new RegExp(
          '<nav class="page-heading-navigation page-heading-navigation--text" aria-label="Page navigation">[\\s\\S]*?<\\/nav>[\\s\\S]*?<div class="page-heading-actions">\\s*<form id="release-assets-form" method="post" action="' + releaseLocation + '/assets" class="inline-form" data-asset-selection-form>',
        ));
        expect(releaseNav.indexOf(`href="/projects/${projectId}"`)).toBeLessThan(releaseNav.indexOf(`href="${releaseLocation}"`));
        expect(headingActions).not.toContain('class="inline-form release-assets-form"');
        expect(headingActions).toContain('name="_csrf"');
        expect(headingActions).toContain('<button class="button button-small button-primary project-assets-heading-action" type="submit">Save asset selection</button>');
        expect(headingActions).not.toContain('<svg');
        expect(res.text).toMatch(/<input type="checkbox" form="release-assets-form"[^>]*name="selectedAssetIds"[^>]*value="\d+"/);
        expect((res.text.match(/>Save asset selection</g) || [])).toHaveLength(1);
        expect(res.text).not.toContain('Back to Release');
        expect(releaseAssetsContent).not.toContain('id="release-assets-form"');
        expect(releaseAssetsContent).not.toContain('Save asset selection');
        expect(releaseAssetsContent).not.toContain('href="' + releaseLocation + '">Back</a>');
        expect(res.text).not.toContain('role-guidance');
        expect(res.text).not.toContain('asset-roles-heading');
        expect(res.text).not.toContain('panel panel--info');
        expect(res.text).not.toContain('<h2>Selected Assets</h2>');
        expect(res.text).not.toContain('<h2>Release Assets</h2>');
        expect(res.text).toMatch(new RegExp(
          '<form method="post" action="' + releaseLocation + '/assets/' + assetId + '/role" class="inline-form release-asset-role-form">[\\s\\S]*?name="role"',
        ));
        expect(res.text).toContain('id="release-assets-form"');
      });

      it('GET /releases/:id/assets preserves View All and selected membership with one record lookup each', async () => {
        const { releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

        recordLookupCounter.reset();
        const res = await agent.get(`${releaseLocation}/assets?page=99&pageSize=all`).expect(200);

        expect(recordLookupCounter.counts).toEqual({ release: 1, project: 1 });
        expect(res.text).toContain('pageSize=all');
        expect(res.text).toMatch(new RegExp(`<input type="checkbox" form="release-assets-form"[^>]*value="${assetId}"[^>]*checked`));
      });

      it.each(['published', 'archived release', 'archived parent'])(
        'GET /releases/:id/assets loads release and project once for a %s page',
        async (state) => {
          const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

          if (state === 'published') {
            setProjectStatusForReleaseTest(db, releaseLocation, 'ready');
            await agent
              .post(`${releaseLocation}/publish`)
              .send('_csrf=' + encodeURIComponent(csrfToken))
              .send('publishedDate=2025-06-15')
              .set('Content-Type', 'application/x-www-form-urlencoded')
              .expect(302);
          } else if (state === 'archived release') {
            await agent
              .post(`${releaseLocation}/archive`)
              .send('_csrf=' + encodeURIComponent(csrfToken))
              .expect(302);
          } else {
            await agent
              .post(`/projects/${projectId}/archive`)
              .send('_csrf=' + encodeURIComponent(csrfToken))
              .expect(302);
          }

          recordLookupCounter.reset();
          const res = await agent.get(`${releaseLocation}/assets`).expect(200);

          expect(recordLookupCounter.counts).toEqual({ release: 1, project: 1 });
          expect(res.text).toContain('read-only');
          expect(res.text).not.toContain('Save asset selection');
        },
      );

      it('GET /releases/:id/assets keeps missing-release handling at one lookup', async () => {
        recordLookupCounter.reset();
        const res = await agent.get('/releases/99999/assets').expect(404);

        expect(recordLookupCounter.counts).toEqual({ release: 1, project: 0 });
        expect(res.text).toContain('Not found');
        expect(res.text).not.toContain('Release 99999 not found');
      });

      it('GET /releases/:id/assets rejects a broken project association in the authoritative release lookup', async () => {
        const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));
        db.pragma('foreign_keys = OFF');
        db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
        db.pragma('foreign_keys = ON');
        expect(db.prepare('SELECT id FROM releases WHERE id = ?').get(releaseId)).toBeDefined();

        recordLookupCounter.reset();
        const res = await agent.get(`${releaseLocation}/assets`).expect(404);

        expect(recordLookupCounter.counts).toEqual({ release: 1, project: 0 });
        expect(res.text).toContain('Not found');
        expect(res.text).not.toContain(`Release ${releaseId} not found`);
      });

      it('POST /releases/:id/publish still publishes', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const res = await agent
          .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        expect(res.headers.location).toBe(releaseLocation);
      });

      it('GET and POST /releases/:id/publish coexist correctly', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

        // GET redirects to the detail-hosted dialog.
        const getRes = await agent
          .get(`${releaseLocation}/publish`)
          .expect(302);
        expect(getRes.headers.location).toBe(`${releaseLocation}?publish=1`);

        // POST returns 302
        const postRes = await agent
          .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        expect(postRes.headers.location).toBe(releaseLocation);
      });
    });

    it('persisted published date marks the release as already published', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      db.prepare("UPDATE releases SET published_date = '2025-12-01' WHERE id = ?").run(releaseId);

      const res = await agent
        .get(`${releaseLocation}/publish`)
        .expect(302);
      expect(res.headers.location).toBe(releaseLocation);
    });

    it('local-today fallback prefills', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const res = await agent
        .get(`${releaseLocation}?publish=1`)
        .expect(200);

      const today = getLocalTodayIso();
      expect(res.text).toContain(`value="${today}"`);
    });

    it('valid submitted date persists exactly', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-11-01')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      expect(release.published_date).toBe('2025-11-01');
      expect(release).not.toHaveProperty('status');
    });

    it('missing direct-POST date preserves fallback behavior', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      expect(release).not.toHaveProperty('status');
      const today = getLocalTodayIso();
      expect(release.published_date).toBe(today);
    });

    describe('invalid published-date input', () => {
      const INVALID_DATES = [
        { label: 'impossible calendar date', value: '2025-02-30' },
        { label: 'non-date string', value: 'not-a-date' },
      ];

      for (const { label, value } of INVALID_DATES) {
        it(`returns 422 for ${label}: "${value}"`, async () => {
          const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
          const releaseId = Number(releaseLocation.replace('/releases/', ''));
          const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
          const beforeJunction = getReleaseAssets(db, releaseId);

          const res = await agent
            .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
            .send(`publishedDate=${value}`)
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .expect(422);

          // Exact submitted value preserved in the form
          expect(res.text).toContain(`value="${value}"`);
          // Field-specific error renders
          expect(res.text).toContain('Published date must be a valid date');
          // Complete release row unchanged
          const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
          expect(afterRelease).toEqual(beforeRelease);
          // Complete junction rows unchanged
          const afterJunction = getReleaseAssets(db, releaseId);
          expect(afterJunction).toEqual(beforeJunction);
        });
      }

      it('whitespace-only input is treated as no date (falls through to today)', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        await agent
          .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('publishedDate=   ')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);

        const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        expect(release).not.toHaveProperty('status');
        const today = getLocalTodayIso();
        expect(release.published_date).toBe(today);
      });

      it('leading/trailing whitespace on a valid date is trimmed and accepted', async () => {
        const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        await agent
          .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('publishedDate=  2025-06-15  ')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);

        const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        expect(release).not.toHaveProperty('status');
        expect(release.published_date).toBe('2025-06-15');
      });
    });

    it('asset changes after GET do not block POST publication', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      // Load the review page (GET)
      await agent
        .get(`${releaseLocation}?publish=1`)
        .expect(200);

       // Change asset presence: remove the asset file and scan
      const slug = 'readiness-test-project';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.unlinkSync(path.join(projectDir, 'asset.png'));
      await agent
        .post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      expect(res.headers.location).toBe(releaseLocation);
    });

    it('stale POST publishes and leaves junction rows unchanged', async () => {
      const { releaseLocation, projectId, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      // Remove the asset file and scan to make it missing
      const slug = 'readiness-test-project';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.unlinkSync(path.join(projectDir, 'asset.png'));
      await agent
        .post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      expect(res.headers.location).toBe(releaseLocation);

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease.published_date).toBeTruthy();
      expect(afterRelease).not.toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('direct forged POST does not require page state', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Forged+Review+POST+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Forged+Review+POST')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      setProjectStatusForReleaseTest(db, createRes.headers.location, 'ready');

      const res = await agent
        .post(`${createRes.headers.location}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      expect(res.headers.location).toBe(createRes.headers.location);
    });

    it('successful publication redirects to the release detail', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);

      const res = await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Should redirect to release detail
      expect(res.headers.location).toBe(releaseLocation);

      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const release = db.prepare('SELECT published_date FROM releases WHERE id = ?').get(releaseId);
      expect(release.published_date).toBe(getLocalTodayIso());
    });

    it('newly published selection is already locked', async () => {
      const { releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Attempt to change asset selection — must be rejected
      const res = await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/locked/);
    });

    it('no JavaScript confirmation is required', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const res = await agent
        .get(`${releaseLocation}?publish=1`)
        .expect(200);

      // The publish form must not have an onclick confirm handler
      expect(res.text).not.toMatch(/onclick/);
    });

    it('renders assets in sort_order ASC, asset_id ASC order', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      const assetRepo = createAssetRepository(db);

      // Create additional assets with deliberately unordered insertion
      const slug = 'readiness-test-project';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);

      // Write distinct files
      fs.writeFileSync(path.join(projectDir, 'delta.txt'), 'delta');
      fs.writeFileSync(path.join(projectDir, 'alpha.txt'), 'alpha');
      fs.writeFileSync(path.join(projectDir, 'charlie.txt'), 'charlie');
      fs.writeFileSync(path.join(projectDir, 'bravo.txt'), 'bravo');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const assetMap = {};
      for (const a of allAssets) {
        assetMap[a.filename] = a;
      }

      // Deliberately unordered insertion with distinct sort_order and roles
      // Expected order: sort_order ASC, asset_id ASC
      // sort_order 0: alpha (asset_id lower) then bravo (asset_id higher) — tie
      // sort_order 1: charlie
      // sort_order 5: delta
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetMap['delta.txt'].id}`)
        .send(`selectedAssetIds[]=${assetMap['bravo.txt'].id}`)
        .send(`selectedAssetIds[]=${assetMap['alpha.txt'].id}`)
        .send(`selectedAssetIds[]=${assetMap['charlie.txt'].id}`)
        .send('roles[]=attachment')
        .send('roles[]=preview')
        .send('roles[]=primary')
        .send('roles[]=attachment')
        .send('sortOrder[]=5')
        .send('sortOrder[]=0')
        .send('sortOrder[]=0')
        .send('sortOrder[]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Fetch the review page
      const res = await agent
        .get(`${releaseLocation}?publish=1`)
        .expect(200);

      // Extract the asset table rows from the review page
      // Phase 10.5C: publish page uses shared data-table class
      const tableSection = res.text.match(/<table class="data-table">[\s\S]*?<\/table>/);
      expect(tableSection).not.toBeNull();
      const tableHtml = tableSection[0];

      // Parse rows from tbody
      const tbodyMatch = tableHtml.match(/<tbody>[\s\S]*?<\/tbody>/);
      expect(tbodyMatch).not.toBeNull();
      const rowRegex = /<tr>[\s\S]*?<\/tr>/g;
      const htmlRows = tbodyMatch[0].match(rowRegex);
      expect(htmlRows).not.toBeNull();

      // Expected order from DB: sort_order ASC, asset_id ASC
      const dbRows = db.prepare(
        `SELECT ra.sort_order, ra.asset_id, a.filename, ra.role
         FROM release_assets ra
         JOIN assets a ON a.id = ra.asset_id
         WHERE ra.release_id = ?
         ORDER BY ra.sort_order ASC, ra.asset_id ASC`
      ).all(releaseId);

      expect(htmlRows.length).toBe(dbRows.length);

      for (let i = 0; i < htmlRows.length; i++) {
        const rowHtml = htmlRows[i];
        const dbRow = dbRows[i];

        // Assert filename
        const filenameMatch = rowHtml.match(/<td class="asset-filename">([^<]+)<\/td>/);
        expect(filenameMatch).not.toBeNull();
        expect(filenameMatch[1]).toBe(dbRow.filename);

        // Assert role
        const roleMatch = rowHtml.match(/<td class="asset-filename">[^<]*<\/td>\s*<td>([^<]+)<\/td>/);
        expect(roleMatch).not.toBeNull();
        expect(roleMatch[1].toLowerCase().trim()).toBe(dbRow.role);

        // Assert sort order is visible
        expect(rowHtml).toContain(String(dbRow.sort_order));
      }
    });
  });

  // ─── Phase 8 archived-lifecycle complete state tests ──────────────────────
  //
  // Every rejected POST must leave the complete release row and junction rows
  // unchanged. Release snapshots include all columns; junction snapshots
  // include release_id, asset_id, role, sort_order, created_at.

  describe('archived-lifecycle complete state preservation', () => {
    /**
     * Snapshot the complete release row (all columns).
     */
    function snapshotRelease(releaseId) {
      return db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
    }

    /**
     * Snapshot the complete junction rows (all columns, deterministic order).
     */
    function snapshotJunction(releaseId) {
      return db.prepare(
        'SELECT release_id, asset_id, role, sort_order, created_at FROM release_assets WHERE release_id = ? ORDER BY sort_order ASC, asset_id ASC'
      ).all(releaseId);
    }

    async function setupArchivedReleaseWithAsset() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Complete+State+Archived+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'complete-state-archived-project';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Complete+State+Archived+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select the asset
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Archive the release
      await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetId: Number(assetId) };
    }

    async function setupArchivedParentReleaseWithAsset() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Complete+State+Archived+Parent')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'complete-state-archived-parent';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const assetId = String(assets[0].id);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Complete+State+Archived+Parent+Release')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select the asset
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Archive the parent project
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetId: Number(assetId) };
    }

    // ── Archived release ──────────────────────────────────────────────────

    it('archived metadata POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await agent
        .post(releaseLocation)
        .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseLocation))
        .send('title=Should+Not+Change')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.body).toMatchObject({ status: 'error', code: expect.stringMatching(/^(?:RELEASE|PROJECT)_ARCHIVED$/) });
      expect(res.body.message).toMatch(/archived/i);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived-parent metadata POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await agent
        .post(releaseLocation)
        .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseLocation))
        .send('title=Should+Not+Change')
        .send('status=ready')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.body).toMatchObject({ status: 'error', code: expect.stringMatching(/^(?:RELEASE|PROJECT)_ARCHIVED$/) });
      expect(res.body.message).toMatch(/archived/i);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived asset POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('selectedAssetIds[]=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived-parent asset POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('selectedAssetIds[]=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived archive POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived and cannot be modified/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived-parent archive POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await agent
        .post(releaseLocation + '/archive')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived publish POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived-parent publish POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId } = await setupArchivedParentReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived corrective removal POST preserves complete release and junction state', async () => {
      const { releaseLocation, releaseId, assetId } = await setupArchivedReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      expect(res.text).toMatch(/archived/);
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
    });

    it('archived-parent corrective removal POST preserves complete state and shows archived notice', async () => {
      const { releaseLocation, releaseId, assetId } = await setupArchivedParentReleaseWithAsset();
      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      // Snapshot the complete asset row
      const assetRepo = createAssetRepository(db);
      const beforeAsset = assetRepo.findById(assetId);

      const res = await agent
        .post(`${releaseLocation}/assets/${assetId}/remove`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      // Archived-parent notice appears
      expect(res.text).toMatch(/parent project is archived/);
      // No Remove form
      expect(res.text).not.toMatch(/Remove/);
      // No Publish form
      expect(res.text).not.toMatch(/\/publish/);
      // No readiness panel
      expect(res.text).not.toMatch(/Needs attention/);
      expect(res.text).not.toMatch(/Publication summary/);
      // Complete state unchanged
      expect(snapshotRelease(releaseId)).toEqual(beforeRelease);
      expect(snapshotJunction(releaseId)).toEqual(beforeJunction);
      const afterAsset = assetRepo.findById(assetId);
      expect(afterAsset).toEqual(beforeAsset);
    });

    // ── Successful published metadata edit ───────────────────────────────

    it('published metadata edit changes only intended fields and preserves status and junction rows', async () => {
      const { releaseLocation, projectId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish the release
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeRelease = snapshotRelease(releaseId);
      const beforeJunction = snapshotJunction(releaseId);

      // Edit metadata: title, description, notes, plannedDate, publishedDate, patreonUrl
      await agent
        .post(releaseLocation)
        .set('Accept', 'application/json')
      .send('_csrf=' + encodeURIComponent(csrfToken))
      .send(loadedReleaseLinkField(releaseLocation))
        .send('title=Updated+Published+Title')
        .send('description=Updated+description')
        .send('notes=Updated+notes')
        .send('status=published')
        .send('plannedDate=2025-07-01')
        .send('publishedDate=2025-06-20')
        .send('patreonUrl=https://patreon.com/updated')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(200);

      const afterRelease = snapshotRelease(releaseId);
      const afterJunction = snapshotJunction(releaseId);

      // Publication metadata remains present without a release-owned status field.
      expect(afterRelease).not.toHaveProperty('status');
      expect(afterRelease.published_date).toBe('2025-06-20');

      // Metadata fields changed
      expect(afterRelease.title).toBe('Updated Published Title');
      expect(afterRelease.description).toBe('Updated description');
      expect(afterRelease.notes).toBe('Updated notes');
      expect(afterRelease.planned_date).toBe('2025-07-01');
      expect(afterRelease.published_date).toBe('2025-06-20');
      expect(afterRelease.patreon_url).toBe('https://patreon.com/updated');

      // Junction rows must be exactly unchanged
      expect(afterJunction).toEqual(beforeJunction);

      // Non-mutable fields must be preserved
      expect(afterRelease.id).toBe(beforeRelease.id);
      expect(afterRelease.project_id).toBe(beforeRelease.project_id);
      expect(afterRelease.created_at).toBe(beforeRelease.created_at);
    });
  });

  // ─── Phase 8 structural published selected-assets card assertions ─────────
  //
  // Parse the exact selected-assets section on published detail and assert
  // structural properties: one shared card collection, release order, roles,
  // and presence values.

  describe('published detail structural selected-assets card assertions', () => {
    async function setupPublishedRelease() {
      const { projectId, releaseLocation, assetId } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Add a second asset with a different role and sort order
      const slug = 'readiness-test-project';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'second-asset.txt'), 'second content');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const secondAsset = allAssets.find((a) => a.id !== Number(assetId));

      // Select both assets with distinctive roles and sort orders
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send(`selectedAssetIds[]=${secondAsset.id}`)
        .send('roles[]=primary')
        .send('roles[]=preview')
        .send('sortOrder[]=0')
        .send('sortOrder[]=10')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Publish
      await agent
        .post(releaseLocation + '/publish')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetId: Number(assetId), secondAssetId: secondAsset.id };
    }

    it('uses one shared read-only card collection in the selected-assets section', async () => {
      const { releaseLocation } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);

      const sectionHtml = extractSelectedAssetsSection(res.text);
      expect(sectionHtml).not.toBe('');

      expect(sectionHtml).toContain('<ul class="asset-grid" role="listbox" aria-label="Selected release assets">');
      expect(sectionHtml).not.toContain('<table class="data-table">');
      expect(sectionHtml).not.toContain('<form');
      expect((sectionHtml.match(/<article[^>]*data-asset-id="\d+"/g) || [])).toHaveLength(2);
    });

    it('multiple assets render in sort_order ASC, asset_id ASC order', async () => {
      const { releaseLocation, releaseId } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);

      const sectionHtml = extractSelectedAssetsSection(res.text);
      expect(sectionHtml).not.toBe('');

      // Verify the order matches the database order
      const dbRows = db.prepare(
        'SELECT ra.sort_order, ra.asset_id, a.filename, ra.role FROM release_assets ra JOIN assets a ON a.id = ra.asset_id WHERE ra.release_id = ? ORDER BY ra.sort_order ASC, ra.asset_id ASC'
      ).all(releaseId);

      const renderedIds = [...sectionHtml.matchAll(/<article[^>]*data-asset-id="(\d+)"/g)]
        .map((match) => Number(match[1]));
      expect(renderedIds).toEqual(dbRows.map((row) => row.asset_id));
    });

    it('roles and presence values correspond to the correct rows', async () => {
      const { releaseLocation, releaseId, assetId, secondAssetId } = await setupPublishedRelease();
      const res = await agent.get(releaseLocation).expect(200);

      const sectionHtml = extractSelectedAssetsSection(res.text);
      expect(sectionHtml).not.toBe('');

      // Get the database rows for reference
      const dbRows = db.prepare(
        'SELECT ra.asset_id, a.filename, ra.role, ra.sort_order FROM release_assets ra JOIN assets a ON a.id = ra.asset_id WHERE ra.release_id = ? ORDER BY ra.sort_order ASC, ra.asset_id ASC'
      ).all(releaseId);

      const htmlCards = [...sectionHtml.matchAll(/<article[^>]*data-asset-id="(\d+)"[\s\S]*?<\/article>/g)]
        .map((match) => ({ id: Number(match[1]), html: match[0] }));
      expect(htmlCards).toHaveLength(dbRows.length);

      for (let i = 0; i < htmlCards.length; i++) {
        const rowHtml = htmlCards[i].html;
        const dbRow = dbRows[i];

        expect(htmlCards[i].id).toBe(dbRow.asset_id);
        expect(rowHtml).toContain(`<strong>Role</strong> ${dbRow.role[0].toUpperCase()}${dbRow.role.slice(1)}`);
        expect(rowHtml).toMatch(/aria-label="Present"|aria-label="Missing at last scan"/);
      }
    });
  });

  // ─── Phase 9-1: Release Asset Candidate Discovery (HTTP) ──────────────

  describe('release asset candidate discovery (Phase 9-1)', () => {
    /**
     * Create a project, scan assets, create a release, and select one asset.
     * Returns { projectId, releaseLocation, releaseId, assetRepo, allAssets }.
     */
    async function setupReleaseWithAssets({
      title = 'Candidate Discovery Test',
      slug = 'candidate-discovery-test',
      // P3-C4: opt-in zz-pad-NN.txt fillers (sorted last) so a supported page
      // size such as 10 still paginates.
      fillers = 0,
    } = {}) {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`title=${encodeURIComponent(title)}`)
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const projectDir = getProjectDir(projectsRoot, projectId, slug);

      // Create multiple files
      fs.writeFileSync(path.join(projectDir, 'alpha.txt'), 'alpha content');
      fs.writeFileSync(path.join(projectDir, 'beta.png'), 'beta content');
      fs.writeFileSync(path.join(projectDir, 'gamma.txt'), 'gamma content');
      fs.writeFileSync(path.join(projectDir, 'delta.txt'), 'delta content');
      for (let index = 0; index < fillers; index++) {
        fs.writeFileSync(path.join(projectDir, `zz-pad-${String(index).padStart(2, '0')}.txt`), `pad ${index}`);
      }
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Candidate+Discovery+Release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      setProjectStatusForReleaseTest(db, releaseLocation, 'ready');

      // Select one asset (alpha.txt)
      const alphaAsset = allAssets.find((a) => a.filename === 'alpha.txt');
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${alphaAsset.id}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetRepo, allAssets };
    }

    function selectedSection(html) {
      const liveRegionStart = html.indexOf('<section data-release-assets-live-region>');
      if (liveRegionStart >= 0) {
        const mainEnd = html.indexOf('</main>', liveRegionStart);
        return html.slice(liveRegionStart, mainEnd >= 0 ? mainEnd : undefined);
      }
      const match = html.match(/<section class="asset-browser-layout" aria-label="Selected assets" data-selected-assets>[\s\S]*?<\/section>/);
      if (!match) throw new Error('Release asset collection section was not rendered.');
      return match[0];
    }

    function assetCard(section, assetId) {
      const match = section.match(new RegExp(`<article[^>]*data-asset-id="${assetId}"[\\s\\S]*?<\\/article>`));
      if (!match) throw new Error(`Asset card ${assetId} was not rendered.`);
      return match[0];
    }

    function switcherUrl(sectionHtml, label) {
      const iconMatch = sectionHtml.match(new RegExp(`href="([^"]*)"[^>]*aria-label="${label} view"`));
      const match = iconMatch || sectionHtml.match(new RegExp(`href="([^"]*)"[^>]*>${label}<\/a>`));
      if (!match) throw new Error(`${label} view switcher link was not rendered.`);
      return new URL(match[1].replace(/&amp;/g, '&'), 'http://localhost');
    }

    // The inline Grid style dropdown is a presentation-only control; read-only
    // assertions about edit controls apply to everything else in the section.
    const GRID_STYLE_CONTROL = /<div class="asset-grid-style-control">\s*<fieldset class="field asset-filter-multiselect-field asset-grid-style-field">[\s\S]*?<\/fieldset>\s*<span class="asset-grid-style-caption" aria-hidden="true">Grid style<\/span>\s*<\/div>/g;
    function withoutGridStyleControl(section, screen) {
      const controls = section.match(GRID_STYLE_CONTROL) || [];
      expect(controls).toHaveLength(1);
      expect(controls[0]).toContain(`data-asset-grid-style-control="${screen}"`);
      return section.replace(GRID_STYLE_CONTROL, '');
    }

    function hasNestedForms(html) {
      const tags = html.match(/<\/?form\b[^>]*>/gi) || [];
      let depth = 0;
      for (const tag of tags) {
        if (tag.startsWith('</')) {
          depth -= 1;
        } else {
          if (depth > 0) return true;
          depth += 1;
        }
      }
      return false;
    }

    function readOnlyDetailSection(html) {
      const section = withoutGridStyleControl(selectedSection(html), 'release-detail');
      expect(section).toMatch(/^<section class="asset-browser-layout" aria-label="Selected assets" data-selected-assets>\s*<div class="asset-browser-content">/);
      expect(section).not.toContain('project-detail-section-body');
      expect(section).not.toMatch(/<h[1-6]\b[^>]*>\s*(?:Selected Assets|Release Assets)\s*<\/h[1-6]>/i);
      expect(section).not.toContain('<form');
      expect(section).not.toContain('<input');
      expect(section).not.toContain('<select');
      expect(section).not.toContain('asset-selection-control');
      expect(section).not.toContain('asset-select-checkbox');
      expect(section).not.toContain('release-assets-form');
      expect(section).not.toContain('data-asset-selectable-card');
      expect(section).not.toContain('release-asset-card-controls');
      expect(section).not.toContain('/role');
      expect(section).not.toContain('/move-');
      expect(section).not.toContain('/remove');
      expect(hasNestedForms(section)).toBe(false);
      return section;
    }

    async function addSecondSelected(fixture) {
      const secondAsset = fixture.allAssets.find((asset) => asset.filename === 'beta.png');
      expect(secondAsset).toBeDefined();
      await agent
        .post(`${fixture.releaseLocation}/assets/add`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${secondAsset.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      return secondAsset;
    }

    it('GET /releases/:id renders selected-only shared grid cards without edit controls', async () => {
      const fixture = await setupReleaseWithAssets();
      const res = await agent.get(fixture.releaseLocation).expect(200);
      const section = readOnlyDetailSection(res.text);

      expect(section).toContain('<ul class="asset-grid" role="listbox" aria-label="Selected release assets">');
      expect(section).toContain('alpha.txt');
      expect(section).not.toContain('beta.png');
      expect(section).not.toContain('gamma.txt');
      expect(section).not.toContain('delta.txt');
      expect(section).toContain('<strong>Role</strong> Primary');
      expect(section).toContain('<strong>Order</strong> 0');
      expect(section).toContain('<article class="asset-card"');
      expect(section).not.toContain('asset-card is-selected');
      expect(section).not.toContain('aria-selected="true"');
      expect(section).toContain('asset-card-top');
      expect(section).toContain('asset-card-media');
      expect(section).toContain('asset-card-body');
      expect(section).toContain('asset-card-meta');
      expect(res.text).toContain('Manage Assets');
      expect(res.text).not.toContain('release-asset-filters');
      expect(res.text).not.toMatch(/name="(?:category|extension|tag)"/);

      const manage = await agent.get(`${fixture.releaseLocation}/assets`).expect(200);
      expect(manage.text).toContain('id="release-assets-form"');
      expect(manage.text).toContain('<article class="asset-card asset-card--project asset-card--release is-selected"');
      expect(manage.text).toContain('asset-card-top');
      expect(manage.text).toContain('asset-card-media');
      expect(manage.text).toContain('data-asset-viewer-preview');
      expect(manage.text).toContain('data-asset-info-card');
      expect(manage.text).not.toContain('asset-card-body');
    });

    it('renders an inline presentation-only Grid style dropdown on Release Detail and Manage Assets', async () => {
      const fixture = await setupReleaseWithAssets();
      const pages = [
        { path: fixture.releaseLocation, screen: 'release-detail' },
        { path: `${fixture.releaseLocation}?view=list`, screen: 'release-detail' },
        { path: `${fixture.releaseLocation}/assets`, screen: 'release-assets' },
        { path: `${fixture.releaseLocation}/assets?view=list`, screen: 'release-assets' },
      ];
      for (const { path: pagePath, screen } of pages) {
        const section = selectedSection((await agent.get(pagePath).expect(200)).text);
        const controls = section.match(/<div class="asset-viewer-display-controls">[\s\S]*?<fieldset class="field asset-filter-multiselect-field asset-grid-style-field">[\s\S]*?<\/fieldset>/);
        expect(controls).not.toBeNull();
        const field = controls[0].slice(controls[0].indexOf('<fieldset'));
        expect(controls[0].indexOf('<nav class="view-switcher"')).toBeGreaterThan(-1);
        // The legend names the control for assistive technology; the visible
        // caption follows the dropdown and is hidden from it.
        expect(field).toContain('<legend class="sr-only">Grid style</legend>');
        expect(controls[0]).toContain('<div class="asset-grid-style-control">');
        expect(section).toMatch(/<\/fieldset>\s*<span class="asset-grid-style-caption" aria-hidden="true">Grid style<\/span>\s*<\/div>/);
        expect(field).toMatch(new RegExp(`<select id="asset-grid-style" class="cc-dropdown-native-select" data-cc-dropdown-native-select aria-label="Grid style" data-asset-grid-style-control="${screen}">`));
        expect([...field.matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)].map(([, value, selected, label]) => [value, Boolean(selected), label]))
          .toEqual([['uncropped', true, 'Uncropped'], ['cropped', false, 'Cropped']]);
        // Presentation only: no form submission, autosubmit or live-filter hooks,
        // and the grid is not cropped by the server.
        expect(field).not.toMatch(/\bname="|data-autosubmit|data-release-assets-live/);
        expect(section).not.toContain('data-grid-style="cropped"');
      }
      expect(withoutGridStyleControl(selectedSection((await agent.get(fixture.releaseLocation).expect(200)).text), 'release-detail'))
        .not.toContain('asset-grid-style');
    });

    it('read-only detail supports list view and preserves only its view query context', async () => {
      const fixture = await setupReleaseWithAssets();
      const grid = await agent.get(`${fixture.releaseLocation}?view=grid&ignored=1`).expect(200);
      const gridSection = readOnlyDetailSection(grid.text);
      expect(gridSection).toContain('<ul class="asset-grid" role="listbox" aria-label="Selected release assets">');
      expect(gridSection).toContain('view-switcher-option--icon');
      expect(gridSection).toMatch(/aria-current="page"[\s\S]*aria-label="Grid view"/);
      expect(gridSection).toContain('<p class="results-meta">1 selected asset</p>');
      expect(gridSection.indexOf('class="asset-viewer-display-controls"')).toBeLessThan(gridSection.indexOf('<p class="results-meta">'));
      expect(gridSection.indexOf('<p class="results-meta">')).toBeLessThan(gridSection.indexOf('<ul class="asset-grid"'));
      expect(switcherUrl(gridSection, 'Grid').searchParams.has('view')).toBe(false);
      const listUrl = switcherUrl(gridSection, 'List');
      expect(listUrl.pathname).toBe(fixture.releaseLocation);
      expect(listUrl.searchParams.get('view')).toBe('list');
      expect(listUrl.searchParams.has('ignored')).toBe(false);

      const list = await agent.get(`${fixture.releaseLocation}?view=list`).expect(200);
      const listSection = readOnlyDetailSection(list.text);
      const managedList = await agent.get(`${fixture.releaseLocation}/assets?view=list`).expect(200);
      expect(listSection).toContain('<ul class="asset-list asset-list--release" role="list" aria-label="Selected release assets">');
      expect(listSection).toContain('<article class="asset-list-card asset-list-card--release"');
      expect(listSection).not.toContain('asset-list-card--release is-selected');
      expect(listSection).not.toContain('aria-selected="true"');
      expect(listSection).not.toContain('<ul class="asset-grid"');
      expect(listSection).toContain('data-asset-list-columns="order asset category role type presence size modified"');
      expect(listSection).not.toContain('asset-list-cell--actions');
      expect(listSection).not.toContain('asset-details-link');
      expect(listSection).toMatch(/<a class="button button-small button-secondary" href="\/projects\/\d+\/assets\/\d+">Open asset<\/a>/);
      expect(listSection).not.toContain('asset-list-cell--select');
      expect(listSection).toMatch(/aria-current="page"[\s\S]*aria-label="List view"/);
      expect(listSection.indexOf('<p class="results-meta">')).toBeLessThan(listSection.indexOf('<ul class="asset-list'));
      expect(switcherUrl(listSection, 'Grid').searchParams.has('view')).toBe(false);
      expect(managedList.text).toContain('<article class="asset-list-card asset-list-card--project asset-list-card--release is-selected"');

      // Release titles carry the shared list information card with the
      // release Role and stored Order; Grid does not.
      const alpha = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');
      const info = listSection.match(new RegExp(`<div id="release-asset-list-info-${alpha.id}"[\\s\\S]*?</dl>`))?.[0] || '';
      expect(listSection).toContain('<div class="dashboard-title-info asset-list-card-title-info" data-dashboard-title-info>');
      expect(info).toContain('data-calendar-info-card popover="manual"');
      expect(info).toContain('aria-label="Details for alpha.txt"');
      expect(info).toContain(`<a class="button button-small button-secondary" href="/projects/${fixture.projectId}/assets/${alpha.id}">Open asset</a>`);
      expect(info).toContain('<h3 class="asset-viewer-grid-card-info-heading asset-list-info-filename">alpha.txt</h3>');
      expect(info).toMatch(/<dt>Path<\/dt><dd class="asset-list-info-path">[^<]*alpha\.txt<\/dd>/);
      expect(info).toContain('<dt>Preview</dt><dd>TXT — preview not supported</dd>');
      expect(info).toContain('<dt>Presence</dt><dd>Present</dd>');
      expect(info).toMatch(/<dt>Category<\/dt><dd>\s*\S/);
      expect(info).toContain('<dt>Role</dt><dd>Primary</dd>');
      expect(info).toContain('<dt>Order</dt><dd>0</dd>');
      expect(info).toContain('<dt>Type</dt><dd>TXT (.txt)</dd>');
      expect(info).toMatch(/<dt>Size<\/dt><dd>[^<—]+<\/dd>/);
      expect(info).toMatch(/<dt>Modified<\/dt><dd>\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}/);
      expect(info.indexOf('<dt>Category</dt>')).toBeLessThan(info.indexOf('<dt>Role</dt>'));
      expect(listSection).not.toContain('Associated releases');
      expect(gridSection).not.toContain('data-calendar-info-trigger');
      // Manage Assets uses its own card ids, never the Selected Assets ones.
      expect(managedList.text).not.toContain('release-asset-list-info-');
    });

    it('read-only grid and list cards link filenames and revisioned previews correctly', async () => {
      const fixture = await setupReleaseWithAssets();
      const secondAsset = await addSecondSelected(fixture);
      const viewerUrl = `/projects/${fixture.projectId}/assets/${secondAsset.id}`;

      const grid = await agent.get(fixture.releaseLocation).expect(200);
      const gridSection = readOnlyDetailSection(grid.text);
      expect(gridSection.indexOf('alpha.txt')).toBeLessThan(gridSection.indexOf('beta.png'));
      expect(gridSection).toContain(`class="asset-card-title-text asset-file-link" href="${viewerUrl}">beta</a>`);
      expect(gridSection).toMatch(new RegExp(`src="${viewerUrl}/preview\\?v=[^"]+"`));
      expect(gridSection).toContain(`href="${viewerUrl}"`);

      const css = (await agent.get('/creatorcrate.css').expect(200)).text;
      expect(css).toMatch(/\.asset-card-title-text\.asset-file-link,[\s\S]*?\.asset-card-title-text\.asset-file-link:visited\s*\{[^}]*color:\s*var\(--text\)/);
      expect(css).toMatch(/\.asset-card-title-text\.asset-file-link:hover,[\s\S]*?\.asset-card-title-text\.asset-file-link:focus-visible\s*\{[^}]*color:\s*var\(--accent\)/);
      expect(css).toMatch(/\.asset-file-link:visited\s*\{\s*color:\s*var\(--link\);\s*\}/);
      expect(css).toMatch(/\.asset-list-card \.asset-list-card-title \.asset-file-link,[\s\S]*?\.asset-list-card \.asset-list-card-title \.asset-file-link:visited[\s\S]*?color:\s*var\(--text\)/);

      const list = await agent.get(`${fixture.releaseLocation}?view=list`).expect(200);
      const listSection = readOnlyDetailSection(list.text);
      expect(listSection.indexOf('alpha.txt')).toBeLessThan(listSection.indexOf('beta.png'));
      // List titles open the information card; navigation stays on the
      // thumbnail, the Details action and the card's Open asset action.
      expect(listSection).not.toContain('class="asset-file-link"');
      expect(listSection).toContain(`<button class="dashboard-title-trigger dashboard-truncate" type="button" data-calendar-info-trigger aria-controls="release-asset-list-info-${secondAsset.id}" aria-expanded="false">beta</button>`);
      expect(listSection).toContain(`class="asset-list-card-media-link" href="${viewerUrl}"`);
      expect(listSection).toMatch(new RegExp(`<a class="button button-small button-secondary" href="${viewerUrl}">Open asset</a>`));
      expect(listSection).toMatch(new RegExp(`src="${viewerUrl}/preview\\?v=[^"]+"`));
      expect(listSection).not.toContain('src=""');
      expect(listSection).not.toContain('href=""');
    });

    it('read-only detail renders unsupported and missing selected-asset fallbacks', async () => {
      const fixture = await setupReleaseWithAssets();
      const unsupported = await agent.get(`${fixture.releaseLocation}?view=list`).expect(200);
      expect(readOnlyDetailSection(unsupported.text)).toContain('TXT — preview not supported');

      const alphaAsset = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(alphaAsset.id);
      const missing = await agent.get(`${fixture.releaseLocation}?view=list`).expect(200);
      const missingSection = readOnlyDetailSection(missing.text);
      expect(missingSection).toContain('Missing at last scan');
      expect(missingSection).not.toContain('src=""');
      const missingInfo = missingSection.match(new RegExp(`<div id="release-asset-list-info-${alphaAsset.id}"[\\s\\S]*?</dl>`))?.[0] || '';
      expect(missingInfo).toContain('<dt>Preview</dt><dd>File missing at last scan</dd>');
      expect(missingInfo).toContain('<dt>Presence</dt><dd>Missing at last scan</dd>');
      expect(missingInfo).not.toContain('<img');
    });

    // Cards carry one inert, metadata-only frame for intrinsic geometry: never controls or autoplay.
    const expectInertVideoFrame = (card, src) => {
      const frames = card.match(/<video\b[^>]*>/g) || [];
      expect(frames).toHaveLength(1);
      expect(frames[0]).toContain(`src="${src}"`);
      expect(frames[0]).toContain('preload="metadata"');
      expect(frames[0]).toContain('data-asset-video-frame');
      expect(frames[0]).not.toMatch(/\scontrols|autoplay/);
    };

    it('renders selected supported videos as inert intrinsic-size frames on detail and managed release surfaces', async () => {
      const fixture = await setupReleaseWithAssets();
      const projectDir = getProjectDir(projectsRoot, fixture.projectId, 'candidate-discovery-test');
      fs.writeFileSync(path.join(projectDir, 'clip.webm'), 'webm content');
      await agent.post(`/projects/${fixture.projectId}/scan`)
        .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
      const video = createAssetRepository(db).findByProjectId(Number(fixture.projectId))
        .find((asset) => asset.filename === 'clip.webm');
      expect(video).toMatchObject({ extension: 'webm', mime_type: 'video/webm' });

      const candidates = await agent.get(`${fixture.releaseLocation}/assets?selection=all`).expect(200);
      const candidateCard = assetCard(candidates.text, video.id);
      expect(candidateCard).toContain('data-asset-selectable-card');
      expect(candidateCard).toContain('data-asset-video-placeholder');
      expect(candidateCard).not.toMatch(/<img\b/);
      expectInertVideoFrame(candidateCard, `/projects/${fixture.projectId}/assets/${video.id}/original`);

      await agent.post(`${fixture.releaseLocation}/assets/add`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${video.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      expect(getReleaseAssets(db, fixture.releaseId)
        .map((row) => row.asset_id)).toContain(video.id);

      const viewerUrl = `/projects/${fixture.projectId}/assets/${video.id}`;
      for (const url of [
        fixture.releaseLocation,
        `${fixture.releaseLocation}?view=list`,
        `${fixture.releaseLocation}/assets`,
        `${fixture.releaseLocation}/assets?view=list`,
      ]) {
        const page = await agent.get(url).expect(200);
        const card = assetCard(page.text, video.id);
        expect(card, url).toContain('WEBM video');
        expect(card, url).toMatch(new RegExp(`class="asset-(?:list-)?card-media-link asset-video-link" href="${viewerUrl}"`));
        expect(card, url).not.toMatch(/<img\b/);
        expectInertVideoFrame(card, `${viewerUrl}/original`);
        expect(card, url).toContain(`data-asset-video-preview-trigger data-video-src="${viewerUrl}/original"`);
        expect(page.text.match(/<dialog id="asset-video-preview-dialog"/g), url).toHaveLength(1);
      }
    });

    it('keeps WebM/MP4 release role, order, removal, and grid/list parity with Project Assets', async () => {
      const fixture = await setupReleaseWithAssets({ title: 'Video Release Parity', slug: 'video-release-parity' });
      const projectDir = getProjectDir(projectsRoot, fixture.projectId, 'video-release-parity');
      fs.writeFileSync(path.join(projectDir, 'clip.webm'), 'webm content');
      fs.writeFileSync(path.join(projectDir, 'clip.mp4'), 'mp4 content');
      await agent.post(`/projects/${fixture.projectId}/scan`)
        .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
      const assets = createAssetRepository(db).findByProjectId(Number(fixture.projectId));
      const webm = assets.find((asset) => asset.filename === 'clip.webm');
      const mp4 = assets.find((asset) => asset.filename === 'clip.mp4');
      expect(webm).toMatchObject({ mime_type: 'video/webm' });
      expect(mp4).toMatchObject({ mime_type: 'video/mp4' });
      const post = (url, body = '') => agent.post(url)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(body)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Selection accepts both containers exactly like other present project assets.
      await post(`${fixture.releaseLocation}/assets/add`, `assetId=${webm.id}`);
      await post(`${fixture.releaseLocation}/assets/add`, `assetId=${mp4.id}`);
      expect(getReleaseAssets(db, fixture.releaseId).map((row) => [row.asset_id, row.role]))
        .toEqual([[expect.any(Number), 'primary'], [webm.id, 'attachment'], [mp4.id, 'attachment']]);

      // Role and order are ordinary release metadata for videos.
      await post(`${fixture.releaseLocation}/assets/${mp4.id}/role`, 'role=primary');
      await post(`${fixture.releaseLocation}/assets/${mp4.id}/move-up`);
      const rows = getReleaseAssets(db, fixture.releaseId);
      expect(rows.slice(1).map((row) => [row.asset_id, row.role])).toEqual([[mp4.id, 'primary'], [webm.id, 'attachment']]);
      // The release "primary" role never becomes the project primary image.
      expect(app.locals.projectPrimaryImageService.getPrimaryImage(Number(fixture.projectId))).toBeFalsy();

      const videoMedia = (card) => {
        const link = card.match(/<a class="asset-(?:list-)?card-media-link asset-video-link"[^>]*>[\s\S]*?<\/a>/)?.[0] || '';
        return {
          href: link.match(/href="([^"?]*)/)?.[1] || null,
          placeholder: link.match(/<span class="[^"]*asset-video-placeholder"[\s\S]*<\/span>/)?.[0] || null,
        };
      };
      const mp4Row = rows.find((row) => row.asset_id === mp4.id);
      for (const view of ['grid', 'list']) {
        const releasePage = await agent.get(`${fixture.releaseLocation}?view=${view}`).expect(200);
        const projectPage = await agent.get(`/projects/${fixture.projectId}/assets?view=${view}`).expect(200);
        const releaseCard = assetCard(releasePage.text, mp4.id);
        const projectCard = assetCard(projectPage.text, mp4.id);

        expect(releaseCard, view).toContain('MP4 video');
        expect(releaseCard, view).toContain('clip.mp4');
        if (view === 'grid') {
          expect(releaseCard, view).toContain('<strong>Role</strong> Primary');
          expect(releaseCard, view).toContain(`<strong>Order</strong> ${mp4Row.sort_order}`);
        } else {
          expect(releaseCard, view).toMatch(/<dt>Role<\/dt>\s*<dd>Primary<\/dd>/);
          expect(releaseCard, view).toMatch(new RegExp(`<dt>Order</dt>\\s*<dd>${mp4Row.sort_order}</dd>`));
        }
        expect(releaseCard, view).not.toMatch(/<img\b/);
        expectInertVideoFrame(releaseCard, `/projects/${fixture.projectId}/assets/${mp4.id}/original`);
        // Release and Project Assets cards share the same video preview trigger.
        expect(releaseCard, view).toContain('data-asset-video-preview-trigger');
        expect(projectCard, view).toContain('data-asset-video-preview-trigger');
        expect(videoMedia(releaseCard).placeholder, view).not.toBeNull();
        expect(videoMedia(releaseCard), view).toEqual(videoMedia(projectCard));
        expect(videoMedia(releaseCard).href).toBe(`/projects/${fixture.projectId}/assets/${mp4.id}`);
        expect(assetCard(releasePage.text, webm.id), view).toContain('WEBM video');
      }

      // Removing one video leaves the other selection intact.
      await post(`${fixture.releaseLocation}/assets/${webm.id}/remove-selected`);
      expect(getReleaseAssets(db, fixture.releaseId).map((row) => row.asset_id)).not.toContain(webm.id);
      expect(getReleaseAssets(db, fixture.releaseId).map((row) => row.asset_id)).toContain(mp4.id);

      // A missing selected video keeps its release metadata and uses the shared missing state.
      fs.rmSync(path.join(projectDir, 'clip.mp4'));
      await agent.post(`/projects/${fixture.projectId}/scan`)
        .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
      for (const view of ['grid', 'list']) {
        const card = assetCard((await agent.get(`${fixture.releaseLocation}?view=${view}`).expect(200)).text, mp4.id);
        expect(card, view).toContain('Missing at last scan');
        expect(card, view).toMatch(view === 'grid' ? /<strong>Role<\/strong> Primary/ : /<dt>Role<\/dt>\s*<dd>Primary<\/dd>/);
        expect(card, view).not.toContain('data-asset-video-placeholder');
        expect(card, view).not.toMatch(/<(?:img|video)\b/);
      }
    });

    it('published and archived detail cards remain read-only while preserving roles', async () => {
      for (const lifecycle of ['published', 'archived']) {
        const fixture = await setupReleaseWithAssets({
          title: `Candidate Discovery ${lifecycle} Detail Test`,
          slug: `candidate-discovery-${lifecycle}-detail-test`,
        });
        await addSecondSelected(fixture);

        if (lifecycle === 'published') {
          await agent
            .post(`${fixture.releaseLocation}/publish`)
            .send('_csrf=' + encodeURIComponent(csrfToken))
            .send('publishedDate=2025-06-15')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .expect(302);
        } else {
          await agent
            .post(`${fixture.releaseLocation}/archive`)
            .send('_csrf=' + encodeURIComponent(csrfToken))
            .expect(302);
        }

        const res = await agent.get(`${fixture.releaseLocation}?view=list`).expect(200);
        const section = readOnlyDetailSection(res.text);
        expect(section).toMatch(/<dt>Role<\/dt>\s*<dd>Primary<\/dd>/);
        expect(section).toMatch(/<dt>Role<\/dt>\s*<dd>Attachment<\/dd>/);
        expect(res.text).not.toContain('release-asset-filters');
        expect(res.text).not.toMatch(/name="(?:category|extension|tag)"/);
      }
    });

    it('empty release detail renders one read-only empty state and retains editable navigation only when allowed', async () => {
      const editable = await setupReleaseWithAssets();
      await agent
        .post(`${editable.releaseLocation}/assets`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const editableDetail = await agent.get(editable.releaseLocation).expect(200);
      const editableSection = selectedSection(editableDetail.text);
      expect(editableSection).toContain('empty-state');
      expect(editableSection).toContain('No assets selected');
      expect(editableSection).not.toContain('<ul class="asset-grid"');
      expect(editableDetail.text).toContain('Manage Assets');

      const archived = await setupReleaseWithAssets({
        title: 'Candidate Discovery Archived Test',
        slug: 'candidate-discovery-archived-test',
      });
      await agent
        .post(`${archived.releaseLocation}/assets`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${archived.releaseLocation}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const archivedDetail = await agent.get(archived.releaseLocation).expect(200);
      const archivedSection = selectedSection(archivedDetail.text);
      expect(archivedSection).toContain('No assets selected');
      expect(archivedDetail.text).not.toContain('Manage Assets');
      expect(archivedSection).not.toContain('<form');
    });

    it('renders one unified release asset collection', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      const section = selectedSection(res.text);
      expect(res.text).not.toContain('<h2>Release Assets</h2>');
      expect(section).toContain('class="asset-grid"');
      expect(section).not.toContain('class="release-assets-form"');
      expect(section).not.toContain('>Save asset selection</button>');
      expect(section).not.toContain('Available Assets');
      expect(section).not.toContain('Bulk Selection');
      expect(section).not.toContain('candidate-grid');
      expect(hasNestedForms(section)).toBe(false);
    });

    it('renders selected and unselected membership options in the same collection', async () => {
      const fixture = await setupReleaseWithAssets();
      const res = await agent.get(`${fixture.releaseLocation}/assets?selection=all`).expect(200);

      const section = selectedSection(res.text);
      const alpha = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');
      const beta = fixture.allAssets.find((asset) => asset.filename === 'beta.png');
      expect(section).toContain(`id="release-asset-select-${alpha.id}"`);
      expect(section).toMatch(new RegExp(`id="release-asset-select-${alpha.id}"[\\s\\S]*?\\bchecked\\b`));
      const betaInput = section.match(new RegExp(`<input[^>]*id="release-asset-select-${beta.id}"[^>]*>`))?.[0] || '';
      expect(betaInput).toContain('type="checkbox"');
      expect(betaInput).not.toContain('checked');
      expect(section).toMatch(new RegExp(`data-asset-id="${alpha.id}"[^>]*aria-selected="true"`));
      expect(section).toMatch(new RegExp(`data-asset-id="${beta.id}"[^>]*aria-selected="false"`));
      expect(section).toContain('alpha.txt');
      expect(section).toContain('beta.png');
      expect(section).toContain('gamma.txt');
      expect(section).toContain('delta.txt');
      // Membership is conveyed by the checkbox and selected-state styling,
      // not by a verbose badge in the grid card.
      expect(section).not.toContain('<strong>Membership</strong> Selected');
      expect(section).not.toContain('<strong>Membership</strong> Not selected');
      expect(section).not.toContain('release-asset-membership-status');
      expect(section).not.toContain('name="roles[]"');
      expect(section).not.toContain('name="sortOrder[]"');
    });

    it('escapes asset labels and does not duplicate rendered IDs', async () => {
      const fixture = await setupReleaseWithAssets();
      const unsafeFilename = 'unsafe & <draft>.txt';
      const unsafeAsset = fixture.assetRepo.upsert(fixture.projectId, unsafeFilename, {
        filename: unsafeFilename,
        nestedPath: '',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        modifiedAt: null,
      });
      const res = await agent.get(`${fixture.releaseLocation}/assets?selection=all`).expect(200);
      const section = selectedSection(res.text);
      const ids = [...section.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

      expect(section).toContain('unsafe &amp; &lt;draft&gt;.txt');
      expect(section).toContain(`id="release-asset-select-${unsafeAsset.id}"`);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('keeps off-page selections in hidden membership inputs when assets are filtered and paginated', async () => {
      const fixture = await setupReleaseWithAssets();
      const alpha = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');
      const beta = fixture.allAssets.find((asset) => asset.filename === 'beta.png');

      await agent
        .post(`${fixture.releaseLocation}/assets`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${alpha.id}`)
        .send(`selectedAssetIds[]=${beta.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .get(`${fixture.releaseLocation}/assets?selection=all&search=gamma&pageSize=1`)
        .expect(200);
      const candidateSection = getCandidateSection(res.text);

      expect(candidateSection).not.toContain(`id="release-asset-select-${alpha.id}"`);
      expect(candidateSection).not.toContain(`id="release-asset-select-${beta.id}"`);
      expect(res.text).toContain(`name="selectedAssetIds" value="${alpha.id}"`);
      expect(res.text).toContain(`name="selectedAssetIds" value="${beta.id}"`);
      expect(candidateSection).toContain('gamma.txt');
      expect(candidateSection).not.toContain('alpha.txt');
      expect(candidateSection).not.toContain('beta.png');
      expect(res.text).toContain('1 project asset matches the current filters.');
    });

    it('bounds candidate options by page size and preserves filter state in pagination', async () => {
      // P3-C4: 30 txt assets at the supported size 10 -> 3 pages.
      const { releaseLocation } = await setupReleaseWithAssets({ fillers: 27 });
      const res = await agent
        .get(`${releaseLocation}/assets?selection=all&extension=txt&pageSize=10`)
        .expect(200);

      expect(res.text).toContain('Page 1 of 3');
      expect(selectedFilterValueAllowEmpty(res.text, 'release-asset-extension-filter-options', 'extension')).toBe('txt');
      expect(res.text).toContain('name="pageSize"');
      const next = res.text.match(/href="([^"]*)"[^>]*>Next</)?.[1];
      expect(next).toBeDefined();
      const nextUrl = new URL(next.replace(/&amp;/g, '&'), 'http://localhost');
      expect(nextUrl.searchParams.get('extension')).toBe('txt');
      expect(nextUrl.searchParams.get('pageSize')).toBe('10');
      expect(nextUrl.searchParams.get('page')).toBe('2');
    });

    it('invalid page falls back to 1', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets?page=invalid`).expect(200);
      // Page should render without error
      expect(res.status).toBe(200);
    });

    it('invalid page size falls back to default', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets?pageSize=invalid`).expect(200);
      expect(res.status).toBe(200);
    });

    it('normalizes invalid pagination inputs without failing the page', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      await agent.get(`${releaseLocation}/assets?page=invalid`).expect(200);
      await agent.get(`${releaseLocation}/assets?pageSize=invalid`).expect(200);
      const unknown = await agent.get(`${releaseLocation}/assets?unknown=param&junk=value`).expect(200);
      expect(unknown.status).toBe(200);
    });

    it('published release asset page remains read-only', async () => {
      const { releaseLocation, projectId } = await setupReleaseWithAssets();
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Publish the release
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      // Must show locked notice
      expect(res.text).toContain('locked and read-only');
      // Save asset selection button must not be present
      expect(res.text).not.toMatch(/type="submit"[^>]*>Save asset selection/);
      expect(res.text).toContain('<span class="release-asset-grid-role-label">Role</span>');
      expect(res.text).toContain('Primary');
      expect(res.text).not.toContain('release-asset-role-form');
    });

    it('archived release asset page remains read-only', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();

      // Archive the release
      await agent
        .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      // Must show archived notice
      expect(res.text).toContain('archived');
      // Save asset selection button must not be present
      expect(res.text).not.toMatch(/type="submit"[^>]*>Save asset selection/);
    });

    it('archived parent project asset page remains read-only', async () => {
      const { releaseLocation, projectId } = await setupReleaseWithAssets();

      // Archive the parent project
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      // Must show archived notice
      expect(res.text).toContain('archived');
      // Save asset selection button must not be present
      expect(res.text).not.toMatch(/type="submit"[^>]*>Save asset selection/);
    });

    it('no N+1 asset query path — single page load is fast', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);
      expect(res.text).toContain('data-release-assets-live-region');
      expect(res.text).toContain('4 project assets match the current filters.');
      expect(res.text).not.toContain('Available Assets');
    });

    it('renders selected assets in the default grid view', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      const section = selectedSection(res.text);

      expect(section).toContain('<ul class="asset-grid"');
      expect(section).not.toContain('asset-list--release');
      expect(section).toMatch(/aria-current="page"[\s\S]*aria-label="Grid view"/);
      expect(switcherUrl(section, 'Grid').searchParams.has('view')).toBe(false);
      expect(switcherUrl(section, 'List').searchParams.get('view')).toBe('list');
    });

    it('supports explicit grid view and preserves candidate query state in the switcher', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent
        .get(`${releaseLocation}/assets?selection=all&view=grid&search=beta&pageSize=10`)
        .expect(200);
      const section = selectedSection(res.text);
      const listUrl = switcherUrl(section, 'List');

      expect(section).toContain('<ul class="asset-grid"');
      expect(listUrl.searchParams.get('view')).toBe('list');
      expect(listUrl.searchParams.get('search')).toBe('beta');
      expect(listUrl.searchParams.get('pageSize')).toBe('10');
    });

    it('supports explicit list view and preserves candidate query state in the switcher', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      const res = await agent
        .get(`${releaseLocation}/assets?view=list&extension=txt&pageSize=10`)
        .expect(200);
      const section = selectedSection(res.text);
      const gridUrl = switcherUrl(section, 'Grid');

      expect(section).toContain('<ul class="asset-list asset-list--project asset-list--release"');
      expect(section).not.toContain('<ul class="asset-grid"');
      expect(section).toMatch(/aria-current="page"[\s\S]*aria-label="List view"/);
      expect(gridUrl.searchParams.has('view')).toBe(false);
      expect(gridUrl.searchParams.get('extension')).toBe('txt');
      expect(gridUrl.searchParams.get('pageSize')).toBe('10');
    });

    it('preserves selected release order in both card views', async () => {
      const fixture = await setupReleaseWithAssets();
      await addSecondSelected(fixture);

      for (const view of ['grid', 'list']) {
        const res = await agent.get(`${fixture.releaseLocation}/assets?view=${view}`).expect(200);
        const section = selectedSection(res.text);
        expect(section.indexOf('alpha.txt')).toBeLessThan(section.indexOf('beta.png'));
      }
    });

    it('links selected previews and filenames to the asset viewer with revisioned preview URLs', async () => {
      const fixture = await setupReleaseWithAssets();
      const secondAsset = await addSecondSelected(fixture);
      const viewerUrl = `/projects/${fixture.projectId}/assets/${secondAsset.id}`;

      const grid = await agent.get(`${fixture.releaseLocation}/assets?view=grid`).expect(200);
      const gridSection = selectedSection(grid.text);
      expect(gridSection).toContain('<h3 class="asset-viewer-grid-card-info-heading">Asset information</h3>');
      expect(gridSection).toMatch(/<dt>Filename<\/dt>\s*<dd>beta\.png<\/dd>/);
      expect(gridSection).toMatch(new RegExp(`src="${viewerUrl}/preview\\?v=[^"]+"`));
      expect(gridSection).toContain(`href="${viewerUrl}"`);

      const list = await agent.get(`${fixture.releaseLocation}/assets?view=list`).expect(200);
      const listSection = selectedSection(list.text);
      expect(listSection).toContain('<h2 class="asset-list-card-title">');
      expect(listSection).toContain('beta');
      expect(listSection).not.toContain('asset-details-link');
      expect(listSection).toContain(`<a class="button button-small button-secondary" href="${viewerUrl}">Open asset</a>`);
      expect(listSection).toMatch(new RegExp(`src="${viewerUrl}/preview\\?v=[^"]+"`));
      expect(listSection).toContain(`beta.png`);
    });

    it('preserves role fields for selected assets and omits movement controls', async () => {
      const fixture = await setupReleaseWithAssets();
      const secondAsset = await addSecondSelected(fixture);
      const res = await agent.get(`${fixture.releaseLocation}/assets?view=grid`).expect(200);
      const section = selectedSection(res.text);
      const firstCard = section.match(new RegExp(`<article[^>]*data-asset-id="${fixture.allAssets.find((asset) => asset.filename === 'alpha.txt').id}"[\\s\\S]*?<\\/article>`))?.[0];
      const lastCard = section.match(new RegExp(`<article[^>]*data-asset-id="${secondAsset.id}"[\\s\\S]*?<\\/article>`))?.[0];

      expect(firstCard).toBeDefined();
      expect(lastCard).toBeDefined();
      expect(section).toMatch(new RegExp(`<select id="role-\\d+" name="role"[\\s\\S]*?<option value="primary" selected>`));
      expect(section).toMatch(new RegExp(`<select id="role-${secondAsset.id}" name="role"[\\s\\S]*?<option value="attachment" selected>`));
      expect(section).not.toContain(`action="${fixture.releaseLocation}/assets/${secondAsset.id}/remove-selected?view=grid"`);
      expect(section).not.toContain('/move-up');
      expect(section).not.toContain('/move-down');
      expect(hasNestedForms(section)).toBe(false);
    });

    it('keeps editable grid roles reachable outside preview information for normal, missing, and unsupported assets', async () => {
      const fixture = await setupReleaseWithAssets();
      const normal = await addSecondSelected(fixture);
      const missing = fixture.allAssets.find((asset) => asset.filename === 'gamma.txt');
      const unsupported = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');

      await agent
        .post(`${fixture.releaseLocation}/assets/add`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${missing.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(missing.id);

      const res = await agent.get(`${fixture.releaseLocation}/assets?view=grid`).expect(200);
      const section = selectedSection(res.text);
      const cards = [
        { asset: normal, marker: 'data-preview-image' },
        { asset: missing, marker: 'Missing at last scan' },
        { asset: unsupported, marker: 'preview not supported' },
      ];

      for (const { asset, marker } of cards) {
        const card = assetCard(section, asset.id);
        const rolePosition = card.indexOf('class="release-asset-grid-role"');
        const previewPosition = card.indexOf('data-asset-viewer-preview');
        expect(card).toContain(marker);
        expect(card).toContain(`<select id="role-${asset.id}" name="role" class="cc-dropdown-native-select" data-cc-dropdown-native-select aria-label="Role for ${asset.filename}" data-autosubmit>`);
        expect(card).toContain(`id="release-asset-role-${asset.id}" data-cc-dropdown`);
        expect(card).toContain(`action="${fixture.releaseLocation}/assets/${asset.id}/role?view=grid"`);
        expect(rolePosition).toBeGreaterThan(-1);
        expect(rolePosition).toBeLessThan(previewPosition);
        expect(card).toContain('class="asset-select-checkbox"');
        expect(card).toContain('class="asset-details-link');
        expect(card).toContain('data-asset-info-card');
        expect(card).not.toContain('<noscript>');
      }
    });

    it('keeps published grid roles readable outside preview information for normal, missing, and unsupported assets', async () => {
      const fixture = await setupReleaseWithAssets();
      const normal = await addSecondSelected(fixture);
      const missing = fixture.allAssets.find((asset) => asset.filename === 'gamma.txt');
      const unsupported = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');

      await agent
        .post(`${fixture.releaseLocation}/assets/add`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${missing.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${fixture.releaseLocation}/assets/${normal.id}/role`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=preview')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(missing.id);
      await agent
        .post(`${fixture.releaseLocation}/publish`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(`${fixture.releaseLocation}/assets?view=grid`).expect(200);
      const section = selectedSection(res.text);
      for (const { asset, marker, role } of [
        { asset: normal, marker: 'data-preview-image', role: 'Preview' },
        { asset: missing, marker: 'Missing at last scan', role: 'Attachment' },
        { asset: unsupported, marker: 'preview not supported', role: 'Primary' },
      ]) {
        const card = assetCard(section, asset.id);
        expect(card).toContain(marker);
        expect(card).toContain('<span class="release-asset-grid-role-label">Role</span>');
        expect(card).toContain(`<span class="release-asset-grid-role-value">${role}</span>`);
        expect(card.indexOf('class="release-asset-grid-role"')).toBeLessThan(card.indexOf('data-asset-viewer-preview'));
        expect(card).toContain('class="asset-details-link');
        expect(card).toContain('data-asset-info-card');
        expect(card).not.toContain('release-asset-role-form');
        expect(card).not.toContain('<select');
        expect(card).not.toContain('asset-select-checkbox');
      }
    });

    it('leaves list role presentation unchanged', async () => {
      const fixture = await setupReleaseWithAssets();
      const res = await agent.get(`${fixture.releaseLocation}/assets?view=list`).expect(200);
      const card = assetCard(selectedSection(res.text), fixture.allAssets.find((asset) => asset.filename === 'alpha.txt').id);

      expect(card).toContain('class="asset-list-cell asset-list-cell--role asset-list-card-meta asset-list-card-meta--role"');
      expect(card).toContain('class="inline-form release-asset-role-form"');
      expect(card).toMatch(/<select id="role-\d+" name="role" class="cc-dropdown-native-select"[^>]*data-autosubmit>/);
      expect(card).not.toContain('release-asset-grid-role');
    });

    // Role and page size use the shared native-backed dropdown: each Role form
    // posts only its own native select, so the presentation radios carry no name
    // and every identifier is unique to its asset.
    it('renders Role and page size as native-backed dropdowns with per-asset contracts', async () => {
      const fixture = await setupReleaseWithAssets();
      const secondAsset = await addSecondSelected(fixture);
      const alpha = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');

      for (const view of ['grid', 'list']) {
        const res = await agent.get(`${fixture.releaseLocation}/assets?view=${view}&pageSize=10`).expect(200);
        expect(res.text).toContain('<body class="refined-page">');

        const forms = [...res.text.matchAll(/<form method="post" action="([^"]+)" class="inline-form release-asset-role-form">([\s\S]*?)<\/form>/g)];
        expect(forms).toHaveLength(2);
        for (const [asset, role] of [[alpha, 'primary'], [secondAsset, 'attachment']]) {
          const [, action, form] = forms.find(([, formAction]) => formAction.includes(`/assets/${asset.id}/role`));
          expect(action.startsWith(`${fixture.releaseLocation}/assets/${asset.id}/role?`)).toBe(true);
          expect(action).toContain('pageSize=10');
          expect([...form.matchAll(/\sname="([^"]+)"/g)].map(([, name]) => name)).toEqual(['_csrf', 'role']);
          const native = sliceSelect(form, `role-${asset.id}`);
          expect(optionValues(native)).toEqual(['primary', 'preview', 'attachment']);
          expect(native).toContain(`<option value="${role}" selected>`);
          expect(form).toContain(`<legend class="sr-only">Role for ${asset.filename}</legend>`);
          expect(form).toContain(`aria-label="Role for ${asset.filename}: ${role[0].toUpperCase()}${role.slice(1)}"`);
          const details = form.match(new RegExp(`<details class="[^"]*cc-dropdown--compact[^"]*" id="release-asset-role-${asset.id}"[^>]*>`))?.[0] || '';
          for (const attribute of [' data-cc-dropdown-dispatch-native-change', ' data-cc-viewport-disclosure', ' hidden']) {
            expect(details).toContain(attribute);
          }
          expect(form).toMatch(new RegExp(`<input id="release-asset-role-${asset.id}-option-\\d" type="radio" value="${role}" checked>`));
        }

        const ids = [...res.text.matchAll(/\sid="((?:release-asset-)?role-\d+[^"]*)"/g)].map(([, id]) => id);
        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids).size).toBe(ids.length);

        const pageSizeForm = res.text.match(/<form class="page-size-form"[\s\S]*?<\/form>/)?.[0] || '';
        expect(pageSizeForm).toContain('<select id="pageSize" name="pageSize" class="cc-dropdown-native-select" data-cc-dropdown-native-select aria-label="Assets per page" data-autosubmit data-release-assets-live-page-size>');
        expect(sliceSelect(pageSizeForm, 'pageSize')).toMatch(/<option value="10"\s+selected>/);
        expect([...pageSizeForm.matchAll(/\sname="([^"]+)"/g)].map(([, name]) => name))
          .toEqual(view === 'list' ? ['pageSize', 'view'] : ['pageSize']);
        expect(pageSizeForm).toContain('id="page-size-dropdown" data-cc-dropdown');
      }
    });

    it('gives Manage Assets list titles the shared information card with membership state', async () => {
      const fixture = await setupReleaseWithAssets();
      const alpha = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');
      const gamma = fixture.allAssets.find((asset) => asset.filename === 'gamma.txt');
      const infoFor = (section, assetId) => section
        .match(new RegExp(`<div id="release-manage-asset-list-info-${assetId}"[\\s\\S]*?</dl>`))?.[0] || '';

      const res = await agent.get(`${fixture.releaseLocation}/assets?selection=all&view=list`).expect(200);
      const section = selectedSection(res.text);
      expect(section).toContain('data-asset-list-columns="select asset category role order type presence size modified"');
      expect(section).not.toContain('asset-list-cell--actions');

      // Selected: the checkbox and Role form stay in their row columns; the
      // title is the shared trigger and the card adds membership, Role, Order.
      const selected = assetCard(section, alpha.id);
      expect(selected).toContain(`<button class="dashboard-title-trigger dashboard-truncate" type="button" data-calendar-info-trigger aria-controls="release-manage-asset-list-info-${alpha.id}" aria-expanded="false">`);
      expect(selected).toMatch(/asset-list-cell--select">\s*<label class="asset-selection-control is-selected"/);
      expect(selected).toMatch(/asset-list-cell--role[\s\S]*?<dd>\s*<form method="post"[^>]*class="inline-form release-asset-role-form"/);
      const selectedInfo = infoFor(selected, alpha.id);
      expect(selectedInfo).toContain('data-calendar-info-card popover="manual"');
      expect(selectedInfo).toContain(`<a class="button button-small button-secondary" href="/projects/${fixture.projectId}/assets/${alpha.id}">Open asset</a>`);
      expect(selectedInfo).toContain('<h3 class="asset-viewer-grid-card-info-heading asset-list-info-filename">alpha.txt</h3>');
      expect(selectedInfo).toMatch(/<dt>Path<\/dt><dd class="asset-list-info-path">[^<]*alpha\.txt<\/dd>/);
      // Membership and stored Role/Order carry the hooks the client draft
      // reconciliation rewrites from unsaved selection changes.
      expect(selectedInfo).toContain(`<div class="asset-viewer-grid-card-info-row" data-release-asset-membership-info data-release-asset-id="${alpha.id}"><dt>Release</dt><dd data-release-asset-membership-status>Selected</dd></div>`);
      expect(selectedInfo).toContain('<div class="asset-viewer-grid-card-info-row" data-release-asset-stored-fact><dt data-release-asset-stored-fact-label="Role">Role</dt><dd>Primary</dd></div>');
      expect(selectedInfo).toContain('<div class="asset-viewer-grid-card-info-row" data-release-asset-stored-fact><dt data-release-asset-stored-fact-label="Order">Order</dt><dd>0</dd></div>');
      expect(selectedInfo).toContain('<dt>Type</dt><dd>TXT (.txt)</dd>');
      expect(selectedInfo).toMatch(/<dt>Modified<\/dt><dd>\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}/);
      // No controls move into the card, and no nested forms.
      expect(selectedInfo).not.toMatch(/<(?:form|input|select)\b/);

      // Unselected: dashes in the row, and the card has no Role or Order.
      const unselected = assetCard(section, gamma.id);
      expect(unselected).toMatch(/asset-list-cell--role[\s\S]*?<dd><span class="dashboard-muted">—<\/span><\/dd>/);
      expect(unselected).toMatch(/asset-list-cell--order[\s\S]*?<dd><span class="dashboard-muted">—<\/span><\/dd>/);
      const unselectedInfo = infoFor(unselected, gamma.id);
      expect(unselectedInfo).toContain('<dt>Release</dt><dd data-release-asset-membership-status>Not selected</dd>');
      expect(unselectedInfo).not.toContain('>Role</dt>');
      expect(unselectedInfo).not.toContain('>Order</dt>');
      expect(unselectedInfo).not.toContain('data-release-asset-stored-fact');

      // Grid keeps its own cards.
      const grid = selectedSection((await agent.get(`${fixture.releaseLocation}/assets?selection=all`).expect(200)).text);
      expect(grid).not.toContain('data-calendar-info-trigger');

      // Read-only: no Select column or controls, but titles keep their cards.
      db.prepare('UPDATE releases SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(fixture.releaseId);
      const archived = withoutGridStyleControl(
        selectedSection((await agent.get(`${fixture.releaseLocation}/assets?selection=all&view=list`).expect(200)).text),
        'release-assets',
      );
      expect(archived).toContain('data-asset-list-columns="asset category role order type presence size modified"');
      expect(archived).not.toMatch(/<(?:form|select)\b/);
      expect(archived).not.toContain('selectedAssetIds');
      expect(archived).not.toContain('asset-selection-control');
      expect(archived).not.toContain('data-asset-selectable-card');
      expect(infoFor(archived, alpha.id)).toContain('<dd data-release-asset-membership-status>Selected</dd>');
      expect(infoFor(archived, alpha.id)).toContain('Role</dt><dd>Primary</dd>');
    });

    it('saves membership by ID while preserving existing role/order and appending new assets', async () => {
      const fixture = await setupReleaseWithAssets();
      const alpha = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');
      const beta = fixture.allAssets.find((asset) => asset.filename === 'beta.png');
      const res = await agent
        .post(`${fixture.releaseLocation}/assets?view=list&search=beta&pageSize=1`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${beta.id}`)
        .send(`selectedAssetIds[]=${alpha.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const redirect = new URL(res.headers.location, 'http://localhost');
      expect(redirect.pathname).toBe(fixture.releaseLocation);
      // B3-F2: no Manage Assets query is carried, only the Save's own ticket.
      expectReleaseAssetsSavedLocation(res.headers.location, fixture.releaseId);
      expect(getReleaseAssets(db, fixture.releaseId).map((row) => ({
        asset_id: row.asset_id,
        role: row.role,
        sort_order: row.sort_order,
      }))).toEqual([
        { asset_id: alpha.id, role: 'primary', sort_order: 0 },
        { asset_id: beta.id, role: 'attachment', sort_order: 1 },
      ]);
    });

    it('keeps a missing selected asset when the collection submits it checked', async () => {
      const fixture = await setupReleaseWithAssets();
      const alpha = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');
      const beta = fixture.allAssets.find((asset) => asset.filename === 'beta.png');
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(alpha.id);

      const page = await agent.get(`${fixture.releaseLocation}/assets?search=beta`).expect(200);
      const collection = getCandidateSection(page.text);
      expect(collection).toBeTruthy();
      expect(collection).toMatch(new RegExp(`id="release-asset-select-${alpha.id}"[\\s\\S]*?checked`));
      expect(collection).toContain('Missing at last scan');

      await agent
        .post(`${fixture.releaseLocation}/assets?search=beta`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${alpha.id}`)
        .send(`selectedAssetIds[]=${beta.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(getReleaseAssets(db, fixture.releaseId).map((row) => row.asset_id)).toEqual([alpha.id, beta.id]);
    });

    it('removes a missing selected asset only when it is explicitly unchecked', async () => {
      const fixture = await setupReleaseWithAssets();
      const alpha = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');
      const beta = fixture.allAssets.find((asset) => asset.filename === 'beta.png');
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(alpha.id);

      await agent
        .post(`${fixture.releaseLocation}/assets`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${beta.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(getReleaseAssets(db, fixture.releaseId).map((row) => row.asset_id)).toEqual([beta.id]);
    });

    it('renders missing and unsupported selected-asset fallbacks', async () => {
      const fixture = await setupReleaseWithAssets();
      const unsupported = await agent.get(`${fixture.releaseLocation}/assets?view=list`).expect(200);
      expect(selectedSection(unsupported.text)).toContain('TXT — preview not supported');

      const alphaAsset = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(alphaAsset.id);
      const missing = await agent.get(`${fixture.releaseLocation}/assets?view=list`).expect(200);
      expect(selectedSection(missing.text)).toContain('Missing at last scan');
    });

    async function assertReadOnlySelectedCards(fixture) {
      const res = await agent.get(`${fixture.releaseLocation}/assets?view=list`).expect(200);
      const section = selectedSection(res.text);
      expect(section).toContain('Role');
      expect(section).toContain('Order');
      expect(section).not.toContain('class="release-assets-form"');
      expect(section).not.toContain('/role"');
      expect(section).not.toContain('/remove-selected"');
      expect(section).not.toContain('/move-up"');
      expect(section).not.toContain('/move-down"');
      expect(section).not.toContain('release-asset-card-controls');
      expect(res.text).not.toContain('class="release-assets-form"');

      // An explicit All assets request cannot turn read-only membership into
      // an editable project collection.
      const all = await agent.get(`${fixture.releaseLocation}/assets?selection=all`).expect(200);
      const allSection = selectedSection(all.text);
      const unselected = fixture.allAssets.find((asset) => asset.filename === 'gamma.txt');
      expect(allSection).not.toContain(`data-asset-id="${unselected.id}"`);
      expect(allSection).not.toContain('data-release-assets-selection-notice');
      expect(allSection).not.toContain('class="asset-select-checkbox"');
      expect(all.text).not.toContain('release-assets-filter-dialog');
      expect(all.text).not.toContain('id="release-assets-form"');
    }

    it('keeps published selected cards informative without mutation controls', async () => {
      const fixture = await setupReleaseWithAssets();
      await addSecondSelected(fixture);
      await agent
        .post(`${fixture.releaseLocation}/publish`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await assertReadOnlySelectedCards(fixture);
    });

    it('keeps archived selected cards informative without mutation controls', async () => {
      const fixture = await setupReleaseWithAssets();
      await addSecondSelected(fixture);
      await agent
        .post(`${fixture.releaseLocation}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      await assertReadOnlySelectedCards(fixture);
    });

    it('keeps the empty selected state valid with the unified asset collection', async () => {
      const { releaseLocation } = await setupReleaseWithAssets();
      await agent
        .post(`${releaseLocation}/assets`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // The default Selected assets view explains the empty saved selection
      // while the Save form stays usable.
      const selectedView = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(selectedSection(selectedView.text)).toContain('No assets selected');
      expect(selectedSection(selectedView.text)).toContain('data-release-assets-selection-notice');
      expect(selectedView.text).toContain('<form id="release-assets-form"');

      const res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);
      const section = selectedSection(res.text);
      expect(section).not.toContain('No assets selected');
      expect(section).toContain('class="asset-grid"');
      // Every card renders an unchecked membership checkbox.
      expect(section).toContain('class="asset-select-checkbox"');
      expect(section).not.toMatch(/<input[^>]*class="asset-select-checkbox"[^>]*\bchecked\b/);
      expect(section).not.toContain('Available Assets');
      expect(section).not.toContain('Bulk Selection');
      expect(section).not.toContain('candidate-grid');
      expect(hasNestedForms(section)).toBe(false);
    });

    describe('Selection filter', () => {
      const decode = (href) => new URL(href.replace(/&amp;/g, '&'), 'http://localhost');
      const selectionRadio = (html, value) => html.match(
        new RegExp(`<input id="release-asset-selection-option-${value}" name="selection" type="radio" value="${value}"[^>]*>`),
      )?.[0];
      const clearHref = (html) => html.match(/<a class="button button-secondary" href="([^"]*)" data-release-assets-reset>Clear<\/a>/)?.[1];

      it('defaults absent and invalid selection to saved selected assets with the notice', async () => {
        const fixture = await setupReleaseWithAssets();
        const alpha = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');
        const beta = fixture.allAssets.find((asset) => asset.filename === 'beta.png');

        for (const query of ['', '?selection=bogus', '?selection=selected']) {
          const res = await agent.get(`${fixture.releaseLocation}/assets${query}`).expect(200);
          const section = selectedSection(res.text);
          expect(assetCard(section, alpha.id), query).toContain('checked');
          expect(section, query).not.toContain(`data-asset-id="${beta.id}"`);
          expect(section, query).toContain('1 selected asset matches the current filters.');
          // The notice sits in the replaceable region, below the toolbar and above the count.
          const notice = section.indexOf('data-release-assets-selection-notice');
          expect(notice, query).toBeGreaterThan(section.indexOf('asset-viewer-display-controls'));
          expect(notice, query).toBeLessThan(section.indexOf('release-asset-results-meta'));
          expect(section, query).toContain('Showing selected assets');
          expect(section, query).toContain('Only saved selected assets are shown.');
          expect(selectionRadio(res.text, 'selected'), query).toContain('checked');
          expect(selectionRadio(res.text, 'all'), query).not.toContain('checked');
          expect(res.text, query).toContain(`<form id="release-assets-form" method="post" action="${fixture.releaseLocation}/assets"`);
          expect(clearHref(res.text), query).toBeUndefined();
          expect(section, query).not.toContain('name="selection"');
        }
      });

      it('shows the eligible collection for explicit all and carries it through generated URLs', async () => {
        // P3-C4: 30 assets matching "a" at the supported size 10 -> page 2 of 3.
        const fixture = await setupReleaseWithAssets({ fillers: 26 });
        const res = await agent.get(`${fixture.releaseLocation}/assets?selection=all&search=a&pageSize=10&page=2`).expect(200);
        const section = selectedSection(res.text);

        expect(section).not.toContain('data-release-assets-selection-notice');
        expect(section).toContain('30 project assets match the current filters.');
        expect(selectionRadio(res.text, 'all')).toContain('checked');
        expect(selectionRadio(res.text, 'selected')).not.toContain('checked');

        for (const label of ['Grid', 'List']) {
          expect(switcherUrl(section, label).searchParams.get('selection')).toBe('all');
        }
        for (const rel of ['prev', 'next']) {
          const href = section.match(new RegExp(`class="pagination-${rel}" href="([^"]*)"`))[1];
          expect(decode(href).searchParams.get('selection')).toBe('all');
        }
        expect(section).toContain('<input type="hidden" name="selection" value="all">');
        expect(res.text).toContain(
          `<form id="release-assets-form" method="post" action="${fixture.releaseLocation}/assets?search=a&amp;selection=all&amp;page=2&amp;pageSize=10"`,
        );

        // Clear resets search and Selection to the default and returns to page 1,
        // keeping the page size.
        const clear = decode(clearHref(res.text));
        expect(clear.pathname).toBe(`${fixture.releaseLocation}/assets`);
        expect([...clear.searchParams.keys()]).toEqual(['pageSize']);
      });

      it('distinguishes no saved selection from no matching selected assets and keeps selected missing assets', async () => {
        const fixture = await setupReleaseWithAssets();
        const alpha = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');

        const noMatch = selectedSection((await agent.get(`${fixture.releaseLocation}/assets?search=beta`).expect(200)).text);
        expect(noMatch).toContain('No matching selected assets');
        expect(noMatch).not.toContain('No assets selected');
        expect(noMatch).toContain('0 selected assets match the current filters.');

        db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(alpha.id);
        const missing = selectedSection((await agent.get(`${fixture.releaseLocation}/assets?search=beta`).expect(200)).text);
        expect(assetCard(missing, alpha.id)).toContain(`id="release-asset-select-${alpha.id}"`);

        await agent
          .post(`${fixture.releaseLocation}/assets`)
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        const empty = selectedSection((await agent.get(`${fixture.releaseLocation}/assets`).expect(200)).text);
        expect(empty).toContain('No assets selected');
        expect(empty).toContain('Choose &#39;All assets&#39; in Filter');
        expect(empty).not.toContain('No matching selected assets');
      });

      it('saves complete membership submitted from the Selected assets view', async () => {
        const fixture = await setupReleaseWithAssets();
        const alpha = fixture.allAssets.find((asset) => asset.filename === 'alpha.txt');
        const gamma = fixture.allAssets.find((asset) => asset.filename === 'gamma.txt');

        // A pending addition hidden by Selected assets is still submitted.
        await agent
          .post(`${fixture.releaseLocation}/assets`)
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`selectedAssetIds[]=${alpha.id}`)
          .send(`selectedAssetIds[]=${gamma.id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        const rows = getReleaseAssets(db, fixture.releaseId);
        expect(rows.map((row) => [row.asset_id, row.role])).toEqual([[alpha.id, 'primary'], [gamma.id, 'attachment']]);

        const res = await agent.get(`${fixture.releaseLocation}/assets`).expect(200);
        const section = selectedSection(res.text);
        expect(section).toContain('2 selected assets match the current filters.');
        expect(section).toContain(`data-asset-id="${gamma.id}"`);
      });
    });
  });

  // ─── Phase 9-3: Role guidance and accessibility ───────────────────────

  describe('role guidance and accessibility (Phase 9-3)', () => {
    async function setupBasicRelease() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Role+Guidance+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'role-guidance-test';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
      fs.writeFileSync(path.join(projectDir, 'asset2.png'), 'png2');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Role+Guidance+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      return { projectId, releaseLocation };
    }

    it('omits the standalone role guidance section', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      expect(res.text).not.toContain('role-guidance');
      expect(res.text).not.toContain('asset-roles-heading');
      expect(res.text).not.toContain('The main asset for this release');
      expect(res.text).not.toContain('A preview or teaser asset');
      expect(res.text).not.toContain('A supporting asset bundled with the release');
    });

    it('search input has visible label', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('<label for="asset-search">Find project assets</label>');
    });

    it('extension filter has visible label', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('<legend>Extension</legend>');
    });

    it('page-size control has visible label', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('<legend>Page size</legend>');
      expect(res.text).toContain('id="asset-page-size" name="pageSize" class="cc-dropdown-native-select"');
    });

    // The live filter form is serialized wholesale on every filter change, so both
    // editable controls must expose the same complete page-size contract.
    it('both editable page-size controls offer the exact supported choices on one-page results', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      const filterSelect = sliceSelect(res.text, 'asset-page-size');
      const footerSelect = sliceSelect(res.text, 'pageSize');

      expect(optionValues(filterSelect)).toEqual(['10', '25', '50', '100', '150', '200', 'all']);
      expect(optionValues(footerSelect)).toEqual(['10', '25', '50', '100', '150', '200', 'all']);
      expect(visibleText(filterSelect)).toContain('10 25 50 100 150 200 View All');
      expect(visibleText(footerSelect)).toContain('10 25 50 100 150 200 View All');
    });

    it('live filter page-size control marks an active pageSize=10 as selected', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets?pageSize=10`).expect(200);
      const filterSelect = sliceSelect(res.text, 'asset-page-size');

      expect(filterSelect).toMatch(/<option value="10"\s+selected>/);
      expect(filterSelect).not.toMatch(/<option value="25"\s+selected>/);
    });

    it('live filter page-size control still marks the default pageSize=25 as selected', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      const filterSelect = sliceSelect(res.text, 'asset-page-size');

      expect(filterSelect).toMatch(/<option value="25"\s+selected>/);
      expect(filterSelect).not.toMatch(/<option value="10"\s+selected>/);
    });

    it('asset selection controls have accessible membership labels', async () => {
      const { releaseLocation } = await setupBasicRelease();
      const res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);
      expect(res.text).toContain('class="asset-select-checkbox"');
      expect(res.text).toContain('aria-label="Select ');
    });

    it('selected asset controls have an accessible deselection name', async () => {
      const { releaseLocation, projectId } = await setupBasicRelease();
      // Add an asset so the selected membership control appears.
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      for (const asset of assets) {
        await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${asset.id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).toContain('aria-label="Deselect ');
      expect(res.text).not.toContain('aria-label="Remove ');
    });

    it('move-up and move-down controls are not present on the release assets page', async () => {
      const { releaseLocation, projectId } = await setupBasicRelease();
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      for (const asset of assets) {
        await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${asset.id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);
      expect(res.text).not.toContain('/move-up');
      expect(res.text).not.toContain('/move-down');
      expect(res.text).not.toContain('already first');
      expect(res.text).not.toContain('already last');
    });

    it('role select uses the supported JavaScript autosubmit path in mutable scope', async () => {
      const { releaseLocation, projectId } = await setupBasicRelease();
      // Add an asset so role select appears
      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      for (const asset of assets) {
        await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${asset.id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }

      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      // Role select exists for mutable scope in the new per-row form
      const roleSelectMatch = res.text.match(/<select id="role-\d+" name="role" class="cc-dropdown-native-select" data-cc-dropdown-native-select aria-label="Role for [^"]+" data-autosubmit>/);
      expect(roleSelectMatch).not.toBeNull();

      expect(res.text).not.toMatch(/<noscript><button[^>]*>Set<\/button><\/noscript>/);
      const roleFormMatch = res.text.match(/action="\/releases\/\d+\/assets\/\d+\/role(?:\?[^"\s]*)?"/g);
      expect(roleFormMatch).not.toBeNull();
    });
  });

  // ─── Phase 9-3: Lifecycle regression ─────────────────────────────────

  describe('Phase 9-3 lifecycle regression', () => {
    async function setupReleaseWithTwoAssets() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Lifecycle+Regression+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'lifecycle-regression-test';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'a.png'), 'png');
      fs.writeFileSync(path.join(projectDir, 'b.png'), 'png');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Lifecycle+Regression+Release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      setProjectStatusForReleaseTest(db, releaseLocation, 'ready');

      // Select both assets
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${allAssets[0].id}`)
        .send(`selectedAssetIds[]=${allAssets[1].id}`)
        .send('roles[]=primary')
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .send('sortOrder[]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetRepo, allAssets };
    }

    it('published release summary remains unchanged after mutation attempt', async () => {
      const { releaseLocation } = await setupReleaseWithTwoAssets();

      // Publish
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeDetail = await agent.get(releaseLocation).expect(200);
      expect(beforeDetail.text).toContain('Publication summary');

      // Attempt mutation via Phase 9-2 route
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('assetId=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);

      const afterDetail = await agent.get(releaseLocation).expect(200);
      expect(afterDetail.text).toContain('Publication summary');
    });

    it('archived release preserves complete release and junction rows', async () => {
      const { releaseLocation, releaseId } = await setupReleaseWithTwoAssets();

      const beforeRows = getReleaseAssets(db, releaseId);
      expect(beforeRows).toHaveLength(2);

      // Archive
      await agent
        .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toEqual(beforeRows);

      // Detail page shows archived notice
      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain('archived');
    });

    it('archived parent preserves complete release and junction rows', async () => {
      const { releaseLocation, releaseId, projectId } = await setupReleaseWithTwoAssets();

      const beforeRows = getReleaseAssets(db, releaseId);

      // Archive parent project
      await agent
        .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toEqual(beforeRows);
    });

    it('published release keeps its publication summary after Phase 9-2 mutations', async () => {
      const { releaseLocation } = await setupReleaseWithTwoAssets();

      // Publish
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Published releases show their publication summary, not a policy panel.
      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).not.toContain('Publishable');
      expect(detail.text).toContain('Publication summary');
    });

    it('missing selected assets remain historically visible', async () => {
      const { releaseLocation, releaseId, projectId, assetRepo, allAssets } = await setupReleaseWithTwoAssets();

      // Mark one asset as missing
      const assetToRemove = allAssets[0];
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(assetToRemove.id);

      // Detail page must still show the missing asset
      const detail = await agent.get(releaseLocation).expect(200);
      expect(detail.text).toContain(assetToRemove.filename);
      expect(detail.text).toContain('Missing');
    });
  });

  // ─── Phase 9-3: Cross-view ordering consistency ───────────────────────

  describe('cross-view ordering consistency (Phase 9-3)', () => {
    async function setupOrderedRelease() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Ordering+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'ordering-test';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'c.txt'), 'c');
      fs.writeFileSync(path.join(projectDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(projectDir, 'b.txt'), 'b');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const assetC = allAssets.find((a) => a.filename === 'c.txt');
      const assetA = allAssets.find((a) => a.filename === 'a.txt');
      const assetB = allAssets.find((a) => a.filename === 'b.txt');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Ordering+Release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      setProjectStatusForReleaseTest(db, releaseLocation, 'ready');

      // Add assets via Phase 9-2 add route in non-alphabetical order
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${assetC.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${assetA.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${assetB.id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetRepo, allAssets, assetA, assetB, assetC };
    }

    it('asset collection shows project assets in canonical filename order', async () => {
      const { releaseLocation } = await setupOrderedRelease();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      // The editable collection is ordered by project asset filename, not
      // release membership order: a, b, c.
      const selectedSection = res.text.match(/<section data-release-assets-live-region>[\s\S]*?<\/section>/);
      expect(selectedSection).not.toBeNull();
      const cPos = selectedSection[0].indexOf('c.txt');
      const aPos = selectedSection[0].indexOf('a.txt');
      const bPos = selectedSection[0].indexOf('b.txt');
      expect(aPos).toBeLessThan(bPos);
      expect(bPos).toBeLessThan(cPos);
    });

    it('release detail shows assets in same order as curation page', async () => {
      const { releaseLocation } = await setupOrderedRelease();
      const res = await agent.get(releaseLocation).expect(200);

      const cPos = res.text.indexOf('c.txt');
      const aPos = res.text.indexOf('a.txt');
      const bPos = res.text.indexOf('b.txt');
      expect(cPos).toBeLessThan(aPos);
      expect(aPos).toBeLessThan(bPos);
    });

    it('publication review shows assets in same order as curation page', async () => {
      const { releaseLocation } = await setupOrderedRelease();
      const res = await agent.get(`${releaseLocation}?publish=1`).expect(200);

      const cPos = res.text.indexOf('c.txt');
      const aPos = res.text.indexOf('a.txt');
      const bPos = res.text.indexOf('b.txt');
      expect(cPos).toBeLessThan(aPos);
      expect(aPos).toBeLessThan(bPos);
    });

    it('published summary shows assets in same order as curation page', async () => {
      const { releaseLocation } = await setupOrderedRelease();

      // Publish
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('publishedDate=2025-06-15')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(releaseLocation).expect(200);

      const cPos = res.text.indexOf('c.txt');
      const aPos = res.text.indexOf('a.txt');
      const bPos = res.text.indexOf('b.txt');
      expect(cPos).toBeLessThan(aPos);
      expect(aPos).toBeLessThan(bPos);
    });
  });

  // ─── Phase 9-3: Count/page parity after mutations ─────────────────────

  describe('count/page parity after mutations (Phase 9-3)', () => {
    it('asset collection count remains stable after adding an asset', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Count+Parity+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'count-parity-test';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(projectDir, 'b.txt'), 'b');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Count+Parity+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      // Before add: 2 eligible project assets.
      let res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);
      expect(res.text).toContain('2 project assets match the current filters.');

      // Add one asset
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Membership changes, but the project asset collection does not.
      res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);
      expect(res.text).toContain('2 project assets match the current filters.');
    });

    it('asset collection count remains stable after removing an asset', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Count+Parity+Remove+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'count-parity-remove-test';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(projectDir, 'b.txt'), 'b');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Count+Parity+Remove+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;

      // Add both assets
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[1].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Before remove: 2 project assets, both selected.
      let res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);
      expect(res.text).toContain('2 project assets match the current filters.');

      // Remove one asset
      await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Removing membership does not remove the project asset from the
      // collection.
      res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);
      expect(res.text).toContain('2 project assets match the current filters.');
    });
  });

  // ─── Phase 9-4: Mutation route HTTP tests ────────────────────────────

  describe('Phase 9-4 mutation route HTTP tests', () => {
    async function setupPhase94Release() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Phase+9-4+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'phase-9-4-test';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'alpha.txt'), 'alpha');
      fs.writeFileSync(path.join(projectDir, 'beta.txt'), 'beta');
      fs.writeFileSync(path.join(projectDir, 'gamma.txt'), 'gamma');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Phase+9-4+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      return { projectId, releaseLocation, releaseId, assetRepo, allAssets };
    }

    async function setupPhase94MoveRelease() {
      const fixture = await setupPhase94Release();
      const { project_id: projectId } = db.prepare('SELECT project_id FROM releases WHERE id = ?').get(fixture.releaseId);
      const projectDir = getProjectDir(projectsRoot, projectId, 'phase-9-4-test');

      fs.writeFileSync(path.join(projectDir, 'delta.txt'), 'delta');
      fs.writeFileSync(path.join(projectDir, 'epsilon.txt'), 'epsilon');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      return fixture;
    }

    async function setupPhase94SelectedRelease(assetCount) {
      const fixture = await setupPhase94Release();
      for (let index = 0; index < assetCount; index++) {
        await agent
          .post(`${fixture.releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${fixture.allAssets[index].id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      }
      return fixture;
    }

    // ── 1. Unexpected-error forwarding ─────────────────────────────────

    it('add route forwards unexpected errors to global handler (500)', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      // Create a stubbed releaseService that throws a plain Error on addCandidateAsset
      const realService = createReleaseService({ db });
      const stubbedService = Object.create(realService, {
        addCandidateAsset: {
          value() { throw new Error('Unexpected internal failure'); },
          writable: true,
        },
      });

      // Re-create app with the stubbed service
      const stubbedApp = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { releaseService: stubbedService, appDataRoot, authState: { csrfPepper: ensureAuthEnablement(appDataRoot).csrfPepper } });
      const { agent: stubbedAgent, csrfToken: stubbedCsrfToken } = await getDisabledModeCsrf(stubbedApp, appDataRoot);

      const res = await stubbedAgent
        .post(`${releaseLocation}/assets/add`)
        .send('_csrf=' + encodeURIComponent(stubbedCsrfToken))
        .send('assetId=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(500);

      // Must render the error page, not a generic fallthrough
      expect(res.text).toContain('Something went wrong');
      expect(res.text).not.toContain('Invalid asset ID');

      // No junction mutation occurred
      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    // ── Successful mutation tests ─────────────────────────────────────

    it('add route succeeds and redirects to asset page', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      const beforeRows = getReleaseAssets(db, releaseId);
      expect(beforeRows).toHaveLength(0);

      const res = await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toBe(`/releases/${releaseId}/assets`);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toHaveLength(1);
      expect(afterRows[0].asset_id).toBe(allAssets[0].id);
      expect(afterRows[0].role).toBe('attachment');
    });

    it('add route preserves candidate filters in redirect', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      const res = await agent
        .post(`${releaseLocation}/assets/add?search=alpha&pageSize=50`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Must preserve search and pageSize, omit page=1
      expect(res.headers.location).toBe(`/releases/${releaseId}/assets?search=alpha&pageSize=50`);
    });

    it('add route strips unknown parameters from redirect', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      const res = await agent
        .post(`${releaseLocation}/assets/add?unknown=param&junk=value`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toBe(`/releases/${releaseId}/assets`);
    });

    it('remove-selected route succeeds and redirects', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      // Add two assets first
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[1].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeRows = getReleaseAssets(db, releaseId);
      expect(beforeRows).toHaveLength(2);

      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toBe(`/releases/${releaseId}/assets`);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toHaveLength(1);
      expect(afterRows[0].asset_id).toBe(allAssets[1].id);
    });

    it('remove-selected route preserves candidate filters in redirect', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected?search=beta&extension=txt`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toBe(`/releases/${releaseId}/assets?search=beta&extension=txt`);
    });

    it('role route succeeds and redirects', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      // Add one asset
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=primary')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toBe(`/releases/${releaseId}/assets`);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toHaveLength(1);
      expect(afterRows[0].role).toBe('primary');
    });

    it('role route preserves candidate filters in redirect', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/role?search=gamma&pageSize=100`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=preview')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(res.headers.location).toBe(`/releases/${releaseId}/assets?search=gamma&pageSize=100`);
    });

    it('move-up route succeeds and preserves query state in redirect', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94MoveRelease();
      // Add two assets
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[1].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeRows = getReleaseAssets(db, releaseId);
      expect(beforeRows[0].asset_id).toBe(allAssets[0].id);
      expect(beforeRows[1].asset_id).toBe(allAssets[1].id);

      // P3-C4: page 2 at the supported size 10 needs more than 10 txt matches.
      const { project_id: moveProjectId } = db.prepare('SELECT project_id FROM releases WHERE id = ?').get(releaseId);
      const moveProjectDir = getProjectDir(projectsRoot, moveProjectId, 'phase-9-4-test');
      for (let index = 0; index < 12; index++) {
        fs.writeFileSync(path.join(moveProjectDir, `zz-pad-${String(index).padStart(2, '0')}.txt`), `pad ${index}`);
      }
      await agent.post(`/projects/${moveProjectId}/scan`)
        .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      // Move the second asset up
      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[1].id}/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .query({
          search: '  txt  ',
          extension: ' TXT ',
          selection: 'all',
          page: '2',
          pageSize: '10',
          unknown: 'discard-me',
        })
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const redirectUrl = new URL(res.headers.location, 'http://localhost');
      expect(redirectUrl.pathname).toBe(`/releases/${releaseId}/assets`);
      expect([...redirectUrl.searchParams.keys()].sort()).toEqual(['extension', 'page', 'pageSize', 'search', 'selection']);
      expect(redirectUrl.searchParams.get('selection')).toBe('all');
      expect(redirectUrl.searchParams.get('search')).toBe('txt');
      expect(redirectUrl.searchParams.get('extension')).toBe('txt');
      expect(redirectUrl.searchParams.get('page')).toBe('2');
      expect(redirectUrl.searchParams.get('pageSize')).toBe('10');
      expect(redirectUrl.searchParams.has('unknown')).toBe(false);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows[0].asset_id).toBe(allAssets[1].id);
      expect(afterRows[1].asset_id).toBe(allAssets[0].id);
    });

    it('move-down route succeeds and omits page=1 from redirect', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94MoveRelease();
      // Add two assets
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[1].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Move the first asset down
      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .query({
          search: '  txt  ',
          extension: ' TXT ',
          page: '1',
          pageSize: '10',
          unknown: 'discard-me',
        })
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const redirectUrl = new URL(res.headers.location, 'http://localhost');
      expect(redirectUrl.pathname).toBe(`/releases/${releaseId}/assets`);
      expect([...redirectUrl.searchParams.keys()].sort()).toEqual(['extension', 'pageSize', 'search']);
      expect(redirectUrl.searchParams.get('search')).toBe('txt');
      expect(redirectUrl.searchParams.get('extension')).toBe('txt');
      expect(redirectUrl.searchParams.get('pageSize')).toBe('10');
      expect(redirectUrl.searchParams.has('page')).toBe(false);
      expect(redirectUrl.searchParams.has('unknown')).toBe(false);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows[0].asset_id).toBe(allAssets[1].id);
      expect(afterRows[1].asset_id).toBe(allAssets[0].id);
    });

    // ── Validation/error tests ────────────────────────────────────────

    it('rejects malformed release ID with 404', async () => {
      await agent
        .post('/releases/abc/assets/add')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('assetId=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
    });

    const malformedReleaseIds = ['abc', '0', '-1', '1abc'];
    const malformedReleaseRouteCases = [
      {
        name: 'remove-selected',
        assetCount: 1,
        assetIndex: 0,
        path: (releaseId, assetId) => `/releases/${releaseId}/assets/${assetId}/remove-selected`,
        body: null,
      },
      {
        name: 'role',
        assetCount: 1,
        assetIndex: 0,
        path: (releaseId, assetId) => `/releases/${releaseId}/assets/${assetId}/role`,
        body: 'role=primary',
      },
      {
        name: 'move-up',
        assetCount: 2,
        assetIndex: 1,
        path: (releaseId, assetId) => `/releases/${releaseId}/assets/${assetId}/move-up`,
        body: null,
      },
      {
        name: 'move-down',
        assetCount: 2,
        assetIndex: 0,
        path: (releaseId, assetId) => `/releases/${releaseId}/assets/${assetId}/move-down`,
        body: null,
      },
    ];

    for (const routeCase of malformedReleaseRouteCases) {
      for (const malformedReleaseId of malformedReleaseIds) {
        it(`rejects malformed release ID ${malformedReleaseId} in ${routeCase.name} with 404`, async () => {
          const { releaseId, allAssets } = await setupPhase94SelectedRelease(routeCase.assetCount);
          const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
          const beforeJunction = getReleaseAssets(db, releaseId);

          let req = agent
            .post(routeCase.path(malformedReleaseId, allAssets[routeCase.assetIndex].id))
      .send('_csrf=' + encodeURIComponent(csrfToken))
            .set('Content-Type', 'application/x-www-form-urlencoded');
          if (routeCase.body) {
            req = req.send(routeCase.body);
          }

          const res = await req.expect(404);
          expect(res.text).not.toContain('Something went wrong');
          expect(db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId)).toEqual(beforeRelease);
          expect(getReleaseAssets(db, releaseId)).toEqual(beforeJunction);
        });
      }
    }

    it('rejects malformed asset ID in add with 422', async () => {
      const { releaseLocation } = await setupPhase94Release();
      const res = await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('assetId=abc')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('Invalid asset ID');
    });

    it('rejects malformed asset ID in remove-selected with 404', async () => {
      const { releaseLocation } = await setupPhase94Release();
      await agent
        .post(`${releaseLocation}/assets/abc/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
    });

    it('rejects malformed asset ID in role with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/abc/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=primary')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects zero asset ID in role with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/0/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=primary')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects negative asset ID in role with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/-1/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=primary')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects trailing-text asset ID in role with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/1abc/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=primary')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects malformed asset ID in move-up with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/abc/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects zero asset ID in move-up with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/0/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects negative asset ID in move-up with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/-1/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects trailing-text asset ID in move-up with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/1abc/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects malformed asset ID in move-down with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/abc/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects zero asset ID in move-down with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/0/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects negative asset ID in move-down with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/-1/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects trailing-text asset ID in move-down with 404', async () => {
      const { releaseLocation, releaseId } = await setupPhase94Release();
      const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const beforeJunction = getReleaseAssets(db, releaseId);

      const res = await agent
        .post(`${releaseLocation}/assets/1abc/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
      expect(res.text).not.toContain('Something went wrong');

      const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
      const afterJunction = getReleaseAssets(db, releaseId);
      expect(afterRelease).toEqual(beforeRelease);
      expect(afterJunction).toEqual(beforeJunction);
    });

    it('rejects invalid role with 422', async () => {
      const { releaseLocation, allAssets } = await setupPhase94Release();
      // Add an asset first
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('role=invalid_role')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('primary');
    });

    it('rejects unselected target in remove-selected with 422', async () => {
      const { releaseLocation, allAssets } = await setupPhase94Release();
      const res = await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('not selected');
    });

    it('rejects cross-project target with 422', async () => {
      const { releaseLocation } = await setupPhase94Release();
      // Create another project with an asset
      const projRes2 = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cross+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId2 = projRes2.headers.location.replace('/projects/', '');
      const slug2 = 'cross-project';
      const projectDir2 = getProjectDir(projectsRoot, projectId2, slug2);
      fs.writeFileSync(path.join(projectDir2, 'cross.txt'), 'cross');
      await agent.post(`/projects/${projectId2}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
      const assetRepo2 = createAssetRepository(db);
      const otherAssets = assetRepo2.findByProjectId(Number(projectId2));

      const res = await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${otherAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('does not belong');
    });

    it('rejects missing candidate with 404', async () => {
      const { releaseLocation } = await setupPhase94Release();
      const res = await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('assetId=99999')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
    });

    it('rejects already-selected candidate with 422', async () => {
      const { releaseLocation, allAssets } = await setupPhase94Release();
      // Add the asset once
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Try to add again
      const res = await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain('already selected');
    });

    it('boundary move-up on first item is a no-op', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      // Add two assets
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[1].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeRows = getReleaseAssets(db, releaseId);

      // Move first item up — should be a no-op
      await agent
        .post(`${releaseLocation}/assets/${allAssets[0].id}/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toEqual(beforeRows);
    });

    it('boundary move-down on last item is a no-op', async () => {
      const { releaseLocation, releaseId, allAssets } = await setupPhase94Release();
      // Add two assets
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[0].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`assetId=${allAssets[1].id}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const beforeRows = getReleaseAssets(db, releaseId);

      // Move last item down — should be a no-op
      await agent
        .post(`${releaseLocation}/assets/${allAssets[1].id}/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const afterRows = getReleaseAssets(db, releaseId);
      expect(afterRows).toEqual(beforeRows);
    });

    // ── Lifecycle HTTP matrix ─────────────────────────────────────────

    async function setupReleaseWithTwoAssets() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Lifecycle+Matrix+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'lifecycle-matrix-test';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(projectDir, 'b.txt'), 'b');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Lifecycle+Matrix+Release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      setProjectStatusForReleaseTest(db, releaseLocation, 'ready');

      // Select both assets
      await agent
        .post(releaseLocation + '/assets')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${allAssets[0].id}`)
        .send(`selectedAssetIds[]=${allAssets[1].id}`)
        .send('roles[]=primary')
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .send('sortOrder[]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return { projectId, releaseLocation, releaseId, assetRepo, allAssets };
    }

    describe('lifecycle matrix — published release', () => {
      async function setupPublishedRelease() {
        const ctx = await setupReleaseWithTwoAssets();
        await agent
          .post(`${ctx.releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('publishedDate=2025-06-15')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        return ctx;
      }

      it('add returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupPublishedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${allAssets[0].id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('remove-selected returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupPublishedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('role returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupPublishedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('role=preview')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('move-up returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupPublishedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('move-down returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupPublishedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });
    });

    describe('lifecycle matrix — archived release', () => {
      async function setupArchivedRelease() {
        const ctx = await setupReleaseWithTwoAssets();
        await agent
          .post(`${ctx.releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);
        return ctx;
      }

      it('add returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${allAssets[0].id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('remove-selected returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('role returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('role=preview')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('move-up returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('move-down returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });
    });

    describe('lifecycle matrix — archived parent', () => {
      async function setupArchivedParentRelease() {
        const ctx = await setupReleaseWithTwoAssets();
        await agent
          .post(`/projects/${ctx.projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);
        return ctx;
      }

      it('add returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedParentRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/add`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`assetId=${allAssets[0].id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('remove-selected returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedParentRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/remove-selected`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('role returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedParentRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/role`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('role=preview')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('move-up returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedParentRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/move-up`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });

      it('move-down returns 422 and preserves release and junction rows', async () => {
        const { releaseLocation, releaseId, allAssets } = await setupArchivedParentRelease();
        const beforeRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const beforeJunction = getReleaseAssets(db, releaseId);

        const res = await agent
          .post(`${releaseLocation}/assets/${allAssets[0].id}/move-down`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);

        expect(res.text).not.toContain('Something went wrong');
        const afterRelease = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
        const afterJunction = getReleaseAssets(db, releaseId);
        expect(afterRelease).toEqual(beforeRelease);
        expect(afterJunction).toEqual(beforeJunction);
      });
    });

    // ── Candidate URL tests ───────────────────────────────────────────

    describe('candidate URL tests', () => {
      // P3-C4: opt-in zz-pad-NN.txt fillers (sorted last) so the supported
      // size 10 still paginates.
      async function setupReleaseWithAssets({ fillers = 0 } = {}) {
        const projRes = await agent
          .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('title=Candidate+URL+Test')
          .send('status=tbd')
          .send('priority=normal')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        const projectId = projRes.headers.location.replace('/projects/', '');

        const slug = 'candidate-url-test';
        const projectDir = getProjectDir(projectsRoot, projectId, slug);
        fs.writeFileSync(path.join(projectDir, 'alpha.txt'), 'alpha');
        fs.writeFileSync(path.join(projectDir, 'beta.txt'), 'beta');
        fs.writeFileSync(path.join(projectDir, 'gamma.txt'), 'gamma');
        fs.writeFileSync(path.join(projectDir, 'delta.txt'), 'delta');
        for (let index = 0; index < fillers; index++) {
          fs.writeFileSync(path.join(projectDir, `zz-pad-${String(index).padStart(2, '0')}.txt`), `pad ${index}`);
        }
        await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

        const assetRepo = createAssetRepository(db);
        const allAssets = assetRepo.findByProjectId(Number(projectId));

        const createRes = await agent
          .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`projectId=${projectId}`)
          .send('title=Candidate+URL+Release')
          .send('status=tbd')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
        const releaseLocation = createRes.headers.location;
        const releaseId = Number(releaseLocation.replace('/releases/', ''));

        return { projectId, releaseLocation, releaseId, assetRepo, allAssets };
      }

      /**
       * Parse an anchor href by its text content from HTML.
       * Unescapes HTML entities (&amp; → &) so URL parsing works.
       * Returns a URL object or null.
       */
      function parseLinkByText(html, linkText) {
        const re = new RegExp(`href="([^"]*)"[^>]*>${linkText}<`);
        const m = html.match(re);
        if (!m) return null;
        try {
          const decoded = m[1].replace(/&amp;/g, '&');
          return new URL(decoded, 'http://localhost');
        } catch {
          return null;
        }
      }

      function releaseAssetsLiveRegion(html) {
        const start = html.indexOf('<section data-release-assets-live-region>');
        const end = html.indexOf('</main>', start);
        return start < 0 || end < 0 ? '' : html.slice(start, end);
      }

      it('renders Release Assets filters in the established external live dialog', async () => {
        const { releaseLocation } = await setupReleaseWithAssets({ fillers: 16 });
        const res = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=10`).expect(200);
        const region = releaseAssetsLiveRegion(res.text);
        const filterDialog = res.text.match(/<dialog id="release-assets-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';

        expect(region).toContain('data-release-assets-live-status');
        expect(region).toContain('class="results-meta release-asset-results-meta"');
        expect(region).toContain('href="#release-assets-filter-dialog" aria-label="Filter assets"');
        expect(region).toContain('data-dialog-open="release-assets-filter-dialog"');
        expect(region).not.toContain('data-release-assets-live-filter');
        expect(filterDialog).toContain('aria-labelledby="release-assets-filter-dialog-title"');
        expect(filterDialog).toContain('data-dialog-close aria-label="Close Filter"');
        expect(filterDialog).toContain('id="release-assets-filter"');
        expect(filterDialog).toContain('class="app-dialog-form project-form release-assets-filter-dialog-form"');
        expect(filterDialog).toContain('data-release-assets-live-filter');
        expect(filterDialog).toContain('data-release-assets-live-search');
        expect(filterDialog).toContain('data-release-assets-live-filter-control');
        expect(filterDialog).toContain('data-release-assets-live-page-size');
        expect(filterDialog).not.toMatch(/>\s*(?:Cancel|Save|Apply)\s*</);
        expect(region).toContain('class="view-switcher"');
        expect(region).toContain('class="pagination"');
        expect(region).toContain('class="page-size-form" method="get" action="/releases/');
        expect(region).toContain('data-release-assets-live-page-size-form');
        expect(region).toContain('data-release-assets-live-page-size');
        expect(region).toContain('<noscript><button class="button button-small" type="submit">Apply</button></noscript>');
        expect(region.replace(/<noscript>[\s\S]*?<\/noscript>/g, '')).not.toContain('>Apply</button>');
        expect(res.text.indexOf('page-heading-navigation--text')).toBeGreaterThan(-1);
        expect(res.text.indexOf('page-heading-navigation--text')).toBeLessThan(res.text.indexOf(region));

        const filtered = await agent.get(`${releaseLocation}/assets?selection=all&search=alpha`).expect(200);
        const filteredDialog = filtered.text.match(/<dialog id="release-assets-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
        expect(filteredDialog).toContain('data-release-assets-reset>Clear</a>');
        expect(releaseAssetsLiveRegion(filtered.text)).not.toContain('data-release-assets-reset');
      });

      it('round-trips 150, 200, and all through both selectors and view URLs', async () => {
        const { releaseLocation } = await setupReleaseWithAssets();

        for (const pageSize of ['150', '200', 'all']) {
          const res = await agent.get(`${releaseLocation}/assets?page=99&pageSize=${pageSize}`).expect(200);
          const filterSelect = sliceSelect(res.text, 'asset-page-size');
          const footerSelect = sliceSelect(res.text, 'pageSize');

          expect(filterSelect).toMatch(new RegExp(`<option value="${pageSize}"\\s+selected>`));
          expect(footerSelect).toMatch(new RegExp(`<option value="${pageSize}"\\s+selected>`));
          expect(res.text).toContain(`pageSize=${pageSize}`);
        }
      });

      describe('WP16 page-size consistency', () => {
        const PAGE_SIZE_OPTIONS = ['10', '25', '50', '100', '150', '200', 'all'];

        async function setupLargeRelease() {
          const projRes = await agent
            .post('/projects')
            .send('_csrf=' + encodeURIComponent(csrfToken))
            .send('title=Release+Pagination+Sizes')
            .send('status=tbd')
            .send('priority=normal')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .expect(302);
          const projectId = projRes.headers.location.replace('/projects/', '');
          const projectDir = getProjectDir(projectsRoot, projectId, 'release-pagination-sizes');
          for (let index = 1; index <= 27; index += 1) {
            fs.writeFileSync(path.join(projectDir, `clip-${String(index).padStart(2, '0')}.txt`), `clip ${index}`);
          }
          for (let index = 1; index <= 3; index += 1) {
            fs.writeFileSync(path.join(projectDir, `note-${index}.md`), `note ${index}`);
          }
          await agent.post(`/projects/${projectId}/scan`)
            .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
          const allAssets = createAssetRepository(db).findByProjectId(Number(projectId));
          const createRes = await agent
            .post('/releases')
            .send('_csrf=' + encodeURIComponent(csrfToken))
            .send(`projectId=${projectId}`)
            .send('title=WP16+Release')
            .send('status=tbd')
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .expect(302);
          const releaseLocation = createRes.headers.location;
          return { releaseLocation, releaseId: Number(releaseLocation.replace('/releases/', '')), allAssets };
        }

        function visibleAssetIds(html) {
          return [...getAssetCollection(html).matchAll(/id="release-asset-select-(\d+)"/g)].map(([, id]) => Number(id));
        }

        function selectedSizes(html) {
          const selected = (id) => sliceSelect(html, id).match(/<option value="([^"]*)"\s+selected>/)?.[1] ?? null;
          return { dialog: selected('asset-page-size'), pagination: selected('pageSize') };
        }

        function pageInfo(html) {
          return releaseAssetsLiveRegion(html).match(/class="pagination-info">Page (\d+) of (\d+)</)?.slice(1).map(Number) || null;
        }

        it('agrees on rows, totals, pages and real IDs for every size, the 25 fallback and View All', async () => {
          const { releaseLocation, allAssets } = await setupLargeRelease();
          const everyId = allAssets.map((asset) => asset.id).sort((a, b) => a - b);
          expect(everyId).toHaveLength(30);

          const fallback = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);
          expect(selectedSizes(fallback.text)).toEqual({ dialog: '25', pagination: '25' });
          expect(visibleAssetIds(fallback.text)).toHaveLength(25);
          expect(pageInfo(fallback.text)).toEqual([1, 2]);

          for (const size of PAGE_SIZE_OPTIONS.filter((value) => value !== 'all')) {
            const pageSize = Number(size);
            const pageCount = Math.ceil(30 / pageSize);
            const seen = [];
            for (let page = 1; page <= pageCount; page += 1) {
              const res = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=${size}&page=${page}`).expect(200);
              const ids = visibleAssetIds(res.text);
              expect(selectedSizes(res.text)).toEqual({ dialog: size, pagination: size });
              expect(releaseAssetsLiveRegion(res.text)).toContain('30 project assets match the current filters.');
              expect(ids).toHaveLength(Math.min(pageSize, 30 - (page - 1) * pageSize));
              expect(pageInfo(res.text)).toEqual(pageCount > 1 ? [page, pageCount] : null);
              seen.push(...ids);
            }
            // No duplicate or missing assets across the pages of one size.
            expect(new Set(seen).size).toBe(seen.length);
            expect([...seen].sort((a, b) => a - b)).toEqual(everyId);
          }

          const all = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=all&page=3`).expect(200);
          expect(selectedSizes(all.text)).toEqual({ dialog: 'all', pagination: 'all' });
          expect([...visibleAssetIds(all.text)].sort((a, b) => a - b)).toEqual(everyId);
          expect(pageInfo(all.text)).toBeNull();

          // Returning from View All to a paginated size starts on a real page.
          const back = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=10`).expect(200);
          expect(pageInfo(back.text)).toEqual([1, 3]);
          expect(visibleAssetIds(back.text)).toHaveLength(10);
        });

        // P3-C4: an unsupported pageSize used to query and render that many
        // rows while neither control could show it (both fell to 10). Only
        // the supported catalogue is honoured now; anything else is the
        // default 25 for the query, the metadata, both controls and every
        // generated URL, which then leave the implicit 25 out.
        it('P3-C4: renders an unsupported, malformed or repeated pageSize at the effective 25 everywhere', async () => {
          const { releaseLocation, releaseId, allAssets } = await setupLargeRelease();
          expect(allAssets).toHaveLength(30);
          const reference = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=25`).expect(200);
          const referenceTwo = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=25&page=2`).expect(200);
          const firstPage = visibleAssetIds(reference.text);
          const secondPage = visibleAssetIds(referenceTwo.text);
          expect(firstPage).toHaveLength(25);
          expect(secondPage).toHaveLength(5);

          const unsupported = [
            '7', '15', '11', '24', '26', '201', '999999', '0', '-1', 'abc', '1.5', '010', '', 'ALL', 'All', '%20all',
            '7&pageSize=15', '50&pageSize=10', '10&pageSize=abc', 'all&pageSize=all',
          ];
          for (const raw of unsupported) {
            const label = `pageSize=${raw}`;
            const res = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=${raw}`).expect(200);
            const region = releaseAssetsLiveRegion(res.text);
            expect(selectedSizes(res.text), label).toEqual({ dialog: '25', pagination: '25' });
            expect(visibleAssetIds(res.text), label).toEqual(firstPage);
            expect(region, label).toContain('30 project assets match the current filters.');
            expect(pageInfo(res.text), label).toEqual([1, 2]);

            const next = parseLinkByText(res.text, 'Next');
            expect(next.pathname, label).toBe(`/releases/${releaseId}/assets`);
            expect([...next.searchParams.entries()], label).toEqual([['selection', 'all'], ['page', '2']]);
            for (const view of ['Grid', 'List']) {
              const href = region.match(new RegExp(`href="([^"]*)"[^>]*aria-label="${view} view"`))?.[1];
              expect(href, `${label} ${view}`).toBeDefined();
              expect(new URL(href.replace(/&amp;/g, '&'), 'http://localhost').searchParams.has('pageSize'), `${label} ${view}`).toBe(false);
            }
            const clear = res.text.match(/href="([^"]*)"[^>]*data-release-assets-reset/)?.[1];
            expect(clear, label).toBeDefined();
            expect(new URL(clear.replace(/&amp;/g, '&'), 'http://localhost').searchParams.has('pageSize'), label).toBe(false);
            expect(res.text, label).toContain(`<form id="release-assets-form" method="post" action="/releases/${releaseId}/assets?selection=all"`);
            expect(res.text, label).not.toMatch(/name="pageSize" value="(?!25")/);

            const pageTwo = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=${raw}&page=2`).expect(200);
            expect(visibleAssetIds(pageTwo.text), label).toEqual(secondPage);
            expect(pageInfo(pageTwo.text), label).toEqual([2, 2]);
            const clamped = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=${raw}&page=99`).expect(200);
            expect(visibleAssetIds(clamped.text), label).toEqual(secondPage);
          }

          // Grid and List render the same effective rows.
          for (const view of ['grid', 'list']) {
            const res = await agent.get(`${releaseLocation}/assets?selection=all&view=${view}&pageSize=7`).expect(200);
            expect(selectedSizes(res.text), view).toEqual({ dialog: '25', pagination: '25' });
            const regionIds = [...new Set([...releaseAssetsLiveRegion(res.text).matchAll(/id="release-asset-select-(\d+)"/g)]
              .map(([, id]) => Number(id)))];
            expect(regionIds, view).toEqual(firstPage);
          }

          // Saved-selected (the default Selection) uses the same effective size.
          const save = await agent
            .post(`${releaseLocation}/assets`)
            .send('_csrf=' + encodeURIComponent(csrfToken))
            .send(allAssets.map((asset) => `selectedAssetIds[]=${asset.id}`).join('&'))
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .expect(302);
          expect(save.headers.location).toBeDefined();
          const membership = getReleaseAssets(db, releaseId).map((row) => row.asset_id);
          expect([...membership].sort((a, b) => a - b)).toEqual(allAssets.map((asset) => asset.id).sort((a, b) => a - b));
          for (const raw of ['7', '15', '999999']) {
            const saved = await agent.get(`${releaseLocation}/assets?pageSize=${raw}`).expect(200);
            expect(selectedSizes(saved.text), raw).toEqual({ dialog: '25', pagination: '25' });
            expect(visibleAssetIds(saved.text), raw).toHaveLength(25);
            expect(releaseAssetsLiveRegion(saved.text), raw).toContain('30 selected assets match the current filters.');
            expect(pageInfo(saved.text), raw).toEqual([1, 2]);
          }

          // Every supported size, and View All, is still honoured as asked.
          for (const size of PAGE_SIZE_OPTIONS) {
            const res = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=${size}`).expect(200);
            expect(selectedSizes(res.text), size).toEqual({ dialog: size, pagination: size });
            expect(visibleAssetIds(res.text), size).toHaveLength(size === 'all' ? 30 : Math.min(Number(size), 30));
          }
        }, 30000);

        it('clamps a later or out-of-range page to the last real page of the requested size', async () => {
          const { releaseLocation } = await setupLargeRelease();
          const lastOfTen = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=10&page=3`).expect(200);
          const outOfRange = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=10&page=99`).expect(200);
          expect(pageInfo(outOfRange.text)).toEqual([3, 3]);
          expect(visibleAssetIds(outOfRange.text)).toEqual(visibleAssetIds(lastOfTen.text));

          // Page 3 of size 10 asked at size 25 resolves to page 2 (5 rows), not an empty page.
          const resized = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=25&page=3`).expect(200);
          expect(pageInfo(resized.text)).toEqual([2, 2]);
          expect(visibleAssetIds(resized.text)).toHaveLength(5);
          expect(selectedSizes(resized.text)).toEqual({ dialog: '25', pagination: '25' });
          const previous = parseLinkByText(resized.text, 'Previous');
          expect(previous.searchParams.has('page')).toBe(false);
          expect(previous.searchParams.has('pageSize')).toBe(false);
        });

        it('combines filters with a size, keeps both controls and the URL in step, and shows an empty match', async () => {
          const { releaseLocation, allAssets } = await setupLargeRelease();
          const noteIds = allAssets.filter((asset) => asset.filename.startsWith('note-')).map((asset) => asset.id).sort((a, b) => a - b);
          const res = await agent.get(`${releaseLocation}/assets?selection=all&extension=md&search=note&view=list&pageSize=10`).expect(200);
          expect(selectedSizes(res.text)).toEqual({ dialog: '10', pagination: '10' });
          expect(releaseAssetsLiveRegion(res.text)).toContain('3 project assets match the current filters.');
          const pageSizeForm = res.text.match(/<form class="page-size-form"[\s\S]*?<\/form>/)?.[0] || '';
          expect([...pageSizeForm.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, name, value]) => [name, value]))
            .toEqual([['search', 'note'], ['extension', 'md'], ['selection', 'all'], ['view', 'list']]);
          const listIds = [...res.text.matchAll(/id="release-asset-select-(\d+)"/g)].map(([, id]) => Number(id)).sort((a, b) => a - b);
          expect(listIds).toEqual(noteIds);

          const empty = await agent.get(`${releaseLocation}/assets?selection=all&search=zzz-nothing&pageSize=10&page=4`).expect(200);
          expect(selectedSizes(empty.text)).toEqual({ dialog: '10', pagination: '10' });
          expect(releaseAssetsLiveRegion(empty.text)).toContain('0 project assets match the current filters.');
          expect(releaseAssetsLiveRegion(empty.text)).not.toContain('class="pagination"');
          expect(visibleAssetIds(empty.text)).toEqual([]);
        });

        it('Clear keeps size and View, restores saved-selected, and never saves membership or defaults', async () => {
          const { releaseLocation, releaseId, allAssets } = await setupLargeRelease();
          const saved = allAssets.filter((asset) => /clip-0[1-3]\.txt/.test(asset.filename)).map((asset) => asset.id);
          const save = agent
            .post(`${releaseLocation}/assets`)
            .send('_csrf=' + encodeURIComponent(csrfToken))
            .set('Content-Type', 'application/x-www-form-urlencoded');
          saved.forEach((id) => save.send(`selectedAssetIds[]=${id}`));
          await save.expect(302);
          const membershipBefore = getReleaseAssets(db, releaseId);
          const defaultsSnapshot = () => ({
            meta: db.prepare('SELECT key, value FROM app_meta ORDER BY key').all(),
            project: db.prepare('SELECT * FROM project_page_defaults').all(),
            scopes: db.prepare('SELECT * FROM project_page_default_scopes').all(),
          });
          const defaultsBefore = defaultsSnapshot();

          const res = await agent.get(`${releaseLocation}/assets?selection=all&extension=md&search=note&view=list&pageSize=10`).expect(200);
          const filterDialog = res.text.match(/<dialog id="release-assets-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
          // Filter-only: no saved-default actions, badges or scope.
          expect(filterDialog).not.toMatch(/Save defaults|Reset filters|Reset defaults|data-defaults|data-page-defaults|name="scope"/);
          expect([...filterDialog.matchAll(/<label[^>]*>([^<]+)<\/label>/g)].map(([, label]) => label.trim()))
            .toContain('Find project assets');
          const clearHref = filterDialog.match(/href="([^"]*)"[^>]*data-release-assets-reset/)?.[1].replace(/&amp;/g, '&');
          const clear = new URL(clearHref, 'http://localhost');
          expect([...clear.searchParams.entries()]).toEqual([['pageSize', '10'], ['view', 'list']]);

          const cleared = await agent.get(`${clear.pathname}${clear.search}`).expect(200);
          expect(selectedSizes(cleared.text)).toEqual({ dialog: '10', pagination: '10' });
          expect(releaseAssetsLiveRegion(cleared.text)).toContain('3 selected assets match the current filters.');
          expect([...cleared.text.matchAll(/id="release-asset-select-(\d+)"/g)].map(([, id]) => Number(id)).sort((a, b) => a - b))
            .toEqual([...saved].sort((a, b) => a - b));
          expect(cleared.text).toContain('data-release-assets-selection-notice');

          expect(getReleaseAssets(db, releaseId)).toEqual(membershipBefore);
          expect(defaultsSnapshot()).toEqual(defaultsBefore);
        });
      });

      it('keeps all canonical while filtering and clearing, with real totals and no slicing', async () => {
        const { releaseLocation, allAssets } = await setupReleaseWithAssets();
        const res = await agent.get(`${releaseLocation}/assets?selection=all&search=a&page=99&pageSize=all`).expect(200);
        const region = releaseAssetsLiveRegion(res.text);
        const filterDialog = res.text.match(/<dialog id="release-assets-filter-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
        const clearHref = filterDialog.match(/href="([^"]*)"[^>]*data-release-assets-reset/)?.[1]
          .replace(/&amp;/g, '&');

        expect(region).toContain(`${allAssets.length} project assets match the current filters.`);
        expect(getCandidateTiles(res.text)).toHaveLength(allAssets.length);
        expect(region).not.toContain('class="pagination"');
        expect(new URL(clearHref, 'http://localhost').searchParams.get('pageSize')).toBe('all');
        expect(new URL(clearHref, 'http://localhost').searchParams.has('page')).toBe(false);
      });

      it('renders controls, then one filtered count, then grid, list, or empty results', async () => {
        const { releaseLocation } = await setupReleaseWithAssets();
        const responses = [
          { response: await agent.get(`${releaseLocation}/assets?selection=all`).expect(200), resultMarker: '<ul class="asset-grid"' },
          { response: await agent.get(`${releaseLocation}/assets?selection=all&view=list`).expect(200), resultMarker: '<ul class="asset-list' },
          { response: await agent.get(`${releaseLocation}/assets?selection=all&search=no-match`).expect(200), resultMarker: '<div class="empty-state"' },
        ];

        for (const { response, resultMarker } of responses) {
          const region = releaseAssetsLiveRegion(response.text);
          const controlsPosition = region.indexOf('class="asset-viewer-display-controls"');
          const countPosition = region.indexOf('class="results-meta release-asset-results-meta"');
          const resultPosition = region.indexOf(resultMarker);

          expect((region.match(/class="results-meta release-asset-results-meta"/g) || [])).toHaveLength(1);
          expect(controlsPosition).toBeGreaterThan(-1);
          expect(countPosition).toBeGreaterThan(controlsPosition);
          expect(resultPosition).toBeGreaterThan(countPosition);
        }
      });

      it('Next link pathname and query on page 1', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets({ fillers: 36 });
        const res = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=10`).expect(200);

        const url = parseLinkByText(res.text, 'Next');
        expect(url).not.toBeNull();
        expect(url.pathname).toBe(`/releases/${releaseId}/assets`);
        expect(url.searchParams.get('page')).toBe('2');
        expect(url.searchParams.get('pageSize')).toBe('10');
        expect([...url.searchParams.keys()].sort()).toEqual(['page', 'pageSize', 'selection']);
      });

      it('Previous link on page 2 omits page=1', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets({ fillers: 36 });
        const res = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=10&page=2`).expect(200);

        const url = parseLinkByText(res.text, 'Previous');
        expect(url).not.toBeNull();
        expect(url.pathname).toBe(`/releases/${releaseId}/assets`);
        expect(url.searchParams.get('pageSize')).toBe('10');
        // page=1 is omitted
        expect(url.searchParams.has('page')).toBe(false);
        expect([...url.searchParams.keys()].sort()).toEqual(['pageSize', 'selection']);
      });

      it('Next link on page 2 preserves page=2', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets({ fillers: 36 });
        const res = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=10&page=2`).expect(200);

        const url = parseLinkByText(res.text, 'Next');
        expect(url).not.toBeNull();
        expect(url.pathname).toBe(`/releases/${releaseId}/assets`);
        expect(url.searchParams.get('page')).toBe('3');
        expect(url.searchParams.get('pageSize')).toBe('10');
        expect([...url.searchParams.keys()].sort()).toEqual(['page', 'pageSize', 'selection']);
      });

      it('page 1 is omitted from pagination URLs', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets({ fillers: 36 });
        const res = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=10`).expect(200);

        const url = parseLinkByText(res.text, 'Next');
        expect(url).not.toBeNull();
        expect(url.pathname).toBe(`/releases/${releaseId}/assets`);
        expect(url.searchParams.get('page')).toBe('2');
        expect(url.searchParams.has('pageSize')).toBe(true);
        // No page=1 anywhere
        expect(url.searchParams.get('page')).not.toBe('1');
      });

      it('search and extension filters are preserved in pagination URLs', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets({ fillers: 36 });
        // P3-C4: extension=txt matches all 40 files, pageSize=10 → 4 pages
        const res = await agent.get(`${releaseLocation}/assets?selection=all&extension=txt&pageSize=10`).expect(200);

        const url = parseLinkByText(res.text, 'Next');
        expect(url).not.toBeNull();
        expect(url.pathname).toBe(`/releases/${releaseId}/assets`);
        expect(url.searchParams.get('extension')).toBe('txt');
        expect(url.searchParams.get('page')).toBe('2');
        expect(url.searchParams.get('pageSize')).toBe('10');
        expect([...url.searchParams.keys()].sort()).toEqual(['extension', 'page', 'pageSize', 'selection']);
      });

      it('unknown parameters are stripped from generated URLs', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets({ fillers: 36 });
        const res = await agent.get(`${releaseLocation}/assets?selection=all&unknown=param&junk=value&pageSize=10`).expect(200);

        const url = parseLinkByText(res.text, 'Next');
        expect(url).not.toBeNull();
        expect(url.pathname).toBe(`/releases/${releaseId}/assets`);
        // Must not contain unknown or junk
        expect(url.searchParams.has('unknown')).toBe(false);
        expect(url.searchParams.has('junk')).toBe(false);
        // Must still have pageSize and page
        expect(url.searchParams.get('pageSize')).toBe('10');
        expect(url.searchParams.get('page')).toBe('2');
        expect([...url.searchParams.keys()].sort()).toEqual(['page', 'pageSize', 'selection']);
      });

      it('page beyond final page clamps and renders canonical links', async () => {
        const { releaseLocation, releaseId } = await setupReleaseWithAssets({ fillers: 36 });
        // P3-C4: 40 files, pageSize=10 → 4 pages. Request page=999 → clamped to page 4.
        const res = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=10&page=999`).expect(200);

        // Displayed page is the clamped page
        expect(res.text).toContain('Page 4 of 4');

        // Previous link should point to page 3 (clamped from 999)
        const prevUrl = parseLinkByText(res.text, 'Previous');
        expect(prevUrl).not.toBeNull();
        expect(prevUrl.pathname).toBe(`/releases/${releaseId}/assets`);
        expect(prevUrl.searchParams.get('page')).toBe('3');
        expect(prevUrl.searchParams.get('pageSize')).toBe('10');
        expect([...prevUrl.searchParams.keys()].sort()).toEqual(['page', 'pageSize', 'selection']);

        // No Next link on the final page
        const nextUrl = parseLinkByText(res.text, 'Next');
        expect(nextUrl).toBeNull();

        // No link carries the unbounded requested page
        expect(res.text).not.toContain('page=999');
      });
    });
  });

  // Shared helpers for the unified release asset collection.
  function getAssetCollection(html) {
    return html.match(/<ul class="asset-(?:grid|list)(?: asset-list--release)?"[^>]*>[\s\S]*?<\/ul>/)?.[0] || '';
  }

  function getCandidateSection(html) {
    return getAssetCollection(html);
  }

  function getCandidateTiles(html) {
    return getAssetCollection(html).match(/<li class="asset-(?:grid|list)-item[^>]*>[\s\S]*?<\/li>/g) || [];
  }

  function getCandidateTile(html, filename) {
    return getCandidateTiles(html).find((tile) => tile.includes(filename)) || '';
  }

  function getBulkSelectionSection(html) {
    return getAssetCollection(html);
  }

  function getCheckedBulkAssetIds(html) {
    return [...getBulkSelectionSection(html).matchAll(
      /<input[^>]*id="release-asset-select-(\d+)"[^>]*\bchecked\b[^>]*>/g,
    )].map((match) => Number(match[1]));
  }

  function filterDisclosureHtml(html, optionsId) {
    return (html.match(/<details class="asset-filter-multiselect[^>]*>[\s\S]*?<\/details>/g) || [])
      .find((candidate) => candidate.includes(`aria-controls="${optionsId}"`)) || '';
  }

  function selectedFilterValueAllowEmpty(html, optionsId, inputName) {
    const disclosure = filterDisclosureHtml(html, optionsId);
    if (!disclosure) throw new Error(`Filter disclosure ${optionsId} was not rendered.`);
    const input = disclosure.match(new RegExp(`<input[^>]*name="${inputName}"[^>]*\\bchecked\\b[^>]*>`))?.[0];
    return input?.match(/value="([^"]*)"/)?.[1];
  }

  function insertProjectCategory(db, projectId, displayName, directorySlug, displayOrder) {
    return db.prepare(`
      INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
      VALUES (?, ?, ?, ?, 1)
      RETURNING id
    `).get(projectId, displayName, directorySlug, displayOrder);
  }

  // ─── Category filter control ───────────────────────────────────────────────

  describe('read-only Manage Assets query contract (B-F1)', () => {
    const READ_ONLY_HTTP_STATES = [
      ['published release',
        ({ releaseId }) => db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(releaseId),
        'This release is published. Asset selections are locked and read-only.'],
      ['archived release',
        ({ releaseId }) => db.prepare("UPDATE releases SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(releaseId),
        'This release is archived. Asset selections are read-only.'],
      ['archived parent project',
        ({ projectId }) => db.prepare("UPDATE projects SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(projectId),
        'The parent project is archived. Asset selections are read-only.'],
    ];

    // Record every real SQL execution on this connection, including
    // statements the app prepared at construction, by wrapping the
    // better-sqlite3 Statement prototype for the duration of one request.
    function instrumentSqlExecution() {
      const proto = Object.getPrototypeOf(db.prepare('SELECT 1'));
      const originals = {};
      const log = [];
      for (const method of ['all', 'get', 'run', 'iterate']) {
        originals[method] = proto[method];
        proto[method] = function execute(...args) {
          const result = originals[method].apply(this, args);
          const rows = method === 'all' ? result : (method === 'get' && result !== undefined ? [result] : []);
          log.push({
            sql: this.source.replace(/\s+/g, ' ').trim(),
            method,
            args,
            rows: rows.length,
            metadataRows: rows.filter((row) => row && typeof row === 'object' && 'filename' in row).length,
          });
          return result;
        };
      }
      return {
        log,
        restore: () => { for (const [method, fn] of Object.entries(originals)) proto[method] = fn; },
      };
    }

    const isEditablePageSql = (entry) => entry.sql.includes('is_saved_member') || entry.sql.includes('AS candidate_total');
    const isSavedCollectionSql = (entry) => entry.sql.startsWith('SELECT ra.release_id, ra.asset_id, ra.role, ra.sort_order, ra.created_at, a.project_id');
    const isMembershipWrite = (entry) => entry.method === 'run' && /\b(INSERT|UPDATE|DELETE)\b[\s\S]*\b(release_assets|releases|assets)\b/i.test(entry.sql);

    // 10,000 assets (alternating PNG/TXT), 400 saved members spread across the
    // project in stored order that is the reverse of ID order. The saved IDs,
    // roles and order are known independently of the service.
    async function buildLargeReadOnlyFixture() {
      const projectId = await createTestProject('B-F1 Read-only Scale');
      const rows = [];
      for (let index = 0; index < 10000; index += 1) {
        const png = index % 2 === 0;
        const filename = `${png ? 'img' : 'doc'}-${String(index).padStart(5, '0')}.${png ? 'png' : 'txt'}`;
        rows.push({
          relativePath: filename, filename, extension: png ? 'png' : 'txt',
          mimeType: png ? 'image/png' : 'text/plain', sizeBytes: 100, modifiedAt: '2025-01-01T00:00:00Z',
        });
      }
      const assets = createAssetRepository(db).upsertMany(projectId, rows);
      const release = createReleaseService({ db }).createRelease(projectId, {
        title: 'B-F1 Read-only', description: '', notes: '', plannedDate: null, patreonUrl: null,
      });
      const saved = Array.from({ length: 400 }, (_, index) => assets[index * 25]).reverse();
      const insert = db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)');
      db.transaction(() => {
        saved.forEach((asset, index) => {
          insert.run(release.id, asset.id, index === 0 ? 'primary' : index === 1 ? 'preview' : 'attachment', index);
        });
      })();
      const missingSaved = saved[7];
      db.prepare("UPDATE assets SET is_present = 0, missing_since = '2025-02-01T00:00:00Z' WHERE id IN (?, ?)")
        .run(missingSaved.id, assets[1].id);
      return { projectId, releaseId: release.id, assets, saved, missingSaved };
    }

    function liveRegion(html) {
      const start = html.indexOf('<section data-release-assets-live-region>');
      const end = html.indexOf('</section>', start);
      expect(start).toBeGreaterThan(-1);
      return html.slice(start, end);
    }

    function renderedCardIds(section) {
      return [...section.matchAll(/<article[^>]*data-asset-id="(\d+)"/g)].map((match) => Number(match[1]));
    }

    async function measuredGet(url) {
      const membershipBefore = getReleaseAssets(db, Number(url.split('/')[2]));
      const { log, restore } = instrumentSqlExecution();
      let res;
      try {
        res = await agent.get(url).expect(200);
      } finally {
        restore();
      }
      expect(getReleaseAssets(db, Number(url.split('/')[2]))).toEqual(membershipBefore);
      return { res, log };
    }

    function expectReadOnlyResponse(res, log, fixture, notice, view) {
      const savedIds = fixture.saved.map((asset) => asset.id);
      const section = liveRegion(res.text);

      // Exactly the complete saved collection, in stored order, no duplicates.
      expect(renderedCardIds(section)).toEqual(savedIds);
      expect((section.match(/class="asset-(?:grid|list)-item is-missing"/g) || [])).toHaveLength(1);
      expect(section).toContain(fixture.saved[0].filename);
      expect(section).toContain(fixture.saved[399].filename);

      if (view === 'list') {
        const orders = [...section.matchAll(/data-release-asset-stored-fact-label="Order">Order<\/dt><dd>(\d+)<\/dd>/g)].map((m) => Number(m[1]));
        expect(orders).toEqual(savedIds.map((_, index) => index));
        const roles = [...section.matchAll(/data-release-asset-stored-fact-label="Role">Role<\/dt><dd>([A-Za-z]+)<\/dd>/g)].map((m) => m[1]);
        expect(roles.slice(0, 3)).toEqual(['Primary', 'Preview', 'Attachment']);
        expect(roles.filter((role) => role !== 'Attachment')).toEqual(['Primary', 'Preview']);
      } else {
        const roles = [...section.matchAll(/<span class="release-asset-grid-role-value">([A-Za-z]+)<\/span>/g)].map((m) => m[1]);
        expect(roles).toHaveLength(400);
        expect(roles.slice(0, 3)).toEqual(['Primary', 'Preview', 'Attachment']);
        expect(roles.filter((role) => role !== 'Attachment')).toEqual(['Primary', 'Preview']);
      }

      // Read-only controls only.
      expect(res.text).toContain(notice);
      expect(res.text).not.toContain('id="release-assets-form"');
      expect(res.text).not.toContain('Save asset selection');
      expect(section).not.toContain('data-release-assets-live-page-size-form');
      expect(section).not.toContain('aria-label="Release asset pages"');
      expect(section).not.toContain('data-dialog-open="release-assets-filter-dialog"');
      expect(section).not.toContain('release-asset-select-');
      expect(section).not.toContain('release-asset-role-form');

      // SQL evidence: zero editable page/count reads; the only full asset
      // metadata rows are the saved collection, from one statement.
      expect(log.filter(isEditablePageSql).map((entry) => entry.sql)).toEqual([]);
      const metadataStatements = log.filter((entry) => entry.metadataRows > 0);
      expect(metadataStatements).toHaveLength(1);
      expect(isSavedCollectionSql(metadataStatements[0])).toBe(true);
      expect(metadataStatements[0].metadataRows).toBe(400);
      expect(Math.max(...log.map((entry) => entry.rows))).toBeLessThanOrEqual(400);
      expect(log.filter(isMembershipWrite)).toEqual([]);
    }

    it('published View All (selection=all&pageSize=all) on 10,000 assets renders 400 saved cards and fetches zero editable rows', async () => {
      const fixture = await buildLargeReadOnlyFixture();
      READ_ONLY_HTTP_STATES[0][1](fixture);
      for (const view of ['grid', 'list']) {
        const viewQuery = view === 'list' ? '&view=list' : '';
        const { res, log } = await measuredGet(`/releases/${fixture.releaseId}/assets?selection=all&pageSize=all${viewQuery}`);
        expectReadOnlyResponse(res, log, fixture, READ_ONLY_HTTP_STATES[0][2], view);
      }
    });

    it('published numeric, unsupported-size and filtered requests render the same complete saved collection', async () => {
      const fixture = await buildLargeReadOnlyFixture();
      READ_ONLY_HTTP_STATES[0][1](fixture);
      const categoryId = createAssetCategoryRepository(db).addProjectCategory({
        projectId: fixture.projectId, displayName: 'Scale', directorySlug: 'scale', displayOrder: 0, enabled: true,
      }).id;
      const queries = [
        ['pageSize=10', 'grid'],
        ['pageSize=25&selection=all&view=list', 'list'],
        ['pageSize=200&selection=all', 'grid'],
        ['pageSize=7', 'grid'],
        ['pageSize=15&view=list&page=9', 'list'],
        [`pageSize=10&selection=all&search=img-0&extension=png&category=${categoryId}&view=list&page=2`, 'list'],
        ['pageSize=all&search=doc&extension=txt', 'grid'],
      ];
      for (const [query, view] of queries) {
        const { res, log } = await measuredGet(`/releases/${fixture.releaseId}/assets?${query}`);
        expectReadOnlyResponse(res, log, fixture, READ_ONLY_HTTP_STATES[0][2], view);
        // The view switch keeps the normalized size, never a stale page.
        const section = liveRegion(res.text);
        const expectedSize = /pageSize=(10|200|all)\b/.exec(query)?.[1];
        const listHref = section.match(/href="([^"]*view=list[^"]*)"/)?.[1] ?? '';
        if (expectedSize) expect(listHref).toContain(`pageSize=${expectedSize}`);
        else expect(listHref).not.toContain('pageSize=');
        expect(listHref).not.toContain('page=');
      }
    });

    it.each(READ_ONLY_HTTP_STATES.slice(1))('%s on 10,000 assets renders the saved collection with zero editable rows (numeric and View All)', async (_label, makeReadOnly, notice) => {
      const fixture = await buildLargeReadOnlyFixture();
      makeReadOnly(fixture);
      for (const [query, view] of [['selection=all&pageSize=all', 'grid'], ['pageSize=25&view=list', 'list'], ['pageSize=200&selection=all', 'grid']]) {
        const { res, log } = await measuredGet(`/releases/${fixture.releaseId}/assets?${query}`);
        expectReadOnlyResponse(res, log, fixture, notice, view);
      }
    });

    it('editable control: the same 10,000-asset project still fetches exactly 25 full metadata rows at size 25', async () => {
      const fixture = await buildLargeReadOnlyFixture();
      const { res, log } = await measuredGet(`/releases/${fixture.releaseId}/assets?selection=all&pageSize=25&page=2`);
      const pageRows = log.filter((entry) => entry.sql.includes('is_saved_member') && entry.sql.includes('LIMIT ? OFFSET ?'));
      expect(pageRows).toHaveLength(1);
      expect(pageRows[0].metadataRows).toBe(25);
      expect(log.filter((entry) => entry.sql.includes('AS candidate_total'))).toHaveLength(1);
      expect(log.reduce((sum, entry) => sum + entry.metadataRows, 0)).toBe(25);
      expect(log.filter((entry) => isSavedCollectionSql(entry))).toEqual([]);
      expect(renderedCardIds(liveRegion(res.text))).toHaveLength(25);
      expect(res.text).toContain('Save asset selection');
      expect(res.text).toContain('Page 2 of 400');
    });

    it('a well-formed Save on a published release stays 422 with the complete saved collection and no membership write', async () => {
      const fixture = await buildLargeReadOnlyFixture();
      READ_ONLY_HTTP_STATES[0][1](fixture);
      const membershipBefore = getReleaseAssets(db, fixture.releaseId);
      const { log, restore } = instrumentSqlExecution();
      let res;
      try {
        res = await agent
          .post(`/releases/${fixture.releaseId}/assets?selection=all&pageSize=all`)
          .send('_csrf=' + encodeURIComponent(csrfToken))
          .send(`selectedAssetIds=${fixture.assets[2].id}`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(422);
      } finally {
        restore();
      }
      expect(getReleaseAssets(db, fixture.releaseId)).toEqual(membershipBefore);
      expect(renderedCardIds(liveRegion(res.text))).toEqual(fixture.saved.map((asset) => asset.id));
      expect(log.filter(isEditablePageSql)).toEqual([]);
      expect(log.filter(isMembershipWrite)).toEqual([]);
    });

    // ─── B-F4: a malformed Save on a read-only release is refused (422) ─────
    // before selectAssets' read-only guards run, but the page still displays
    // the complete persisted saved collection, never the rejected draft.
    describe('malformed read-only Save recovery (B-F4)', () => {
      // 2,000 project assets (alternating categorized PNG / uncategorized
      // TXT); 60 saved members in a stored order unrelated to ID order:
      // Primary, a MISSING Preview, then Attachments; one animated/generated
      // saved member. A foreign project owns a distinctively named asset.
      async function buildMalformedSaveFixture() {
        const projectId = await createTestProject('B-F4 Read-only');
        const rows = [];
        for (let index = 0; index < 2000; index += 1) {
          const png = index % 2 === 0;
          const filename = `${png ? 'img' : 'doc'}-${String(index).padStart(5, '0')}.${png ? 'png' : 'txt'}`;
          rows.push({
            relativePath: filename, filename, extension: png ? 'png' : 'txt',
            mimeType: png ? 'image/png' : 'text/plain', sizeBytes: 100, modifiedAt: '2025-01-01T00:00:00Z',
          });
        }
        const assets = createAssetRepository(db).upsertMany(projectId, rows);
        const category = createAssetCategoryRepository(db).addProjectCategory({
          projectId, displayName: 'Scale', directorySlug: 'scale', displayOrder: 0, enabled: true,
        });
        db.prepare("UPDATE assets SET category_id = ? WHERE project_id = ? AND extension = 'png'").run(category.id, projectId);
        const release = createReleaseService({ db }).createRelease(projectId, {
          title: 'B-F4 Read-only', description: '', notes: '', plannedDate: null, patreonUrl: null,
        });
        const picked = Array.from({ length: 60 }, (_, index) => assets[index * 33]);
        const saved = picked.map((_, i) => (i % 2 === 0 ? picked[i / 2] : picked[59 - (i - 1) / 2]));
        const insert = db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)');
        db.transaction(() => {
          saved.forEach((asset, index) => {
            insert.run(release.id, asset.id, index === 0 ? 'primary' : index === 1 ? 'preview' : 'attachment', index);
          });
        })();
        db.prepare("UPDATE assets SET is_present = 0, missing_since = '2025-02-01T00:00:00Z' WHERE id = ?").run(saved[1].id);
        db.prepare('UPDATE assets SET source_animated = 1, source_generation = 3 WHERE id = ?').run(saved[3].id);
        const foreignProjectId = await createTestProject('B-F4 Foreign');
        const [foreign] = createAssetRepository(db).upsertMany(foreignProjectId, [{
          relativePath: 'foreign-secret-bf4.png', filename: 'foreign-secret-bf4.png', extension: 'png',
          mimeType: 'image/png', sizeBytes: 100, modifiedAt: '2025-01-01T00:00:00Z',
        }]);
        const nonMember = assets.find((asset) => !saved.includes(asset) && asset.extension === 'png');
        return { projectId, releaseId: release.id, assets, saved, category, foreign, nonMember };
      }

      async function measuredPost(fixture, query, body, status = 422) {
        const membershipBefore = getReleaseAssets(db, fixture.releaseId);
        const { log, restore } = instrumentSqlExecution();
        let res;
        try {
          res = await agent
            .post(`/releases/${fixture.releaseId}/assets${query ? `?${query}` : ''}`)
            .set('Content-Type', 'application/x-www-form-urlencoded')
            .send(body)
            .expect(status);
        } finally {
          restore();
        }
        expect(getReleaseAssets(db, fixture.releaseId)).toEqual(membershipBefore);
        expect(log.filter(isMembershipWrite)).toEqual([]);
        expect(db.inTransaction).toBe(false);
        return { res, log };
      }

      const withCsrf = (body) => `_csrf=${encodeURIComponent(csrfToken)}&${body}`;

      function expectPersistedReadOnlyError(res, log, fixture, { notice, error, view }) {
        const savedIds = fixture.saved.map((asset) => asset.id);
        const section = liveRegion(res.text);

        // Exact saved IDs in stored order, no duplicates, no candidates.
        expect(renderedCardIds(section)).toEqual(savedIds);
        expect(new Set(renderedCardIds(section)).size).toBe(savedIds.length);
        expect(renderedCardIds(section)).not.toContain(fixture.nonMember.id);
        // The missing saved Preview stays in place.
        const missing = section.match(/class="asset-(?:grid|list)-item is-missing">[\s\S]*?data-asset-id="(\d+)"/g) || [];
        expect(missing).toHaveLength(1);
        expect(missing[0]).toContain(`data-asset-id="${fixture.saved[1].id}"`);
        expect(section).toContain('Missing at last scan');
        // Metadata: every saved filename, category label.
        for (const asset of fixture.saved) expect(section).toContain(asset.filename);
        expect(section).toContain('Scale');

        if (view === 'list') {
          const orders = [...section.matchAll(/data-release-asset-stored-fact-label="Order">Order<\/dt><dd>(\d+)<\/dd>/g)].map((m) => Number(m[1]));
          expect(orders).toEqual(savedIds.map((_, index) => index));
          const roles = [...section.matchAll(/data-release-asset-stored-fact-label="Role">Role<\/dt><dd>([A-Za-z]+)<\/dd>/g)].map((m) => m[1]);
          expect(roles).toEqual(savedIds.map((_, i) => (i === 0 ? 'Primary' : i === 1 ? 'Preview' : 'Attachment')));
          expect(section).toContain('asset-list-card');
        } else {
          const roles = [...section.matchAll(/<span class="release-asset-grid-role-value">([A-Za-z]+)<\/span>/g)].map((m) => m[1]);
          expect(roles).toEqual(savedIds.map((_, i) => (i === 0 ? 'Primary' : i === 1 ? 'Preview' : 'Attachment')));
          expect(section).toContain('asset-grid-item');
        }

        // Truthful refusal: read-only notice + the validation error alert.
        expect(res.text).toContain(notice);
        expect(res.text).toMatch(new RegExp(`<p>${error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</p>`));
        expect(res.text).not.toMatch(/saved successfully|Asset selection saved/i);

        // No editable form, carriers, mutation or pagination controls.
        expect(res.text).not.toContain('id="release-assets-form"');
        expect(res.text).not.toContain('Save asset selection');
        expect(res.text).not.toContain('name="roleOrder"');
        expect(res.text).not.toContain('name="roleAssetIds');
        expect(res.text).not.toMatch(/name="roles\[/);
        expect(res.text).not.toMatch(/name="sortOrder\[/);
        expect(res.text).not.toContain('name="selectedAssetIds"');
        expect(section).not.toContain('release-asset-select-');
        expect(section).not.toContain('release-asset-role-form');
        expect(section).not.toContain('aria-label="Release asset pages"');
        expect(section).not.toContain('data-release-assets-live-page-size-form');

        // No foreign metadata, no internals.
        expect(res.text).not.toContain('foreign-secret-bf4');
        expect(res.text).not.toMatch(/SQLITE|SELECT |at .*\.js:\d+/);

        // SQL: no editable page/count, no submitted-ID hydration, and the only
        // full metadata rows are the saved collection from one statement.
        expect(log.filter(isEditablePageSql).map((entry) => entry.sql)).toEqual([]);
        expect(log.filter((entry) => entry.sql.includes('a.project_id = ? AND a.id IN ('))).toEqual([]);
        const metadataStatements = log.filter((entry) => entry.metadataRows > 0);
        expect(metadataStatements).toHaveLength(1);
        expect(isSavedCollectionSql(metadataStatements[0])).toBe(true);
        expect(metadataStatements[0].metadataRows).toBe(savedIds.length);
        expect(Math.max(...log.map((entry) => entry.rows))).toBeLessThanOrEqual(savedIds.length);
      }

      it.each(READ_ONLY_HTTP_STATES)('%s: a non-integer selected ID stays 422 and renders the complete saved collection (Grid and List)', async (_label, makeReadOnly, notice) => {
        const fixture = await buildMalformedSaveFixture();
        makeReadOnly(fixture);
        const body = withCsrf([
          'selectedAssetIds=abc',
          `selectedAssetIds=${fixture.foreign.id}`,
          `selectedAssetIds=${fixture.nonMember.id}`,
          `selectedAssetIds=${fixture.saved[0].id}`,
        ].join('&'));
        const cases = [
          ['pageSize=10&page=2', 'grid'],
          [`pageSize=25&selection=all&search=img&extension=png&category=${fixture.category.id}&view=list&page=3`, 'list'],
          ['pageSize=200&selection=selected', 'grid'],
          ['pageSize=all&selection=all&view=list', 'list'],
          ['pageSize=7', 'grid'],
          ['pageSize=15&view=list', 'list'],
        ];
        for (const [query, view] of cases) {
          const { res, log } = await measuredPost(fixture, query, body);
          expectPersistedReadOnlyError(res, log, fixture, { notice, error: 'Invalid asset selection.', view });
          // URL context survives on the view switch (GET route, normalized size, no page).
          const section = liveRegion(res.text);
          const switchHref = section.match(/href="(\/releases\/\d+\/assets\?[^"]*view=(?:list|grid)[^"]*)"/)?.[1] ?? '';
          expect(switchHref).toMatch(new RegExp(`^/releases/${fixture.releaseId}/assets\\?`));
          const expectedSize = /pageSize=(10|200|all)\b/.exec(query)?.[1];
          if (expectedSize) expect(switchHref).toContain(`pageSize=${expectedSize}`);
          else expect(switchHref).not.toContain('pageSize=');
          if (query.includes('search=img')) expect(switchHref).toContain('search=img');
          expect(switchHref).not.toContain('page=');
        }
      });

      it('published: other malformed or invalid Save classes keep their established 422 refusals with the saved collection', async () => {
        const fixture = await buildMalformedSaveFixture();
        const [, makeReadOnly, notice] = READ_ONLY_HTTP_STATES[0];
        makeReadOnly(fixture);
        const id = fixture.saved[0].id;
        const cases = [
          // Route-level malformed shapes (refused before the read-only guard).
          [`selectedAssetIds[x]=${id}`, 'Invalid asset selection format.'],
          [`selectedAssetIds=${id}&roleOrder=${encodeURIComponent('not-compact')}`, 'Invalid asset selection format.'],
          [`selectedAssetIds=${id}&roleAssetIds[0]=abc&roles[0]=primary&sortOrder[0]=0`, 'Invalid asset selection format.'],
          [`selectedAssetIds=${id}&selectedAssetIds=${encodeURIComponent('<b>1</b>')}`, 'Invalid asset selection.'],
          // B-F2R3: a legacy order outside the non-negative safe-integer
          // range is refused at the route, never coerced to 0.
          [`selectedAssetIds=${id}&roles[0]=primary&sortOrder[0]=-4`, 'Invalid asset order. Each order must be a whole number from 0 to 9007199254740991.'],
          [`selectedAssetIds=${id}&roles[0]=primary&sortOrder[0]=9007199254740992`, 'Invalid asset order. Each order must be a whole number from 0 to 9007199254740991.'],
          // Well-formed requests reach the published guard first.
          ['selectedAssetIds=999999999', notice],
          [`selectedAssetIds=${fixture.foreign.id}`, notice],
          [`selectedAssetIds=${id}&selectedAssetIds=${id}`, notice],
          [`selectedAssetIds=${id}&roles[0]=bogus&sortOrder[0]=0`, notice],
        ];
        for (const [body, error] of cases) {
          const { res, log } = await measuredPost(fixture, 'pageSize=25', withCsrf(body));
          expectPersistedReadOnlyError(res, log, fixture, { notice, error, view: 'grid' });
          expect(res.text).not.toContain('<b>1</b>');
        }
      });

      it('a missing or invalid CSRF token is refused (403) before any rendering or write', async () => {
        const fixture = await buildMalformedSaveFixture();
        READ_ONLY_HTTP_STATES[0][1](fixture);
        for (const body of ['selectedAssetIds=abc', '_csrf=forged&selectedAssetIds=abc']) {
          const { res, log } = await measuredPost(fixture, 'pageSize=25', body, 403);
          expect(res.text).not.toContain('data-release-assets-live-region');
          expect(log.filter((entry) => entry.metadataRows > 0)).toEqual([]);
        }
      });

      it('editable control: a malformed Save on an editable release still renders the rejected draft for retry', async () => {
        const fixture = await buildMalformedSaveFixture();
        const { res } = await measuredPost(
          fixture,
          'pageSize=25',
          withCsrf(`selectedAssetIds=abc&selectedAssetIds=${fixture.nonMember.id}`),
        );
        expect(res.text).toContain('id="release-assets-form"');
        expect(res.text).toContain('<p>Invalid asset selection.</p>');
        // The draft (one surviving ID) replaces persisted membership in the form.
        expect(res.text).toContain(`value="${fixture.nonMember.id}"`);
        expect(res.text).not.toContain('foreign-secret-bf4');
      });
    });
  });

  describe('rejected Save role/order recovery (B-F2)', () => {
    const decodeAttr = (value) => value
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

    function readAttrs(tag) {
      const attrs = {};
      for (const match of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) {
        if (match[1] === 'input') continue;
        attrs[match[1]] = match[2] === undefined ? '' : decodeAttr(match[2]);
      }
      return attrs;
    }

    // The Save form's successful controls in tree order, as an HTML form
    // submission builds its entry list: inputs inside the form that are not
    // re-associated elsewhere, plus inputs anywhere with form="release-assets-form";
    // unchecked checkboxes, disabled and unnamed controls are skipped.
    function saveFormEntries(html) {
      const formStart = html.indexOf('<form id="release-assets-form"');
      expect(formStart).toBeGreaterThan(-1);
      const formEnd = html.indexOf('</form>', formStart);
      const formTag = html.slice(formStart, html.indexOf('>', formStart) + 1);
      const entries = [];
      for (const match of html.matchAll(/<input\b[^>]*>/g)) {
        const attrs = readAttrs(match[0]);
        const inside = match.index > formStart && match.index < formEnd;
        const owned = attrs.form !== undefined ? attrs.form === 'release-assets-form' : inside;
        if (!owned || attrs.name === undefined || attrs.disabled !== undefined) continue;
        if (attrs.type === 'checkbox' && attrs.checked === undefined) continue;
        entries.push([attrs.name, attrs.value ?? (attrs.type === 'checkbox' ? 'on' : '')]);
      }
      return { action: decodeAttr(readAttrs(formTag).action), method: readAttrs(formTag).method, entries };
    }

    const encodeEntries = (entries) => entries
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join('&');

    // The keyed role/order association the retry form carries: one compact
    // `roleOrder` field (B-F2R1), never the expanded per-asset fields.
    function carriedDraft(entries) {
      expect(entries.some(([name]) => /^(roleAssetIds|roles|sortOrder)\b/.test(name))).toBe(false);
      const carriers = entries.filter(([name]) => name === 'roleOrder');
      expect(carriers.length).toBeLessThanOrEqual(1);
      if (!carriers.length) return [];
      return JSON.parse(carriers[0][1]).map(([assetId, role, sortOrder]) => ({ assetId, role, sortOrder }));
    }

    // Replace the retry form's compact carrier with an edited draft.
    const withCarriedDraft = (entries, draft) => entries.map(([name, value]) => (
      name === 'roleOrder'
        ? [name, JSON.stringify(draft.map(({ assetId, role, sortOrder }) => [assetId, role, sortOrder]))]
        : [name, value]
    ));

    const selectedIds = (entries) => entries
      .filter(([name]) => name === 'selectedAssetIds')
      .map(([, value]) => Number(value));

    const selectionAlert = (html) => html
      .match(/<div class="error-summary" role="alert" data-release-assets-selection-errors>[\s\S]*?<\/div>/)?.[0] || '';

    // 25 images (three Save pages at size 10) with a saved Primary, a saved
    // missing Preview, an off-page saved member and an off-page saved member
    // the draft removes; one asset in another project.
    async function buildRecoveryFixture() {
      const projectId = await createTestProject('B-F2 Recovery');
      const rows = Array.from({ length: 25 }, (_, index) => {
        const filename = `img-${String(index).padStart(2, '0')}.png`;
        return { relativePath: filename, filename, extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: '2025-01-01T00:00:00Z' };
      });
      const assets = createAssetRepository(db).upsertMany(projectId, rows);
      const byName = Object.fromEntries(assets.map((asset) => [asset.filename, asset.id]));
      const foreignProjectId = await createTestProject('B-F2 Foreign');
      const foreign = insertAssetDirect(db, foreignProjectId, 'foreign-secret-<i>meta</i>.png');
      const release = createReleaseService({ db }).createRelease(projectId, {
        title: 'B-F2 Recovery', description: '', notes: '', plannedDate: null, patreonUrl: null,
      });
      const ids = {
        primary: byName['img-00.png'],
        missingPreview: byName['img-01.png'],
        visibleAddition: byName['img-03.png'],
        hiddenMember: byName['img-15.png'],
        offPageAddition: byName['img-18.png'],
        offPageRemoval: byName['img-20.png'],
        foreign: foreign.id,
      };
      const insert = db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)');
      insert.run(release.id, ids.primary, 'primary', 0);
      insert.run(release.id, ids.missingPreview, 'preview', 1);
      insert.run(release.id, ids.hiddenMember, 'attachment', 2);
      insert.run(release.id, ids.offPageRemoval, 'attachment', 3);
      db.prepare("UPDATE assets SET is_present = 0, missing_since = '2025-02-01T00:00:00Z' WHERE id = ?").run(ids.missingPreview);
      return { projectId, releaseId: release.id, ids, url: `/releases/${release.id}/assets?selection=all&pageSize=10` };
    }

    // The rejected legacy draft: submitted sequence differs from the saved
    // order, every entry has an explicit role and order, one role is invalid
    // (and markup-bearing), one ID is foreign, the off-page removal is omitted.
    function rejectedDraft(ids) {
      return [
        { assetId: ids.hiddenMember, role: 'attachment', sortOrder: 5 },
        { assetId: ids.offPageAddition, role: '<b>bogus</b>', sortOrder: 4 },
        { assetId: ids.primary, role: 'primary', sortOrder: 2 },
        { assetId: ids.missingPreview, role: 'preview', sortOrder: 3 },
        { assetId: ids.foreign, role: 'attachment', sortOrder: 6 },
        { assetId: ids.visibleAddition, role: 'attachment', sortOrder: 1 },
      ];
    }

    function legacyBody(draft) {
      return [
        ['_csrf', csrfToken],
        ...draft.map((entry) => ['selectedAssetIds[]', String(entry.assetId)]),
        ...draft.map((entry) => ['roles[]', entry.role]),
        ...draft.map((entry) => ['sortOrder[]', String(entry.sortOrder)]),
      ];
    }

    const postForm = (url, entries) => agent.post(url)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(encodeEntries(entries));

    function expectRetryForm(res, fixture, draft) {
      const form = saveFormEntries(res.text);
      expect(form.method).toBe('post');
      expect(new URL(form.action, 'http://localhost').pathname).toBe(`/releases/${fixture.releaseId}/assets`);
      expect(form.entries.filter(([name]) => name === '_csrf')).toEqual([['_csrf', csrfToken]]);
      // Exact membership, no duplicates introduced by hidden + visible inputs.
      const ids = selectedIds(form.entries);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort((a, b) => a - b)).toEqual(draft.map((entry) => entry.assetId).sort((a, b) => a - b));
      // Exact submitted sequence with each asset's own role and order.
      expect(carriedDraft(form.entries)).toEqual(draft);
      return form;
    }

    it('renders the rejected draft with keyed roles/order and a visible escaped indexed role error; resubmission is unchanged, then a corrected Save succeeds', async () => {
      const fixture = await buildRecoveryFixture();
      const { ids } = fixture;
      const draft = rejectedDraft(ids);
      const membershipBefore = getReleaseAssets(db, fixture.releaseId);

      const rejected = await postForm(fixture.url, legacyBody(draft)).expect(422);
      expect(getReleaseAssets(db, fixture.releaseId)).toEqual(membershipBefore);

      // Accessible, escaped, ID-only validation message.
      const alert = selectionAlert(rejected.text);
      expect(alert).toContain('The asset selection was not saved.');
      expect(alert).toContain(
        `<li>Asset ${ids.offPageAddition} has an invalid role &quot;&lt;b&gt;bogus&lt;/b&gt;&quot;. Role must be one of: primary, preview, attachment.</li>`,
      );
      expect(rejected.text).not.toContain('<b>bogus</b>');
      expect(rejected.text).not.toContain('foreign-secret');
      expect(rejected.text).not.toContain('&lt;i&gt;meta');

      const first = expectRetryForm(rejected, fixture, draft);
      // The visible page renders its own checkboxes; everything else the draft
      // holds (off-page addition, hidden member, foreign ID) is a hidden input.
      const hidden = [...rejected.text.matchAll(/<input type="hidden" name="selectedAssetIds" value="(\d+)">/g)].map((m) => Number(m[1]));
      const visible = new Set([...rejected.text.matchAll(/id="release-asset-select-(\d+)"/g)].map((m) => Number(m[1])));
      expect(visible.size).toBe(10);
      expect(rejected.text).toContain('Page 1 of 3');
      expect(hidden).toEqual(draft.map((entry) => entry.assetId).filter((assetId) => !visible.has(assetId)));
      expect(hidden).toContain(ids.foreign);
      expect(hidden).toContain(ids.offPageAddition);
      expect(hidden).toContain(ids.hiddenMember);
      expect(visible.has(ids.visibleAddition)).toBe(true);
      expect(hidden.length).toBeGreaterThanOrEqual(2);
      expect(hidden).not.toContain(ids.offPageRemoval);
      // The invalid markup-bearing role is carried escaped inside the compact field.
      expect(rejected.text).toContain(`[${ids.offPageAddition},&quot;&lt;b&gt;bogus&lt;/b&gt;&quot;,4]`);

      // Resubmitting the rendered form unchanged is the same draft and the
      // same refusal, with no membership write.
      const again = await postForm(first.action, first.entries).expect(422);
      expect(getReleaseAssets(db, fixture.releaseId)).toEqual(membershipBefore);
      expect(selectionAlert(again.text)).toBe(alert);
      const second = expectRetryForm(again, fixture, draft);

      // Correct only the invalid role. The foreign ID is then reported by the
      // unchanged ownership check; the corrected draft is still carried.
      const correctedDraft = draft.map((entry) => (
        entry.assetId === ids.offPageAddition ? { ...entry, role: 'attachment' } : entry
      ));
      const corrected = withCarriedDraft(second.entries, correctedDraft);
      const ownership = await postForm(second.action, corrected).expect(422);
      expect(ownership.text).toContain(`Asset ${ids.foreign} does not belong to the release&#39;s project.`);
      expect(ownership.text).not.toContain('foreign-secret');
      expect(selectionAlert(ownership.text)).toBe('');
      expect(getReleaseAssets(db, fixture.releaseId)).toEqual(membershipBefore);
      const third = expectRetryForm(ownership, fixture, correctedDraft);

      // Remove the foreign ID from the membership; its stale key is ignored.
      const withoutForeign = third.entries.filter(([name, value]) => !(name === 'selectedAssetIds' && Number(value) === ids.foreign));
      await postForm(third.action, withoutForeign).expect(302);

      expect(getReleaseAssets(db, fixture.releaseId).map(({ asset_id, role, sort_order }) => ({ asset_id, role, sort_order }))).toEqual([
        { asset_id: ids.visibleAddition, role: 'attachment', sort_order: 1 },
        { asset_id: ids.primary, role: 'primary', sort_order: 2 },
        { asset_id: ids.missingPreview, role: 'preview', sort_order: 3 },
        { asset_id: ids.offPageAddition, role: 'attachment', sort_order: 4 },
        { asset_id: ids.hiddenMember, role: 'attachment', sort_order: 5 },
      ]);

      // Reopened: a normal GET carries no role/order fields (membership only).
      const reopened = await agent.get(fixture.url).expect(200);
      const reopenedForm = saveFormEntries(reopened.text);
      expect(carriedDraft(reopenedForm.entries)).toEqual([]);
      expect(reopened.text).not.toContain('data-release-assets-submitted-role-order');
      expect(selectedIds(reopenedForm.entries).sort((a, b) => a - b)).toEqual(
        [ids.visibleAddition, ids.primary, ids.missingPreview, ids.offPageAddition, ids.hiddenMember].sort((a, b) => a - b),
      );
    });

    it('deselecting the invalid-role asset in the retry form drops its role and saves the rest of the draft', async () => {
      const fixture = await buildRecoveryFixture();
      const { ids } = fixture;
      // Invalid role on the visible addition; no foreign ID.
      const draft = [
        { assetId: ids.visibleAddition, role: 'cover', sortOrder: 3 },
        { assetId: ids.hiddenMember, role: 'preview', sortOrder: 0 },
        { assetId: ids.primary, role: 'primary', sortOrder: 1 },
      ];
      const rejected = await postForm(fixture.url, legacyBody(draft)).expect(422);
      expect(selectionAlert(rejected.text)).toContain(`Asset ${ids.visibleAddition} has an invalid role &quot;cover&quot;.`);
      const form = expectRetryForm(rejected, fixture, draft);

      // The user unchecks the visible checkbox — the only change.
      const unchecked = form.entries.filter(([name, value]) => !(name === 'selectedAssetIds' && Number(value) === ids.visibleAddition));
      await postForm(form.action, unchecked).expect(302);
      expect(getReleaseAssets(db, fixture.releaseId).map(({ asset_id, role, sort_order }) => ({ asset_id, role, sort_order }))).toEqual([
        { asset_id: ids.hiddenMember, role: 'preview', sort_order: 0 },
        { asset_id: ids.primary, role: 'primary', sort_order: 1 },
        // The legacy contract keeps an unsubmitted saved missing member.
        { asset_id: ids.missingPreview, role: 'preview', sort_order: 1 },
      ]);
    });

    it('pairs keyed roles/order by asset ID regardless of selectedAssetIds order; new selections default and stale keys are ignored', async () => {
      const fixture = await buildRecoveryFixture();
      const { ids } = fixture;
      await postForm(fixture.url, [
        ['_csrf', csrfToken],
        // Checkbox/hidden order differs from the keyed sequence.
        ['selectedAssetIds', String(ids.visibleAddition)],
        ['selectedAssetIds', String(ids.primary)],
        ['selectedAssetIds', String(ids.hiddenMember)],
        ['roleAssetIds[0]', String(ids.primary)],
        ['roles[0]', 'Primary '],
        ['sortOrder[0]', '4'],
        ['roleAssetIds[1]', String(ids.offPageRemoval)],
        ['roles[1]', 'not-a-role'],
        ['sortOrder[1]', '0'],
        ['roleAssetIds[2]', String(ids.hiddenMember)],
        ['roles[2]', 'preview'],
        ['sortOrder[2]', '7'],
      ]).expect(302);
      expect(getReleaseAssets(db, fixture.releaseId).map(({ asset_id, role, sort_order }) => ({ asset_id, role, sort_order }))).toEqual([
        { asset_id: ids.visibleAddition, role: 'attachment', sort_order: 0 },
        { asset_id: ids.missingPreview, role: 'preview', sort_order: 1 },
        { asset_id: ids.primary, role: 'primary', sort_order: 4 },
        { asset_id: ids.hiddenMember, role: 'preview', sort_order: 7 },
      ]);
    });

    it('rejects malformed keyed role/order carriers without a membership write', async () => {
      const fixture = await buildRecoveryFixture();
      const { ids } = fixture;
      const before = getReleaseAssets(db, fixture.releaseId);
      for (const [carrier, message] of [
        [[['roleAssetIds[x]', String(ids.primary)]], 'Invalid asset selection format.'],
        [[['roleAssetIds[0][a]', String(ids.primary)]], 'Invalid asset selection format.'],
        [[['roleAssetIds[0]', 'abc']], 'Invalid asset selection format.'],
      ]) {
        const res = await postForm(fixture.url, [
          ['_csrf', csrfToken],
          ['selectedAssetIds', String(ids.primary)],
          ...carrier,
          ['roles[0]', 'primary'],
        ]).expect(422);
        expect(res.text).toContain(message);
        expect(getReleaseAssets(db, fixture.releaseId)).toEqual(before);
      }
    });

    it('keeps existing outcomes for repeated, non-integer and unknown IDs and adds no carrier to a membership-only draft', async () => {
      const fixture = await buildRecoveryFixture();
      const { ids } = fixture;
      const before = getReleaseAssets(db, fixture.releaseId);

      const repeated = await postForm(fixture.url, legacyBody([
        { assetId: ids.primary, role: 'primary', sortOrder: 0 },
        { assetId: ids.primary, role: 'preview', sortOrder: 1 },
      ])).expect(422);
      expect(repeated.text).toContain('Duplicate asset IDs are not allowed.');

      const nonInteger = await postForm(fixture.url, [
        ['_csrf', csrfToken], ['selectedAssetIds[]', 'abc'], ['roles[]', 'primary'],
      ]).expect(422);
      expect(nonInteger.text).toContain('Invalid asset selection.');
      expect(nonInteger.text).not.toContain('data-release-assets-submitted-role-order');

      await postForm(fixture.url, [
        ['_csrf', csrfToken], ['selectedAssetIds[]', '987654'], ['roles[]', 'primary'],
      ]).expect(404);

      // A membership-only rejected draft stays membership-only on retry.
      const membershipOnly = await postForm(fixture.url, [
        ['_csrf', csrfToken],
        ['selectedAssetIds', String(ids.primary)],
        ['selectedAssetIds', String(ids.foreign)],
      ]).expect(422);
      expect(membershipOnly.text).toContain(`Asset ${ids.foreign} does not belong to the release&#39;s project.`);
      expect(membershipOnly.text).not.toContain('foreign-secret');
      const form = saveFormEntries(membershipOnly.text);
      expect(carriedDraft(form.entries)).toEqual([]);
      expect(form.entries.some(([name]) => /^(roles|sortOrder|roleAssetIds|roleOrder)\b/.test(name))).toBe(false);
      expect(selectedIds(form.entries).sort((a, b) => a - b)).toEqual([ids.primary, ids.foreign].sort((a, b) => a - b));
      expect(getReleaseAssets(db, fixture.releaseId)).toEqual(before);
    });

    it('a well-formed legacy Save on a published release stays read-only with no carrier and no write', async () => {
      const fixture = await buildRecoveryFixture();
      db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(fixture.releaseId);
      const before = getReleaseAssets(db, fixture.releaseId);
      const res = await postForm(fixture.url, legacyBody([
        { assetId: fixture.ids.primary, role: 'bogus', sortOrder: 0 },
      ])).expect(422);
      expect(res.text).toContain('This release is published. Asset selections are locked and read-only.');
      expect(res.text).not.toContain('id="release-assets-form"');
      expect(res.text).not.toContain('data-release-assets-submitted-role-order');
      expect(res.text).not.toContain('data-release-assets-selection-errors');
      expect(getReleaseAssets(db, fixture.releaseId)).toEqual(before);
    });
  });

  describe('release asset category filter control', () => {
    async function setupCategoryFilterRelease() {
      const projectRes = await agent
        .post('/projects')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Category+Filter+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projectRes.headers.location.replace('/projects/', '');

      const projectDir = getProjectDir(projectsRoot, projectId, 'category-filter-test');
      fs.writeFileSync(path.join(projectDir, 'source-asset.txt'), 'source');
      fs.writeFileSync(path.join(projectDir, 'other-asset.txt'), 'other');
      await agent
        .post(`/projects/${projectId}/scan`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));
      const sourceAsset = assets.find((asset) => asset.filename === 'source-asset.txt');
      const otherAsset = assets.find((asset) => asset.filename === 'other-asset.txt');
      const sourceCategory = insertProjectCategory(db, Number(projectId), 'Filter Source', 'filter-source', 90);
      const otherCategory = insertProjectCategory(db, Number(projectId), 'Filter Other', 'filter-other', 91);
      const emptyCategory = insertProjectCategory(db, Number(projectId), 'Filter Empty', 'filter-empty', 92);

      db.prepare('UPDATE assets SET category_id = ? WHERE id = ?').run(sourceCategory.id, sourceAsset.id);
      db.prepare('UPDATE assets SET category_id = ? WHERE id = ?').run(otherCategory.id, otherAsset.id);

      const releaseRes = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Category+Filter+Release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      return {
        projectId: Number(projectId),
        projectDir,
        releaseLocation: releaseRes.headers.location,
        releaseId: Number(releaseRes.headers.location.replace('/releases/', '')),
        sourceCategory,
        otherCategory,
        emptyCategory,
        sourceAsset,
        otherAsset,
      };
    }

    it('renders All categories and the project category options with all assets visible', async () => {
      const fixture = await setupCategoryFilterRelease();
      const res = await agent.get(`${fixture.releaseLocation}/assets?selection=all`).expect(200);

      const categoryDisclosure = filterDisclosureHtml(res.text, 'release-asset-category-filter-options');
      const extensionDisclosure = filterDisclosureHtml(res.text, 'release-asset-extension-filter-options');
      expect(categoryDisclosure).toBeTruthy();
      expect(extensionDisclosure).toBeTruthy();
      for (const [disclosure, inputName] of [[categoryDisclosure, 'category'], [extensionDisclosure, 'extension']]) {
        expect(disclosure).toContain('data-cc-dropdown');
        expect(disclosure).toContain('data-cc-dropdown-mode="single"');
        expect(disclosure).toContain('data-cc-viewport-disclosure');
        expect(disclosure).toContain('asset-filter-multiselect--sized');
        expect(disclosure).toContain('class="asset-filter-multiselect-summary-current"');
        expect(disclosure).toContain('class="asset-filter-multiselect-summary-width" aria-hidden="true"');
        expect(disclosure).toMatch(new RegExp(`<label for="[^"]+">\\s*<input[^>]+name="${inputName}"`));
        expect(disclosure).not.toContain('data-asset-viewer-filter-disclosure');
      }
      expect(categoryDisclosure).toContain('aria-label="Category filter: All categories (2)"');
      expect(categoryDisclosure).toContain('>All categories (2)</span>');
      expect(categoryDisclosure).toContain(`value="${fixture.sourceCategory.id}"`);
      expect(categoryDisclosure).toContain('>Filter Source (1)</span>');
      expect(categoryDisclosure).toContain(`value="${fixture.otherCategory.id}"`);
      expect(categoryDisclosure).toContain('>Filter Other (1)</span>');
      expect(categoryDisclosure).toContain('>Filter Empty (0)</span>');
      const widthBlock = categoryDisclosure.match(/class="asset-filter-multiselect-summary-width"[^>]*>([\s\S]*?)<\/span>\s*<\/span>\s*<\/summary>/)?.[1] || '';
      expect(widthBlock).toContain('All categories (2)');
      expect(widthBlock).toContain('Filter Source (1)');
      expect(widthBlock).toContain('Filter Other (1)');
      expect(widthBlock).toContain('Filter Empty (0)');
      expect(extensionDisclosure).toContain('aria-label="Extension filter: All extensions"');
      expect(extensionDisclosure).toContain('>All extensions</span>');
      expect(extensionDisclosure).toContain('>.txt</span>');
      expect(selectedFilterValueAllowEmpty(res.text, 'release-asset-category-filter-options', 'category')).toBe('');
      expect(selectedFilterValueAllowEmpty(res.text, 'release-asset-extension-filter-options', 'extension')).toBe('');
      expect(categoryDisclosure).toMatch(/value=""[^>]+checked[^>]+data-release-assets-live-filter-control/);
      expect(extensionDisclosure).toMatch(/value=""[^>]+checked[^>]+data-release-assets-live-filter-control/);
      expect(res.text).toContain('id="release-asset-page-size-dropdown" data-cc-dropdown data-cc-dropdown-mode="single"');
      expect(res.text).toContain('id="asset-page-size" name="pageSize" class="cc-dropdown-native-select" data-cc-dropdown-native-select aria-label="Page size" data-release-assets-live-page-size');
      expect(res.text).toContain('class="app-dialog-form project-form release-assets-filter-dialog-form"');
      const ids = [...res.text.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
      expect(new Set(ids).size).toBe(ids.length);

      expect(getCandidateSection(res.text)).toContain(fixture.sourceAsset.filename);
      expect(getCandidateSection(res.text)).toContain(fixture.otherAsset.filename);
      expect(getBulkSelectionSection(res.text)).toContain(fixture.sourceAsset.filename);
      expect(getBulkSelectionSection(res.text)).toContain(fixture.otherAsset.filename);
    });

    it('preserves the active category while filtering release assets', async () => {
      const fixture = await setupCategoryFilterRelease();
      const res = await agent
        .get(`${fixture.releaseLocation}/assets?selection=all&category=${fixture.sourceCategory.id}`)
        .expect(200);

      expect(selectedFilterValueAllowEmpty(res.text, 'release-asset-category-filter-options', 'category'))
        .toBe(String(fixture.sourceCategory.id));

      const candidateSection = getCandidateSection(res.text);
      expect(candidateSection).toContain(fixture.sourceAsset.filename);
      expect(candidateSection).not.toContain(fixture.otherAsset.filename);

      const bulkSection = getBulkSelectionSection(res.text);
      expect(bulkSection).toContain(fixture.sourceAsset.filename);
      expect(bulkSection).not.toContain(fixture.otherAsset.filename);
      expect(res.text).toContain(`action="/releases/${fixture.releaseId}/assets"`);
      expect(bulkSection).toContain('name="selectedAssetIds"');
      expect(res.text).toContain('Save asset selection');
    });

    it('keeps selected assets from other categories through a filtered save', async () => {
      const fixture = await setupCategoryFilterRelease();

      await agent
        .post(`${fixture.releaseLocation}/assets`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${fixture.sourceAsset.id}`)
        .send(`selectedAssetIds[]=${fixture.otherAsset.id}`)
        .send('roles[]=primary')
        .send('roles[]=attachment')
        .send('sortOrder[]=0')
        .send('sortOrder[]=1')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Keep one unselected asset in the active category so the filtered
      // The filtered release asset collection remains observable after both
      // category assets are selected.
      fs.writeFileSync(path.join(fixture.projectDir, 'source-candidate.txt'), 'candidate');
      await agent
        .post(`/projects/${fixture.projectId}/scan`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      // The scan fixture may re-derive category metadata; restore the
      // explicitly assigned categories before asserting filtered membership.
      db.prepare('UPDATE assets SET category_id = ? WHERE id = ?')
        .run(fixture.sourceCategory.id, fixture.sourceAsset.id);
      db.prepare('UPDATE assets SET category_id = ? WHERE id = ?')
        .run(fixture.otherCategory.id, fixture.otherAsset.id);
      const candidateAsset = createAssetRepository(db)
        .findByProjectId(fixture.projectId)
        .find((asset) => asset.filename === 'source-candidate.txt');
      db.prepare('UPDATE assets SET category_id = ? WHERE id = ?')
        .run(fixture.sourceCategory.id, candidateAsset.id);

      const res = await agent
        .get(`${fixture.releaseLocation}/assets?selection=all&category=${fixture.sourceCategory.id}`)
        .expect(200);

      const candidateSection = getCandidateSection(res.text);
      expect(candidateSection).toContain('class="asset-grid"');
      expect(candidateSection).toContain(candidateAsset.filename);
      expect(candidateSection).not.toContain(fixture.otherAsset.filename);

      const bulkSection = getBulkSelectionSection(res.text);
      expect(bulkSection).toContain(fixture.sourceAsset.filename);
      expect(bulkSection).not.toContain(fixture.otherAsset.filename);
      expect(getCheckedBulkAssetIds(res.text)).toEqual([fixture.sourceAsset.id]);
      expect(res.text).toContain(`name="selectedAssetIds" value="${fixture.otherAsset.id}"`);

      const save = agent
        .post(`${fixture.releaseLocation}/assets`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${fixture.sourceAsset.id}`)
        .send(`selectedAssetIds[]=${fixture.otherAsset.id}`);
      await save
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(getReleaseAssets(db, fixture.releaseId)).toEqual([
        { release_id: fixture.releaseId, asset_id: fixture.sourceAsset.id, role: 'primary', sort_order: 0, created_at: expect.any(String) },
        { release_id: fixture.releaseId, asset_id: fixture.otherAsset.id, role: 'attachment', sort_order: 1, created_at: expect.any(String) },
      ]);
    });

    it('renders an empty category result without breaking the selection form', async () => {
      const fixture = await setupCategoryFilterRelease();
      const res = await agent
        .get(`${fixture.releaseLocation}/assets?selection=all&category=${fixture.emptyCategory.id}`)
        .expect(200);

      expect(selectedFilterValueAllowEmpty(res.text, 'release-asset-category-filter-options', 'category'))
        .toBe(String(fixture.emptyCategory.id));
      expect(res.text).toContain('0 project assets match the current filters.');

      expect(res.text).toMatch(/<h2\b[^>]*>No matching project assets<\/h2>/);
      expect(res.text.indexOf('0 project assets match the current filters.')).toBeLessThan(
        res.text.indexOf('No matching project assets'),
      );
      expect(getBulkSelectionSection(res.text)).toBe('');
      expect(res.text).toContain('id="release-assets-form"');
      expect(res.text).toContain('Save asset selection');
    });

    it('uses shared disclosures for filtered category and extension state while preserving view context', async () => {
      const fixture = await setupCategoryFilterRelease();
      const res = await agent
        .get(`${fixture.releaseLocation}/assets?category=${fixture.sourceCategory.id}&extension=txt&view=list&page=3`)
        .expect(200);
      const categoryDisclosure = filterDisclosureHtml(res.text, 'release-asset-category-filter-options');
      const extensionDisclosure = filterDisclosureHtml(res.text, 'release-asset-extension-filter-options');

      expect(categoryDisclosure).toContain('aria-label="Category filter: Filter Source (1)"');
      expect(categoryDisclosure).toContain('class="asset-filter-multiselect-summary-current">Filter Source (1)</span>');
      expect(categoryDisclosure).toMatch(new RegExp(`name="category"[^>]+value="${fixture.sourceCategory.id}"[^>]*checked`));
      expect(categoryDisclosure).toContain('>All categories (2)</span>');
      expect(categoryDisclosure).toContain('>Filter Source (1)</span>');
      expect(categoryDisclosure).toContain('>Filter Other (1)</span>');
      expect(categoryDisclosure).toContain('>Filter Empty (0)</span>');

      expect(extensionDisclosure).toContain('aria-label="Extension filter: .txt"');
      expect(extensionDisclosure).toContain('class="asset-filter-multiselect-summary-current">.txt</span>');
      expect(extensionDisclosure).toMatch(/name="extension"[^>]+value="txt"[^>]*checked/);
      expect(extensionDisclosure).toContain('>All extensions</span>');
      expect(extensionDisclosure).toContain('>.txt</span>');

      const form = res.text.match(/<form id="release-assets-filter"[^>]*>[\s\S]*?<\/form>/)?.[0] || '';
      expect(form).toContain('<input type="hidden" name="view" value="list">');
      expect(form).not.toContain('name="page"');
      expect(res.text).not.toMatch(/<select[^>]+id="asset-(category|extension)"/);
    });
  });

  // ─── Phase 9-5: Exact rendered release asset rows ─────────────────────

  describe('Phase 9-5 exact rendered candidate rows', () => {
    async function setupVariedAssets() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Exact+Candidate+Rows')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'exact-candidate-rows';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);

      // Write files in non-sorted order to test sorting
      fs.writeFileSync(path.join(projectDir, 'gamma.txt'), 'gamma');
      fs.writeFileSync(path.join(projectDir, 'alpha.png'), 'alpha');
      fs.writeFileSync(path.join(projectDir, 'BETA.png'), 'beta');
      fs.writeFileSync(path.join(projectDir, 'gamma.png'), 'gamma');
      fs.writeFileSync(path.join(projectDir, 'alpha.txt'), 'alpha');
      fs.writeFileSync(path.join(projectDir, 'beta.txt'), 'beta');
      fs.writeFileSync(path.join(projectDir, 'selected.txt'), 'selected');
      fs.writeFileSync(path.join(projectDir, 'missing.txt'), 'missing');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));
      const byFilename = (name) => allAssets.find((a) => a.filename === name);

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Exact+Candidate+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select one asset
      await agent
        .post(`${releaseLocation}/assets`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${byFilename('selected.txt').id}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Mark missing.txt as missing
      assetRepo.markMissingByProjectIdAndPathNotIn(Number(projectId), [
        'gamma.txt', 'alpha.png', 'BETA.png', 'gamma.png', 'alpha.txt', 'beta.txt', 'selected.txt'
      ]);

      return { releaseLocation, releaseId, byFilename, allAssets, projectId, assetRepo };
    }

    it('renders present project assets with direct membership controls', async () => {
      const { releaseLocation, byFilename } = await setupVariedAssets();
      const res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);
      const candidateSection = getCandidateSection(res.text);
      const imageTile = getCandidateTile(res.text, 'alpha.png');
      const fallbackTile = getCandidateTile(res.text, 'alpha.txt');

      expect(candidateSection).toContain('<ul class="asset-grid"');
      expect(candidateSection).not.toContain('<table class="data-table">');
      expect(getCandidateTiles(res.text)).toHaveLength(7);

      expect(imageTile).toContain(`id="release-asset-select-${byFilename('alpha.png').id}"`);
      expect(imageTile).toContain('alpha.png');
      // Unselected membership is conveyed by the unchecked checkbox and the
      // unselected card state, not by a verbose badge.
      expect(imageTile).toMatch(/<input[^>]*type="checkbox"[^>]*id="release-asset-select-\d+"[^>]*>/);
      expect(imageTile).not.toMatch(/<input[^>]*type="checkbox"[^>]*id="release-asset-select-\d+"[^>]*\bchecked\b/);
      expect(imageTile).not.toContain('Not selected');

      expect(fallbackTile).not.toContain('<img');
      expect(fallbackTile).toContain('alpha.txt');

      const bulkSection = getBulkSelectionSection(res.text);
      expect(bulkSection).toContain(`id="release-asset-select-${byFilename('selected.txt').id}"`);
      expect(bulkSection).toMatch(new RegExp(`id="release-asset-select-${byFilename('selected.txt').id}"[\\s\\S]*?checked`));
      expect(candidateSection).toContain('selected.txt');
    });

    it('renders exact candidate asset IDs and sequence', async () => {
      const { releaseLocation, byFilename } = await setupVariedAssets();
      const res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);

      const candidateSection = getCandidateSection(res.text);

      // Extract full filenames from the release asset information panels.
      const filenameRe = /<dt>Filename<\/dt>\s*<dd>([^<]+)<\/dd>/g;
      const filenames = [];
      let m;
      while ((m = filenameRe.exec(candidateSection)) !== null) {
        filenames.push(m[1]);
      }

      // Extract rendered asset IDs from the card data attributes.
      const idRe = /data-asset-id="(\d+)"/g;
      const ids = [];
      while ((m = idRe.exec(candidateSection)) !== null) {
        ids.push(Number(m[1]));
      }

      // Expected order: filename COLLATE NOCASE, extension, asset ID
      expect(filenames).toEqual(['alpha.png', 'alpha.txt', 'BETA.png', 'beta.txt', 'gamma.png', 'gamma.txt', 'selected.txt']);

      // Verify each rendered ID matches the corresponding asset.
      expect(ids[0]).toBe(byFilename('alpha.png').id);
      expect(ids[1]).toBe(byFilename('alpha.txt').id);
      expect(ids[2]).toBe(byFilename('BETA.png').id);
      expect(ids[3]).toBe(byFilename('beta.txt').id);
      expect(ids[4]).toBe(byFilename('gamma.png').id);
      expect(ids[5]).toBe(byFilename('gamma.txt').id);
      expect(ids[6]).toBe(byFilename('selected.txt').id);
    });

    it('asset ID is the tie-breaker when filename and extension are identical', async () => {
      const { releaseLocation, projectId } = await setupVariedAssets();

      // Insert two assets with the same case-folded filename and same extension
      // so that only asset ID determines their relative order.
      // Direct DB insert is needed because on Windows, 'dup.txt' and 'DUP.txt'
      // cannot coexist in the same directory.
      const insertAsset = (filename) => db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename, extension,
                            mime_type, size_bytes, modified_at,
                            is_present, last_seen_at, missing_since)
        VALUES (?, ?, ?, 'txt', 'text/plain', 100, NULL, 1, datetime('now'), NULL)
        RETURNING id
      `).get(projectId, `subdir/${filename}`, filename);

      // Insert them one at a time — the second will have a higher id.
      const lowerId = insertAsset('dup.txt').id;
      const higherId = insertAsset('DUP.txt').id;
      expect(higherId).toBeGreaterThan(lowerId);

      const res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);
      const candidateSection = getCandidateSection(res.text);

      // Extract display filenames and IDs
      const filenameRe = /<dt>Filename<\/dt>\s*<dd>([^<]+)<\/dd>/g;
      const filenames = [];
      let m;
      while ((m = filenameRe.exec(candidateSection)) !== null) {
        filenames.push(m[1]);
      }

      const idRe = /data-asset-id="(\d+)"/g;
      const ids = [];
      while ((m = idRe.exec(candidateSection)) !== null) {
        ids.push(Number(m[1]));
      }

      // Find the positions of our tie-break test assets
      const lowerIdx = ids.indexOf(lowerId);
      const higherIdx = ids.indexOf(higherId);
      expect(lowerIdx).toBeGreaterThanOrEqual(0);
      expect(higherIdx).toBeGreaterThanOrEqual(0);

      // dup.txt (lower id) must come before DUP.txt (higher id) because
      // COLLATE NOCASE makes "dup" == "DUP", extension is same ("txt"),
      // and THEN a.id ASC determines the order
      expect(lowerIdx).toBeLessThan(higherIdx);

      // Verify the filenames are in the right positions
      expect(filenames[lowerIdx]).toBe('dup.txt');
      expect(filenames[higherIdx]).toBe('DUP.txt');

      // Also assert: if we swap the assertion (higher before lower), it must fail
      // as a self-check that the order is intentional
      expect(ids.indexOf(higherId)).toBeGreaterThan(ids.indexOf(lowerId));
    });

    it('selected asset remains visible with selected membership state', async () => {
      const { releaseLocation, byFilename } = await setupVariedAssets();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      const candidateSection = getCandidateSection(res.text);
      expect(candidateSection).toContain(byFilename('selected.txt').filename);
      expect(candidateSection).toMatch(new RegExp(`id="release-asset-select-${byFilename('selected.txt').id}"[\\s\\S]*?\\bchecked\\b`));
    });

    it('missing unselected asset is absent from the eligible collection', async () => {
      const { releaseLocation, byFilename } = await setupVariedAssets();
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      const candidateSection = getCandidateSection(res.text);
      expect(candidateSection).not.toContain(byFilename('missing.txt').filename);
    });

    it('same-project present unselected assets appear in the collection', async () => {
      const { releaseLocation, byFilename } = await setupVariedAssets();
      const res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);

      const candidateSection = getCandidateSection(res.text);
      expect(candidateSection).toContain(byFilename('alpha.png').filename);
      expect(candidateSection).toContain(byFilename('gamma.txt').filename);
    });

    it('asset total matches rendered count', async () => {
      const { releaseLocation } = await setupVariedAssets();
      const res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);

      const candidateSection = getCandidateSection(res.text);

       // Count cards = number of rendered asset IDs.
       const filenameRe = /data-asset-id="\d+"/g;
      let count = 0;
      while (filenameRe.exec(candidateSection) !== null) count++;

       expect(count).toBe(7);
      const totalMatch = res.text.match(/(\d+) project asset[s]? match(?:es)? the current filters/);
      expect(totalMatch).not.toBeNull();
       expect(Number(totalMatch[1])).toBe(7);
    });
  });

  // ─── Phase 9-5: Rendered count/page parity ──────────────────────────

  describe('Phase 9-5 rendered count and page parity', () => {
    // P3-C4: opt-in zz-pad-NN.txt fillers so supported sizes still paginate.
    async function setupCountTestAssets({ fillers = 0 } = {}) {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Count+Parity+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'count-parity-test';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);

      // Create 10 files with varied names and extensions
      const files = [
        'alpha.png', 'alpha.txt', 'beta.png', 'beta.txt',
        'gamma.png', 'gamma.txt', 'delta.docx', 'epsilon.pdf',
        'zeta.jpg', 'eta.svg'
      ];
      for (const f of files) {
        fs.writeFileSync(path.join(projectDir, f), f);
      }
      for (let index = 0; index < fillers; index++) {
        fs.writeFileSync(path.join(projectDir, `zz-pad-${String(index).padStart(2, '0')}.txt`), `pad ${index}`);
      }
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const allAssets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Count+Parity+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      return { projectId, releaseLocation, releaseId, allAssets };
    }

    it('no filter — rendered row count equals page size', async () => {
      const { releaseLocation } = await setupCountTestAssets({ fillers: 20 });
      // P3-C4: pageSize=10 should show 10 rows, total=30, pageCount=3
      const res = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=10`).expect(200);

      const rowCount = getCandidateTiles(res.text).length;
      expect(rowCount).toBe(10);

      expect(res.text).toContain('30 project assets match the current filters.');
      expect(res.text).toContain('Page 1 of 3');
      const controlsPosition = res.text.indexOf('class="asset-viewer-display-controls"');
      const countPosition = res.text.indexOf('30 project assets match the current filters.');
      const collectionStart = res.text.indexOf('<ul class="asset-grid"', countPosition);
      const paginationPosition = res.text.indexOf('<nav class="pagination" aria-label="Release asset pages">');
      expect(controlsPosition).toBeLessThan(countPosition);
      expect(countPosition).toBeLessThan(collectionStart);
      expect(collectionStart).toBeLessThan(paginationPosition);
    });

    it('filename search — correct count and single page', async () => {
      const { releaseLocation } = await setupCountTestAssets();
      const res = await agent.get(`${releaseLocation}/assets?selection=all&search=alpha`).expect(200);

      const rowCount = getCandidateTiles(res.text).length;

      // alpha.png and alpha.txt
      expect(rowCount).toBe(2);
      expect(res.text).toContain('2 project assets match the current filters.');
    });

    it('extension filter — correct count and page count', async () => {
      const { releaseLocation } = await setupCountTestAssets({ fillers: 12 });
      const res = await agent.get(`${releaseLocation}/assets?selection=all&extension=txt&pageSize=10`).expect(200);

      const rowCount = getCandidateTiles(res.text).length;

      // P3-C4: alpha.txt, beta.txt, gamma.txt + 12 fillers — 15 total, pageSize=10 → page 1 shows 10, pageCount=2
      expect(rowCount).toBe(10);
      expect(res.text).toContain('15 project assets match the current filters.');
      expect(res.text).toContain('Page 1 of 2');
    });

    it('combined search + extension — correct counts', async () => {
      const { releaseLocation } = await setupCountTestAssets();
      const res = await agent.get(`${releaseLocation}/assets?selection=all&search=alpha&extension=png`).expect(200);

      const rowCount = getCandidateTiles(res.text).length;

      // alpha.png only
      expect(rowCount).toBe(1);
      expect(res.text).toContain('1 project asset matches the current filters.');
    });

    it('page beyond final page falls back to last page', async () => {
      const { releaseLocation, releaseId } = await setupCountTestAssets({ fillers: 20 });
      const res = await agent.get(`${releaseLocation}/assets?selection=all&pageSize=10&page=999`).expect(200);

      expect(res.text).toContain('Page 3 of 3');

      // Parse Previous link — should point to page 2 (clamped from 999)
      const prevMatch = res.text.match(/href="([^"]*)"[^>]*>Previous</);
      expect(prevMatch).not.toBeNull();
      const prevUrl = new URL(prevMatch[1].replace(/&amp;/g, '&'), 'http://localhost');
      expect(prevUrl.pathname).toBe(`/releases/${releaseId}/assets`);
      expect(prevUrl.searchParams.get('page')).toBe('2');
      expect(prevUrl.searchParams.get('pageSize')).toBe('10');
      expect([...prevUrl.searchParams.keys()].sort()).toEqual(['page', 'pageSize', 'selection']);

      // No Next link on the final page
      const nextMatch = res.text.match(/href="([^"]*)"[^>]*>Next</);
      expect(nextMatch).toBeNull();

      // No link carries the unbounded requested page
      expect(res.text).not.toContain('page=999');
    });
  });

  // ─── Phase 9-5: Malformed cross-project HTTP fixture ────────────────

  describe('Phase 9-5 malformed cross-project HTTP fixture', () => {
    it('malformed junction row does not hide valid candidates', async () => {
      // Create project A with assets
      const projARes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Malformed+A')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectAId = projARes.headers.location.replace('/projects/', '');
      const slugA = 'malformed-a';
      const projectDirA = getProjectDir(projectsRoot, projectAId, slugA);
      fs.writeFileSync(path.join(projectDirA, 'alpha.png'), 'alpha');
      fs.writeFileSync(path.join(projectDirA, 'beta.png'), 'beta');
      await agent.post(`/projects/${projectAId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      // Create project B with an asset
      const projBRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Malformed+B')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectBId = projBRes.headers.location.replace('/projects/', '');
      const slugB = 'malformed-b';
      const projectDirB = getProjectDir(projectsRoot, projectBId, slugB);
      fs.writeFileSync(path.join(projectDirB, 'cross.txt'), 'cross');
      await agent.post(`/projects/${projectBId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assetsA = assetRepo.findByProjectId(Number(projectAId));
      const assetsB = assetRepo.findByProjectId(Number(projectBId));

      // Create release in project A
      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectAId}`)
        .send('title=Malformed+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select one valid asset from project A
      await agent
        .post(`${releaseLocation}/assets`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetsA[0].id}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      // Directly insert a malformed junction row (project B asset on project A release)
      db.prepare(
        'INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)'
      ).run(releaseId, assetsB[0].id, 'attachment', 99);

      // Fetch candidate page
      const res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);

      const candidateSection = getCandidateSection(res.text);

      // The malformed row should not hide the valid candidate (beta.png from project A)
      expect(candidateSection).toContain('beta.png');
    });

    it('selected and available sections remain consistent with ownership', async () => {
      // Create a clean project and release
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Consistency+Check')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');
      const slug = 'consistency-check';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'valid1.txt'), 'v1');
      fs.writeFileSync(path.join(projectDir, 'valid2.txt'), 'v2');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Consistency+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));

      // Select valid2.txt
      await agent
        .post(`${releaseLocation}/assets`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assets[1].id}`)
        .send('roles[]=preview')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      const res = await agent.get(`${releaseLocation}/assets?selection=all`).expect(200);

      // Selected section should show the selected asset
      const releaseAssetSection = getCandidateSection(res.text);
      expect(releaseAssetSection).toContain('valid2.txt');

      // The unified collection should show the unselected asset.
      const candidateSection = getCandidateSection(res.text);
      expect(candidateSection).toContain('valid1.txt');
      expect(candidateSection).toContain('valid2.txt');
      expect(candidateSection).toMatch(new RegExp(`id="release-asset-select-${assets[1].id}"[\\s\\S]*?\\bchecked\\b`));
    });
  });

  // ─── Phase 9-5: Read-only control visibility ────────────────────────

  describe('Phase 9-5 read-only control visibility', () => {
    async function setupReadOnlyRelease(status, archiveAction = null) {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Read+Only+Test')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const slug = 'read-only-test';
      const projectDir = getProjectDir(projectsRoot, projectId, slug);
      fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
      await agent.post(`/projects/${projectId}/scan`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const assetRepo = createAssetRepository(db);
      const assets = assetRepo.findByProjectId(Number(projectId));

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Read+Only+Release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      if (status === 'published') {
        setProjectStatusForReleaseTest(db, releaseLocation, 'ready');
      }

      // Select the asset
      await agent
        .post(`${releaseLocation}/assets`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assets[0].id}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      if (status === 'published') {
        await agent
          .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .send('publishedDate=2025-06-15')
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .expect(302);
      } else if (status === 'archived-release') {
        await agent
          .post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);
      } else if (status === 'archived-parent') {
        await agent
          .post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
          .expect(302);
      }

      return { releaseLocation, releaseId, asset: assets[0] };
    }

    async function assertNoMutationControls(releaseLocation) {
      const res = await agent.get(`${releaseLocation}/assets`).expect(200);

      expect(res.text).not.toContain('data-release-assets-live-page-size-form');
      expect(res.text).not.toContain('id="asset-page-size"');

      // No Add forms
      const addForms = res.text.match(/action="[^"]*\/assets\/add"/g);
      expect(addForms).toBeNull();

      // No Remove Selected forms
      const removeForms = res.text.match(/action="[^"]*\/remove-selected"/g);
      expect(removeForms).toBeNull();

      // No role-update forms/selects
      const roleForms = res.text.match(/action="[^"]*\/role"/g);
      expect(roleForms).toBeNull();

      // No Move Up forms/buttons
      const moveUpForms = res.text.match(/action="[^"]*\/move-up"/g);
      expect(moveUpForms).toBeNull();

      // No Move Down forms/buttons
      const moveDownForms = res.text.match(/action="[^"]*\/move-down"/g);
      expect(moveDownForms).toBeNull();

      // The legacy Save asset selection button must also be absent
      expect(res.text).not.toContain('Save asset selection');

      // No bulk-selection form (POST to /releases/:id/assets)
      const bulkFormAction = res.text.match(/method="post"[^>]*action="\/releases\/\d+\/assets"/g);
      expect(bulkFormAction).toBeNull();

      // No bulk-selection checkboxes
      expect(res.text).not.toContain('class="asset-checkbox"');

      // No role selects in the bulk form
      expect(res.text).not.toContain('class="asset-role"');

      // No sort-order inputs in the bulk form
      expect(res.text).not.toContain('class="asset-sort-order"');

      // No checkbox-toggle script (the <script> block after the form)
      expect(res.text).not.toContain('asset-checkbox');

      return res;
    }

    it('published release has no mutation controls', async () => {
      const { releaseLocation } = await setupReadOnlyRelease('published');
      await assertNoMutationControls(releaseLocation);
    });

    it('archived release has no mutation controls', async () => {
      const { releaseLocation } = await setupReadOnlyRelease('archived-release');
      await assertNoMutationControls(releaseLocation);
    });

    it('archived parent has no mutation controls', async () => {
      const { releaseLocation } = await setupReadOnlyRelease('archived-parent');
      await assertNoMutationControls(releaseLocation);
    });
  });

  // ─── Phase 10.5: Remaining defect corrections ──────────────────────────

  describe('release detail archive action deduplication', () => {
    async function createEligibleRelease() {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Dedup+Archive+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Dedup+Archive+Release')
        .send('status=tbd')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      return { projectId, releaseLocation: createRes.headers.location };
    }

    it('renders exactly one archive form for an eligible release inside the Edit dialog', async () => {
      const { releaseLocation } = await createEligibleRelease();
      const res = await agent.get(releaseLocation).expect(200);
      const editDialog = res.text.match(/<dialog id="release-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      const editForm = editDialog.match(/<form id="release-edit-form"[\s\S]*?<\/form>/)?.[0] || '';

      const archiveForms = (editDialog.match(/<form\b[^>]*>/g) || [])
        .filter((form) => form.match(/\saction="([^"]*)"/)?.[1] === `${releaseLocation}/archive`);
      expect(archiveForms).toHaveLength(1);
      expect(archiveForms[0]).toMatch(/\smethod="post"(?:\s|>)/);
      expect(editDialog).toContain('Release actions');
      expect(editDialog).toContain('notes-workspace-disclosure--archive');
      expect(editDialog).toContain('data-confirm="Archive this release? This cannot be undone."');
      expect(editForm).not.toMatch(/action="\/releases\/\d+\/(?:archive|delete)"/);
    });

    it('detail no longer renders the standalone Danger Zone', async () => {
      const { releaseLocation } = await createEligibleRelease();
      const res = await agent.get(releaseLocation).expect(200);

      expect(res.text).not.toContain('destructive-section');
      expect(res.text).not.toContain('Danger zone');
    });

    it('heading-level area does not contain a second archive form', async () => {
      const { releaseLocation } = await createEligibleRelease();
      const res = await agent.get(releaseLocation).expect(200);

      // The page heading keeps only navigation and Review & Publish; Edit is an icon action below it.
      const headingMatch = res.text.match(/<header class="page-heading">[\s\S]*?<\/header>/);
      const actionMatch = res.text.match(/<nav class="project-detail-action-toolbar" aria-label="Release actions">[\s\S]*?<\/nav>/);
      expect(headingMatch).not.toBeNull();
      expect(headingMatch[0]).not.toContain('/archive');
      expect(actionMatch).not.toBeNull();
      expect(actionMatch[0]).toContain('?edit=1');
    });

    it('published release has no archive form', async () => {
      const { releaseLocation } = await setupPublishableRelease(agent, projectsRoot, db, csrfToken);
      // Publish the release
      await agent
        .post(`${releaseLocation}/publish`)
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(releaseLocation).expect(200);
      const archiveForms = res.text.match(/action="\/releases\/\d+\/archive"/g);
      expect(archiveForms).toBeNull();
    });

    it('archived release has no archive form', async () => {
      const projRes = await agent
        .post('/projects')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send('title=Cancel+Archive+Project')
        .send('status=tbd')
        .send('priority=normal')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const projectId = projRes.headers.location.replace('/projects/', '');

      const createRes = await agent
        .post('/releases')
      .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Cancel+Archive+Release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      await agent
        .post(`${createRes.headers.location}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent.get(createRes.headers.location).expect(200);
      const archiveForms = res.text.match(/action="\/releases\/\d+\/archive"/g);
      expect(archiveForms).toBeNull();
    });

    it('already archived release has no archive form', async () => {
      const { releaseLocation } = await createEligibleRelease();
      await agent.post(`${releaseLocation}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(releaseLocation).expect(200);
      const archiveForms = res.text.match(/action="\/releases\/\d+\/archive"/g);
      expect(archiveForms).toBeNull();
    });

    it('project-archived release has no archive form', async () => {
      const { projectId, releaseLocation } = await createEligibleRelease();
      await agent.post(`/projects/${projectId}/archive`)
      .send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);

      const res = await agent.get(releaseLocation).expect(200);
      const archiveForms = res.text.match(/action="\/releases\/\d+\/archive"/g);
      expect(archiveForms).toBeNull();
    });
  });

  describe('release delete endpoint', () => {
    async function createReleaseForDelete() {
      const projectId = await createTestProject('Delete Test Project');
      const createRes = await agent
        .post('/releases')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`projectId=${projectId}`)
        .send('title=Delete+Test+Release')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);
      const releaseLocation = createRes.headers.location;
      const releaseId = Number(releaseLocation.replace('/releases/', ''));
      return { projectId, releaseId, releaseLocation };
    }

    it('Edit dialog contains sibling archive and delete forms for an active release', async () => {
      const { releaseLocation } = await createReleaseForDelete();
      const res = await agent.get(`${releaseLocation}?edit=1`).expect(200);
      const editDialog = res.text.match(/<dialog id="release-edit-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      const editForm = editDialog.match(/<form id="release-edit-form"[\s\S]*?<\/form>/)?.[0] || '';

      expect(editDialog).toContain('data-release-edit-deep-link=');
      expect(editDialog).toContain('settings-section project-edit-dialog-section project-actions project-edit-dialog-actions');
      expect(editDialog).toContain('notes-workspace-disclosure--archive');
      expect(editDialog).toContain('notes-workspace-disclosure--delete');
      expect(editDialog).toMatch(new RegExp(`action="${releaseLocation}/archive"`));
      expect(editDialog).toMatch(new RegExp(`action="${releaseLocation}/delete"`));
      expect(editDialog).toContain('data-confirm="Archive this release? This cannot be undone."');
      expect(editDialog).toContain('data-confirm="Delete this release permanently? This action is irreversible and cannot be undone."');
      expect(editForm).not.toMatch(/action="\/releases\/\d+\/(?:archive|delete)"/);
      expect(res.text).not.toContain('Danger zone');
    });

    it('create page does not render the delete form', async () => {
      const projectId = await createTestProject('Create No Delete Project');
      const res = await agent.get(`/releases/new?projectId=${projectId}`).expect(200);

      expect(res.text).not.toContain('Danger zone');
      expect(res.text).not.toContain('Delete Release');
      expect(res.text).not.toMatch(/action="\/releases\/\d+\/delete"/);
    });

    it('POST /releases/:id/delete removes the release and redirects to /releases', async () => {
      const { releaseId, releaseLocation } = await createReleaseForDelete();

      await agent
        .post(`${releaseLocation}/delete`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302)
        .expect('location', '/releases');

      const after = await agent.get(releaseLocation).expect(404);
      expect(after.status).toBe(404);
      expect(releaseRepository.findById(releaseId)).toBeUndefined();
    });

    it('POST /releases/:id/delete cascades to release_assets without deleting assets', async () => {
      const { projectId, releaseId, releaseLocation } = await createReleaseForDelete();
      const assetRepo = createAssetRepository(db);
      const projectDir = getProjectDir(projectsRoot, projectId, 'delete-test-project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'asset.png'), 'png');
      await agent
        .post(`/projects/${projectId}/scan`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);
      const assets = assetRepo.findByProjectId(projectId);
      const assetId = assets[0].id;

      await agent
        .post(`${releaseLocation}/assets`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .send(`selectedAssetIds[]=${assetId}`)
        .send('roles[]=primary')
        .send('sortOrder[]=0')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302);

      expect(getReleaseAssets(db, releaseId)).toHaveLength(1);

      await agent
        .post(`${releaseLocation}/delete`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(302)
        .expect('location', '/releases');

      expect(getReleaseAssets(db, releaseId)).toHaveLength(0);
      expect(assetRepo.findById(assetId)).toBeDefined();
    });

    it('POST /releases/:id/delete returns 404 for non-existent release', async () => {
      await agent
        .post('/releases/99999/delete')
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(404);
    });

    it('POST /releases/:id/delete renders read-only detail page when release is archived', async () => {
      const { releaseId, releaseLocation } = await createReleaseForDelete();
      await agent
        .post(`${releaseLocation}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent
        .post(`${releaseLocation}/delete`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain(`Release ${releaseId} is archived and cannot be modified.`);
      expect(res.text).toContain('This release is archived and read-only.');
      expect(res.text).toContain('Release details');
      expect(res.text).not.toContain('Create a tracked release record.');
      expect(res.text).not.toContain('id="release-form"');
      expect(res.text).not.toContain('release-edit-dialog');
      expect(res.text).not.toMatch(new RegExp(`action="${releaseLocation}/delete"`));
      expect(releaseRepository.findById(releaseId)).toBeDefined();
    });

    it('POST /releases/:id/delete renders read-only detail page when parent project is archived', async () => {
      const { projectId, releaseId, releaseLocation } = await createReleaseForDelete();
      await agent
        .post(`/projects/${projectId}/archive`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .expect(302);

      const res = await agent
        .post(`${releaseLocation}/delete`)
        .send('_csrf=' + encodeURIComponent(csrfToken))
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(422);
      expect(res.text).toContain(`Project ${projectId} is archived and cannot be modified.`);
      expect(res.text).toContain('The parent project is archived. This release is read-only.');
      expect(res.text).toContain('Release details');
      expect(res.text).not.toContain('Create a tracked release record.');
      expect(res.text).not.toContain('id="release-form"');
      expect(res.text).not.toContain('release-edit-dialog');
      expect(res.text).not.toMatch(new RegExp(`action="${releaseLocation}/delete"`));
      expect(releaseRepository.findById(releaseId)).toBeDefined();
    });
  });

  // ─── Release-backed calendar ───────────────────────────────────────────

  describe('release-backed calendar', () => {
    function createCalendarRelease(projectId, overrides = {}) {
      return releaseRepository.create({
        projectId,
        title: 'Calendar Release',
        description: '',
        notes: '',
        plannedDate: null,
        plannedTime: null,
        patreonUrl: null,
        publishedDate: null,
        ...overrides,
      });
    }

    it('renders a release entry with compact status and a canonical detail link', async () => {
      const projectId = insertProjectDirect(db, { title: 'Calendar Project', status: 'planned' });
      const release = createCalendarRelease(projectId, {
        title: 'Calendar Release',
        plannedDate: '2026-07-14',
        plannedTime: '13:45',
      });

      const res = await agent.get('/calendar?month=2026-07').expect(200);

      expect(res.text).toContain('class="calendar-release-title">Calendar Release</span>');
      expect(res.text).toContain(`href="/releases/${release.id}">Open release</a>`);
      expect(res.text).toContain('13:45');
      expect(res.text).toContain('Planned');
    });

    it('does not render an event for a project without a release record', async () => {
      insertProjectDirect(db, { title: 'Project Without Release' });

      const res = await agent.get('/calendar?month=2026-07').expect(200);

      expect(res.text).toContain('0 matching releases');
      expect(res.text).not.toContain('data-calendar-event');
    });

    it('places a release on its release-owned planned date', async () => {
      const projectId = insertProjectDirect(db, { title: 'Release Date Project' });
      const release = createCalendarRelease(projectId, {
        title: 'Release Date Entry',
        plannedDate: '2026-07-18',
      });

      const res = await agent.get('/calendar?month=2026-07').expect(200);

      const releaseDay = res.text.match(
        /<li class="agenda-day[^>]*>\s*<div class="agenda-day-date">\s*2026-07-18[\s\S]*?<\/li>/,
      )?.[0] || '';
      expect(releaseDay).toContain('class="calendar-release-title">Release Date Entry</span>');
      expect(releaseDay).toContain(`href="/releases/${release.id}">Open release</a>`);
    });

    it('omits archived releases', async () => {
      const projectId = insertProjectDirect(db, { title: 'Archived Calendar Project' });
      const release = createCalendarRelease(projectId, {
        title: 'Archived Calendar Release',
        plannedDate: '2026-07-20',
      });
      releaseRepository.archive(release.id);

      const res = await agent.get('/calendar?month=2026-07').expect(200);

      expect(res.text).not.toContain('Archived Calendar Release');
  });

});


  describe('release quick-schedule endpoint', () => {
    function createScheduleRelease(projectId, overrides = {}) {
      return releaseRepository.create({
        projectId,
        title: 'Schedule Release',
        description: 'Keep description',
        notes: 'Keep notes',
        plannedDate: null,
        plannedTime: null,
        patreonUrl: 'https://example.com/post',
        publishedDate: null,
        ...overrides,
      });
    }

    function postSchedule(id, body, { token = csrfToken } = {}) {
      const req = agent.post(`/releases/${id}/schedule`).set('Accept', 'application/json');
      if (token !== null) req.set('X-CSRF-Token', token);
      return req.send(body);
    }

    function readRelease(id) {
      return db.prepare('SELECT * FROM releases WHERE id = ?').get(id);
    }

    it('schedules an undated release and returns both schedule pairs as JSON', async () => {
      const projectId = insertProjectDirect(db, { title: 'Schedule Project' });
      const release = createScheduleRelease(projectId);
      const before = readRelease(release.id);

      const res = await postSchedule(release.id, {
        plannedDate: '2026-10-13', expectedPlannedDate: null, expectedPlannedTime: null,
      }).expect(200);

      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({
        status: 'success',
        message: 'Release scheduled for 2026-10-13.',
        changed: true,
        release: {
          id: release.id,
          previousSchedule: { plannedDate: null, plannedTime: null },
          schedule: { plannedDate: '2026-10-13', plannedTime: null },
        },
      });
      const after = readRelease(release.id);
      expect(after.planned_date).toBe('2026-10-13');
      expect(after.planned_time).toBeNull();
      expect({ ...after, planned_date: null, updated_at: null }).toEqual({ ...before, updated_at: null });
    });

    it('undoes a schedule with a blank form-encoded date', async () => {
      const projectId = insertProjectDirect(db);
      const release = createScheduleRelease(projectId, { plannedDate: '2026-10-13' });

      const res = await agent.post(`/releases/${release.id}/schedule`)
        .set('Accept', 'application/json')
        .type('form')
        .send({ _csrf: csrfToken, plannedDate: '', plannedTime: '', expectedPlannedDate: '2026-10-13', expectedPlannedTime: '' })
        .expect(200);

      expect(res.body.message).toBe('Release schedule cleared.');
      expect(res.body.release.schedule).toEqual({ plannedDate: null, plannedTime: null });
      expect(readRelease(release.id).planned_date).toBeNull();
    });

    it('reports a no-op without changing updated_at', async () => {
      const projectId = insertProjectDirect(db);
      const release = createScheduleRelease(projectId, { plannedDate: '2026-10-13' });
      db.prepare("UPDATE releases SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(release.id);

      const res = await postSchedule(release.id, {
        plannedDate: '2026-10-13', expectedPlannedDate: '2026-10-13', expectedPlannedTime: null,
      }).expect(200);

      expect(res.body).toMatchObject({ status: 'success', changed: false, message: 'Release schedule unchanged.' });
      expect(readRelease(release.id).updated_at).toBe('2000-01-01 00:00:00');
    });

    it('rejects a missing or invalid CSRF token without changing the release', async () => {
      const projectId = insertProjectDirect(db);
      const release = createScheduleRelease(projectId);
      const body = { plannedDate: '2026-10-13', expectedPlannedDate: null, expectedPlannedTime: null };

      const missing = await postSchedule(release.id, body, { token: null }).expect(403);
      expect(missing.body).toEqual({ status: 'error', message: 'Invalid or missing CSRF token.' });
      await postSchedule(release.id, body, { token: 'not-the-token' }).expect(403);
      expect(readRelease(release.id).planned_date).toBeNull();
    });

    it('returns 422 JSON for invalid input', async () => {
      const projectId = insertProjectDirect(db);
      const release = createScheduleRelease(projectId);

      const invalidDate = await postSchedule(release.id, {
        plannedDate: '2026-02-30', expectedPlannedDate: null, expectedPlannedTime: null,
      }).expect(422);
      expect(invalidDate.body).toMatchObject({
        status: 'error', code: 'VALIDATION_FAILED', errors: { plannedDate: expect.any(String) },
      });
      expect(invalidDate.body.message).toBe(invalidDate.body.errors.plannedDate);

      const wrongType = await postSchedule(release.id, {
        plannedDate: 20261013, expectedPlannedDate: null, expectedPlannedTime: null,
      }).expect(422);
      expect(wrongType.body.errors).toHaveProperty('plannedDate');

      const withTime = await postSchedule(release.id, {
        plannedDate: '2026-10-13', plannedTime: '10:00', expectedPlannedDate: null, expectedPlannedTime: null,
      }).expect(422);
      expect(withTime.body.errors).toHaveProperty('plannedTime');

      const missingExpected = await postSchedule(release.id, { plannedDate: '2026-10-13' }).expect(422);
      expect(Object.keys(missingExpected.body.errors).sort()).toEqual(['expectedPlannedDate', 'expectedPlannedTime']);

      expect(readRelease(release.id).planned_date).toBeNull();
    });

    it('returns 422 JSON for lifecycle rejections', async () => {
      const archivedProjectId = insertProjectDirect(db, { archivedAt: '2026-01-01 00:00:00' });
      const legacyProjectId = insertProjectDirect(db, { status: 'archived' });
      const projectId = insertProjectDirect(db);
      const body = { plannedDate: '2026-10-13', expectedPlannedDate: null, expectedPlannedTime: null };

      const archivedProject = await postSchedule(createScheduleRelease(archivedProjectId).id, body).expect(422);
      expect(archivedProject.body).toMatchObject({ status: 'error', code: 'PROJECT_ARCHIVED', errors: { general: expect.any(String) } });
      const legacyProject = await postSchedule(createScheduleRelease(legacyProjectId).id, body).expect(422);
      expect(legacyProject.body.code).toBe('PROJECT_ARCHIVED');

      const archivedRelease = createScheduleRelease(projectId);
      releaseRepository.archive(archivedRelease.id);
      const archived = await postSchedule(archivedRelease.id, body).expect(422);
      expect(archived.body.code).toBe('RELEASE_ARCHIVED');

      const publishedRelease = createScheduleRelease(projectId, { publishedDate: '2026-10-01' });
      const published = await postSchedule(publishedRelease.id, body).expect(422);
      expect(published.body).toMatchObject({ code: 'VALIDATION_FAILED', errors: { plannedDate: expect.any(String) } });
      expect(readRelease(publishedRelease.id).planned_date).toBeNull();
    });

    it('returns 404 JSON for an unknown or malformed release id', async () => {
      const body = { plannedDate: '2026-10-13', expectedPlannedDate: null, expectedPlannedTime: null };
      const unknown = await postSchedule(999999, body).expect(404);
      expect(unknown.body).toEqual({ status: 'error', code: 'RELEASE_NOT_FOUND', message: 'Release not found.' });
      const malformed = await postSchedule('abc', body).expect(404);
      expect(malformed.body.code).toBe('RELEASE_NOT_FOUND');
    });

    it('returns 409 JSON with the current schedule when the expected schedule is stale', async () => {
      const projectId = insertProjectDirect(db);
      const release = createScheduleRelease(projectId);
      await postSchedule(release.id, { plannedDate: '2026-10-13', expectedPlannedDate: null, expectedPlannedTime: null }).expect(200);
      db.prepare("UPDATE releases SET planned_date = '2026-11-01', planned_time = '18:00' WHERE id = ?").run(release.id);

      const res = await postSchedule(release.id, {
        plannedDate: null, expectedPlannedDate: '2026-10-13', expectedPlannedTime: null,
      }).expect(409);

      expect(res.body).toMatchObject({
        status: 'error',
        code: 'SCHEDULE_CONFLICT',
        message: expect.any(String),
        currentSchedule: { plannedDate: '2026-11-01', plannedTime: '18:00' },
      });
      expect(readRelease(release.id).planned_date).toBe('2026-11-01');
    });
  });

  // B3-F1 / B3-F2: a completed Manage Assets Save confirms itself once on
  // Release Detail. Each completed Save is issued its own unpredictable,
  // single-use, short-lived ticket bound to the release, and its 302 goes to
  // /releases/:id?assetsSaved=<ticket>. Only that ticket's own Release Detail
  // GET shows the confirmation, once; B3-F1's shared release-ID flash cookie
  // no longer proves anything.
  describe('Manage Assets Save success confirmation (B3-F1/B3-F2)', () => {
    const CONFIRMATION = 'Assets saved successfully.';
    const OBSOLETE_FLASH = 'creatorcrate_release_assets_saved';
    const TICKET = /^[A-Za-z0-9_-]{43}$/;
    const TTL_MS = 2 * 60 * 1000;

    async function createSaveFixture(title) {
      const projectId = await createTestProject(title);
      const dir = path.join(projectsRoot, app.locals.projectService.findById(projectId).project_dir);
      for (const name of ['b3-one.png', 'b3-two.png', 'b3-three.png']) fs.writeFileSync(path.join(dir, name), 'png');
      await agent.post(`/projects/${projectId}/scan`).send('_csrf=' + encodeURIComponent(csrfToken)).expect(302);
      const ids = createAssetRepository(db).findByProjectId(projectId)
        .sort((a, b) => a.filename.localeCompare(b.filename)).map((asset) => asset.id);
      expect(ids).toHaveLength(3);
      const release = releaseRepository.create({
        projectId, title: `${title} Release`, description: '', notes: '',
        plannedDate: null, plannedTime: null, patreonUrl: null, publishedDate: null,
      });
      return { projectId, releaseId: release.id, ids };
    }

    const memberIds = (releaseId) => getReleaseAssets(db, releaseId).map((row) => row.asset_id);

    function saveForm(releaseId, ids, { token = csrfToken } = {}) {
      const body = [
        ...(token === null ? [] : [`_csrf=${encodeURIComponent(token)}`]),
        ...ids.map((id) => `selectedAssetIds=${encodeURIComponent(id)}`),
      ].join('&');
      return agent.post(`/releases/${releaseId}/assets`).type('form').send(body);
    }

    const obsoleteFlashCookies = (res) => (res.headers['set-cookie'] || [])
      .filter((value) => value.startsWith(`${OBSOLETE_FLASH}=`));

    // A successful Save's redirect: 302, pathname exactly /releases/:id and a
    // single opaque assetsSaved ticket as the only parameter (so it names no
    // asset), and it sets no confirmation cookie.
    function ticketOf(res, releaseId) {
      expect(res.status).toBe(302);
      const location = new URL(res.headers.location, 'http://creatorcrate.test');
      expect(res.headers.location.startsWith(`/releases/${releaseId}?`)).toBe(true);
      expect(location.pathname).toBe(`/releases/${releaseId}`);
      expect([...location.searchParams.keys()]).toEqual(['assetsSaved']);
      const ticket = location.searchParams.get('assetsSaved');
      expect(ticket).toMatch(TICKET);
      expect(res.headers['set-cookie'] || []).toEqual([]);
      return ticket;
    }

    const detailWith = (releaseId, ticket, client = agent) => client
      .get(`/releases/${releaseId}?assetsSaved=${encodeURIComponent(ticket)}`);

    // The page feedback element, exactly once, and whether it shows the confirmation.
    function feedback(html) {
      const elements = html.match(/<div class="notice notice--success app-dialog-feedback" data-dialog-feedback[^>]*>[\s\S]*?<\/div>/g) || [];
      expect(elements).toHaveLength(1);
      const [element] = elements;
      return {
        element,
        confirmed: !/\shidden[\s>]/.test(element.split('>')[0] + '>') && element.includes(CONFIRMATION),
        count: html.split(CONFIRMATION).length - 1,
      };
    }

    function expectConfirmed(res, label) {
      expect(res.status, label).toBe(200);
      const shown = feedback(res.text);
      expect(shown.confirmed, label).toBe(true);
      expect(shown.count, label).toBe(1);
      expect(shown.element, label).toMatch(/role="status"/);
      expect(shown.element, label).toMatch(/data-release-assets-saved/);
      expect(shown.element, label).toContain(`<p data-dialog-feedback-text>${CONFIRMATION}</p>`);
      expect(res.headers['cache-control'], label).toBe('no-store');
    }

    function expectNotConfirmed(res, label) {
      expect(res.status, label).toBe(200);
      const shown = feedback(res.text);
      expect(shown.confirmed, label).toBe(false);
      expect(shown.count, label).toBe(0);
      expect(shown.element, label).toMatch(/^<div [^>]*\shidden>/);
      expect(shown.element, label).not.toContain('data-release-assets-saved');
    }

    it('confirms a successful Save once through its own ticket: refresh, the same ticket again, a return visit and a direct GET never replay it; a new Save confirms again', async () => {
      const f = await createSaveFixture('B3F1 Confirm Once');
      expectNotConfirmed(await agent.get(`/releases/${f.releaseId}`), 'before any Save');

      const saved = await saveForm(f.releaseId, [f.ids[0], f.ids[1]]);
      const ticket = ticketOf(saved, f.releaseId);
      expect(memberIds(f.releaseId)).toEqual([f.ids[0], f.ids[1]]);

      // The redirected Release Detail GET shows it once and consumes it.
      const shown = await agent.get(saved.headers.location);
      expectConfirmed(shown, 'redirect');
      expect(shown.headers['set-cookie'] || []).toEqual([]);

      // Refresh (the same ticket-bearing URL) and the ticket from another client.
      const refreshed = await agent.get(saved.headers.location);
      expectNotConfirmed(refreshed, 'refresh');
      expect(refreshed.headers['cache-control']).toBe('no-store');
      expectNotConfirmed(await detailWith(f.releaseId, ticket, request(app)), 'consumed ticket, other client');
      // Away, then back.
      await agent.get('/releases').expect(200);
      await agent.get(`/releases/${f.releaseId}/assets`).expect(200);
      expectNotConfirmed(await agent.get(`/releases/${f.releaseId}`), 'return visit');
      // A direct ordinary GET from a fresh client.
      expectNotConfirmed(await request(app).get(`/releases/${f.releaseId}`), 'direct GET');
      // A list-view URL is the same Release Detail and claims nothing either.
      expectNotConfirmed(await agent.get(`/releases/${f.releaseId}?view=list`), 'list view');

      // A second successful Save gets a new ticket and confirms once again.
      const again = await saveForm(f.releaseId, [f.ids[2]]);
      const secondTicket = ticketOf(again, f.releaseId);
      expect(secondTicket).not.toBe(ticket);
      expect(memberIds(f.releaseId)).toEqual([f.ids[2]]);
      expectConfirmed(await agent.get(again.headers.location), 'second Save');
      expectNotConfirmed(await agent.get(again.headers.location), 'refresh after second Save');
      expectNotConfirmed(await agent.get(`/releases/${f.releaseId}`), 'plain GET after second Save');
    });

    // B3-F2a: an earlier Save's unfollowed confirmation never reaches an
    // unrelated Release Detail visit after a later Save failed.
    it('B3-F2a: a pending successful Save followed by a refused (403) Save never confirms an unrelated Release Detail GET', async () => {
      const f = await createSaveFixture('B3F2a Pending');
      const saved = await saveForm(f.releaseId, [f.ids[0]]);
      const ticket = ticketOf(saved, f.releaseId);
      expect(memberIds(f.releaseId)).toEqual([f.ids[0]]);

      // Redirect deliberately not followed. A later Save is refused.
      const refused = await saveForm(f.releaseId, [f.ids[1], f.ids[2]], { token: 'not-a-token' });
      expect(refused.status).toBe(403);
      expect(refused.headers.location).toBeUndefined();
      expect(refused.headers['set-cookie'] || []).toEqual([]);
      expect(refused.text).not.toContain(CONFIRMATION);
      expect(memberIds(f.releaseId)).toEqual([f.ids[0]]);

      // An ordinary Release Detail GET carries no ticket and shows no success.
      expectNotConfirmed(await agent.get(`/releases/${f.releaseId}`), 'unrelated Detail GET');
      expectNotConfirmed(await agent.get(`/releases/${f.releaseId}?view=list`), 'unrelated list-view GET');

      // Actually following the earlier, genuine redirect still confirms it, once.
      expectConfirmed(await agent.get(saved.headers.location), 'original redirect followed later');
      expectNotConfirmed(await agent.get(saved.headers.location), 'original redirect replayed');
      expect(memberIds(f.releaseId)).toEqual([f.ids[0]]);
      expect(ticket).toMatch(TICKET);
    });

    // B3-F2b: overlapping successful Saves each keep their own confirmation.
    it('B3-F2b: two overlapping successful Saves each confirm independently, in either consumption order, and never replay', async () => {
      const f = await createSaveFixture('B3F2b Overlap');

      // A then B, neither redirect followed.
      const a = await saveForm(f.releaseId, [f.ids[0], f.ids[1]]);
      const ticketA = ticketOf(a, f.releaseId);
      expect(memberIds(f.releaseId)).toEqual([f.ids[0], f.ids[1]]);
      const b = await saveForm(f.releaseId, [f.ids[2]]);
      const ticketB = ticketOf(b, f.releaseId);
      // Persisted in submission order: B, the later Save, is the membership.
      expect(memberIds(f.releaseId)).toEqual([f.ids[2]]);
      expect(ticketA).not.toBe(ticketB);

      // An unrelated visit consumes neither.
      expectNotConfirmed(await agent.get(`/releases/${f.releaseId}`), 'unrelated visit while A and B pend');

      expectConfirmed(await agent.get(a.headers.location), 'follow A');
      expectConfirmed(await agent.get(b.headers.location), 'follow B');
      expectNotConfirmed(await agent.get(a.headers.location), 'refresh A');
      expectNotConfirmed(await agent.get(b.headers.location), 'refresh B');
      expectNotConfirmed(await detailWith(f.releaseId, ticketA, request(app)), 'replay A elsewhere');
      expectNotConfirmed(await detailWith(f.releaseId, ticketB, request(app)), 'replay B elsewhere');

      // C then D, consumed D first, each from its own client ("tab").
      const tabC = request.agent(app);
      const tabD = request.agent(app);
      const c = await saveForm(f.releaseId, [f.ids[1]]);
      const d = await saveForm(f.releaseId, [f.ids[0], f.ids[2]]);
      const ticketC = ticketOf(c, f.releaseId);
      const ticketD = ticketOf(d, f.releaseId);
      expect(new Set([ticketA, ticketB, ticketC, ticketD]).size).toBe(4);
      expect(memberIds(f.releaseId)).toEqual([f.ids[0], f.ids[2]]);
      expectConfirmed(await tabD.get(d.headers.location), 'follow D first');
      expectConfirmed(await tabC.get(c.headers.location), 'follow C second');
      expectNotConfirmed(await tabD.get(d.headers.location), 'refresh D');
      expectNotConfirmed(await tabC.get(c.headers.location), 'refresh C');
      expect(memberIds(f.releaseId)).toEqual([f.ids[0], f.ids[2]]);
    });

    it('confirms nothing for a missing, fabricated, malformed, consumed or cross-release ticket, or an obsolete B3-F1 cookie, and never refuses Release Detail for it', async () => {
      const first = await createSaveFixture('B3F2 First');
      const second = await createSaveFixture('B3F2 Second');
      const saved = await saveForm(first.releaseId, [first.ids[0]]);
      const ticket = ticketOf(saved, first.releaseId);

      expectNotConfirmed(await agent.get(`/releases/${first.releaseId}`), 'no ticket');
      // A valid ticket for the first release confirms nothing on the second,
      // and is not spent by being presented there.
      const crossed = await detailWith(second.releaseId, ticket);
      expectNotConfirmed(crossed, 'cross-release ticket');
      expect(crossed.headers['cache-control']).toBe('no-store');

      const fabricated = 'A'.repeat(43);
      const malformed = [
        ['fabricated well-formed', `assetsSaved=${fabricated}`],
        ['empty', 'assetsSaved='],
        ['short', 'assetsSaved=abc'],
        ['too long', `assetsSaved=${ticket}A`],
        ['bad characters', `assetsSaved=${encodeURIComponent(`${ticket.slice(0, 42)}+`)}`],
        ['numeric release ID', `assetsSaved=${first.releaseId}`],
        ['notice code', 'assetsSaved=1'],
        ['repeated', `assetsSaved=${ticket}&assetsSaved=${ticket}`],
        ['bracketed', `assetsSaved[]=${ticket}`],
        ['keyed', `assetsSaved[x]=${ticket}`],
      ];
      for (const [label, query] of malformed) {
        expectNotConfirmed(await agent.get(`/releases/${first.releaseId}?${query}`), label);
      }

      // The obsolete B3-F1 cookie naming this very release claims nothing and
      // is cleared; unrelated cookies are left alone.
      const obsolete = await request(app).get(`/releases/${first.releaseId}`)
        .set('Cookie', `${OBSOLETE_FLASH}=${first.releaseId}; unrelated_cookie=kept`);
      expectNotConfirmed(obsolete, 'obsolete matching cookie');
      const cleared = obsoleteFlashCookies(obsolete);
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatch(new RegExp(`^${OBSOLETE_FLASH}=;`));
      expect(cleared[0]).toMatch(new RegExp(`; Path=/releases/${first.releaseId}(;|$)`));
      expect(cleared[0]).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(obsolete.headers['set-cookie'].filter((value) => value.startsWith('unrelated_cookie='))).toEqual([]);
      expect(obsolete.headers['cache-control']).toBeUndefined();

      // None of the above spent the genuine ticket, which still confirms
      // once, even beside an obsolete cookie, and is then consumed.
      const genuine = await request(app).get(saved.headers.location)
        .set('Cookie', `${OBSOLETE_FLASH}=${first.releaseId}`);
      expectConfirmed(genuine, 'genuine ticket');
      expect(obsoleteFlashCookies(genuine)).toHaveLength(1);
      expectNotConfirmed(await detailWith(first.releaseId, ticket), 'consumed ticket');
      expectNotConfirmed(await detailWith(second.releaseId, ticket), 'consumed ticket on other release');
    });

    it('expires an unfollowed ticket: the Save stays persisted, only the message is lost', async () => {
      const f = await createSaveFixture('B3F2 Expiry');
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
      try {
        const late = await saveForm(f.releaseId, [f.ids[1]]);
        const lateTicket = ticketOf(late, f.releaseId);
        const prompt = await saveForm(f.releaseId, [f.ids[0]]);
        ticketOf(prompt, f.releaseId);
        vi.advanceTimersByTime(TTL_MS - 1);
        expectConfirmed(await agent.get(prompt.headers.location), 'just inside the lifetime');
        vi.advanceTimersByTime(1);
        expectNotConfirmed(await detailWith(f.releaseId, lateTicket), 'expired');
        expectNotConfirmed(await agent.get(late.headers.location), 'expired, again');
      } finally {
        vi.useRealTimers();
      }
      expect(memberIds(f.releaseId)).toEqual([f.ids[0]]);
    });

    it('never issues a ticket for rejected Saves (422 recoverable and fail-closed, 403, 404, 415, read-only), and none spends a pending one', async () => {
      const f = await createSaveFixture('B3F1 Rejected');
      const foreign = await createSaveFixture('B3F1 Foreign');
      // A genuine Save whose redirect is left pending throughout.
      const pending = await saveForm(f.releaseId, [f.ids[0]]);
      ticketOf(pending, f.releaseId);
      const persisted = memberIds(f.releaseId);
      expect(persisted).toEqual([f.ids[0]]);

      const rejections = [
        ['recoverable 422 (foreign ID)', () => saveForm(f.releaseId, [f.ids[1], foreign.ids[0]]), 422],
        // An unknown asset ID keeps its established 404 refusal.
        ['unknown ID 404', () => saveForm(f.releaseId, [f.ids[1], 987654321]), 404],
        ['fail-closed 422 (malformed field)', () => agent.post(`/releases/${f.releaseId}/assets`).type('form')
          .send(`_csrf=${encodeURIComponent(csrfToken)}&selectedAssetIds[__proto__]=3`), 422],
        ['fail-closed 422 (unsafe order)', () => agent.post(`/releases/${f.releaseId}/assets`).type('form')
          .send(`_csrf=${encodeURIComponent(csrfToken)}&selectedAssetIds[]=${f.ids[1]}&roles[]=primary&sortOrder[]=9007199254740992`), 422],
        ['invalid CSRF 403', () => saveForm(f.releaseId, [f.ids[1]], { token: 'not-a-token' }), 403],
        ['missing CSRF 403', () => saveForm(f.releaseId, [f.ids[1]], { token: null }), 403],
        ['unsupported media 415', () => agent.post(`/releases/${f.releaseId}/assets`)
          .set('Content-Type', 'application/json').set('X-CSRF-Token', csrfToken)
          .send(JSON.stringify({ _csrf: csrfToken, selectedAssetIds: [f.ids[1]] })), 415],
        ['unknown release 404', () => saveForm(987654321, [f.ids[1]]), 404],
      ];
      for (const [label, send, status] of rejections) {
        const res = await send();
        expect(res.status, label).toBe(status);
        expect(res.headers.location, label).toBeUndefined();
        expect(res.headers['set-cookie'] || [], label).toEqual([]);
        expect(res.text, label).not.toContain(CONFIRMATION);
        expect(res.text, label).not.toContain('assetsSaved');
        expect(memberIds(f.releaseId), label).toEqual(persisted);
        expectNotConfirmed(await agent.get(`/releases/${f.releaseId}`), `${label}: Release Detail`);
      }

      // Read-only refusal: an archived release refuses a valid Save.
      db.prepare("UPDATE releases SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(f.releaseId);
      const readOnly = await saveForm(f.releaseId, [f.ids[1]]);
      expect(readOnly.status).toBe(422);
      expect(readOnly.headers.location).toBeUndefined();
      expect(readOnly.headers['set-cookie'] || []).toEqual([]);
      expect(readOnly.text).not.toContain(CONFIRMATION);
      expect(memberIds(f.releaseId)).toEqual(persisted);
      const archivedDetail = await agent.get(`/releases/${f.releaseId}`);
      expectNotConfirmed(archivedDetail, 'archived Release Detail');
      expect(archivedDetail.text).toContain('This release is archived and read-only.');

      // The pending genuine Save still confirms, once: no refusal spent it.
      expectConfirmed(await agent.get(pending.headers.location), 'pending genuine Save');
      expectNotConfirmed(await agent.get(pending.headers.location), 'pending genuine Save replayed');
    });

    it('keeps pending tickets bounded: the oldest unfollowed ticket is dropped once 256 newer ones pend', async () => {
      const f = await createSaveFixture('B3F2 Bounded');
      const oldest = await saveForm(f.releaseId, [f.ids[0]]);
      ticketOf(oldest, f.releaseId);
      const second = await saveForm(f.releaseId, [f.ids[1]]);
      ticketOf(second, f.releaseId);
      for (let index = 0; index < 255; index += 1) {
        await saveForm(f.releaseId, [f.ids[index % 3]]).expect(302);
      }
      // 257 issued: the first is evicted, the second (now oldest) is kept.
      expectNotConfirmed(await agent.get(oldest.headers.location), 'evicted ticket');
      expectConfirmed(await agent.get(second.headers.location), 'oldest retained ticket');
      expect(memberIds(f.releaseId)).toEqual([f.ids[254 % 3]]);
    }, 60_000);

    it('keeps tickets per app instance: another app never honours this one\'s ticket', async () => {
      const f = await createSaveFixture('B3F2 Per App');
      const saved = await saveForm(f.releaseId, [f.ids[0]]);
      ticketOf(saved, f.releaseId);
      const otherDataRoot = path.join(tmpDir, 'other-app');
      fs.mkdirSync(otherDataRoot, { recursive: true });
      const { csrfPepper } = ensureAuthEnablement(otherDataRoot);
      // Same database, so the release exists there too, as after a restart.
      const otherApp = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot: otherDataRoot, authState: { csrfPepper } });
      expectNotConfirmed(await request(otherApp).get(saved.headers.location), 'other app instance (restart)');
      expectConfirmed(await agent.get(saved.headers.location), 'issuing app instance');
    });

    it('keeps the archived-parent warning beside the confirmation it cannot replace', async () => {
      const f = await createSaveFixture('B3F1 Coexist');
      const saved = await saveForm(f.releaseId, [f.ids[0]]);
      ticketOf(saved, f.releaseId);
      // The project is archived between the Save and the redirected GET: the
      // warning still renders, separately, and the confirmation does not replace it.
      db.prepare("UPDATE projects SET status = 'archived', archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(f.projectId);
      const shown = await agent.get(saved.headers.location);
      expectConfirmed(shown, 'archived parent');
      expect(shown.text).toContain('The parent project is archived. This release is read-only.');
    });
  });
});

// ─── B-F3: the whole Manage Assets Save POST reads asset state in bounded ─────
// batches. A dedicated verbose connection records every SQL statement SQLite
// executes for the request (including transaction control and the 422
// recovery render), and a prepare wrapper records rows returned per statement.
describe('Manage Assets Save validation SQL bounds (B-F3)', () => {
  const BATCH = 500;
  const VALIDATION = /^SELECT id, project_id, is_present FROM assets WHERE id IN \(/;
  const RECOVERY = /\bWHERE a\.project_id = (?:\?|[\d.]+) AND a\.id IN \(/;
  const PER_ID_ASSET_READ = /^SELECT\b(?=.*\bFROM assets(?: a)?\b)(?=.*\bWHERE (?:a\.)?id = (?:\?|[\d.]+)(?:\s|$))/;
  const MEMBERSHIP_WRITE = /^(?:INSERT|UPDATE|DELETE)\b.*\brelease_assets\b/;
  const ASSET_READ = /^SELECT\b.*\bFROM assets\b/;

  let tmpDir;
  let db;
  let app;
  let agent;
  let csrfToken;
  let tracing;
  let trace;
  let rowLog;
  let projectId;
  let ids;
  let foreignId;
  let service;

  const normalize = (sql) => String(sql).replace(/\s+/g, ' ').trim();

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-b-f3-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.mkdirSync(appDataRoot, { recursive: true });
    tracing = false;
    trace = [];
    rowLog = [];
    db = new Database(path.join(tmpDir, 'test.db'), {
      verbose: (sql) => { if (tracing) trace.push(normalize(sql)); },
    });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    registerSqlFunctions(db);
    runMigrations(db, MIGRATIONS_DIR);
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql, ...args) => {
      const statement = originalPrepare(sql, ...args);
      const text = normalize(sql);
      return new Proxy(statement, {
        get(target, prop, receiver) {
          if (prop === 'all' || prop === 'get') {
            return (...params) => {
              const result = target[prop](...params);
              if (tracing) rowLog.push({ sql: text, rows: prop === 'all' ? result.length : (result ? 1 : 0) });
              return result;
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    ({ agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot));

    projectId = insertProjectDirect(db, { title: 'B-F3 Project' });
    const rows = Array.from({ length: 620 }, (_, index) => {
      const filename = `img-${String(index).padStart(4, '0')}.png`;
      return { relativePath: filename, filename, extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: '2025-01-01T00:00:00Z' };
    });
    ids = createAssetRepository(db).upsertMany(projectId, rows).map((asset) => asset.id);
    const foreignProjectId = insertProjectDirect(db, { title: 'B-F3 Foreign' });
    foreignId = insertAssetDirect(db, foreignProjectId, 'foreign-secret-<i>meta</i>.png').id;
    service = createReleaseService({ db });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRelease(title = 'B-F3 Release') {
    return service.createRelease(projectId, { title, description: '', notes: '', plannedDate: null, patreonUrl: null });
  }

  function membership(releaseId) {
    return db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order, asset_id')
      .all(releaseId)
      .map((row) => [row.asset_id, row.role, row.sort_order]);
  }

  const encode = (entries) => entries
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');

  async function post(releaseId, entries) {
    trace.length = 0;
    rowLog.length = 0;
    tracing = true;
    let res;
    try {
      res = await agent
        .post(`/releases/${releaseId}/assets?pageSize=10`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(encode([['_csrf', csrfToken], ...entries]));
    } finally {
      tracing = false;
    }
    const count = (pattern) => trace.filter((sql) => pattern.test(sql)).length;
    const rowsFor = (pattern) => rowLog.filter((entry) => pattern.test(entry.sql)).reduce((sum, entry) => sum + entry.rows, 0);
    return {
      res,
      sql: {
        validation: count(VALIDATION),
        validationRows: rowsFor(VALIDATION),
        recovery: count(RECOVERY),
        recoveryRows: rowsFor(RECOVERY),
        perIdAssetReads: count(PER_ID_ASSET_READ),
        membershipWrites: count(MEMBERSHIP_WRITE),
        begin: count(/^BEGIN\b/),
        maxAssetRowsPerStatement: Math.max(0, ...rowLog.filter((entry) => ASSET_READ.test(entry.sql)).map((entry) => entry.rows)),
        total: trace.length,
      },
    };
  }

  const membershipEntries = (assetIds) => assetIds.map((id) => ['selectedAssetIds', String(id)]);

  // The Save form's successful controls, as the browser would submit them.
  function retryFormEntries(html) {
    const formStart = html.indexOf('<form id="release-assets-form"');
    expect(formStart).toBeGreaterThan(-1);
    const formEnd = html.indexOf('</form>', formStart);
    const entries = [];
    for (const match of html.matchAll(/<input\b[^>]*>/g)) {
      const attr = (name) => {
        const found = new RegExp(`\\s${name}(?:="([^"]*)")?(?=[\\s>/])`).exec(match[0]);
        return found ? (found[1] ?? '') : undefined;
      };
      const form = attr('form');
      const inside = match.index > formStart && match.index < formEnd;
      const owned = form !== undefined ? form === 'release-assets-form' : inside;
      const name = attr('name');
      if (!owned || name === undefined || attr('disabled') !== undefined) continue;
      if (attr('type') === 'checkbox' && attr('checked') === undefined) continue;
      entries.push([name, (attr('value') ?? '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&amp;/g, '&')]);
    }
    return entries;
  }

  const selectedIds = (entries) => entries.filter(([name]) => name === 'selectedAssetIds').map(([, value]) => Number(value));

  it('rejects a 517-ID Save with a foreign ID: bounded validation and recovery, no writes, draft kept', async () => {
    const release = createRelease();
    service.selectAssets(release.id, [
      { assetId: ids[0], role: 'primary', sortOrder: 0 },
      { assetId: ids[550], role: 'preview', sortOrder: 1 },
      { assetId: ids[10], role: 'attachment', sortOrder: 2 },
    ]);
    const before = membership(release.id);
    const submitted = [...ids.slice(0, 300), foreignId, ...ids.slice(300, 516)];
    expect(submitted).toHaveLength(517);

    const { res, sql } = await post(release.id, membershipEntries(submitted));

    expect(res.status).toBe(422);
    expect(res.text).toContain(`Asset ${foreignId} does not belong to the release&#39;s project.`);
    expect(res.text).not.toContain('foreign-secret');
    expect(membership(release.id)).toEqual(before);
    // Validation: ceil(517 / 500) = 2 ownership/presence statements.
    expect(sql.validation).toBe(2);
    expect(sql.validationRows).toBe(517);
    expect(sql.perIdAssetReads).toBe(0);
    // Recovery: its own project-scoped hydrate batches over the submitted IDs
    // not already on the rendered page (page 1 lists the three saved members,
    // two of them submitted): 515 IDs → 500 + 15. The project scope drops the
    // foreign ID, so 514 rows come back.
    expect(sql.recovery).toBe(2);
    expect(sql.recoveryRows).toBe(514);
    expect(sql.membershipWrites).toBe(0);
    expect(sql.maxAssetRowsPerStatement).toBeLessThanOrEqual(BATCH);
    // Everything else in the request is a fixed set: session/CSRF, release
    // and project lookups, guards, saved membership, page, aggregates,
    // categories and extensions for the recovery render.
    expect(sql.total).toBe(33);

    // The retry form carries every submitted ID exactly once (the foreign ID
    // by ID only); page-visible checkboxes follow the hidden off-page
    // carriers in tree order, so compare as a set. Resubmitting it unchanged
    // is rejected the same way.
    const retry = retryFormEntries(res.text);
    const byId = (a, b) => a - b;
    expect(selectedIds(retry)).toHaveLength(517);
    expect(selectedIds(retry).sort(byId)).toEqual([...submitted].sort(byId));
    const again = await post(release.id, retry.filter(([name]) => name !== '_csrf'));
    expect(again.res.status).toBe(422);
    expect(again.sql.validation).toBe(2);
    expect(again.sql.perIdAssetReads).toBe(0);
    expect(membership(release.id)).toEqual(before);

    // Dropping the foreign ID through the same form saves once.
    const corrected = await post(release.id, retry.filter(([name, value]) => name !== '_csrf' && !(name === 'selectedAssetIds' && value === String(foreignId))));
    expect(corrected.res.status).toBe(302);
    expect(corrected.sql.validation).toBe(2);
    expect(corrected.sql.perIdAssetReads).toBe(0);
    expect(corrected.sql.recovery).toBe(0);
    // Membership-only Save: saved members keep their roles and relative order
    // (ids[550] was never submitted, so it is removed); new IDs append in the
    // order the form submitted them.
    const correctedIds = selectedIds(retry).filter((id) => id !== foreignId);
    const saved = membership(release.id);
    expect(saved).toHaveLength(516);
    expect(saved.slice(0, 2)).toEqual([[ids[0], 'primary', 0], [ids[10], 'attachment', 1]]);
    expect(saved.map(([id]) => id)).toEqual([ids[0], ids[10], ...correctedIds.filter((id) => id !== ids[0] && id !== ids[10])]);
    expect(saved.slice(2).every(([, role], index) => role === 'attachment' && saved[index + 2][2] === index + 2)).toBe(true);
  });

  it('saves a valid 517-ID membership once with bounded validation reads', async () => {
    const release = createRelease();
    const submitted = [...ids.slice(100, 617)].reverse();

    const { res, sql } = await post(release.id, membershipEntries(submitted));

    expect(res.status).toBe(302);
    expectReleaseAssetsSavedLocation(res.headers.location, release.id);
    expect(sql.validation).toBe(2);
    expect(sql.validationRows).toBe(517);
    expect(sql.perIdAssetReads).toBe(0);
    expect(sql.recovery).toBe(0);
    // One atomic replace: a single transaction, one DELETE + 517 guarded INSERTs.
    expect(sql.begin).toBe(1);
    expect(sql.membershipWrites).toBe(1 + 517);
    expect(sql.maxAssetRowsPerStatement).toBeLessThanOrEqual(BATCH);
    // 2 validation + 518 writes + 9 fixed request statements.
    expect(sql.total).toBe(529);
    expect(membership(release.id)).toEqual(submitted.map((id, index) => [id, 'attachment', index]));
  });

  it.each([1, 25, 250, 500, 501, 517])('validates a %i-ID POST with ceil(n / 500) lookups', async (n) => {
    const release = createRelease(`Growth ${n}`);
    const { res, sql } = await post(release.id, membershipEntries(ids.slice(0, n)));
    expect(res.status).toBe(302);
    expect(sql.validation).toBe(Math.ceil(n / BATCH));
    expect(sql.validationRows).toBe(n);
    expect(sql.perIdAssetReads).toBe(0);
    expect(sql.recovery).toBe(0);
    expect(sql.membershipWrites).toBe(1 + n);
    // The rest of the request is the same nine statements at every size.
    expect(sql.total - sql.validation - sql.membershipWrites).toBe(9);
    expect(membership(release.id)).toHaveLength(n);
  });

  it('clears membership on an empty POST with no asset reads', async () => {
    const release = createRelease();
    service.selectAssets(release.id, ids.slice(0, 2).map((assetId) => ({ assetId })), { membershipOnly: true });
    const { res, sql } = await post(release.id, []);
    expect(res.status).toBe(302);
    expect(sql.validation).toBe(0);
    expect(sql.perIdAssetReads).toBe(0);
    // One DELETE plus the same nine fixed request statements.
    expect(sql.total).toBe(10);
    expect(membership(release.id)).toEqual([]);
  });

  it('rejects a 501-ID POST ending in an unknown ID as not found after two lookups', async () => {
    const release = createRelease();
    service.selectAssets(release.id, [{ assetId: ids[3], role: 'primary', sortOrder: 0 }]);
    const unknown = ids.at(-1) + 5000;
    const { res, sql } = await post(release.id, membershipEntries([...ids.slice(0, 500), unknown]));
    expect(res.status).toBe(404);
    expect(sql.validation).toBe(2);
    expect(sql.perIdAssetReads).toBe(0);
    expect(sql.membershipWrites).toBe(0);
    expect(membership(release.id)).toEqual([[ids[3], 'primary', 0]]);
  });

  it('keeps a keyed (B-F2) role/order draft through a batched-validation rejection', async () => {
    const release = createRelease();
    const draft = [...ids.slice(0, 120).map((assetId, index) => ({
      assetId,
      role: index === 5 ? 'primary' : (index === 9 ? 'preview' : 'attachment'),
      sortOrder: 200 - index,
    })), { assetId: foreignId, role: 'attachment', sortOrder: 7 }];
    const entries = [];
    draft.forEach(({ assetId, role, sortOrder }, index) => {
      entries.push(['selectedAssetIds', String(assetId)]);
      entries.push([`roleAssetIds[${index}]`, String(assetId)], [`roles[${index}]`, role], [`sortOrder[${index}]`, String(sortOrder)]);
    });

    const { res, sql } = await post(release.id, entries);

    expect(res.status).toBe(422);
    expect(res.text).toContain(`Asset ${foreignId} does not belong to the release&#39;s project.`);
    expect(res.text).not.toContain('foreign-secret');
    expect(sql.validation).toBe(1);
    expect(sql.perIdAssetReads).toBe(0);
    expect(sql.membershipWrites).toBe(0);
    expect(membership(release.id)).toEqual([]);
    const retry = retryFormEntries(res.text);
    expect(selectedIds(retry)).toEqual(draft.map(({ assetId }) => assetId));
    expect(retry.some(([name]) => /^(roleAssetIds|roles|sortOrder)\b/.test(name))).toBe(false);
    const carriers = retry.filter(([name]) => name === 'roleOrder');
    expect(carriers).toHaveLength(1);
    expect(JSON.parse(carriers[0][1]).map(([assetId, role, sortOrder]) => ({ assetId, role, sortOrder })))
      .toEqual(draft);
  });

  // ─── B-F2R1: a large rejected legacy draft stays resubmittable ─────────────
  // Express's URL-encoded parser refuses more than 1,000 parameters with 413
  // before any route runs. The retry form carries role/order in one compact
  // `roleOrder` field, so it submits (members + 2) fields instead of the
  // expanded keyed carrier's (4 × members + 1).
  describe('large rejected-Save recovery within the parameter limit (B-F2R1)', () => {
    const PARAMETER_LIMIT = 1000;
    const BODY_LIMIT_BYTES = 100 * 1024;

    const compact = (draft) => JSON.stringify(draft.map(({ assetId, role, sortOrder }) => [assetId, role, sortOrder]));
    const carried = (entries) => {
      const carriers = entries.filter(([name]) => name === 'roleOrder');
      expect(carriers).toHaveLength(1);
      return JSON.parse(carriers[0][1]).map(([assetId, role, sortOrder]) => ({ assetId, role, sortOrder }));
    };
    const legacyPositional = (draft) => [
      ...draft.map(({ assetId }) => ['selectedAssetIds[]', String(assetId)]),
      ...draft.map(({ role }) => ['roles[]', role]),
      ...draft.map(({ sortOrder }) => ['sortOrder[]', String(sortOrder)]),
    ];
    // The B-F2 expanded keyed carrier the retry form rendered before B-F2R1.
    const expandedKeyed = (draft) => draft.flatMap(({ assetId, role, sortOrder }, index) => [
      ['selectedAssetIds', String(assetId)],
      [`roleAssetIds[${index}]`, String(assetId)],
      [`roles[${index}]`, role],
      [`sortOrder[${index}]`, String(sortOrder)],
    ]);
    const bodyBytes = (entries) => Buffer.byteLength(encode([['_csrf', csrfToken], ...entries]));
    const withoutCsrf = (entries) => entries.filter(([name]) => name !== '_csrf');
    const savedRoleOrder = (draft) => [...draft]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(({ assetId, role, sortOrder }) => [assetId, role, sortOrder]);

    // n members in a non-ascending sequence with unique explicit orders (7 is
    // coprime with every size used, so (index × 7) mod n is a permutation),
    // the saved Primary and Preview kept, and one invalid role.
    function largeDraft(n, invalidAt = 7) {
      const chosen = [ids[1], ids[0], ...ids.slice(2, n).reverse()];
      return chosen.map((assetId, index) => ({
        assetId,
        role: index === invalidAt ? 'bogus' : (assetId === ids[0] ? 'primary' : (assetId === ids[1] ? 'preview' : 'attachment')),
        sortOrder: (index * 7) % n,
      }));
    }

    function editableRelease(title) {
      const release = createRelease(title);
      service.selectAssets(release.id, [
        { assetId: ids[0], role: 'primary', sortOrder: 0 },
        { assetId: ids[1], role: 'preview', sortOrder: 1 },
        { assetId: ids[610], role: 'attachment', sortOrder: 2 },
      ]);
      return release;
    }

    it('a 300-member legacy draft: 422 retry form fits the parser, unchanged retry is refused, corrected retry saves exact roles/order', async () => {
      const release = editableRelease();
      const before = membership(release.id);
      const draft = largeDraft(300);
      expect(new Set(draft.map(({ sortOrder }) => sortOrder)).size).toBe(300);

      const initial = legacyPositional(draft);
      expect(initial.length + 1).toBe(901);
      const rejected = await post(release.id, initial);
      expect(rejected.res.status).toBe(422);
      expect(rejected.res.text).toContain('data-release-assets-selection-errors');
      expect(rejected.res.text).toContain(`Asset ${draft[7].assetId} has an invalid role &quot;bogus&quot;.`);
      // Role validation precedes the batched asset lookups (B-F3 precedence).
      expect(rejected.sql.validation).toBe(0);
      expect(rejected.sql.perIdAssetReads).toBe(0);
      expect(rejected.sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(before);

      // The rendered retry form: _csrf, one roleOrder, one selectedAssetIds per member.
      const retry = retryFormEntries(rejected.res.text);
      expect(retry.filter(([name]) => name === '_csrf')).toEqual([['_csrf', csrfToken]]);
      expect(retry).toHaveLength(302);
      expect(retry.length).toBeLessThanOrEqual(PARAMETER_LIMIT);
      expect(Buffer.byteLength(encode(retry))).toBeLessThan(BODY_LIMIT_BYTES);
      const retryIds = selectedIds(retry);
      expect(new Set(retryIds).size).toBe(300);
      expect([...retryIds].sort((a, b) => a - b)).toEqual(draft.map(({ assetId }) => assetId).sort((a, b) => a - b));
      expect(retryIds).not.toContain(ids[610]);
      // Each asset keeps its own role and order, in the submitted sequence.
      expect(carried(retry)).toEqual(draft);
      // Was 4 × 300 + 1 = 1,201 fields with the expanded keyed carrier.
      expect(expandedKeyed(draft).length + 1).toBe(1201);

      // Unchanged retry reaches the route and is refused the same way.
      const again = await post(release.id, withoutCsrf(retry));
      expect(again.res.status).toBe(422);
      expect(again.res.text).toContain(`Asset ${draft[7].assetId} has an invalid role &quot;bogus&quot;.`);
      expect(again.sql.validation).toBe(0);
      expect(again.sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(before);
      const second = retryFormEntries(again.res.text);
      expect(carried(second)).toEqual(draft);

      // Correct the invalid role in the carrier; the Save succeeds.
      const correctedDraft = draft.map((entry, index) => (index === 7 ? { ...entry, role: 'attachment' } : entry));
      const corrected = withoutCsrf(second).map(([name, value]) => (name === 'roleOrder' ? [name, compact(correctedDraft)] : [name, value]));
      const saved = await post(release.id, corrected);
      expect(saved.res.status).toBe(302);
      expectReleaseAssetsSavedLocation(saved.res.headers.location, release.id);
      expect(saved.sql.validation).toBe(1);
      expect(saved.sql.perIdAssetReads).toBe(0);
      expect(saved.sql.begin).toBe(1);
      expect(saved.sql.membershipWrites).toBe(1 + 300);
      expect(membership(release.id)).toEqual(savedRoleOrder(correctedDraft));
    });

    it.each([100, 240, 249, 250, 251, 300, 333])('a %i-member rejected legacy draft retries through the parser (no 413)', async (n) => {
      const release = editableRelease(`Size ${n}`);
      const before = membership(release.id);
      const draft = largeDraft(n);
      const rejected = await post(release.id, legacyPositional(draft));
      expect(rejected.res.status).toBe(422);
      const retry = retryFormEntries(rejected.res.text);
      expect(retry).toHaveLength(n + 2);
      expect(Buffer.byteLength(encode(retry))).toBeLessThan(BODY_LIMIT_BYTES);
      expect(carried(retry)).toEqual(draft);

      const again = await post(release.id, withoutCsrf(retry));
      expect(again.res.status).toBe(422);
      expect(again.res.text).toContain(`Asset ${draft[7].assetId} has an invalid role &quot;bogus&quot;.`);
      expect(again.sql.validation).toBe(0);
      expect(again.sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(before);

      // The pre-B-F2R1 expanded keyed carrier for the same draft: 4n + 1
      // fields, refused by the parser from 250 members on.
      const expanded = await post(release.id, expandedKeyed(draft));
      expect(expandedKeyed(draft).length + 1).toBe(4 * n + 1);
      expect(expanded.res.status).toBe(4 * n + 1 > PARAMETER_LIMIT ? 413 : 422);
      expect(expanded.res.text).toContain(4 * n + 1 > PARAMETER_LIMIT ? 'too many parameters' : 'has an invalid role &quot;bogus&quot;.');
      expect(expanded.sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(before);
    });

    it('a 517-member compact draft with a foreign ID: two lookups, 422 with the draft kept, corrected Save writes exact roles/order', async () => {
      const release = editableRelease();
      const before = membership(release.id);
      const draft = [...largeDraft(516, -1), { assetId: foreignId, role: 'attachment', sortOrder: 9999 }];
      const entries = [['roleOrder', compact(draft)], ...draft.map(({ assetId }) => ['selectedAssetIds', String(assetId)])];
      expect(entries.length + 1).toBe(519);
      expect(bodyBytes(entries)).toBeLessThan(BODY_LIMIT_BYTES);

      const rejected = await post(release.id, entries);
      expect(rejected.res.status).toBe(422);
      expect(rejected.res.text).toContain(`Asset ${foreignId} does not belong to the release&#39;s project.`);
      expect(rejected.res.text).not.toContain('foreign-secret');
      expect(rejected.sql.validation).toBe(2);
      expect(rejected.sql.perIdAssetReads).toBe(0);
      expect(rejected.sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(before);
      const retry = retryFormEntries(rejected.res.text);
      expect(retry).toHaveLength(519);
      expect(carried(retry)).toEqual(draft);

      const corrected = withoutCsrf(retry).filter(([name, value]) => !(name === 'selectedAssetIds' && value === String(foreignId)));
      const saved = await post(release.id, corrected);
      expect(saved.res.status).toBe(302);
      expect(saved.sql.validation).toBe(2);
      expect(saved.sql.membershipWrites).toBe(1 + 516);
      // The foreign ID's stale key is ignored.
      expect(membership(release.id)).toEqual(savedRoleOrder(draft.slice(0, 516)));
    });

    it('supports 998 members with a compact carrier (1,000 fields); 999 members exceed the parser limit with 413 and no write', async () => {
      const more = Array.from({ length: 400 }, (_, index) => {
        const filename = `more-${String(index).padStart(4, '0')}.png`;
        return { relativePath: filename, filename, extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: '2025-01-01T00:00:00Z' };
      });
      const all = [...ids, ...createAssetRepository(db).upsertMany(projectId, more).map((asset) => asset.id)];
      const release = editableRelease();
      const before = membership(release.id);
      const draftOf = (n) => all.slice(0, n).map((assetId, index) => ({ assetId, role: index === 0 ? 'primary' : 'attachment', sortOrder: n - index }));
      const entriesOf = (draft) => [['roleOrder', compact(draft)], ...draft.map(({ assetId }) => ['selectedAssetIds', String(assetId)])];

      const over = entriesOf(draftOf(999));
      expect(over.length + 1).toBe(1001);
      const refused = await post(release.id, over);
      expect(refused.res.status).toBe(413);
      expect(refused.sql.validation).toBe(0);
      expect(refused.sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(before);

      const max = draftOf(998);
      const entries = entriesOf(max);
      expect(entries.length + 1).toBe(PARAMETER_LIMIT);
      expect(bodyBytes(entries)).toBeLessThan(BODY_LIMIT_BYTES);
      const saved = await post(release.id, entries);
      expect(saved.res.status).toBe(302);
      expect(saved.sql.validation).toBe(2);
      expect(saved.sql.membershipWrites).toBe(1 + 998);
      expect(membership(release.id)).toEqual(savedRoleOrder(max));
    });

    it('rejects malformed, mixed and over-bound compact carriers as an invalid format with no write', async () => {
      const release = editableRelease();
      const before = membership(release.id);
      const member = String(ids[0]);
      const tooMany = JSON.stringify(Array.from({ length: 1001 }, (_, index) => [ids[0], 'primary', index]));
      const cases = [
        [['roleOrder', '']],
        [['roleOrder', 'not json']],
        [['roleOrder', '{"0":[1,"primary",0]}']],
        [['roleOrder', '[1,"primary",0]']],
        [['roleOrder', `[[${member},"primary"]]`]],
        [['roleOrder', `[[${member},"primary",0,1]]`]],
        [['roleOrder', `[["${member}","primary",0]]`]],
        [['roleOrder', '[[0,"primary",0]]']],
        [['roleOrder', `[[${member},"primary",-1]]`]],
        [['roleOrder', `[[${member},"primary",1.5]]`]],
        [['roleOrder', `[[${member},"primary","0"]]`]],
        [['roleOrder', `[[${member},null,0]]`]],
        [['roleOrder', `[[${member},"primary",0]]`], ['roleOrder', `[[${member},"primary",0]]`]],
        [['roleOrder[0]', `[[${member},"primary",0]]`]],
        [['roleOrder', `[[${member},"primary",0]]`], ['roles[0]', 'primary']],
        [['roleOrder', `[[${member},"primary",0]]`], ['sortOrder[0]', '0']],
        [['roleOrder', `[[${member},"primary",0]]`], ['roleAssetIds[0]', member]],
        [['roleOrder', tooMany]],
      ];
      for (const carrier of cases) {
        const { res, sql } = await post(release.id, [['selectedAssetIds', member], ...carrier]);
        expect(res.status, JSON.stringify(carrier).slice(0, 80)).toBe(422);
        expect(res.text).toContain('Invalid asset selection format.');
        expect(res.text).not.toContain('data-release-assets-submitted-role-order');
        expect(sql.validation).toBe(0);
        expect(sql.membershipWrites).toBe(0);
        expect(membership(release.id)).toEqual(before);
      }
    });

    it('keeps duplicate, foreign, unknown and read-only refusals for compact drafts', async () => {
      const release = editableRelease();
      const before = membership(release.id);
      const roleOrder = ['roleOrder', compact([{ assetId: ids[0], role: 'primary', sortOrder: 0 }, { assetId: ids[2], role: 'attachment', sortOrder: 1 }])];

      const duplicate = await post(release.id, [roleOrder, ['selectedAssetIds', String(ids[0])], ['selectedAssetIds', String(ids[2])], ['selectedAssetIds', String(ids[0])]]);
      expect(duplicate.res.status).toBe(422);
      expect(duplicate.res.text).toContain('Duplicate asset IDs are not allowed.');
      expect(duplicate.sql.membershipWrites).toBe(0);

      // A key cannot smuggle membership: only selectedAssetIds selects.
      const keyOnly = await post(release.id, [['roleOrder', compact([{ assetId: foreignId, role: 'primary', sortOrder: 0 }])], ['selectedAssetIds', String(ids[2])]]);
      expect(keyOnly.res.status).toBe(302);
      expect(membership(release.id)).toEqual([[ids[2], 'attachment', 0]]);
      service.selectAssets(release.id, before.map(([assetId, role, sortOrder]) => ({ assetId, role, sortOrder })));

      const foreign = await post(release.id, [['roleOrder', compact([{ assetId: foreignId, role: 'primary', sortOrder: 0 }])], ['selectedAssetIds', String(foreignId)]]);
      expect(foreign.res.status).toBe(422);
      expect(foreign.res.text).toContain(`Asset ${foreignId} does not belong to the release&#39;s project.`);
      expect(foreign.res.text).not.toContain('foreign-secret');
      expect(foreign.sql.membershipWrites).toBe(0);

      const unknown = ids.at(-1) + 9000;
      const missing = await post(release.id, [['roleOrder', compact([{ assetId: unknown, role: 'primary', sortOrder: 0 }])], ['selectedAssetIds', String(unknown)]]);
      expect(missing.res.status).toBe(404);
      expect(missing.sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(before);

      // A parseable large compact draft on a published or archived release
      // stays read-only.
      const large = largeDraft(300, -1);
      const largeEntries = [['roleOrder', compact(large)], ...large.map(({ assetId }) => ['selectedAssetIds', String(assetId)])];
      db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(release.id);
      const published = await post(release.id, largeEntries);
      expect(published.res.status).toBe(422);
      expect(published.res.text).toContain('This release is published. Asset selections are locked and read-only.');
      expect(published.res.text).not.toContain('id="release-assets-form"');
      expect(published.res.text).not.toContain('data-release-assets-submitted-role-order');
      expect(published.sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(before);
    });

    it('a large compact draft without a valid CSRF token, or over the body byte limit, is refused before the route', async () => {
      const release = editableRelease();
      const before = membership(release.id);
      const draft = largeDraft(300, -1);
      const body = [['roleOrder', compact(draft)], ...draft.map(({ assetId }) => ['selectedAssetIds', String(assetId)])];
      for (const csrf of [[], [['_csrf', 'not-the-token']]]) {
        tracing = true;
        trace.length = 0;
        const res = await agent.post(`/releases/${release.id}/assets`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send(encode([...csrf, ...body]));
        tracing = false;
        expect(res.status).toBe(403);
        expect(trace.filter((sql) => VALIDATION.test(sql) || MEMBERSHIP_WRITE.test(sql))).toEqual([]);
      }

      // The 100 KB URL-encoded body limit still applies: one oversized role.
      const oversized = [['roleOrder', compact([{ assetId: ids[0], role: 'x'.repeat(BODY_LIMIT_BYTES), sortOrder: 0 }])], ['selectedAssetIds', String(ids[0])]];
      expect(bodyBytes(oversized)).toBeGreaterThan(BODY_LIMIT_BYTES);
      const tooLarge = await post(release.id, oversized);
      expect(tooLarge.res.status).toBe(413);
      expect(tooLarge.sql.validation).toBe(0);
      expect(tooLarge.sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(before);
    });
  });

  // ─── B-F2R3: unrepresentable legacy order and unsafe empty retry ──────────
  // A legacy order must fit the compact retry carrier (a non-negative safe
  // integer); and a rejected Save whose draft cannot be reconstructed must
  // never come back as an editable form whose Save clears membership.
  describe('unrepresentable legacy order and unrecoverable rejected Save (B-F2R3)', () => {
    const ORDER_ERROR = 'Invalid asset order. Each order must be a whole number from 0 to 9007199254740991.';
    const FORMAT_ERROR = 'Invalid asset selection format.';
    const UNSAFE = '9007199254740992';
    const compactOf = (draft) => JSON.stringify(draft.map(({ assetId, role, sortOrder }) => [assetId, role, sortOrder]));
    const legacyPositional = (draft) => [
      ...draft.map(({ assetId }) => ['selectedAssetIds[]', String(assetId)]),
      ...draft.map(({ role }) => ['roles[]', role]),
      ...draft.map(({ sortOrder }) => ['sortOrder[]', String(sortOrder)]),
    ];

    // Two persisted members (saved Primary and Preview) on an editable release.
    function persistedRelease(title = 'B-F2R3 Release') {
      const release = createRelease(title);
      service.selectAssets(release.id, [
        { assetId: ids[0], role: 'primary', sortOrder: 0 },
        { assetId: ids[1], role: 'preview', sortOrder: 1 },
      ]);
      return release;
    }
    const PERSISTED = () => [[ids[0], 'primary', 0], [ids[1], 'preview', 1]];

    // The independent reviewer's draft: three selected assets (the two saved
    // members plus an off-page addition), explicit roles, one invalid role,
    // one order beyond Number.MAX_SAFE_INTEGER.
    const reviewerDraft = () => [
      { assetId: ids[0], role: 'primary', sortOrder: 0 },
      { assetId: ids[1], role: 'preview', sortOrder: 1 },
      { assetId: ids[42], role: 'bogus', sortOrder: UNSAFE },
    ];

    // A fail-closed refusal: visible notice and error, no Save form, no
    // membership/role/order fields anywhere, no write, membership unchanged.
    function expectFailClosed({ res, sql }, release, error, before) {
      expect(res.status).toBe(422);
      expect(res.text).toMatch(new RegExp(`<p>${error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</p>`));
      expect(res.text).toContain('data-release-assets-save-recovery-unavailable');
      expect(res.text).toContain('<strong>Nothing was saved.</strong>');
      expect(res.text).toMatch(new RegExp(`<a href="/releases/${release.id}/assets\\?pageSize=10">Reload Manage Assets</a>`));
      expect(res.text).not.toContain('id="release-assets-form"');
      expect(res.text).not.toContain('Save asset selection');
      expect(res.text).not.toContain('form="release-assets-form"');
      expect(res.text).not.toContain('name="selectedAssetIds"');
      expect(res.text).not.toContain('name="roleOrder"');
      expect(res.text).not.toMatch(/name="(?:roleAssetIds|roles|sortOrder)\[/);
      expect(res.text).not.toContain('release-assets-filter-dialog');
      expect(res.text).not.toContain('data-release-assets-live-page-size-form');
      expect(res.text).not.toContain('foreign-secret');
      expect(sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(before);
    }

    it('refuses the reviewer\'s unsafe-order draft (invalid role + 9007199254740992) without a resubmittable form', async () => {
      const release = persistedRelease();
      expect(membership(release.id)).toEqual(PERSISTED());
      const refused = await post(release.id, legacyPositional(reviewerDraft()));
      expectFailClosed(refused, release, ORDER_ERROR, PERSISTED());
      // Refused at the route: no Save validation lookup ran.
      expect(refused.sql.validation).toBe(0);
      expect(refused.res.text).not.toContain(UNSAFE);
    });

    it('refuses an unsafe order even when every role is valid, in positional and keyed legacy formats', async () => {
      const release = persistedRelease();
      const valid = reviewerDraft().map((entry, index) => (index === 2 ? { ...entry, role: 'attachment' } : entry));
      expectFailClosed(await post(release.id, legacyPositional(valid)), release, ORDER_ERROR, PERSISTED());
      const keyed = valid.flatMap(({ assetId, role, sortOrder }, index) => [
        ['selectedAssetIds', String(assetId)],
        [`roleAssetIds[${index}]`, String(assetId)],
        [`roles[${index}]`, role],
        [`sortOrder[${index}]`, String(sortOrder)],
      ]);
      expectFailClosed(await post(release.id, keyed), release, ORDER_ERROR, PERSISTED());
    });

    it('applies one non-negative safe-integer order boundary; nothing is rounded, clamped, truncated or zeroed', async () => {
      const release = persistedRelease();
      const invalid = [
        '-1', '-0', '+1', '1.5', '1.0', '0.5', '1e3', '1E3', '0x10', 'Infinity', '-Infinity', 'NaN', 'abc', '1 2',
        UNSAFE, '9007199254740993', '18446744073709551616', '9'.repeat(400),
      ];
      for (const value of invalid) {
        const refused = await post(release.id, [
          ['selectedAssetIds[]', String(ids[0])], ['roles[]', 'primary'], ['sortOrder[]', value],
        ]);
        expect(refused.res.status, value).toBe(422);
        expectFailClosed(refused, release, ORDER_ERROR, PERSISTED());
      }
      // A nested order value is not a scalar order.
      expectFailClosed(
        await post(release.id, [['selectedAssetIds[]', String(ids[0])], ['roles[0]', 'primary'], ['sortOrder[0][]', '1']]),
        release, ORDER_ERROR, PERSISTED(),
      );
    });

    it('keeps valid legacy orders: 0, ordinary values, leading zeros, the established blank/missing default and MAX_SAFE_INTEGER', async () => {
      const release = persistedRelease();
      const saved = await post(release.id, [
        ['selectedAssetIds[]', String(ids[0])], ['selectedAssetIds[]', String(ids[1])],
        ['selectedAssetIds[]', String(ids[42])], ['selectedAssetIds[]', String(ids[3])],
        ['roles[]', 'primary'], ['roles[]', 'preview'], ['roles[]', 'attachment'], ['roles[]', 'attachment'],
        ['sortOrder[]', String(Number.MAX_SAFE_INTEGER)], ['sortOrder[]', '007'], ['sortOrder[]', ' 12 '], ['sortOrder[]', ''],
      ]);
      expect(saved.res.status).toBe(302);
      expect(membership(release.id)).toEqual([
        [ids[3], 'attachment', 0],
        [ids[1], 'preview', 7],
        [ids[42], 'attachment', 12],
        [ids[0], 'primary', Number.MAX_SAFE_INTEGER],
      ]);

      // A missing order index defaults to 0, and a bare single order is the
      // whole value at index 0 (never read character by character).
      const bare = await post(release.id, [
        ['selectedAssetIds', String(ids[0])], ['selectedAssetIds', String(ids[1])],
        ['roles[0]', 'primary'], ['roles[1]', 'preview'], ['sortOrder', '12'],
      ]);
      expect(bare.res.status).toBe(302);
      expect(membership(release.id)).toEqual([[ids[1], 'preview', 0], [ids[0], 'primary', 12]]);
    });

    it('a MAX_SAFE_INTEGER order survives a rejected draft\'s compact carrier and the corrected retry', async () => {
      const release = persistedRelease();
      const draft = [
        { assetId: ids[42], role: 'bogus', sortOrder: 3 },
        { assetId: ids[0], role: 'primary', sortOrder: Number.MAX_SAFE_INTEGER },
        { assetId: ids[1], role: 'preview', sortOrder: 0 },
      ];
      const rejected = await post(release.id, legacyPositional(draft));
      expect(rejected.res.status).toBe(422);
      expect(rejected.sql.membershipWrites).toBe(0);
      const retry = retryFormEntries(rejected.res.text);
      expect(retry.filter(([name]) => name === 'roleOrder')).toEqual([['roleOrder', compactOf(draft)]]);
      const corrected = retry.filter(([name]) => name !== '_csrf').map(([name, value]) => (
        name === 'roleOrder' ? [name, value.replace('"bogus"', '"attachment"')] : [name, value]
      ));
      expect((await post(release.id, corrected)).res.status).toBe(302);
      expect(membership(release.id)).toEqual([
        [ids[1], 'preview', 0], [ids[42], 'attachment', 3], [ids[0], 'primary', Number.MAX_SAFE_INTEGER],
      ]);
    });

    it('a valid selection with a malformed compact carrier fails closed instead of rendering an empty saveable form', async () => {
      const release = persistedRelease();
      const selected = [ids[0], ids[1], ids[42]].map((id) => ['selectedAssetIds', String(id)]);
      const good = [[ids[0], 'primary', 0], [ids[1], 'preview', 1], [ids[42], 'attachment', 2]];
      const cases = [
        ['invalid JSON', [['roleOrder', '[[1,"primary",0]']]],
        ['entry of wrong length', [['roleOrder', JSON.stringify([[ids[0], 'primary'], ...good.slice(1)])]]],
        ['unsafe integer order', [['roleOrder', `[[${ids[0]},"primary",0],[${ids[1]},"preview",1],[${ids[42]},"bogus",${UNSAFE}]]`]]],
        ['invalid asset ID', [['roleOrder', JSON.stringify([[0, 'primary', 0], ...good.slice(1)])]]],
        ['mixed compact and keyed fields', [['roleOrder', JSON.stringify(good)], ['roleAssetIds[0]', String(ids[0])], ['roles[0]', 'primary'], ['sortOrder[0]', '0']]],
        ['repeated roleOrder', [['roleOrder', JSON.stringify(good)], ['roleOrder', JSON.stringify(good)]]],
        ['nested roleOrder', [['roleOrder[0]', JSON.stringify(good)]]],
        ['empty roleOrder', [['roleOrder', '']]],
      ];
      for (const [label, carrier] of cases) {
        const refused = await post(release.id, [...selected, ...carrier]);
        expect(refused.res.status, label).toBe(422);
        expectFailClosed(refused, release, FORMAT_ERROR, PERSISTED());
        expect(refused.sql.validation, label).toBe(0);
      }
    });

    it('a nonempty submission with no readable asset ID, or a malformed selection shape, fails closed', async () => {
      const release = persistedRelease();
      expectFailClosed(await post(release.id, [['selectedAssetIds', 'abc']]), release, 'Invalid asset selection.', PERSISTED());
      expectFailClosed(
        await post(release.id, [['selectedAssetIds', 'abc'], ['roles[]', 'primary'], ['sortOrder[]', '0']]),
        release, 'Invalid asset selection.', PERSISTED(),
      );
      expectFailClosed(await post(release.id, [['selectedAssetIds[x]', String(ids[0])]]), release, FORMAT_ERROR, PERSISTED());
      // A partly readable selection keeps its readable IDs for retry (B-F4 control).
      const partial = await post(release.id, [['selectedAssetIds', 'abc'], ['selectedAssetIds', String(ids[42])]]);
      expect(partial.res.status).toBe(422);
      expect(partial.res.text).not.toContain('data-release-assets-save-recovery-unavailable');
      expect(selectedIds(retryFormEntries(partial.res.text))).toEqual([ids[42]]);
      expect(membership(release.id)).toEqual(PERSISTED());
    });

    it('an intentional valid empty Save still clears membership', async () => {
      const release = persistedRelease();
      const cleared = await post(release.id, []);
      expect(cleared.res.status).toBe(302);
      expectReleaseAssetsSavedLocation(cleared.res.headers.location, release.id);
      expect(membership(release.id)).toEqual([]);
    });

    it('an ordinary valid legacy Save persists its explicit roles and orders', async () => {
      const release = persistedRelease();
      const draft = [
        { assetId: ids[42], role: 'attachment', sortOrder: 5 },
        { assetId: ids[1], role: 'primary', sortOrder: 2 },
        { assetId: ids[0], role: 'preview', sortOrder: 9 },
      ];
      expect((await post(release.id, legacyPositional(draft))).res.status).toBe(302);
      expect(membership(release.id)).toEqual([[ids[1], 'primary', 2], [ids[42], 'attachment', 5], [ids[0], 'preview', 9]]);
    });

    it('an ordinary rejected legacy Save keeps a recoverable retry; unchanged it is refused again, corrected it saves', async () => {
      const release = persistedRelease();
      // Off-page addition (ids[42]) and off-page removal: membership changes.
      const draft = [
        { assetId: ids[42], role: 'bogus', sortOrder: 2 },
        { assetId: ids[1], role: 'preview', sortOrder: 0 },
        { assetId: ids[0], role: 'primary', sortOrder: 1 },
      ];
      const first = await post(release.id, legacyPositional(draft));
      expect(first.res.status).toBe(422);
      expect(first.res.text).toContain(`Asset ${ids[42]} has an invalid role &quot;bogus&quot;.`);
      expect(first.res.text).not.toContain('data-release-assets-save-recovery-unavailable');
      expect(first.sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(PERSISTED());
      const retry = retryFormEntries(first.res.text).filter(([name]) => name !== '_csrf');
      expect([...selectedIds(retry)].sort((a, b) => a - b)).toEqual(draft.map(({ assetId }) => assetId).sort((a, b) => a - b));
      expect(retry.filter(([name]) => name === 'roleOrder')).toEqual([['roleOrder', compactOf(draft)]]);

      const unchanged = await post(release.id, retry);
      expect(unchanged.res.status).toBe(422);
      expect(unchanged.res.text).toContain(`Asset ${ids[42]} has an invalid role &quot;bogus&quot;.`);
      expect(unchanged.res.text).not.toContain(FORMAT_ERROR);
      expect(unchanged.sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(PERSISTED());
      expect(retryFormEntries(unchanged.res.text).filter(([name]) => name === 'roleOrder')).toEqual([['roleOrder', compactOf(draft)]]);

      const corrected = retry.map(([name, value]) => (name === 'roleOrder' ? [name, value.replace('"bogus"', '"attachment"')] : [name, value]));
      expect((await post(release.id, corrected)).res.status).toBe(302);
      expect(membership(release.id)).toEqual([[ids[1], 'preview', 0], [ids[0], 'primary', 1], [ids[42], 'attachment', 2]]);
    });

    it('read-only releases keep their B-F4 refusal for an unsafe order; CSRF still precedes the route', async () => {
      const release = persistedRelease();
      db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(release.id);
      const published = await post(release.id, legacyPositional(reviewerDraft()));
      expect(published.res.status).toBe(422);
      expect(published.res.text).toContain('This release is published. Asset selections are locked and read-only.');
      expect(published.res.text).toContain(`<p>${ORDER_ERROR}</p>`);
      expect(published.res.text).not.toContain('id="release-assets-form"');
      expect(published.res.text).not.toContain('data-release-assets-save-recovery-unavailable');
      expect(published.sql.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(PERSISTED());

      const editable = persistedRelease('B-F2R3 CSRF');
      tracing = true;
      trace.length = 0;
      const forged = await agent.post(`/releases/${editable.id}/assets`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(encode([['_csrf', 'forged'], ...legacyPositional(reviewerDraft())]));
      tracing = false;
      expect(forged.status).toBe(403);
      expect(trace.filter((sql) => MEMBERSHIP_WRITE.test(sql))).toEqual([]);
      expect(membership(editable.id)).toEqual(PERSISTED());
    });
  });

  // ─── B-F2R4: sparse indexed role/order fields keep their original index ───
  // Express's URL-encoded parser compacts `roles[1]=preview` (alone) into
  // `roles: ['preview']`. A role/order submitted at index k must stay with the
  // asset submitted at index k; it must never slide onto another asset.
  describe('sparse keyed role/order index preservation (B-F2R4)', () => {
    const FORMAT_ERROR = 'Invalid asset selection format.';
    const ORDER_ERROR = 'Invalid asset order. Each order must be a whole number from 0 to 9007199254740991.';
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    function rows(releaseId) {
      return db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY asset_id')
        .all(releaseId)
        .map((row) => [row.asset_id, row.role, row.sort_order]);
    }

    // Persisted rows as the oracle: exactly these IDs, once each.
    async function expectSaved(entries, expected) {
      const release = createRelease();
      const { res, sql } = await post(release.id, entries);
      expect(res.status, JSON.stringify(entries)).toBe(302);
      expect(sql.membershipWrites).toBeGreaterThan(0);
      const saved = rows(release.id);
      expect(saved, JSON.stringify(entries)).toEqual([...expected].sort((a, b) => a[0] - b[0]));
      expect(new Set(saved.map(([assetId]) => assetId)).size).toBe(saved.length);
      return release;
    }

    function persisted(title = 'B-F2R4 Release') {
      const release = createRelease(title);
      service.selectAssets(release.id, [
        { assetId: ids[5], role: 'primary', sortOrder: 0 },
        { assetId: ids[6], role: 'preview', sortOrder: 1 },
      ]);
      return release;
    }
    const PERSISTED_ROWS = () => [[ids[5], 'primary', 0], [ids[6], 'preview', 1]];

    function expectFailClosed({ res, sql }, release, error) {
      expect(res.status).toBe(422);
      expect(res.text).toMatch(new RegExp(`<p>${escape(error)}</p>`));
      expect(res.text).toContain('data-release-assets-save-recovery-unavailable');
      expect(res.text).toContain('<strong>Nothing was saved.</strong>');
      expect(res.text).not.toContain('id="release-assets-form"');
      expect(res.text).not.toContain('Save asset selection');
      expect(res.text).not.toContain('name="selectedAssetIds"');
      expect(res.text).not.toContain('name="roleOrder"');
      expect(res.text).not.toMatch(/name="(?:roleAssetIds|roles|sortOrder)\[/);
      expect(res.text).not.toContain('foreign-secret');
      expect(sql.membershipWrites).toBe(0);
      expect(rows(release.id)).toEqual([...PERSISTED_ROWS()].sort((a, b) => a[0] - b[0]));
    }

    // Raw body exactly as written (brackets unencoded), CSRF first.
    async function postRaw(releaseId, raw) {
      trace.length = 0;
      tracing = true;
      try {
        const res = await agent.post(`/releases/${releaseId}/assets?pageSize=10`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send(`_csrf=${encodeURIComponent(csrfToken)}&${raw}`);
        return { res, sql: { membershipWrites: trace.filter((text) => MEMBERSHIP_WRITE.test(text)).length } };
      } finally {
        tracing = false;
      }
    }

    it('reproduces the reviewer case: roles[1]/sortOrder[1] stay with roleAssetIds[1]', async () => {
      const [A, B] = [ids[0], ids[1]];
      const release = await expectSaved([
        ['selectedAssetIds', String(A)], ['selectedAssetIds', String(B)],
        ['roleAssetIds[0]', String(A)], ['roleAssetIds[1]', String(B)],
        ['roles[1]', 'preview'], ['sortOrder[1]', '19'],
      ], [[A, 'attachment', 0], [B, 'preview', 19]]);
      // Same result for the raw, unencoded wire form.
      const raw = createRelease('B-F2R4 raw');
      const { res } = await postRaw(raw.id,
        `selectedAssetIds=${A}&selectedAssetIds=${B}&roleAssetIds[0]=${A}&roleAssetIds[1]=${B}&roles[1]=preview&sortOrder[1]=19`);
      expect(res.status).toBe(302);
      expect(rows(raw.id)).toEqual(rows(release.id));
    });

    it('a sparse Primary role stays on its own asset (no Primary moves to another asset)', async () => {
      const [A, B, C] = [ids[0], ids[1], ids[2]];
      await expectSaved([
        ['selectedAssetIds', String(A)], ['selectedAssetIds', String(B)], ['selectedAssetIds', String(C)],
        ['roleAssetIds[0]', String(A)], ['roleAssetIds[1]', String(B)], ['roleAssetIds[2]', String(C)],
        ['roles[2]', 'primary'], ['sortOrder[2]', '0'], ['sortOrder[1]', '5'],
      ], [[A, 'attachment', 0], [B, 'attachment', 5], [C, 'primary', 0]]);
    });

    it('pairs every dense and sparse keyed combination by original index', async () => {
      const [A, B, C, D] = [ids[0], ids[1], ids[2], ids[3]];
      const select = (...assetIds) => assetIds.map((assetId) => ['selectedAssetIds', String(assetId)]);
      const keys = (pairs) => pairs.map(([index, assetId]) => [`roleAssetIds[${index}]`, String(assetId)]);
      const cases = [
        // A. Dense 0, 1, 2.
        [[...select(A, B, C), ...keys([[0, A], [1, B], [2, C]]),
          ['roles[0]', 'primary'], ['roles[1]', 'preview'], ['roles[2]', 'attachment'],
          ['sortOrder[0]', '0'], ['sortOrder[1]', '1'], ['sortOrder[2]', '2']],
        [[A, 'primary', 0], [B, 'preview', 1], [C, 'attachment', 2]]],
        // B. Only role index 1.
        [[...select(A, B), ...keys([[0, A], [1, B]]), ['roles[1]', 'preview']],
          [[A, 'attachment', 0], [B, 'preview', 0]]],
        // C. Only order index 1.
        [[...select(A, B), ...keys([[0, A], [1, B]]), ['sortOrder[1]', '5']],
          [[A, 'attachment', 0], [B, 'attachment', 5]]],
        // D. Roles at 0 and 2; none at 1.
        [[...select(A, B, C), ...keys([[0, A], [1, B], [2, C]]), ['roles[0]', 'primary'], ['roles[2]', 'preview']],
          [[A, 'primary', 0], [B, 'attachment', 0], [C, 'preview', 0]]],
        // E. Orders at 0 and 2; none at 1.
        [[...select(A, B, C), ...keys([[0, A], [1, B], [2, C]]), ['sortOrder[0]', '4'], ['sortOrder[2]', '8']],
          [[A, 'attachment', 4], [B, 'attachment', 0], [C, 'attachment', 8]]],
        // F. Role at 1, order at 2.
        [[...select(A, B, C), ...keys([[0, A], [1, B], [2, C]]), ['roles[1]', 'preview'], ['sortOrder[2]', '6']],
          [[A, 'attachment', 0], [B, 'preview', 0], [C, 'attachment', 6]]],
        // G. Indexed fields in reversed wire order.
        [[['sortOrder[1]', '19'], ['roles[1]', 'preview'], ...keys([[1, B], [0, A]]), ...select(B, A)],
          [[A, 'attachment', 0], [B, 'preview', 19]]],
        // H. A key for an unselected asset is ignored (its role/order with it).
        [[...select(A, B), ...keys([[0, A], [1, B], [2, C]]), ['roles[2]', 'primary'], ['sortOrder[2]', '9']],
          [[A, 'attachment', 0], [B, 'attachment', 0]]],
        // I. A selected asset with no keyed entry takes the defaults.
        [[...select(A, B, D), ...keys([[0, A], [1, B]]), ['roles[1]', 'preview'], ['sortOrder[1]', '3']],
          [[A, 'attachment', 0], [B, 'preview', 3], [D, 'attachment', 0]]],
        // J. A missing middle asset-ID index.
        [[...select(A, C), ...keys([[0, A], [2, C]]), ['roles[2]', 'preview'], ['sortOrder[2]', '3']],
          [[A, 'attachment', 0], [C, 'preview', 3]]],
        // L. Large numeric indices (past the parser's array threshold).
        [[...select(A, B), ...keys([[0, A], [150, B]]), ['roles[150]', 'preview'], ['sortOrder[150]', '7']],
          [[A, 'attachment', 0], [B, 'preview', 7]]],
        [[...select(A, B), ...keys([[999998, A], [999999, B]]), ['roles[999999]', 'primary']],
          [[A, 'attachment', 0], [B, 'primary', 0]]],
        // O. Empty role/order values take the defaults at their own index.
        [[...select(A, B), ...keys([[0, A], [1, B]]), ['roles[0]', 'preview'], ['roles[1]', ''], ['sortOrder[1]', ''], ['sortOrder[0]', '2']],
          [[A, 'preview', 2], [B, 'attachment', 0]]],
        // P. Shared role, different orders.
        [[...select(A, B, C), ...keys([[0, A], [1, B], [2, C]]),
          ['roles[1]', 'preview'], ['roles[2]', 'preview'], ['sortOrder[1]', '9'], ['sortOrder[2]', '3']],
        [[A, 'attachment', 0], [B, 'preview', 9], [C, 'preview', 3]]],
        // B-F2R3 boundary at a sparse index.
        [[...select(A, B), ...keys([[0, A], [1, B]]), ['sortOrder[1]', '9007199254740991']],
          [[A, 'attachment', 0], [B, 'attachment', Number.MAX_SAFE_INTEGER]]],
      ];
      for (const [entries, expected] of cases) await expectSaved(entries, expected);
    });

    it('the legacy positional shape also pairs roles[k]/sortOrder[k] with the k-th selected ID', async () => {
      const [A, B, C] = [ids[0], ids[1], ids[2]];
      await expectSaved([
        ['selectedAssetIds', String(A)], ['selectedAssetIds', String(B)],
        ['roles[1]', 'preview'], ['sortOrder[1]', '19'],
      ], [[A, 'attachment', 0], [B, 'preview', 19]]);
      // Indexed selectedAssetIds keep their own indices too.
      await expectSaved([
        ['selectedAssetIds[0]', String(A)], ['selectedAssetIds[2]', String(C)],
        ['roles[2]', 'primary'], ['sortOrder[0]', '4'],
      ], [[A, 'attachment', 4], [C, 'primary', 0]]);
    });

    it('keeps all four dense Save formats', async () => {
      const [A, B] = [ids[0], ids[1]];
      // Membership only: server-owned roles/order (new members attachment, appended order).
      const membershipOnly = createRelease('B-F2R4 membership');
      expect((await post(membershipOnly.id, [['selectedAssetIds', String(A)], ['selectedAssetIds', String(B)]])).res.status).toBe(302);
      expect(rows(membershipOnly.id).map(([assetId]) => assetId)).toEqual([A, B]);
      // Legacy positional.
      await expectSaved([
        ['selectedAssetIds[]', String(A)], ['selectedAssetIds[]', String(B)],
        ['roles[]', 'primary'], ['roles[]', 'preview'], ['sortOrder[]', '1'], ['sortOrder[]', '2'],
      ], [[A, 'primary', 1], [B, 'preview', 2]]);
      // Keyed.
      await expectSaved([
        ['selectedAssetIds', String(B)], ['selectedAssetIds', String(A)],
        ['roleAssetIds[0]', String(A)], ['roles[0]', 'primary'], ['sortOrder[0]', '1'],
        ['roleAssetIds[1]', String(B)], ['roles[1]', 'preview'], ['sortOrder[1]', '2'],
      ], [[A, 'primary', 1], [B, 'preview', 2]]);
      // Compact roleOrder tuples are explicit and untouched.
      await expectSaved([
        ['selectedAssetIds', String(A)], ['selectedAssetIds', String(B)],
        ['roleOrder', JSON.stringify([[B, 'preview', 2], [A, 'primary', 1]])],
      ], [[A, 'primary', 1], [B, 'preview', 2]]);
    });

    it('refuses ambiguous or malformed indexed shapes fail-closed, with no write', async () => {
      const [A, B, C] = [ids[0], ids[1], ids[2]];
      const base = `selectedAssetIds=${A}&selectedAssetIds=${B}&roleAssetIds[0]=${A}&roleAssetIds[1]=${B}`;
      const cases = [
        // K. Repeated indices.
        [`${base}&roles[1]=preview&roles[1]=primary`, FORMAT_ERROR],
        [`${base}&roleAssetIds[1]=${C}`, FORMAT_ERROR],
        [`${base}&sortOrder[1]=1&sortOrder[1]=2`, ORDER_ERROR],
        // M. Non-numeric / signed / padded indices.
        [`${base}&roles[x]=preview`, FORMAT_ERROR],
        [`${base}&roles[-1]=preview`, FORMAT_ERROR],
        [`${base}&roles[01]=preview`, FORMAT_ERROR],
        [`${base}&roles[__proto__]=preview`, FORMAT_ERROR],
        // L. Excessive index.
        [`${base}&roles[1000000]=preview`, FORMAT_ERROR],
        [`selectedAssetIds=${A}&roleAssetIds[1000000]=${A}`, FORMAT_ERROR],
        // N. Nested values.
        [`${base}&roles[1][a]=preview`, FORMAT_ERROR],
        [`${base}&roles[1][]=preview`, FORMAT_ERROR],
        [`${base}&roleAssetIds[2][]=${C}`, FORMAT_ERROR],
        [`${base}&sortOrder[1][]=4`, ORDER_ERROR],
        // A key qs would still parse into the field.
        [`${base}&[roles][1]=preview`, FORMAT_ERROR],
        // Mixed bare/indexed forms of one field.
        [`${base}&roles=preview&roles[1]=primary`, FORMAT_ERROR],
        // A role/order at an index with no asset ID never slides onto one.
        [`selectedAssetIds=${A}&selectedAssetIds=${C}&roleAssetIds[0]=${A}&roleAssetIds[2]=${C}&roles[1]=primary`, FORMAT_ERROR],
        [`${base}&sortOrder[2]=19`, FORMAT_ERROR],
        [`selectedAssetIds=${A}&selectedAssetIds=${B}&roles[2]=preview`, FORMAT_ERROR],
        [`selectedAssetIds[0]=${A}&selectedAssetIds[2]=${B}&roles[1]=primary`, FORMAT_ERROR],
        // Empty or non-integer key IDs.
        [`${base}&roleAssetIds[2]=`, FORMAT_ERROR],
        // Conflicting payload shapes.
        [`${base}&roleOrder=${encodeURIComponent(JSON.stringify([[A, 'primary', 0]]))}`, FORMAT_ERROR],
        // B-F2R3 unsafe order at a sparse index.
        [`${base}&sortOrder[1]=9007199254740992`, ORDER_ERROR],
        [`${base}&sortOrder[1]=1e3`, ORDER_ERROR],
        [`${base}&sortOrder[1]=-1`, ORDER_ERROR],
        [`${base}&sortOrder[1]=1.5`, ORDER_ERROR],
      ];
      for (const [raw, error] of cases) {
        const release = persisted();
        const result = await postRaw(release.id, raw);
        expect(result.res.status, raw).toBe(422);
        expectFailClosed(result, release, error);
      }
    });

    it('validation errors keep the original index: an invalid sparse role names its own asset and retries faithfully', async () => {
      const [A, B] = [ids[0], ids[1]];
      const release = persisted();
      const first = await post(release.id, [
        ['selectedAssetIds', String(A)], ['selectedAssetIds', String(B)],
        ['roleAssetIds[0]', String(A)], ['roleAssetIds[1]', String(B)],
        ['roles[1]', 'bogus'], ['sortOrder[1]', '19'],
      ]);
      expect(first.res.status).toBe(422);
      expect(first.res.text).toContain(`Asset ${B} has an invalid role &quot;bogus&quot;.`);
      expect(first.res.text).not.toContain(`Asset ${A} has an invalid role`);
      expect(first.res.text).not.toContain('data-release-assets-save-recovery-unavailable');
      expect(first.sql.membershipWrites).toBe(0);
      expect(rows(release.id)).toEqual(PERSISTED_ROWS());
      const retry = retryFormEntries(first.res.text).filter(([name]) => name !== '_csrf');
      const compact = JSON.stringify([[A, 'attachment', 0], [B, 'bogus', 19]]);
      expect(retry.filter(([name]) => name === 'roleOrder')).toEqual([['roleOrder', compact]]);
      expect(selectedIds(retry).sort((a, b) => a - b)).toEqual([A, B]);

      const unchanged = await post(release.id, retry);
      expect(unchanged.res.status).toBe(422);
      expect(unchanged.res.text).toContain(`Asset ${B} has an invalid role &quot;bogus&quot;.`);
      expect(unchanged.sql.membershipWrites).toBe(0);
      expect(rows(release.id)).toEqual(PERSISTED_ROWS());

      const corrected = retry.map(([name, value]) => (name === 'roleOrder' ? [name, value.replace('"bogus"', '"preview"')] : [name, value]));
      expect((await post(release.id, corrected)).res.status).toBe(302);
      expect(rows(release.id)).toEqual([[A, 'attachment', 0], [B, 'preview', 19]]);
    });

    it('unknown, foreign and duplicate IDs with sparse keyed fields are refused without a write or foreign metadata', async () => {
      const [A, B] = [ids[0], ids[1]];
      // Established statuses: unknown ID 404; foreign / duplicate 422.
      for (const [label, selected, status, message] of [
        ['unknown', [A, 999999999], 404, null],
        ['foreign', [A, foreignId], 422, `Asset ${foreignId} does not belong to the release&#39;s project.`],
        ['duplicate', [A, B, B], 422, 'Duplicate asset IDs are not allowed.'],
      ]) {
        const release = persisted(`B-F2R4 ${label}`);
        const result = await post(release.id, [
          ...selected.map((assetId) => ['selectedAssetIds', String(assetId)]),
          ['roleAssetIds[0]', String(A)], ['roleAssetIds[1]', String(selected[1])],
          ['roles[1]', 'primary'], ['sortOrder[1]', '19'],
        ]);
        expect(result.res.status, label).toBe(status);
        if (message) expect(result.res.text).toContain(message);
        expect(result.sql.membershipWrites, label).toBe(0);
        expect(result.res.text).not.toContain('foreign-secret');
        expect(rows(release.id)).toEqual(PERSISTED_ROWS());
        // A recoverable retry keeps B's Primary/19 on its own ID, never on A.
        const roleOrder = result.res.text.includes('<form id="release-assets-form"')
          ? retryFormEntries(result.res.text).find(([name]) => name === 'roleOrder')?.[1]
          : undefined;
        if (label !== 'unknown') expect(roleOrder, label).toBeDefined();
        if (roleOrder) {
          const tuples = JSON.parse(roleOrder);
          expect(tuples.find(([assetId]) => assetId === A), label).toEqual([A, 'attachment', 0]);
          expect(tuples.find(([assetId]) => assetId === selected[1]), label).toEqual([selected[1], 'primary', 19]);
        }
      }
    });

    it('read-only releases refuse sparse keyed Saves with the persisted collection and no Save form', async () => {
      const [A, B] = [ids[0], ids[1]];
      const release = persisted();
      db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(release.id);
      for (const raw of [
        `selectedAssetIds=${A}&selectedAssetIds=${B}&roleAssetIds[0]=${A}&roleAssetIds[1]=${B}&roles[1]=preview&sortOrder[1]=19`,
        `selectedAssetIds=${A}&roleAssetIds[0]=${A}&roles[1]=preview`,
      ]) {
        const result = await postRaw(release.id, raw);
        expect(result.res.status).toBe(422);
        expect(result.res.text).toContain('This release is published. Asset selections are locked and read-only.');
        expect(result.res.text).not.toContain('id="release-assets-form"');
        expect(result.res.text).not.toContain('name="roleOrder"');
        expect(result.sql.membershipWrites).toBe(0);
        expect(rows(release.id)).toEqual(PERSISTED_ROWS());
      }
    });

    it('keeps CSRF ahead of the route for a sparse keyed Save', async () => {
      const [A, B] = [ids[0], ids[1]];
      const release = persisted();
      trace.length = 0;
      tracing = true;
      const forged = await agent.post(`/releases/${release.id}/assets`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`_csrf=forged&selectedAssetIds=${A}&selectedAssetIds=${B}&roleAssetIds[0]=${A}&roleAssetIds[1]=${B}&roles[1]=preview`);
      tracing = false;
      expect(forged.status).toBe(403);
      expect(trace.filter((sql) => MEMBERSHIP_WRITE.test(sql))).toEqual([]);
      expect(rows(release.id)).toEqual(PERSISTED_ROWS());
    });

    it('keeps the B-F3 validation batch bound for a large sparse keyed Save', async () => {
      const release = createRelease();
      const members = ids.slice(0, 520);
      const entries = [
        ...members.map((assetId) => ['selectedAssetIds', String(assetId)]),
        ['roleAssetIds[0]', String(members[0])],
        ['roleAssetIds[400]', String(members[400])], ['roles[400]', 'primary'], ['sortOrder[400]', '3'],
      ];
      const { res, sql } = await post(release.id, entries);
      expect(res.status).toBe(302);
      expect(sql.validation).toBe(2);
      expect(sql.maxAssetRowsPerStatement).toBeLessThanOrEqual(BATCH);
      expect(sql.perIdAssetReads).toBe(0);
      const saved = rows(release.id);
      expect(saved).toHaveLength(520);
      expect(saved.find(([assetId]) => assetId === members[400])).toEqual([members[400], 'primary', 3]);
      expect(saved.find(([assetId]) => assetId === members[0])).toEqual([members[0], 'attachment', 0]);
      expect(saved.filter(([, role]) => role === 'primary')).toHaveLength(1);
    });
  });
  // ─── B-F2R5: a malformed selected-ID field is never an empty Save ─────────
  // Express's extended parser (qs, allowPrototypes) turns
  // `selectedAssetIds[__proto__]=3` into `selectedAssetIds: {}` — an empty
  // membership. The raw selected-ID field must be validated before the
  // membership-only / positional / keyed / compact format is chosen, so a
  // dropped or reshaped selection is refused instead of clearing the release.
  describe('malformed selected-ID validation before format choice (B-F2R5)', () => {
    const FORMAT_ERROR = 'Invalid asset selection format.';
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    function rows(releaseId) {
      return db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY asset_id')
        .all(releaseId)
        .map((row) => [row.asset_id, row.role, row.sort_order]);
    }

    // A Primary, B Preview.
    function persisted(title = 'B-F2R5 Release') {
      const release = createRelease(title);
      service.selectAssets(release.id, [
        { assetId: ids[5], role: 'primary', sortOrder: 0 },
        { assetId: ids[6], role: 'preview', sortOrder: 1 },
      ]);
      return release;
    }
    const PERSISTED_ROWS = () => [[ids[5], 'primary', 0], [ids[6], 'preview', 1]];

    // Raw body exactly as written, CSRF first.
    async function postRaw(releaseId, raw, csrf = csrfToken) {
      trace.length = 0;
      rowLog.length = 0;
      tracing = true;
      try {
        const res = await agent.post(`/releases/${releaseId}/assets?pageSize=10`)
          .set('Content-Type', 'application/x-www-form-urlencoded')
          .send(raw === '' ? `_csrf=${encodeURIComponent(csrf)}` : `_csrf=${encodeURIComponent(csrf)}&${raw}`);
        const count = (pattern) => trace.filter((text) => pattern.test(text)).length;
        return { res, sql: { membershipWrites: count(MEMBERSHIP_WRITE), validation: count(VALIDATION) } };
      } finally {
        tracing = false;
      }
    }

    function expectFailClosed({ res, sql }, release, label) {
      // Persisted membership and write count first: they are the data-loss oracle.
      expect(rows(release.id), label).toEqual(PERSISTED_ROWS());
      expect(sql.membershipWrites, label).toBe(0);
      expect(res.status, label).toBe(422);
      expect(res.text, label).toMatch(new RegExp(`<div class="error-summary" role="alert">\\s*<p>${escape(FORMAT_ERROR)}</p>`));
      expect(res.text, label).toContain('data-release-assets-save-recovery-unavailable');
      expect(res.text, label).toContain('<strong>Nothing was saved.</strong>');
      expect(res.text, label).not.toContain('id="release-assets-form"');
      expect(res.text, label).not.toContain('Save asset selection');
      expect(res.text, label).not.toContain('name="selectedAssetIds"');
      expect(res.text, label).not.toContain('name="roleOrder"');
      expect(res.text, label).not.toMatch(/name="(?:roleAssetIds|roles|sortOrder)\[/);
      expect(res.text, label).not.toContain('foreign-secret');
      expect(res.text, label).not.toContain('__proto__');
      expect(sql.membershipWrites, label).toBe(0);
      // Refused before any asset validation lookup.
      expect(sql.validation, label).toBe(0);
      expect(rows(release.id), label).toEqual(PERSISTED_ROWS());
    }

    it('reproduces the reviewer case: selectedAssetIds[__proto__]=3 is refused, membership kept', async () => {
      const release = persisted();
      expect(rows(release.id)).toEqual(PERSISTED_ROWS());
      const result = await postRaw(release.id, 'selectedAssetIds[__proto__]=3');
      expectFailClosed(result, release, '__proto__');
    });

    it('refuses prototype-like and percent-encoded selected-ID names without depending on req.body', async () => {
      const A = ids[5];
      for (const raw of [
        'selectedAssetIds[__proto__]=3',
        'selectedAssetIds[constructor]=3',
        'selectedAssetIds[prototype]=3',
        'selectedAssetIds[toString]=3',
        'selectedAssetIds[hasOwnProperty]=3',
        'selectedAssetIds[valueOf]=3',
        'selectedAssetIds[__proto__][0]=3',
        'selectedAssetIds[__proto__][__proto__]=3',
        `selectedAssetIds[__proto__]=${A}`,
        'selectedAssetIds%5B__proto__%5D=3',
        'selectedAssetIds%5b__proto__%5d=3',
        'selectedAssetIds%5B%5F%5Fproto%5F%5F%5D=3',
        'selectedAssetIds%5Bconstructor%5D=3',
        'selectedAssetIds%5Bprototype%5D=3',
        'selectedAssetIds%5BtoString%5D=3',
        'selectedAssetIds[__proto__]=',
      ]) {
        const release = persisted('B-F2R5 case');
        expectFailClosed(await postRaw(release.id, raw), release, raw);
      }
    });

    it('refuses mixed valid/malformed, ambiguous, nested and oversized selected-ID fields', async () => {
      const [A, B] = [ids[5], ids[6]];
      for (const raw of [
        // A valid neighbour must not hide a dropped malformed entry.
        `selectedAssetIds[0]=${A}&selectedAssetIds[__proto__]=3`,
        `selectedAssetIds[__proto__]=3&selectedAssetIds[0]=${A}`,
        `selectedAssetIds=${A}&selectedAssetIds[__proto__]=3`,
        `selectedAssetIds[__proto__]=3&selectedAssetIds=${A}`,
        `selectedAssetIds[]=${A}&selectedAssetIds%5B__proto__%5D=3`,
        `selectedAssetIds[1]=${A}&selectedAssetIds[toString]=${B}`,
        // Mixed bare/indexed forms, repeated index, non-numeric, nested,
        // oversized index, unterminated and leading-bracket keys.
        `selectedAssetIds=${A}&selectedAssetIds[1]=${B}`,
        `selectedAssetIds[0]=${A}&selectedAssetIds[0]=${B}`,
        `selectedAssetIds[a]=${A}`,
        `selectedAssetIds[0][a]=${A}`,
        `selectedAssetIds[-1]=${A}`,
        `selectedAssetIds[01]=${A}`,
        `selectedAssetIds[9999999]=${A}`,
        `selectedAssetIds%5B0=${A}`,
        `[selectedAssetIds][0]=${A}`,
      ]) {
        const release = persisted('B-F2R5 case');
        expectFailClosed(await postRaw(release.id, raw), release, raw);
      }
    });

    it('a role/order carrier never masks a malformed selected-ID field', async () => {
      const [A, B] = [ids[5], ids[6]];
      const roleOrder = encodeURIComponent(JSON.stringify([[A, 'primary', 0], [B, 'preview', 1]]));
      for (const raw of [
        // Sparse keyed (B-F2R4 shape).
        `selectedAssetIds[__proto__]=3&roleAssetIds[0]=${A}&roleAssetIds[1]=${B}&roles[1]=preview&sortOrder[1]=19`,
        // Legacy positional.
        'selectedAssetIds[__proto__]=3&roles[0]=primary&sortOrder[0]=0',
        // Compact roleOrder (valid and malformed).
        `selectedAssetIds[__proto__]=3&roleOrder=${roleOrder}`,
        `selectedAssetIds[__proto__]=3&roleOrder=%5B%5B${A}%2C%22primary%22%2C1.5%5D%5D`,
        // B-F2R3 unsafe order with a malformed selection: still format-refused.
        `selectedAssetIds[__proto__]=3&roleAssetIds[0]=${A}&sortOrder[0]=9007199254740992`,
        `selectedAssetIds[0]=${A}&selectedAssetIds[__proto__]=${B}&roleAssetIds[0]=${A}&roles[0]=primary`,
      ]) {
        const release = persisted('B-F2R5 case');
        expectFailClosed(await postRaw(release.id, raw), release, raw);
      }
    });

    it('keeps a deliberate empty Save: no selected-ID field (or a lone bare empty value) clears membership', async () => {
      for (const raw of ['', 'selectedAssetIds=']) {
        const release = persisted(`B-F2R5 empty ${raw}`);
        const { res, sql } = await postRaw(release.id, raw);
        expect(res.status, raw).toBe(302);
        expectReleaseAssetsSavedLocation(res.headers.location, release.id);
        expect(sql.membershipWrites, raw).toBeGreaterThan(0);
        expect(rows(release.id), raw).toEqual([]);
      }
    });

    it('keeps every supported selected-ID representation', async () => {
      const [A, B, C] = [ids[5], ids[6], ids[7]];
      for (const [raw, expected] of [
        [`selectedAssetIds=${A}`, [A]],
        [`selectedAssetIds=${A}&selectedAssetIds=${B}&selectedAssetIds=${C}`, [A, B, C]],
        [`selectedAssetIds[]=${A}&selectedAssetIds[]=${B}`, [A, B]],
        [`selectedAssetIds=${A}&selectedAssetIds[]=${B}`, [A, B]],
        [`selectedAssetIds[0]=${A}&selectedAssetIds[1]=${B}`, [A, B]],
        [`selectedAssetIds[1]=${A}`, [A]],
        [`selectedAssetIds[5]=${A}&selectedAssetIds[2]=${B}`, [A, B]],
        [`selectedAssetIds[150]=${A}&selectedAssetIds[999999]=${C}`, [A, C]],
        [`selectedAssetIds%5B0%5D=${A}&selectedAssetIds%5B1%5D=${C}`, [A, C]],
        [`selectedAssetIds%5B%5D=${B}`, [B]],
      ]) {
        const release = persisted('B-F2R5 case');
        const { res, sql } = await postRaw(release.id, raw);
        expect(res.status, raw).toBe(302);
        expect(sql.membershipWrites, raw).toBeGreaterThan(0);
        expect(rows(release.id).map(([assetId]) => assetId), raw).toEqual([...expected].sort((x, y) => x - y));
        // Membership-only keeps a saved member's role/order.
        if (expected.includes(A)) expect(rows(release.id).find(([assetId]) => assetId === A), raw).toEqual([A, 'primary', 0]);
      }
    });

    it('keeps B-F2R4 sparse keyed pairing, legacy positional pairing and the B-F2R3 order refusal', async () => {
      const [A, B] = [ids[0], ids[1]];
      const sparse = createRelease('B-F2R5 sparse');
      const keyed = await postRaw(sparse.id,
        `selectedAssetIds=${A}&selectedAssetIds=${B}&roleAssetIds[0]=${A}&roleAssetIds[1]=${B}&roles[1]=preview&sortOrder[1]=19`);
      expect(keyed.res.status).toBe(302);
      expect(rows(sparse.id)).toEqual([[A, 'attachment', 0], [B, 'preview', 19]]);
      const positional = createRelease('B-F2R5 positional');
      const legacy = await postRaw(positional.id,
        `selectedAssetIds[0]=${A}&selectedAssetIds[1]=${B}&roles[0]=primary&sortOrder[0]=4&roles[1]=preview&sortOrder[1]=7`);
      expect(legacy.res.status).toBe(302);
      expect(rows(positional.id)).toEqual([[A, 'primary', 4], [B, 'preview', 7]]);
      const unsafe = persisted('B-F2R5 unsafe');
      const refused = await postRaw(unsafe.id, `selectedAssetIds=${ids[5]}&roles[0]=primary&sortOrder[0]=9007199254740992`);
      expect(refused.res.status).toBe(422);
      expect(refused.res.text).toContain('Invalid asset order.');
      expect(refused.sql.membershipWrites).toBe(0);
      expect(rows(unsafe.id)).toEqual(PERSISTED_ROWS());
    });

    it('keeps unknown, foreign and duplicate refusals for indexed selected IDs', async () => {
      const A = ids[5];
      for (const [label, raw, status, message] of [
        ['unknown', `selectedAssetIds[0]=${A}&selectedAssetIds[1]=999999999`, 404, null],
        ['foreign', `selectedAssetIds[0]=${A}&selectedAssetIds[1]=${foreignId}`, 422, `Asset ${foreignId} does not belong to the release&#39;s project.`],
        ['duplicate', `selectedAssetIds[0]=${A}&selectedAssetIds[3]=${A}`, 422, 'Duplicate asset IDs are not allowed.'],
      ]) {
        const release = persisted(`B-F2R5 ${label}`);
        const { res, sql } = await postRaw(release.id, raw);
        expect(res.status, label).toBe(status);
        if (message) expect(res.text, label).toContain(message);
        expect(res.text, label).not.toContain('foreign-secret');
        expect(sql.membershipWrites, label).toBe(0);
        expect(rows(release.id), label).toEqual(PERSISTED_ROWS());
      }
    });

    it('a rejected malformed Save cannot be retried into an empty Save', async () => {
      const release = persisted();
      const first = await postRaw(release.id, 'selectedAssetIds[__proto__]=3');
      expectFailClosed(first, release, 'initial');
      // No Save form, so the response offers nothing a browser could submit.
      expect(first.res.text).not.toMatch(/<form\b[^>]*action="\/releases\/\d+\/assets[^"]*"[^>]*method="post"/i);
      expect(first.res.text).not.toMatch(/<form\b[^>]*method="post"[^>]*action="\/releases\/\d+\/assets/i);
      const reload = /<a href="([^"]+)">Reload Manage Assets<\/a>/.exec(first.res.text)?.[1]?.replace(/&amp;/g, '&');
      expect(reload).toBe(`/releases/${release.id}/assets?pageSize=10`);
      // Reload starts from the saved selection: A and B checked.
      const page = await agent.get(reload);
      expect(page.status).toBe(200);
      const entries = retryFormEntries(page.text);
      expect(selectedIds(entries).sort((x, y) => x - y)).toEqual([ids[5], ids[6]]);
      expect(rows(release.id)).toEqual(PERSISTED_ROWS());
      // Submitting the reloaded form unchanged keeps both members and roles.
      const resubmit = await post(release.id, entries.filter(([name]) => name !== '_csrf'));
      expect(resubmit.res.status).toBe(302);
      expect(rows(release.id)).toEqual(PERSISTED_ROWS());
      // Repeating the malformed POST stays refused.
      expectFailClosed(await postRaw(release.id, 'selectedAssetIds[__proto__]=3'), release, 'repeat');
    });

    it('read-only releases keep the B-F4 saved collection for a malformed selected-ID POST', async () => {
      const cases = [
        ['published', (release) => db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(release.id)],
        ['archived', (release) => db.prepare('UPDATE releases SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(release.id)],
        ['archived project', () => db.prepare("UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?").run(projectId)],
      ];
      for (const [label, lock] of cases) {
        const release = persisted(`B-F2R5 ${label}`);
        lock(release);
        const { res, sql } = await postRaw(release.id, 'selectedAssetIds[__proto__]=3');
        expect(res.status, label).toBe(422);
        expect(res.text, label).toContain(FORMAT_ERROR);
        expect(res.text, label).not.toContain('id="release-assets-form"');
        expect(res.text, label).not.toContain('name="roleOrder"');
        expect(res.text, label).not.toContain('data-release-assets-save-recovery-unavailable');
        // The complete persisted saved collection is displayed.
        expect(res.text, label).toContain('img-0005.png');
        expect(res.text, label).toContain('img-0006.png');
        expect(sql.membershipWrites, label).toBe(0);
        expect(rows(release.id), label).toEqual(PERSISTED_ROWS());
      }
    });

    it('keeps CSRF ahead of the route for a malformed selected-ID POST', async () => {
      const release = persisted();
      const { res, sql } = await postRaw(release.id, 'selectedAssetIds[__proto__]=3', 'forged');
      expect(res.status).toBe(403);
      expect(sql.membershipWrites).toBe(0);
      expect(rows(release.id)).toEqual(PERSISTED_ROWS());
    });

    // ─── B-F2R6: a raw field name outside the Save contract is refused ──────
    // Express's parser drops or relocates keys such as
    // `__proto__[selectedAssetIds]` or `selectedAssetIds.__proto__`, leaving no
    // selectedAssetIds at all — which used to read as an intentional empty
    // Save and delete every member. Every raw name is now classified against
    // the Save contract (_csrf, roleOrder bare; selectedAssetIds, roleAssetIds,
    // roles, sortOrder bare / [] / [k]) before any format is chosen.
    describe('unsupported raw Save field names (B-F2R6)', () => {
      it('refuses each reported alias independently with zero membership writes', async () => {
        for (const raw of [
          '__proto__[selectedAssetIds]=1',
          'constructor[selectedAssetIds]=1',
          'selectedAssetIds.__proto__=1',
          'selectedAssetIds%2E__proto__=1',
        ]) {
          const release = persisted('B-F2R6 reported alias');
          expect(rows(release.id), raw).toEqual(PERSISTED_ROWS());
          expectFailClosed(await postRaw(release.id, raw), release, raw);
        }
      });

      it('refuses prototype-rooted, dotted and encoded aliases after one qs-equivalent decode', async () => {
        for (const raw of [
          'prototype[selectedAssetIds]=1',
          'toString[selectedAssetIds]=1',
          'hasOwnProperty[selectedAssetIds]=1',
          'selectedAssetIds.constructor=1',
          'selectedAssetIds.prototype=1',
          'selectedAssetIds.toString=1',
          'selectedAssetIds[__proto__]=1',
          'selectedAssetIds[constructor]=1',
          '__proto__[selectedAssetIds][0]=1',
          '__proto__[__proto__][selectedAssetIds]=1',
          'constructor[prototype][selectedAssetIds]=1',
          'selectedAssetIds.__proto__[0]=1',
          'selectedAssetIds.__proto__.x=1',
          // Percent-encoded brackets, dots and underscores; mixed case escapes.
          '__proto__%5BselectedAssetIds%5D=1',
          '__proto__%5bselectedAssetIds%5d=1',
          '%5F%5Fproto%5F%5F%5BselectedAssetIds%5D=1',
          '%5f%5fproto%5f%5f[selectedAssetIds]=1',
          'constructor%5BselectedAssetIds%5D=1',
          'selectedAssetIds%2e__proto__=1',
          'selectedAssetIds%2E%5F%5Fproto%5F%5F=1',
          'selectedAssetIds%2Econstructor=1',
          'selectedAssetIds.%5F%5Fproto%5F%5F=1',
          // Double-encoded names stay literal after the single decode.
          'selectedAssetIds%255B0%255D=1',
          'selectedAssetIds%252E__proto__=1',
          '%5BselectedAssetIds%5D%5B0%5D=1',
        ]) {
          const release = persisted('B-F2R6 alias');
          expectFailClosed(await postRaw(release.id, raw), release, raw);
        }
      });

      it('refuses unknown, empty, nested and malformed field names in general', async () => {
        for (const raw of [
          'unknownField=1',
          'zzUnknownMarker=1',
          'selectedAssetIds.extra=1',
          'selectedAssetIds[extra]=1',
          '[selectedAssetIds][0]=1',
          '[zzUnknownMarker]=1',
          '[]=1',
          'unknown[selectedAssetIds]=1',
          'nested[unknown][selectedAssetIds]=1',
          '=1',
          '=',
          'zzUnknownMarker',
          'SelectedAssetIds=1',
          'selectedassetids=1',
          'selected+AssetIds=1',
          'selectedAssetIds%20=1',
          'selectedAssetIds+=1',
          's%C3%A9lectedAssetIds=1',
          'selectedAssetIds%ZZ=1',
          'selectedAssetIds%=1',
          // Scalar fields are accepted only under their exact bare name
          // (`_csrf[]` / `_csrf[0]` reshape the token and are refused by CSRF
          // first; see the CSRF case below).
          '_csrf.x=1',
          '_csrf%2Ex=1',
          'roleOrder[]=%5B%5D',
          'roleOrder[0]=%5B%5D',
          'roleOrder.x=1',
        ]) {
          const release = persisted('B-F2R6 unknown');
          const result = await postRaw(release.id, raw);
          expectFailClosed(result, release, raw);
          // Attacker-controlled names are never echoed.
          expect(result.res.text, raw).not.toContain('zzUnknownMarker');
        }
      });

      it('a supported field never masks an unsupported one, in either order', async () => {
        const [A, B, C] = [ids[5], ids[6], ids[7]];
        const compact = `roleOrder=${encodeURIComponent(JSON.stringify([[A, 'primary', 0], [B, 'preview', 1]]))}`;
        const keyed = `roleAssetIds[0]=${A}&roleAssetIds[1]=${B}&roles[0]=primary&sortOrder[0]=0&roles[1]=preview&sortOrder[1]=1`;
        const positional = `selectedAssetIds[0]=${A}&selectedAssetIds[1]=${B}&roles[0]=primary&sortOrder[0]=0`;
        const pairs = [
          // A/B: valid selected ID with a malformed alias.
          [`selectedAssetIds=${A}`, '__proto__[selectedAssetIds]=1'],
          [`selectedAssetIds=${A}`, 'selectedAssetIds.__proto__=1'],
          [`selectedAssetIds=${A}&selectedAssetIds=${C}`, 'selectedAssetIds%2E__proto__=1'],
          // C: valid IDs with an unrelated unsupported field.
          [`selectedAssetIds=${A}&selectedAssetIds=${B}&selectedAssetIds=${C}`, 'unknownField=1'],
          [`selectedAssetIds[0]=${A}&selectedAssetIds[3]=${C}`, 'nested[unknown][selectedAssetIds]=1'],
          // D: no valid selected IDs, only an alias (with a bare empty value).
          ['selectedAssetIds=', '__proto__[selectedAssetIds]=1'],
          // E: valid compact carrier.
          [`selectedAssetIds=${A}&selectedAssetIds=${B}&${compact}`, 'constructor[selectedAssetIds]=1'],
          [compact, 'selectedAssetIds.__proto__=1'],
          // F: valid keyed and positional role/order.
          [`selectedAssetIds=${A}&selectedAssetIds=${B}&${keyed}`, 'selectedAssetIds%2E__proto__=1'],
          [keyed, '__proto__[selectedAssetIds]=1'],
          [positional, 'unknown[selectedAssetIds]=1'],
        ];
        for (const [valid, alias] of pairs) {
          for (const raw of [`${valid}&${alias}`, `${alias}&${valid}`]) {
            const release = persisted('B-F2R6 mixed');
            expectFailClosed(await postRaw(release.id, raw), release, raw);
          }
        }
      });

      it('keeps every supported Save format and both intentional empty Saves', async () => {
        const [A, B, C] = [ids[5], ids[6], ids[7]];
        const cases = [
          // Normal one-asset membership-only Save keeps A's saved role/order.
          ['one asset', `selectedAssetIds=${A}`, [[A, 'primary', 0]]],
          ['membership-only', `selectedAssetIds=${A}&selectedAssetIds=${B}&selectedAssetIds=${C}`,
            [[A, 'primary', 0], [B, 'preview', 1], [C, 'attachment', 2]]],
          ['sparse indexed', `selectedAssetIds[150]=${B}&selectedAssetIds[7]=${A}`, [[A, 'primary', 0], [B, 'preview', 1]]],
          ['encoded brackets', `selectedAssetIds%5B0%5D=${A}&selectedAssetIds%5b1%5d=${C}`, null],
          ['positional', `selectedAssetIds[0]=${A}&selectedAssetIds[1]=${C}&roles[0]=preview&sortOrder[0]=4&roles[1]=primary&sortOrder[1]=2`,
            [[A, 'preview', 4], [C, 'primary', 2]]],
          ['keyed', `selectedAssetIds=${A}&selectedAssetIds=${C}&roleAssetIds[0]=${C}&roleAssetIds[3]=${A}&roles[3]=preview&sortOrder[3]=9`,
            [[A, 'preview', 9], [C, 'attachment', 0]]],
          ['compact', `selectedAssetIds=${A}&selectedAssetIds=${C}&roleOrder=${encodeURIComponent(JSON.stringify([[C, 'primary', 0], [A, 'preview', 5]]))}`,
            [[A, 'preview', 5], [C, 'primary', 0]]],
          ['empty: no selected-ID field', '', []],
          ['empty: bare selectedAssetIds=', 'selectedAssetIds=', []],
        ];
        for (const [label, raw, expected] of cases) {
          const release = persisted(`B-F2R6 ${label}`);
          const { res, sql } = await postRaw(release.id, raw);
          expect(res.status, label).toBe(302);
          expectReleaseAssetsSavedLocation(res.headers.location, release.id, label);
          expect(sql.membershipWrites, label).toBeGreaterThan(0);
          if (expected) {
            expect(rows(release.id), label).toEqual([...expected].sort((x, y) => x[0] - y[0]));
          } else {
            expect(rows(release.id).map(([assetId]) => assetId), label).toEqual([A, C]);
          }
        }
      });

      it('a repeated unsupported Save stays refused and the reloaded form saves A and B unchanged', async () => {
        const release = persisted('B-F2R6 retry');
        for (const raw of ['__proto__[selectedAssetIds]=1', 'selectedAssetIds.__proto__=1', '__proto__[selectedAssetIds]=1']) {
          const result = await postRaw(release.id, raw);
          expectFailClosed(result, release, raw);
          expect(result.res.text, raw).not.toMatch(/<form\b[^>]*method="post"[^>]*action="\/releases\/\d+\/assets/i);
          expect(result.res.text, raw).not.toMatch(/<form\b[^>]*action="\/releases\/\d+\/assets[^"]*"[^>]*method="post"/i);
          const reload = /<a href="([^"]+)">Reload Manage Assets<\/a>/.exec(result.res.text)?.[1]?.replace(/&amp;/g, '&');
          expect(reload, raw).toBe(`/releases/${release.id}/assets?pageSize=10`);
        }
        const page = await agent.get(`/releases/${release.id}/assets?pageSize=10`);
        const entries = retryFormEntries(page.text);
        expect(selectedIds(entries).sort((x, y) => x - y)).toEqual([ids[5], ids[6]]);
        const resubmit = await post(release.id, entries.filter(([name]) => name !== '_csrf'));
        expect(resubmit.res.status).toBe(302);
        expect(rows(release.id)).toEqual(PERSISTED_ROWS());
      });

      it('read-only releases keep the B-F4 saved collection for an unsupported field', async () => {
        const cases = [
          ['published', (release) => db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(release.id)],
          ['archived', (release) => db.prepare('UPDATE releases SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(release.id)],
          ['archived project', () => db.prepare("UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?").run(projectId)],
        ];
        for (const [label, lock] of cases) {
          const release = persisted(`B-F2R6 ${label}`);
          lock(release);
          for (const raw of ['__proto__[selectedAssetIds]=1', 'selectedAssetIds%2E__proto__=1']) {
            const { res, sql } = await postRaw(release.id, raw);
            expect(res.status, `${label} ${raw}`).toBe(422);
            expect(res.text, label).toContain(FORMAT_ERROR);
            expect(res.text, label).not.toContain('id="release-assets-form"');
            expect(res.text, label).not.toContain('name="roleOrder"');
            expect(res.text, label).not.toContain('name="selectedAssetIds"');
            expect(res.text, label).not.toContain('data-release-assets-save-recovery-unavailable');
            expect(res.text, label).toContain('img-0005.png');
            expect(res.text, label).toContain('img-0006.png');
            expect(sql.membershipWrites, label).toBe(0);
            expect(sql.validation, label).toBe(0);
            expect(rows(release.id), label).toEqual(PERSISTED_ROWS());
          }
        }
      });

      it('keeps CSRF, unknown, foreign and duplicate refusals ahead of or alongside the field contract', async () => {
        const A = ids[5];
        const forgedRelease = persisted('B-F2R6 csrf');
        const forged = await postRaw(forgedRelease.id, '__proto__[selectedAssetIds]=1', 'forged');
        expect(forged.res.status).toBe(403);
        expect(forged.sql.membershipWrites).toBe(0);
        expect(rows(forgedRelease.id)).toEqual(PERSISTED_ROWS());
        // A reshaped token field (`_csrf[]`, `_csrf[0]`) is refused by CSRF.
        for (const raw of ['_csrf[]=x', '_csrf[0]=x', '_csrf%5Bx%5D.y=1']) {
          const { res, sql } = await postRaw(forgedRelease.id, raw);
          expect(res.status, raw).toBe(403);
          expect(sql.membershipWrites, raw).toBe(0);
          expect(rows(forgedRelease.id), raw).toEqual(PERSISTED_ROWS());
        }
        for (const [label, raw, status] of [
          ['unknown', `selectedAssetIds=${A}&selectedAssetIds=999999999`, 404],
          ['foreign', `selectedAssetIds=${A}&selectedAssetIds=${foreignId}`, 422],
          ['duplicate', `selectedAssetIds=${A}&selectedAssetIds=${A}`, 422],
          // An unsupported name is refused before any asset lookup, so a
          // foreign ID beside it is never resolved or disclosed.
          ['foreign + alias', `selectedAssetIds=${foreignId}&__proto__[selectedAssetIds]=1`, 422],
        ]) {
          const release = persisted(`B-F2R6 ${label}`);
          const { res, sql } = await postRaw(release.id, raw);
          expect(res.status, label).toBe(status);
          expect(res.text, label).not.toContain('foreign-secret');
          expect(sql.membershipWrites, label).toBe(0);
          if (label === 'foreign + alias') expect(sql.validation, label).toBe(0);
          expect(rows(release.id), label).toEqual(PERSISTED_ROWS());
        }
      });
    });

    // ─── B-F2R7: only a URL-encoded form body is a Save draft ───────────────
    // The Manage Assets Save form posts application/x-www-form-urlencoded.
    // express.json() also parses JSON for every route, and text/plain,
    // octet-stream, multipart or a missing Content-Type leave req.body empty,
    // so either could reach parsed-body interpretation as a full or partial
    // membership replacement (an apparently intentional empty Save). The route
    // refuses any other media type with 415 before reading the draft.
    //
    // Requests here go over a real socket with node:http so the exact
    // Content-Type header and body bytes are what the test writes (no client
    // default), and the server's own `request` event records what arrived.
    describe('Save request Content-Type enforcement (B-F2R7)', () => {
      const UNSUPPORTED = 'Unsupported asset selection request format.';
      let server;
      let origin;
      let cookie;
      let token;
      let arrived;

      beforeEach(async () => {
        arrived = [];
        server = http.createServer(app);
        server.on('request', (req) => {
          arrived.push({ method: req.method, url: req.url, contentType: req.headers['content-type'] });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${server.address().port}`;
        const health = await rawRequest('GET', '/health', {});
        const setCookie = health.headers['set-cookie'].find((value) => value.startsWith('cc_csrf_anon='));
        cookie = setCookie.split(';')[0];
        const { csrfPepper } = ensureAuthEnablement(path.join(tmpDir, 'app'));
        token = deriveDisabledModeCsrfToken(csrfPepper, decodeURIComponent(cookie.split('=')[1]));
      });

      afterEach(async () => {
        await new Promise((resolve) => server.close(resolve));
      });

      function rawRequest(method, pathname, headers, body) {
        return new Promise((resolve, reject) => {
          const req = http.request(`${origin}${pathname}`, { method, headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
          });
          req.on('error', reject);
          if (body !== undefined) req.write(body);
          req.end();
        });
      }

      /**
       * POST exactly `body` with exactly `contentType` (undefined omits the
       * header). `csrf` is sent as X-CSRF-Token unless null.
       */
      async function send(releaseId, { contentType, body, csrf = token }) {
        const headers = { Cookie: cookie, Accept: 'text/html', 'Content-Length': Buffer.byteLength(body) };
        if (contentType !== undefined) headers['Content-Type'] = contentType;
        if (csrf !== null) headers['X-CSRF-Token'] = csrf;
        arrived.length = 0;
        trace.length = 0;
        rowLog.length = 0;
        tracing = true;
        let res;
        try {
          res = await rawRequest('POST', `/releases/${releaseId}/assets?pageSize=10`, headers, body);
        } finally {
          tracing = false;
        }
        const count = (pattern) => trace.filter((text) => pattern.test(text)).length;
        const post = arrived.filter((entry) => entry.method === 'POST');
        expect(post).toHaveLength(1);
        return {
          res,
          sentContentType: contentType,
          arrivedContentType: post[0].contentType,
          sql: {
            membershipWrites: count(MEMBERSHIP_WRITE),
            validation: count(VALIDATION),
            begin: count(/^BEGIN\b/),
            assetReads: count(/^SELECT\b.*\bFROM assets\b/),
          },
        };
      }

      function expectUnsupported(result, release, label) {
        const { res, sql } = result;
        // Persisted membership and write count first: they are the data-loss oracle.
        expect(rows(release.id), label).toEqual(PERSISTED_ROWS());
        expect(sql.membershipWrites, label).toBe(0);
        expect(sql.begin, label).toBe(0);
        expect(sql.validation, label).toBe(0);
        expect(sql.assetReads, label).toBe(0);
        expect(db.inTransaction, label).toBe(false);
        expect(result.arrivedContentType, label).toBe(result.sentContentType);
        expect(res.status, label).toBe(415);
        expect(res.headers.location, label).toBeUndefined();
        expect(res.text, label).toContain(UNSUPPORTED);
        // An explicit refusal: no success notice, no Save form that could
        // resubmit an empty draft, and no project or foreign metadata.
        expect(res.text, label).not.toContain('id="release-assets-form"');
        expect(res.text, label).not.toContain('Save asset selection');
        expect(res.text, label).not.toContain('name="selectedAssetIds"');
        expect(res.text, label).not.toContain('name="roleOrder"');
        expect(res.text, label).not.toContain('img-0005.png');
        expect(res.text, label).not.toContain('foreign-secret');
        expect(res.text, label).not.toContain('B-F3 Project');
        expect(res.text, label).not.toMatch(/saved|updated/i);
      }

      function expectCsrfRefused(result, release, label) {
        expect(rows(release.id), label).toEqual(PERSISTED_ROWS());
        expect(result.sql.membershipWrites, label).toBe(0);
        expect(result.res.status, label).toBe(403);
        expect(result.res.text, label).not.toContain(UNSUPPORTED);
      }

      const json = (value) => JSON.stringify(value);

      it('reproduces the reviewer cases: JSON and unparsed bodies are refused, A and B kept', async () => {
        const [A, B, C] = [ids[5], ids[6], ids[7]];
        const cases = [
          // CASE 1: the token travels in the JSON body itself (no header), so
          // a non-403 answer proves express.json() parsed it.
          ['json unknown only', { contentType: 'application/json', body: json({ _csrf: token, unknown: 1 }), csrf: null }],
          // CASE 2: a partial replacement (A, C) that would drop B.
          ['json mixed', { contentType: 'application/json', body: json({ _csrf: token, selectedAssetIds: [A, C], unknown: 1 }), csrf: null }],
          // CASE 3/4: body never parsed; CSRF through the accepted header.
          ['text/plain', { contentType: 'text/plain', body: 'selectedAssetIds=3' }],
          ['octet-stream', { contentType: 'application/octet-stream', body: 'selectedAssetIds=3' }],
        ];
        for (const [label, request] of cases) {
          const release = persisted(`B-F2R7 ${label}`);
          expect(rows(release.id), label).toEqual([[A, 'primary', 0], [B, 'preview', 1]]);
          expectUnsupported(await send(release.id, request), release, label);
        }
        // Negative authorization control: a forged header is still 403.
        const forged = persisted('B-F2R7 forged');
        expectCsrfRefused(await send(forged.id, { contentType: 'text/plain', body: 'selectedAssetIds=3', csrf: 'forged' }), forged, 'forged');
      });

      it('refuses every JSON Save shape before draft interpretation', async () => {
        const [A, B, C] = [ids[5], ids[6], ids[7]];
        const compact = json([[A, 'primary', 0], [B, 'preview', 1]]);
        const cases = [
          ['A unknown only', { _csrf: token, unknown: 1 }],
          ['B selected + unknown', { _csrf: token, selectedAssetIds: [A, C], unknown: 1 }],
          ['C valid-looking selected', { selectedAssetIds: [A, B] }],
          ['C scalar selected', { selectedAssetIds: String(A) }],
          ['D empty selected', { selectedAssetIds: [] }],
          ['D empty object', {}],
          ['E compact roleOrder', { selectedAssetIds: [A, B], roleOrder: compact }],
          ['E keyed', { selectedAssetIds: [A, B], roleAssetIds: [A, B], roles: ['primary', 'preview'], sortOrder: ['0', '1'] }],
          ['F malformed nesting', { selectedAssetIds: { 0: { 1: [A] } }, roles: [[['primary']]], nested: { selectedAssetIds: [C] } }],
          ['F prototype keys', JSON.parse(`{"__proto__":{"selectedAssetIds":[${C}]},"constructor":{"prototype":{}}}`)],
        ];
        for (const contentType of ['application/json', 'application/json; charset=utf-8', 'application/vnd.api+json', 'application/merge-patch+json']) {
          for (const [label, value] of cases) {
            const release = persisted(`B-F2R7 json ${label}`);
            // G: valid CSRF in the supported header.
            expectUnsupported(await send(release.id, { contentType, body: json(value) }), release, `${contentType} ${label}`);
          }
        }
        // H: invalid CSRF on JSON stays the established 403, header or body.
        const forged = persisted('B-F2R7 json forged');
        expectCsrfRefused(await send(forged.id, { contentType: 'application/json', body: json({ selectedAssetIds: [A] }), csrf: 'forged' }), forged, 'json forged header');
        expectCsrfRefused(await send(forged.id, { contentType: 'application/json', body: json({ _csrf: 'forged', selectedAssetIds: [A] }), csrf: null }), forged, 'json forged body');
        expectCsrfRefused(await send(forged.id, { contentType: 'application/json', body: json({ selectedAssetIds: [A] }), csrf: null }), forged, 'json missing token');
        // Syntactically invalid JSON is refused by the parser (400) before CSRF.
        const broken = persisted('B-F2R7 json broken');
        const brokenResult = await send(broken.id, { contentType: 'application/json', body: '{"selectedAssetIds":' });
        expect(brokenResult.res.status).toBe(400);
        expect(brokenResult.sql.membershipWrites).toBe(0);
        expect(rows(broken.id)).toEqual(PERSISTED_ROWS());
      });

      it('refuses unparsed, multipart, missing, unexpected, malformed and look-alike media types', async () => {
        const A = ids[5];
        const form = `selectedAssetIds=${A}`;
        const multipartBody = [
          '--b7', 'Content-Disposition: form-data; name="_csrf"', '', 'x',
          '--b7', 'Content-Disposition: form-data; name="selectedAssetIds"', '', String(A),
          '--b7--', '',
        ].join('\r\n');
        const cases = [
          ['text/plain', 'text/plain', form],
          ['text/plain charset', 'text/plain; charset=utf-8', form],
          ['octet-stream', 'application/octet-stream', form],
          ['multipart', 'multipart/form-data; boundary=b7', multipartBody],
          ['missing', undefined, form],
          ['unexpected xml', 'application/xml', form],
          ['unexpected html', 'text/html', form],
          ['malformed: no subtype', 'application/', form],
          ['malformed: no slash', 'x-www-form-urlencoded', form],
          ['malformed: empty parameter', 'application/x-www-form-urlencoded;;;=', form],
          ['malformed: bad parameter', 'application/x-www-form-urlencoded; charset', form],
          ['malformed: spaces in type', 'application /x-www-form-urlencoded', form],
          ['look-alike: suffix', 'application/x-www-form-urlencodedx', form],
          ['look-alike: +json', 'application/x-www-form-urlencoded+json', form],
          ['look-alike: text tree', 'text/x-www-form-urlencoded', form],
          ['look-alike: truncated', 'application/x-www-form-urlencode', form],
          ['look-alike: no x-', 'application/www-form-urlencoded', form],
          ['look-alike: reversed', 'x-www-form-urlencoded/application', form],
          ['look-alike: in parameter', 'text/plain; type=application/x-www-form-urlencoded', form],
          ['look-alike: two types', 'text/plain, application/x-www-form-urlencoded', form],
        ];
        for (const [label, contentType, body] of cases) {
          const release = persisted(`B-F2R7 ${label}`);
          expectUnsupported(await send(release.id, { contentType, body }), release, label);
        }
        // A nonempty unparsed body with no usable req.body is never an empty Save,
        // even when the token is only in that unparsed body (CSRF then refuses).
        for (const [label, contentType, body] of [
          ['text/plain missing token', 'text/plain', `_csrf=${token}&${form}`],
          ['octet-stream forged', 'application/octet-stream', form],
          ['multipart forged', 'multipart/form-data; boundary=b7', multipartBody],
          ['missing type forged', undefined, form],
        ]) {
          const release = persisted(`B-F2R7 csrf ${label}`);
          const csrf = label.endsWith('forged') ? 'forged' : null;
          expectCsrfRefused(await send(release.id, { contentType, body, csrf }), release, label);
        }
      });

      it('keeps the parser charset boundary: a non-UTF-8 URL-encoded charset is refused before CSRF', async () => {
        for (const charset of ['iso-8859-1', 'utf-16', 'latin1', 'x-unknown']) {
          const release = persisted(`B-F2R7 charset ${charset}`);
          const result = await send(release.id, {
            contentType: `application/x-www-form-urlencoded; charset=${charset}`,
            body: `_csrf=${token}&selectedAssetIds=${ids[5]}`,
            csrf: null,
          });
          expect(result.res.status, charset).toBe(415);
          expect(result.sql.membershipWrites, charset).toBe(0);
          expect(result.sql.validation, charset).toBe(0);
          expect(rows(release.id), charset).toEqual(PERSISTED_ROWS());
        }
      });

      it('accepts the browser URL-encoded Save with or without a UTF-8 charset, in every supported format', async () => {
        const [A, B, C] = [ids[5], ids[6], ids[7]];
        const compact = encodeURIComponent(json([[C, 'primary', 0], [A, 'preview', 5]]));
        const formats = [
          ['membership-only', `selectedAssetIds=${A}&selectedAssetIds=${B}&selectedAssetIds=${C}`,
            [[A, 'primary', 0], [B, 'preview', 1], [C, 'attachment', 2]]],
          ['positional', `selectedAssetIds[0]=${A}&selectedAssetIds[1]=${C}&roles[0]=preview&sortOrder[0]=4&roles[1]=primary&sortOrder[1]=2`,
            [[A, 'preview', 4], [C, 'primary', 2]]],
          ['sparse keyed', `selectedAssetIds=${A}&selectedAssetIds=${C}&roleAssetIds[0]=${C}&roleAssetIds[3]=${A}&roles[3]=preview&sortOrder[3]=9`,
            [[A, 'preview', 9], [C, 'attachment', 0]]],
          ['compact', `selectedAssetIds=${A}&selectedAssetIds=${C}&roleOrder=${compact}`,
            [[A, 'preview', 5], [C, 'primary', 0]]],
          ['empty A: no selected-ID field', '', []],
          ['empty B: bare selectedAssetIds=', 'selectedAssetIds=', []],
        ];
        for (const contentType of [
          'application/x-www-form-urlencoded',
          'application/x-www-form-urlencoded;charset=UTF-8',
          'application/x-www-form-urlencoded; charset=utf-8',
          'Application/X-WWW-Form-URLEncoded; Charset="UTF-8"',
        ]) {
          for (const [label, raw, expected] of formats) {
            const release = persisted(`B-F2R7 ${label}`);
            const name = `${contentType} ${label}`;
            // Token in the form body, as the rendered form submits it.
            const body = raw === '' ? `_csrf=${encodeURIComponent(token)}` : `_csrf=${encodeURIComponent(token)}&${raw}`;
            const result = await send(release.id, { contentType, body, csrf: null });
            expect(result.arrivedContentType, name).toBe(contentType);
            expect(result.res.status, name).toBe(302);
            expectReleaseAssetsSavedLocation(result.res.headers.location, release.id, name);
            expect(result.sql.membershipWrites, name).toBeGreaterThan(0);
            expect(db.inTransaction, name).toBe(false);
            expect(rows(release.id), name).toEqual([...expected].sort((x, y) => x[0] - y[0]));
          }
        }
        // The token may also travel in the supported header for a form body.
        const headerRelease = persisted('B-F2R7 form header token');
        const viaHeader = await send(headerRelease.id, { contentType: 'application/x-www-form-urlencoded', body: `selectedAssetIds=${B}` });
        expect(viaHeader.res.status).toBe(302);
        // Membership-only keeps B's saved role and renumbers its order.
        expect(rows(headerRelease.id)).toEqual([[B, 'preview', 0]]);
      });

      it('keeps URL-encoded CSRF and raw-field refusals unchanged', async () => {
        const A = ids[5];
        const forged = persisted('B-F2R7 form forged');
        expectCsrfRefused(await send(forged.id, {
          contentType: 'application/x-www-form-urlencoded', body: `_csrf=forged&selectedAssetIds=${A}`, csrf: null,
        }), forged, 'form forged body');
        expectCsrfRefused(await send(forged.id, {
          contentType: 'application/x-www-form-urlencoded', body: `selectedAssetIds=${A}`, csrf: null,
        }), forged, 'form missing token');
        // B-F2R5/B-F2R6 raw validation still answers a malformed URL-encoded Save.
        for (const raw of ['unknown=1', '__proto__[selectedAssetIds]=1', 'selectedAssetIds[__proto__]=3']) {
          const release = persisted('B-F2R7 raw field');
          const result = await send(release.id, {
            contentType: 'application/x-www-form-urlencoded; charset=UTF-8', body: `_csrf=${token}&${raw}`, csrf: null,
          });
          expect(rows(release.id), raw).toEqual(PERSISTED_ROWS());
          expect(result.sql.membershipWrites, raw).toBe(0);
          expect(result.res.status, raw).toBe(422);
          expect(result.res.text, raw).toContain(FORMAT_ERROR);
          expect(result.res.text, raw).toContain('data-release-assets-save-recovery-unavailable');
          expect(result.res.text, raw).not.toContain(UNSUPPORTED);
        }
      });

      it('read-only releases refuse unsupported media types without writes or Save controls; B-F4 is unchanged', async () => {
        const cases = [
          ['published', (release) => db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(release.id)],
          ['archived', (release) => db.prepare('UPDATE releases SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(release.id)],
          ['archived project', () => db.prepare("UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?").run(projectId)],
        ];
        for (const [label, lock] of cases) {
          const release = persisted(`B-F2R7 ${label}`);
          lock(release);
          for (const request of [
            { contentType: 'application/json', body: json({ _csrf: token, unknown: 1 }), csrf: null },
            { contentType: 'application/json', body: json({ selectedAssetIds: [ids[7]] }) },
            { contentType: 'text/plain', body: 'selectedAssetIds=3' },
            { contentType: 'multipart/form-data; boundary=b7', body: '--b7--\r\n' },
            { contentType: undefined, body: 'selectedAssetIds=3' },
          ]) {
            expectUnsupported(await send(release.id, request), release, `${label} ${request.contentType}`);
          }
          // A supported but malformed URL-encoded request keeps the B-F4 page.
          const malformed = await send(release.id, {
            contentType: 'application/x-www-form-urlencoded', body: `_csrf=${token}&__proto__[selectedAssetIds]=1`, csrf: null,
          });
          expect(malformed.res.status, label).toBe(422);
          expect(malformed.res.text, label).toContain(FORMAT_ERROR);
          expect(malformed.res.text, label).toContain('img-0005.png');
          expect(malformed.res.text, label).toContain('img-0006.png');
          expect(malformed.res.text, label).not.toContain('id="release-assets-form"');
          expect(malformed.sql.membershipWrites, label).toBe(0);
          expect(rows(release.id), label).toEqual(PERSISTED_ROWS());
        }
      });

      it('keeps the large URL-encoded Save boundary under the unchanged parser limits', async () => {
        const selected = ids.slice(0, 517);
        const roleOrder = json(selected.map((id, index) => [id, index === 0 ? 'primary' : 'attachment', index]));
        const release = createRelease('B-F2R7 large');
        const body = [`_csrf=${encodeURIComponent(token)}`, ...selected.map((id) => `selectedAssetIds=${id}`), `roleOrder=${encodeURIComponent(roleOrder)}`].join('&');
        expect(Buffer.byteLength(body)).toBeLessThan(100 * 1024);
        const result = await send(release.id, { contentType: 'application/x-www-form-urlencoded;charset=UTF-8', body, csrf: null });
        expect(result.res.status).toBe(302);
        expect(result.sql.validation).toBe(2);
        expect(db.prepare('SELECT COUNT(*) AS n FROM release_assets WHERE release_id = ?').get(release.id).n).toBe(517);
        // The same members as JSON are refused, and the saved 517 stay.
        const refused = await send(release.id, { contentType: 'application/json', body: json({ selectedAssetIds: [selected[0]] }) });
        expect(refused.res.status).toBe(415);
        expect(refused.sql.membershipWrites).toBe(0);
        expect(db.prepare('SELECT COUNT(*) AS n FROM release_assets WHERE release_id = ?').get(release.id).n).toBe(517);
      });
    });
  });

  // ─── Package C1: HTTP Save input, recovery and security contract ──────────
  // Every request here is written byte for byte onto a real socket against a
  // real listening server, so the transmitted media type, framing and header
  // order are exactly what the test states. Each test builds its own release
  // (A Primary/0, B Preview/1 unless stated) and audits SQL during the
  // request: membership writes and BEGIN distinguish a validation refusal
  // (none), a rollback (BEGIN without a committed change) and a Save.
  describe('Manage Assets Save HTTP contract coverage (Package C1)', () => {
    const FORMAT_ERROR = 'Invalid asset selection format.';
    const ORDER_ERROR = 'Invalid asset order. Each order must be a whole number from 0 to 9007199254740991.';
    const UNSUPPORTED = 'Unsupported asset selection request format.';
    const UNSAFE = '9007199254740992';
    const FORM = 'application/x-www-form-urlencoded';
    // Real-socket matrices issue up to ~100 requests per test.
    const C1_TIMEOUT_MS = 60000;
    const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    let server;
    let port;
    let cookie;
    let token;
    let observed;

    beforeEach(async () => {
      observed = [];
      // Records what Node/Express saw for each request; app handles it unchanged.
      server = http.createServer((req, res) => {
        const entry = {
          method: req.method,
          rawHeaders: [...req.rawHeaders],
          contentType: req.headers['content-type'],
          contentLength: req.headers['content-length'],
          transferEncoding: req.headers['transfer-encoding'],
        };
        res.on('finish', () => {
          entry.expressForm = typeof req.is === 'function' ? req.is(FORM) : undefined;
          entry.expressJson = typeof req.is === 'function' ? req.is('application/json') : undefined;
          entry.bodyKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body).sort() : null;
        });
        observed.push(entry);
        app(req, res);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
      const health = await exchange(buildRequest({ method: 'GET', target: '/health', headers: [], framing: 'none' }));
      const setCookie = health.headers['set-cookie'].find((value) => value.startsWith('cc_csrf_anon='));
      cookie = setCookie.split(';')[0];
      const { csrfPepper } = ensureAuthEnablement(path.join(tmpDir, 'app'));
      token = deriveDisabledModeCsrfToken(csrfPepper, decodeURIComponent(cookie.split('=')[1]));
    }, C1_TIMEOUT_MS);

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
    }, C1_TIMEOUT_MS);

    /** Exact HTTP/1.1 request bytes. framing: 'length' | 'none' | 'chunked'. */
    function buildRequest({ method = 'POST', target, headers, body = '', framing = 'length', chunks = [] }) {
      const lines = [`${method} ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close'];
      for (const [name, value] of headers) lines.push(`${name}: ${value}`);
      let payload = Buffer.alloc(0);
      if (framing === 'length') {
        payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
        lines.push(`Content-Length: ${payload.length}`);
      } else if (framing === 'chunked') {
        lines.push('Transfer-Encoding: chunked');
        payload = Buffer.concat([
          ...chunks.flatMap((chunk) => {
            const bytes = Buffer.from(chunk, 'utf8');
            return [Buffer.from(`${bytes.length.toString(16)}\r\n`, 'latin1'), bytes, Buffer.from('\r\n', 'latin1')];
          }),
          Buffer.from('0\r\n\r\n', 'latin1'),
        ]);
      } else if (framing !== 'none') {
        throw new Error(`unknown framing ${framing}`);
      }
      return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), payload]);
    }

    function parseResponse(buffer) {
      const split = buffer.indexOf('\r\n\r\n');
      const head = buffer.subarray(0, split).toString('latin1').split('\r\n');
      const headers = {};
      for (const line of head.slice(1)) {
        const colon = line.indexOf(':');
        (headers[line.slice(0, colon).trim().toLowerCase()] ||= []).push(line.slice(colon + 1).trim());
      }
      let body = buffer.subarray(split + 4);
      if ((headers['transfer-encoding'] || []).some((value) => /chunked/i.test(value))) {
        const parts = [];
        let offset = 0;
        for (;;) {
          const lineEnd = body.indexOf('\r\n', offset);
          const size = parseInt(body.subarray(offset, lineEnd).toString('latin1'), 16);
          if (!size) break;
          parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
          offset = lineEnd + 2 + size + 2;
        }
        body = Buffer.concat(parts);
      }
      return {
        status: Number(head[0].split(' ')[1]),
        headers,
        location: headers.location ? headers.location[0] : undefined,
        text: body.toString('utf8'),
      };
    }

    function exchange(requestBytes) {
      return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        const chunks = [];
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('raw HTTP exchange timed out')); }, 10000);
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('end', () => { clearTimeout(timer); resolve(parseResponse(Buffer.concat(chunks))); });
        socket.on('error', (err) => { clearTimeout(timer); reject(err); });
        socket.write(requestBytes);
      });
    }

    /**
     * POST to Manage Assets Save. `contentTypes` lists every Content-Type
     * header line in transmission order ([] sends none). `csrfHeader` is the
     * X-CSRF-Token value (null omits it).
     */
    async function send(releaseId, {
      contentTypes = [FORM], body = '', framing = 'length', chunks, csrfHeader = null, extraHeaders = [],
    }) {
      const headers = [['Cookie', cookie], ['Accept', 'text/html']];
      for (const value of contentTypes) headers.push(['Content-Type', value]);
      if (csrfHeader !== null) headers.push(['X-CSRF-Token', csrfHeader]);
      headers.push(...extraHeaders);
      const requestBytes = buildRequest({ target: `/releases/${releaseId}/assets?pageSize=10`, headers, body, framing, chunks });
      observed.length = 0;
      trace.length = 0;
      rowLog.length = 0;
      tracing = true;
      let res;
      try {
        res = await exchange(requestBytes);
      } finally {
        tracing = false;
      }
      const count = (pattern) => trace.filter((text) => pattern.test(text)).length;
      const posts = observed.filter((entry) => entry.method === 'POST');
      expect(posts).toHaveLength(1);
      return {
        res,
        requestBytes,
        seen: posts[0],
        sql: {
          membershipWrites: count(MEMBERSHIP_WRITE),
          validation: count(VALIDATION),
          begin: count(/^BEGIN\b/),
          commit: count(/^COMMIT\b/),
          rollback: count(/^ROLLBACK\b/),
          // Any data write at all (membership, sessions, metadata).
          anyWrites: count(/^(?:INSERT|UPDATE|DELETE|REPLACE)\b/),
          assetReads: count(/^SELECT\b.*\bFROM assets\b/),
        },
      };
    }

    async function getPage(releaseId, query = '?pageSize=10') {
      return exchange(buildRequest({
        method: 'GET', target: `/releases/${releaseId}/assets${query}`, headers: [['Cookie', cookie], ['Accept', 'text/html']], framing: 'none',
      }));
    }

    const withToken = (raw) => (raw === '' ? `_csrf=${encodeURIComponent(token)}` : `_csrf=${encodeURIComponent(token)}&${raw}`);
    const A = () => ids[5];
    const B = () => ids[6];
    const C = () => ids[7];

    function rows(releaseId) {
      return db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY asset_id')
        .all(releaseId)
        .map((row) => [row.asset_id, row.role, row.sort_order]);
    }

    /** A fresh editable release: A Primary/0, B Preview/1. */
    // Release titles are neutral: a label such as `__proto__` must not reach
    // the page through the title, where it would mask the absence assertions.
    let releaseSerial = 0;
    function persisted(title) {
      releaseSerial += 1;
      const release = createRelease(`C1 release ${releaseSerial}`);
      service.selectAssets(release.id, [
        { assetId: A(), role: 'primary', sortOrder: 0 },
        { assetId: B(), role: 'preview', sortOrder: 1 },
      ]);
      expect(rows(release.id), `${title} fixture`).toEqual(PERSISTED());
      return release;
    }
    const PERSISTED = () => [[A(), 'primary', 0], [B(), 'preview', 1]];

    const LOCKS = [
      ['published', (release) => db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(release.id),
        () => 'This release is published. Asset selections are locked and read-only.'],
      ['archived release', (release) => db.prepare('UPDATE releases SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(release.id),
        (release) => `Release ${release.id} is archived and cannot be modified.`],
      ['archived parent project', () => db.prepare("UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?").run(projectId),
        () => `Project ${projectId} is archived and cannot be modified.`],
    ];
    function unlockProject() {
      db.prepare("UPDATE projects SET status = 'tbd', archived_at = NULL WHERE id = ?").run(projectId);
    }

    /**
     * Nothing was written and nothing is left open. A refusal page may read
     * its model inside one read-only snapshot (BEGIN … SELECT … COMMIT); that
     * snapshot holds no write and never rolls back, so a write-then-rollback
     * cannot pass for a validation refusal.
     */
    function expectUntouched(result, release, label, expected = PERSISTED()) {
      expect(rows(release.id), label).toEqual(expected);
      expect(result.sql.membershipWrites, label).toBe(0);
      expect(result.sql.anyWrites, label).toBe(0);
      expect(result.sql.rollback, label).toBe(0);
      expect(result.sql.begin, label).toBeLessThanOrEqual(1);
      expect(result.sql.commit, label).toBe(result.sql.begin);
      expect(db.inTransaction, label).toBe(false);
    }

    function expectNoSaveControls(text, label) {
      expect(text, label).not.toContain('id="release-assets-form"');
      expect(text, label).not.toContain('Save asset selection');
      expect(text, label).not.toContain('form="release-assets-form"');
      expect(text, label).not.toContain('name="selectedAssetIds"');
      expect(text, label).not.toContain('name="roleOrder"');
      expect(text, label).not.toMatch(/name="(?:roleAssetIds|roles|sortOrder)\[/);
      expect(text, label).not.toContain('foreign-secret');
    }

    function expectUnsupported(result, release, label) {
      expectUntouched(result, release, label);
      // Refused before any service read: no transaction at all.
      expect(result.sql.begin, label).toBe(0);
      expect(result.sql.validation, label).toBe(0);
      expect(result.sql.assetReads, label).toBe(0);
      expect(result.res.status, label).toBe(415);
      expect(result.res.location, label).toBeUndefined();
      expect(result.res.text, label).toContain(UNSUPPORTED);
      expectNoSaveControls(result.res.text, label);
      expect(result.res.text, label).not.toContain('img-0005.png');
      expect(result.res.text, label).not.toContain('C1 ');
    }

    function expectFailClosed(result, release, label, error = FORMAT_ERROR) {
      expectUntouched(result, release, label);
      expect(result.sql.validation, label).toBe(0);
      expect(result.res.status, label).toBe(422);
      expect(result.res.location, label).toBeUndefined();
      expect(result.res.text, label).toMatch(new RegExp(`<div class="error-summary" role="alert">\\s*<p>${escapeRe(error)}</p>`));
      expect(result.res.text, label).toContain('data-release-assets-save-recovery-unavailable');
      expect(result.res.text, label).toContain('<strong>Nothing was saved.</strong>');
      expectNoSaveControls(result.res.text, label);
      expect(result.res.text, label).not.toContain('__proto__');
    }

    function expectCsrfRefused(result, release, label) {
      expectUntouched(result, release, label);
      expect(result.sql.validation, label).toBe(0);
      expect(result.res.status, label).toBe(403);
      expect(result.res.location, label).toBeUndefined();
      expect(result.res.text, label).not.toContain(UNSUPPORTED);
    }

    function expectSaved(result, release, label, expected) {
      expect(result.res.status, label).toBe(302);
      expectReleaseAssetsSavedLocation(result.res.location, release.id, label);
      expect(result.sql.begin, label).toBe(1);
      expect(result.sql.commit, label).toBe(1);
      expect(result.sql.rollback, label).toBe(0);
      expect(result.sql.membershipWrites, label).toBe(1 + expected.length);
      expect(db.inTransaction, label).toBe(false);
      expect(rows(release.id), label).toEqual([...expected].sort((x, y) => x[0] - y[0]));
    }

    // ── §4 supported encodings ────────────────────────────────────────────
    it('C1 accepts every supported URL-encoded media type with a body or header CSRF token and persists the intended membership', async () => {
      const contentTypes = [
        'application/x-www-form-urlencoded',
        'application/x-www-form-urlencoded; charset=UTF-8',
        'application/x-www-form-urlencoded;charset=utf-8',
        'application/x-www-form-urlencoded; charset="UTF-8"',
        'application/x-www-form-urlencoded; charset="utf-8"',
        'APPLICATION/X-WWW-FORM-URLENCODED',
        'Application/X-Www-Form-Urlencoded; Charset=UTF-8',
      ];
      // Membership-only B, C: B keeps its saved Preview role, A is removed, C appends.
      const expected = () => [[B(), 'preview', 0], [C(), 'attachment', 1]];
      for (const contentType of contentTypes) {
        for (const via of ['body token', 'header token']) {
          const label = `${contentType} / ${via}`;
          const release = persisted(label);
          const raw = `selectedAssetIds=${B()}&selectedAssetIds=${C()}`;
          const result = await send(release.id, via === 'body token'
            ? { contentTypes: [contentType], body: withToken(raw) }
            : { contentTypes: [contentType], body: raw, csrfHeader: token });
          // The bytes on the wire carry exactly this one Content-Type.
          const head = result.requestBytes.toString('latin1').split('\r\n\r\n')[0];
          expect(head.match(/^content-type:.*$/gim), label).toEqual([`Content-Type: ${contentType}`]);
          expect(result.seen.contentType, label).toBe(contentType);
          expect(result.seen.expressForm, label).toBe(FORM);
          expect(result.seen.bodyKeys, label).toEqual(via === 'body token' ? ['_csrf', 'selectedAssetIds'] : ['selectedAssetIds']);
          // Reached Save validation (one batched lookup) and persisted.
          expect(result.sql.validation, label).toBe(1);
          expectSaved(result, release, label, expected());
        }
      }
    }, C1_TIMEOUT_MS);

    // ── §5 unsupported media types ────────────────────────────────────────
    it('C1 refuses unsupported, missing, malformed and look-alike media types with valid CSRF: 415 and zero writes', async () => {
      const form = `selectedAssetIds=${C()}`;
      const multipartBody = [
        '--c1b', 'Content-Disposition: form-data; name="_csrf"', '', token,
        '--c1b', 'Content-Disposition: form-data; name="selectedAssetIds"', '', String(C()),
        '--c1b--', '',
      ].join('\r\n');
      const cases = [
        ['application/json', ['application/json'], JSON.stringify({ selectedAssetIds: [C()] })],
        ['application/json charset', ['application/json; charset=utf-8'], JSON.stringify({ selectedAssetIds: [C()] })],
        ['application/problem+json', ['application/problem+json'], JSON.stringify({ selectedAssetIds: [C()] })],
        ['text/plain', ['text/plain'], form],
        ['octet-stream', ['application/octet-stream'], form],
        ['multipart with real boundary/body', ['multipart/form-data; boundary=c1b'], multipartBody],
        ['missing Content-Type', [], form],
        ['malformed: bare slash', ['/'], form],
        ['malformed: double semicolon', ['application/x-www-form-urlencoded;;'], form],
        ['malformed: unterminated quoted charset', ['application/x-www-form-urlencoded; charset="utf-8'], form],
        ['malformed: empty value', [''], form],
        ['look-alike: -x suffix', ['application/x-www-form-urlencoded-x'], form],
        ['look-alike: +xml suffix', ['application/x-www-form-urlencoded+xml'], form],
        ['look-alike: multipart tree', ['multipart/x-www-form-urlencoded'], form],
        ['look-alike: vnd prefix', ['application/vnd.x-www-form-urlencoded'], form],
        ['embedded in a parameter of another type', ['text/plain; boundary="application/x-www-form-urlencoded"'], form],
        ['embedded in a profile parameter', ['application/octet-stream; profile=application/x-www-form-urlencoded'], form],
      ];
      for (const [label, contentTypes, body] of cases) {
        const release = persisted(label);
        const result = await send(release.id, { contentTypes, body, csrfHeader: token });
        expect(result.seen.contentType, label).toBe(contentTypes.length ? contentTypes[0] : undefined);
        expect(result.seen.expressForm, label).not.toBe(FORM);
        expectUnsupported(result, release, label);
      }
      // A URL-encoded media type named only in an unrelated header is not the
      // request's Content-Type.
      for (const [label, contentTypes, extraHeaders] of [
        ['X-Content-Type header, text/plain body', ['text/plain'], [['X-Content-Type', FORM]]],
        ['Accept header only, no Content-Type', [], [['Accept-Post', FORM], ['X-Original-Content-Type', FORM]]],
        ['Content-Disposition parameter', ['application/octet-stream'], [['Content-Disposition', `form-data; type=${FORM}`]]],
      ]) {
        const release = persisted(label);
        const result = await send(release.id, { contentTypes, body: form, csrfHeader: token, extraHeaders });
        expectUnsupported(result, release, label);
      }
      // Unsupported charset: the unchanged body parser refuses it (415) before
      // CSRF and before the route.
      for (const charset of ['iso-8859-1', 'utf-16', 'x-unknown']) {
        const label = `charset ${charset}`;
        const release = persisted(label);
        const result = await send(release.id, { contentTypes: [`${FORM}; charset=${charset}`], body: withToken(form) });
        expectUntouched(result, release, label);
        expect(result.res.status, label).toBe(415);
        expect(result.res.text, label).not.toContain(UNSUPPORTED);
        expect(result.sql.validation, label).toBe(0);
        expect(result.res.location, label).toBeUndefined();
      }
    }, C1_TIMEOUT_MS);

    // ── §6 JSON data-loss controls ────────────────────────────────────────
    it('C1 refuses JSON Save bodies A–H on A Primary/0 + B Preview/1 without touching the rows', async () => {
      const json = (value) => JSON.stringify(value);
      const compact = json([[A(), 'primary', 0], [B(), 'preview', 1]]);
      const cases = [
        // Token in the JSON body itself (no header): a non-403 proves express.json parsed it.
        ['A body token + unknown', { body: json({ _csrf: token, unknown: 1 }) }],
        ['B body token + [A,C] + unknown', { body: json({ _csrf: token, selectedAssetIds: [A(), C()], unknown: 1 }) }],
        ['C valid-looking selected', { body: json({ _csrf: token, selectedAssetIds: [A(), B()] }) }],
        ['C string selected', { body: json({ _csrf: token, selectedAssetIds: [String(A()), String(B())] }) }],
        ['D empty selected', { body: json({ _csrf: token, selectedAssetIds: [] }) }],
        ['E compact roleOrder', { body: json({ _csrf: token, selectedAssetIds: [A(), B()], roleOrder: compact }) }],
        ['E keyed roleAssetIds', { body: json({ _csrf: token, selectedAssetIds: [A(), B()], roleAssetIds: [B()], roles: { 0: 'primary' }, sortOrder: { 0: '3' } }) }],
        ['F malformed nested', { body: json({ _csrf: token, selectedAssetIds: [[A()], { x: B() }], roles: [{ 0: ['primary'] }] }) }],
        ['F null selected', { body: json({ _csrf: token, selectedAssetIds: null }) }],
        // G: token through the supported header.
        ['G header token + [A,C]', { body: json({ selectedAssetIds: [A(), C()] }), csrfHeader: token }],
        ['G header token + empty', { body: json({ selectedAssetIds: [] }), csrfHeader: token }],
      ];
      for (const [label, request] of cases) {
        const release = persisted(`json ${label}`);
        const result = await send(release.id, { contentTypes: ['application/json'], ...request });
        expect(result.seen.expressJson, label).toBe('application/json');
        expect(result.seen.bodyKeys.length, label).toBeGreaterThan(0);
        expectUnsupported(result, release, label);
      }
      // H: invalid CSRF stays the established 403 in every position. A body
      // token wins over the header, so a forged body token is refused even
      // alongside a valid header.
      for (const [label, request] of [
        ['H forged body token', { body: json({ _csrf: 'forged', selectedAssetIds: [A()] }) }],
        ['H forged header token', { body: json({ selectedAssetIds: [A()] }), csrfHeader: 'forged' }],
        ['H missing token', { body: json({ selectedAssetIds: [] }) }],
        ['H forged body + valid header', { body: json({ _csrf: 'forged', selectedAssetIds: [] }), csrfHeader: token }],
      ]) {
        const release = persisted(`json ${label}`);
        expectCsrfRefused(await send(release.id, { contentTypes: ['application/json'], ...request }), release, label);
      }
    }, C1_TIMEOUT_MS);

    // ── §7 raw field-name regressions ─────────────────────────────────────
    it('C1 refuses every malformed raw field name alone and beside valid membership, compact or keyed fields', async () => {
      const F = () => foreignId;
      // [label, raw fragment]. Each fragment names a field outside the Save
      // contract or an unreadable selected-ID shape; values are the foreign
      // ID so any leak of its metadata would show.
      const malformed = [
        ['__proto__[selectedAssetIds]', () => `__proto__[selectedAssetIds]=${F()}`],
        ['constructor[selectedAssetIds]', () => `constructor[selectedAssetIds]=${F()}`],
        ['selectedAssetIds.__proto__', () => `selectedAssetIds.__proto__=${F()}`],
        ['selectedAssetIds%2E__proto__', () => `selectedAssetIds%2E__proto__=${F()}`],
        ['selectedAssetIds[__proto__]', () => `selectedAssetIds[__proto__]=${F()}`],
        ['selectedAssetIds[constructor]', () => `selectedAssetIds[constructor]=${F()}`],
        ['unknown top-level', () => `unknownField=${F()}`],
        ['unknown nested', () => `unknown[selectedAssetIds]=${F()}`],
        ['dotted alias', () => `roles.0=primary&selected.AssetIds=${F()}`],
        ['nested brackets', () => `selectedAssetIds[0][1]=${F()}`],
        ['invalid index: leading zero', () => `selectedAssetIds[01]=${F()}`],
        ['invalid index: negative', () => `selectedAssetIds[-1]=${F()}`],
        ['invalid index: exponent', () => `selectedAssetIds[1e2]=${F()}`],
        ['invalid index: seven digits', () => `selectedAssetIds[1000000]=${F()}`],
        ['repeated numeric index', () => `selectedAssetIds[4]=${C()}&selectedAssetIds[4]=${F()}`],
        ['malformed encoded bracket', () => `selectedAssetIds%5B0=${F()}`],
        ['reversed brackets', () => `selectedAssetIds]0[=${F()}`],
        ['double-encoded brackets', () => `selectedAssetIds%255B0%255D=${F()}`],
        ['leading bracket root', () => `[selectedAssetIds][0]=${F()}`],
      ];
      const compact = () => encodeURIComponent(JSON.stringify([[A(), 'primary', 0], [B(), 'preview', 1]]));
      const placements = [
        ['alone', (bad) => bad],
        ['valid selected ID first', (bad) => `selectedAssetIds=${A()}&${bad}`],
        ['malformed first', (bad) => `${bad}&selectedAssetIds=${A()}`],
        ['with compact roleOrder', (bad) => `selectedAssetIds=${A()}&selectedAssetIds=${B()}&${bad}&roleOrder=${compact()}`],
        ['with keyed role/order', (bad) => `selectedAssetIds=${A()}&selectedAssetIds=${B()}&roleAssetIds[0]=${A()}&roles[0]=primary&sortOrder[0]=0&${bad}&roleAssetIds[1]=${B()}&roles[1]=preview&sortOrder[1]=1`],
      ];
      for (const [name, fragment] of malformed) {
        for (const [where, place] of placements) {
          const label = `${name} / ${where}`;
          const release = persisted(label);
          const result = await send(release.id, { body: withToken(place(fragment())) });
          expect(result.seen.expressForm, label).toBe(FORM);
          expectFailClosed(result, release, label);
          expect(result.res.text, label).not.toContain(`Asset ${foreignId}`);
        }
      }
    }, C1_TIMEOUT_MS);

    // ── §8 intentional empty Saves ────────────────────────────────────────
    it('C1 keeps intentional empty Saves: no selected-ID field, a bare empty value, and the rendered form with nothing checked', async () => {
      for (const [label, raw] of [['A no selectedAssetIds', ''], ['B selectedAssetIds=', 'selectedAssetIds=']]) {
        const release = persisted(label);
        const result = await send(release.id, { body: withToken(raw) });
        expect(result.sql.validation, label).toBe(0);
        expectSaved(result, release, label, []);
      }

      // C: the actual rendered form. Both saved members are page-visible
      // checked checkboxes (no hidden off-page carriers), so unchecking them
      // leaves exactly the form's _csrf — the browser's empty submission.
      const release = persisted('C rendered form unchecked');
      const page = await getPage(release.id);
      expect(page.status).toBe(200);
      expect(page.text).toMatch(/<form id="release-assets-form" method="post" action="\/releases\/\d+\/assets\?pageSize=10" class="inline-form"/);
      expect(page.text).not.toMatch(/<form id="release-assets-form"[^>]*enctype=/);
      const entries = retryFormEntries(page.text);
      expect(entries.filter(([name]) => name === 'selectedAssetIds').map(([, value]) => Number(value)).sort((x, y) => x - y)).toEqual([A(), B()]);
      expect(page.text).not.toMatch(/<input type="hidden" name="selectedAssetIds"/);
      const unchecked = entries.filter(([name]) => name !== 'selectedAssetIds');
      expect(unchecked).toEqual([['_csrf', token]]);
      const result = await send(release.id, { body: encode(unchecked) });
      expectSaved(result, release, 'C rendered form unchecked', []);

      // Not an empty Save: unsupported or malformed bodies with the same
      // (empty) apparent membership are refused and leave A/B in place.
      const json = persisted('empty JSON');
      expectUnsupported(await send(json.id, { contentTypes: ['application/json'], body: '{}', csrfHeader: token }), json, 'empty JSON');
      const text = persisted('empty text/plain');
      expectUnsupported(await send(text.id, { contentTypes: ['text/plain'], body: '', csrfHeader: token }), text, 'empty text/plain');
      const malformed = persisted('malformed empty-looking');
      expectFailClosed(await send(malformed.id, { body: withToken('selectedAssetIds[__proto__]=') }), malformed, 'malformed empty-looking');
    }, C1_TIMEOUT_MS);

    // ── §9 request framing (CHARACTERIZATION of the current runtime) ──────
    // Observed behavior, not a new framing policy: a supported media type
    // with no body framing is refused as unsupported (the URL-encoded parser
    // never reads a body that has none, so no Save draft exists); a framed
    // zero-byte body is a parsed empty form, i.e. an intentional clear.
    it('C1 characterizes Save request framing: unframed, zero-length, empty chunked, chunked and unparseable bodies', async () => {
      const unframed = persisted('no Content-Length, no Transfer-Encoding');
      const none = await send(unframed.id, { body: '', framing: 'none', csrfHeader: token });
      const noneHead = none.requestBytes.toString('latin1');
      expect(noneHead).not.toMatch(/^(content-length|transfer-encoding):/im);
      expect(noneHead.endsWith('\r\n\r\n')).toBe(true);
      expect(none.seen.contentLength).toBeUndefined();
      expect(none.seen.transferEncoding).toBeUndefined();
      expect(none.seen.contentType).toBe(FORM);
      expectUnsupported(none, unframed, 'unframed');

      const zero = persisted('Content-Length: 0');
      const zeroResult = await send(zero.id, { body: '', framing: 'length', csrfHeader: token });
      expect(zeroResult.requestBytes.toString('latin1')).toMatch(/\r\nContent-Length: 0\r\n\r\n$/);
      expect(zeroResult.seen.contentLength).toBe('0');
      expect(zeroResult.seen.expressForm).toBe(FORM);
      expectSaved(zeroResult, zero, 'Content-Length: 0', []);

      const emptyChunked = persisted('empty chunked');
      const emptyChunkedResult = await send(emptyChunked.id, { framing: 'chunked', chunks: [], csrfHeader: token });
      expect(emptyChunkedResult.requestBytes.toString('latin1')).toMatch(/\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n$/);
      expect(emptyChunkedResult.seen.transferEncoding).toBe('chunked');
      expect(emptyChunkedResult.seen.contentLength).toBeUndefined();
      expectSaved(emptyChunkedResult, emptyChunked, 'empty chunked', []);

      // Nonempty chunked form, split mid-token and mid-field, body CSRF token.
      const chunked = persisted('nonempty chunked');
      const body = withToken(`selectedAssetIds=${C()}&selectedAssetIds=${A()}`);
      const cut = [7, 40, body.length - 3];
      const chunks = [body.slice(0, cut[0]), body.slice(cut[0], cut[1]), body.slice(cut[1], cut[2]), body.slice(cut[2])];
      expect(chunks.join('')).toBe(body);
      const chunkedResult = await send(chunked.id, { framing: 'chunked', chunks });
      expect(chunkedResult.seen.transferEncoding).toBe('chunked');
      expect(chunkedResult.seen.bodyKeys).toEqual(['_csrf', 'selectedAssetIds']);
      expectSaved(chunkedResult, chunked, 'nonempty chunked', [[A(), 'primary', 0], [C(), 'attachment', 1]]);

      // Correct media type, body that does not decode to a readable Save:
      // refused fail-closed (422), never a clear.
      for (const [label, rawBody] of [
        ['invalid percent escape in value', Buffer.from(withToken('selectedAssetIds=%E0%A4%A'))],
        ['invalid percent escape in name', Buffer.from(withToken(`selected%ZZAssetIds=${C()}`))],
        ['invalid UTF-8 bytes in value', Buffer.concat([Buffer.from(withToken('selectedAssetIds=')), Buffer.from([0xff, 0xfe])])],
        ['NUL in value', Buffer.from(withToken('selectedAssetIds=%00'))],
      ]) {
        const release = persisted(label);
        const result = await send(release.id, { body: rawBody });
        expect(result.seen.expressForm, label).toBe(FORM);
        expect(result.res.status, label).toBe(422);
        expectUntouched(result, release, label);
        expect(result.sql.validation, label).toBe(0);
        expect(result.res.text, label).toContain('data-release-assets-save-recovery-unavailable');
        expectNoSaveControls(result.res.text, label);
      }
    }, C1_TIMEOUT_MS);

    // ── §10 duplicate Content-Type (CHARACTERIZATION of the current runtime)
    // Node's HTTP parser keeps the FIRST Content-Type line and discards later
    // ones (req.headers), while req.rawHeaders keeps every line. This pins
    // what this Node/Express runtime does; proxies and other servers may
    // differ, and no header normalization is added.
    it('C1 characterizes duplicate Content-Type headers: Node keeps the first line, membership follows that type', async () => {
      const form = () => withToken(`selectedAssetIds=${B()}&selectedAssetIds=${C()}`);
      const formSaved = () => [[B(), 'preview', 0], [C(), 'attachment', 1]];
      const cases = [
        ['supported first, unsupported second', [['Content-Type', FORM], ['Content-Type', 'application/json']], form, 302],
        ['unsupported first, supported second (form body)', [['Content-Type', 'text/plain'], ['Content-Type', FORM]], form, 415],
        ['JSON first, supported second (form body)', [['Content-Type', 'application/json'], ['Content-Type', FORM]], form, 400],
        ['JSON first, supported second (JSON body)', [['Content-Type', 'application/json'], ['Content-Type', FORM]],
          () => JSON.stringify({ _csrf: token, selectedAssetIds: [] }), 415],
        ['identical duplicates', [['Content-Type', FORM], ['Content-Type', FORM]], form, 302],
        ['case-variant names, supported first', [['content-type', FORM], ['CONTENT-TYPE', 'text/plain']], form, 302],
        ['case-variant names, unsupported first', [['CONTENT-TYPE', 'application/octet-stream'], ['content-type', FORM]], form, 415],
      ];
      for (const [label, headerLines, body, status] of cases) {
        const release = persisted(label);
        const result = await send(release.id, {
          contentTypes: [], body: body(), extraHeaders: headerLines, csrfHeader: status === 415 ? token : null,
        });
        // As transmitted: both lines, in order.
        const transmitted = result.requestBytes.toString('latin1').split('\r\n\r\n')[0].split('\r\n')
          .filter((line) => /^content-type:/i.test(line));
        expect(transmitted, label).toEqual(headerLines.map(([name, value]) => `${name}: ${value}`));
        // Visible to Node/Express: every raw line, but only the first as the header.
        const rawTypes = [];
        for (let i = 0; i < result.seen.rawHeaders.length; i += 2) {
          if (/^content-type$/i.test(result.seen.rawHeaders[i])) rawTypes.push(result.seen.rawHeaders[i + 1]);
        }
        expect(rawTypes, label).toEqual(headerLines.map(([, value]) => value));
        expect(result.seen.contentType, label).toBe(headerLines[0][1]);
        expect(result.seen.expressForm, label).toBe(headerLines[0][1] === FORM ? FORM : false);
        expect(result.res.status, label).toBe(status);
        if (status === 302) {
          expectSaved(result, release, label, formSaved());
        } else {
          expectUntouched(result, release, label);
          expect(result.sql.validation, label).toBe(0);
          if (status === 415) expect(result.res.text, label).toContain(UNSUPPORTED);
        }
      }
    }, C1_TIMEOUT_MS);

    // ── §11 Save format compatibility and sparse pairing ─────────────────
    it('C1 persists exact asset_id/role/sort_order for all four URL-encoded Save formats', async () => {
      const compact = () => encodeURIComponent(JSON.stringify([[B(), 'primary', 4], [A(), 'attachment', 2]]));
      const formats = [
        ['membership-only', () => `selectedAssetIds=${C()}&selectedAssetIds=${A()}`,
          () => [[A(), 'primary', 0], [C(), 'attachment', 1]]],
        ['legacy positional', () => `selectedAssetIds=${C()}&selectedAssetIds=${A()}&roles=preview&roles=primary&sortOrder=3&sortOrder=1`,
          () => [[C(), 'preview', 3], [A(), 'primary', 1]]],
        ['B-F2 keyed roleAssetIds', () => `selectedAssetIds=${A()}&selectedAssetIds=${C()}&roleAssetIds[0]=${C()}&roleAssetIds[1]=${A()}`
          + '&roles[0]=primary&roles[1]=preview&sortOrder[0]=7&sortOrder[1]=8',
          () => [[C(), 'primary', 7], [A(), 'preview', 8]]],
        ['B-F2R1 compact roleOrder', () => `selectedAssetIds=${A()}&selectedAssetIds=${B()}&roleOrder=${compact()}`,
          () => [[B(), 'primary', 4], [A(), 'attachment', 2]]],
      ];
      for (const [label, raw, expected] of formats) {
        const release = persisted(label);
        const result = await send(release.id, { body: withToken(raw()) });
        expect(result.sql.validation, label).toBe(1);
        expectSaved(result, release, label, expected());
      }
    }, C1_TIMEOUT_MS);

    it('C1 pairs sparse keyed and positional role/order fields by original index with no misattribution', async () => {
      const cases = [
        // The specified keyed case: A Attachment/0, B Preview/19.
        ['sparse keyed (spec)', () => `selectedAssetIds=${A()}&selectedAssetIds=${B()}&roleAssetIds[0]=${A()}&roleAssetIds[1]=${B()}`
          + '&roles[1]=preview&sortOrder[1]=19',
          () => [[A(), 'attachment', 0], [B(), 'preview', 19]]],
        ['sparse positional, adjacent', () => `selectedAssetIds[0]=${A()}&selectedAssetIds[1]=${B()}&roles[1]=preview&sortOrder[1]=19`,
          () => [[A(), 'attachment', 0], [B(), 'preview', 19]]],
        // qs compacts selectedAssetIds[4] to position 1 and roles[4] to 0; the
        // raw indices keep the role on B.
        ['sparse positional, gap', () => `selectedAssetIds[0]=${A()}&selectedAssetIds[4]=${B()}&roles[4]=preview&sortOrder[4]=19`,
          () => [[A(), 'attachment', 0], [B(), 'preview', 19]]],
        ['sparse keyed, reversed with Primary', () => `selectedAssetIds=${A()}&selectedAssetIds=${B()}&roleAssetIds[2]=${B()}&roleAssetIds[5]=${A()}`
          + '&roles[5]=primary&sortOrder[5]=3',
          () => [[B(), 'attachment', 0], [A(), 'primary', 3]]],
        ['sparse keyed, order only', () => `selectedAssetIds=${A()}&selectedAssetIds=${B()}&roleAssetIds[0]=${A()}&roleAssetIds[9]=${B()}&sortOrder[9]=19`,
          () => [[A(), 'attachment', 0], [B(), 'attachment', 19]]],
      ];
      for (const [label, raw, expected] of cases) {
        const release = persisted(label);
        const result = await send(release.id, { body: withToken(raw()) });
        expectSaved(result, release, label, expected());
        // The role/order submitted for B never lands on A.
        const saved = new Map(rows(release.id).map(([assetId, role, sortOrder]) => [assetId, { role, sortOrder }]));
        if (label === 'sparse keyed, reversed with Primary') {
          // The Primary/3 submitted at index 5 stays on A; B (index 2) takes the defaults.
          expect(saved.get(B()), label).toEqual({ role: 'attachment', sortOrder: 0 });
        } else {
          expect(saved.get(A()), label).toEqual({ role: 'attachment', sortOrder: 0 });
          expect(saved.get(B()).sortOrder, label).toBe(19);
        }
      }
    }, C1_TIMEOUT_MS);

    // ── §12 unsafe-order recovery ─────────────────────────────────────────
    it('C1 refuses an invalid role + unsafe order fail-closed, and keeps an ordinary invalid role recoverable through the next real submission', async () => {
      const unsafe = persisted('unsafe order');
      const refused = await send(unsafe.id, {
        body: withToken(`selectedAssetIds=${A()}&selectedAssetIds=${B()}&roles=bogus&roles=preview&sortOrder=${UNSAFE}&sortOrder=1`),
      });
      expectFailClosed(refused, unsafe, 'unsafe order', ORDER_ERROR);
      expect(refused.res.text).not.toContain(UNSAFE);
      // The saved members are still listed for reference.
      expect(refused.res.text).toContain('img-0005.png');
      expect(refused.res.text).toContain('img-0006.png');

      // Ordinary invalid role, valid orders: A bogus/0, C preview/1 (C is new).
      const release = persisted('ordinary invalid role');
      const first = await send(release.id, {
        body: withToken(`selectedAssetIds=${A()}&selectedAssetIds=${C()}&roles=bogus&roles=preview&sortOrder=0&sortOrder=1`),
      });
      expect(first.res.status).toBe(422);
      expect(first.res.text).toContain(`Asset ${A()} has an invalid role &quot;bogus&quot;.`);
      expect(first.res.text).not.toContain('data-release-assets-save-recovery-unavailable');
      expectUntouched(first, release, 'ordinary first');
      // The role refusal precedes any asset lookup.
      expect(first.sql.validation).toBe(0);

      // The rendered compact carrier, as an attribute.
      const carrierJson = JSON.stringify([[A(), 'bogus', 0], [C(), 'preview', 1]]);
      expect(first.res.text).toContain(`<input type="hidden" name="roleOrder" value="${carrierJson.replace(/"/g, '&quot;')}">`);
      const retry = retryFormEntries(first.res.text);
      expect(retry.filter(([name]) => name === '_csrf')).toEqual([['_csrf', token]]);
      expect(selectedIds(retry).sort((x, y) => x - y)).toEqual([A(), C()]);
      expect(retry.filter(([name]) => name === 'roleOrder')).toEqual([['roleOrder', carrierJson]]);
      expect(retry.map(([name]) => name).filter((name) => !['_csrf', 'selectedAssetIds', 'roleOrder'].includes(name))).toEqual([]);

      // The next actual HTTP submission of that form, unchanged: still refused.
      const unchanged = await send(release.id, { body: encode(retry) });
      expect(unchanged.res.status).toBe(422);
      expect(unchanged.res.text).toContain(`Asset ${A()} has an invalid role &quot;bogus&quot;.`);
      expect(unchanged.res.text).not.toContain(FORMAT_ERROR);
      expectUntouched(unchanged, release, 'unchanged retry');
      expect(retryFormEntries(unchanged.res.text).filter(([name]) => name === 'roleOrder')).toEqual([['roleOrder', carrierJson]]);

      // Corrected through the same carrier: saves exactly.
      const corrected = retry.map(([name, value]) => (name === 'roleOrder' ? [name, value.replace('"bogus"', '"attachment"')] : [name, value]));
      expectSaved(await send(release.id, { body: encode(corrected) }), release, 'corrected retry',
        [[A(), 'attachment', 0], [C(), 'preview', 1]]);
    }, C1_TIMEOUT_MS);

    // ── §13 malformed retry input ─────────────────────────────────────────
    it('C1 refuses malformed retry carriers fail-closed and escapes a rejected role in the recoverable retry', async () => {
      const enc = (value) => encodeURIComponent(JSON.stringify(value));
      const cases = [
        ['malformed roleOrder JSON', () => `selectedAssetIds=${A()}&selectedAssetIds=${B()}&roleOrder=${encodeURIComponent('[[')}`],
        ['wrong tuple length', () => `selectedAssetIds=${A()}&selectedAssetIds=${B()}&roleOrder=${enc([[A(), 'primary']])}`],
        ['four-element tuple', () => `selectedAssetIds=${A()}&roleOrder=${enc([[A(), 'primary', 0, 1]])}`],
        ['unsafe compact sortOrder', () => `selectedAssetIds=${A()}&roleOrder=${encodeURIComponent(`[[${A()},"primary",${UNSAFE}]]`)}`],
        ['negative compact sortOrder', () => `selectedAssetIds=${A()}&roleOrder=${enc([[A(), 'primary', -1]])}`],
        ['string compact asset ID', () => `selectedAssetIds=${A()}&roleOrder=${enc([[String(A()), 'primary', 0]])}`],
        ['conflicting compact and keyed', () => `selectedAssetIds=${A()}&roleOrder=${enc([[A(), 'primary', 0]])}&roleAssetIds[0]=${A()}&roles[0]=preview`],
        ['conflicting compact and positional', () => `selectedAssetIds=${A()}&roleOrder=${enc([[A(), 'primary', 0]])}&roles=preview`],
        ['repeated compact carrier', () => `selectedAssetIds=${A()}&roleOrder=${enc([[A(), 'primary', 0]])}&roleOrder=${enc([[A(), 'primary', 0]])}`],
        ['malformed selected ID + valid carrier', () => `selectedAssetIds[__proto__]=${C()}&selectedAssetIds=${A()}&roleOrder=${enc([[A(), 'primary', 0]])}`],
        ['unreadable selected ID + valid carrier', () => `selectedAssetIds=abc&roleOrder=${enc([[A(), 'primary', 0]])}`],
        ['unpaired positional role', () => `selectedAssetIds=${A()}&roles[1]=primary`],
        ['unpaired keyed order', () => `selectedAssetIds=${A()}&selectedAssetIds=${B()}&roleAssetIds[0]=${A()}&sortOrder[3]=5`],
        ['non-numeric keyed ID', () => `selectedAssetIds=${A()}&roleAssetIds[0]=x${A()}&roles[0]=primary`],
      ];
      for (const [label, raw] of cases) {
        const release = persisted(label);
        const result = await send(release.id, { body: withToken(raw()) });
        const error = label === 'unreadable selected ID + valid carrier' ? 'Invalid asset selection.' : FORMAT_ERROR;
        expectFailClosed(result, release, label, error);
      }

      // A recoverable rejected draft escapes the submitted role everywhere.
      const role = '<script>alert("x")</script>';
      const release = persisted('escaped role');
      const result = await send(release.id, {
        body: withToken(`selectedAssetIds=${A()}&roleOrder=${enc([[A(), role, 0]])}`),
      });
      expect(result.res.status).toBe(422);
      expectUntouched(result, release, 'escaped role');
      expect(result.res.text).not.toContain(role);
      expect(result.res.text).not.toContain('<script>alert');
      expect(result.res.text).toContain(`Asset ${A()} has an invalid role &quot;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&quot;.`);
      // The attribute escapes the JSON backslash as &#92;; a browser decodes it
      // (the shared form scraper only decodes named entities).
      expect(result.res.text).toContain('&lt;script&gt;alert(&#92;&quot;x&#92;&quot;)&lt;/script&gt;');
      const retry = retryFormEntries(result.res.text).map(([name, value]) => [name, value.replace(/&#92;/g, String.fromCharCode(92))]);
      expect(retry.filter(([name]) => name === 'roleOrder')).toEqual([['roleOrder', JSON.stringify([[A(), role, 0]])]]);
      // Its next submission is refused the same way, without a write.
      const again = await send(release.id, { body: encode(retry) });
      expect(again.res.status).toBe(422);
      expect(again.res.text).not.toContain('<script>alert');
      expectUntouched(again, release, 'escaped role retry');
      expect(selectedIds(retry)).toEqual([A()]);
    }, C1_TIMEOUT_MS);

    // ── §14 CSRF and authorization ────────────────────────────────────────
    it('C1 keeps CSRF, media-type, read-only and asset authorization precedence with no unauthorized write', async () => {
      const raw = () => `selectedAssetIds=${C()}`;
      const valid = [
        ['valid body token', () => ({ body: withToken(raw()) })],
        ['valid header token', () => ({ body: raw(), csrfHeader: token })],
      ];
      for (const [label, request] of valid) {
        const release = persisted(label);
        expectSaved(await send(release.id, request()), release, label, [[C(), 'attachment', 0]]);
      }
      const refusedCsrf = [
        ['missing token', () => ({ body: raw() })],
        ['forged body token', () => ({ body: `_csrf=forged&${raw()}` })],
        ['forged header token', () => ({ body: raw(), csrfHeader: 'forged' })],
        ['forged body token + valid header', () => ({ body: `_csrf=forged&${raw()}`, csrfHeader: token })],
        ['empty body token', () => ({ body: `_csrf=&${raw()}` })],
        ['unsupported body + forged token', () => ({ contentTypes: ['text/plain'], body: raw(), csrfHeader: 'forged' })],
        ['JSON body + forged token', () => ({ contentTypes: ['application/json'], body: JSON.stringify({ _csrf: 'forged', selectedAssetIds: [] }) })],
      ];
      for (const [label, request] of refusedCsrf) {
        const release = persisted(label);
        expectCsrfRefused(await send(release.id, request()), release, label);
      }
      const unsupported = persisted('unsupported body + valid token');
      expectUnsupported(await send(unsupported.id, { contentTypes: ['text/plain'], body: raw(), csrfHeader: token }), unsupported, 'unsupported + valid');

      // Asset authorization: unknown 404, foreign/duplicate 422, never a write.
      for (const [label, body, status, message] of [
        ['unknown asset', () => `selectedAssetIds=${A()}&selectedAssetIds=999999999`, 404, null],
        ['foreign asset', () => `selectedAssetIds=${A()}&selectedAssetIds=${foreignId}`, 422, `Asset ${foreignId} does not belong to the release&#39;s project.`],
        ['duplicate asset', () => `selectedAssetIds=${A()}&selectedAssetIds=${A()}`, 422, 'Duplicate asset IDs are not allowed.'],
      ]) {
        const release = persisted(label);
        const result = await send(release.id, { body: withToken(body()) });
        expect(result.res.status, label).toBe(status);
        if (message) expect(result.res.text, label).toContain(message);
        expect(result.res.text, label).not.toContain('foreign-secret');
        expectUntouched(result, release, label);
      }

      // Read-only states: a valid URL-encoded Save is refused by the service
      // guard (422 with the saved collection); CSRF still runs first, and an
      // unsupported media type is still 415.
      for (const [label, lock, message] of LOCKS) {
        const release = persisted(label);
        lock(release);
        try {
          const result = await send(release.id, { body: withToken(raw()) });
          expect(result.res.status, label).toBe(422);
          expect(result.res.text, label).toContain(message(release));
          expectUntouched(result, release, label);
          expectNoSaveControls(result.res.text, label);
          expect(result.res.text, label).toContain('img-0005.png');
          expectCsrfRefused(await send(release.id, { body: `_csrf=forged&${raw()}` }), release, `${label} forged`);
          expectUnsupported(await send(release.id, { contentTypes: ['application/json'], body: '{}', csrfHeader: token }), release, `${label} JSON`);
        } finally {
          unlockProject();
        }
      }

      // An unknown release: CSRF first (403), then 404, never a write.
      tracing = true;
      trace.length = 0;
      const forgedUnknown = await exchange(buildRequest({
        target: '/releases/999999/assets', headers: [['Cookie', cookie], ['Content-Type', FORM]], body: `_csrf=forged&${raw()}`,
      }));
      const unknown = await exchange(buildRequest({
        target: '/releases/999999/assets', headers: [['Cookie', cookie], ['Content-Type', FORM]], body: withToken(raw()),
      }));
      tracing = false;
      expect(forgedUnknown.status).toBe(403);
      expect(unknown.status).toBe(404);
      expect(trace.filter((text) => MEMBERSHIP_WRITE.test(text))).toEqual([]);
    }, C1_TIMEOUT_MS);

    // ── §15 read-only recovery ────────────────────────────────────────────
    it('C1 read-only releases answer a malformed URL-encoded Save with the complete persisted collection and no Save controls', async () => {
      const malformedBodies = [
        ['prototype-rooted field', () => `__proto__[selectedAssetIds]=${C()}`],
        ['malformed selected-ID index', () => `selectedAssetIds[__proto__]=${C()}`],
        ['unknown field', () => `unknownField=${foreignId}`],
        ['unsafe legacy order', () => `selectedAssetIds=${A()}&roles=bogus&sortOrder=${UNSAFE}`],
        ['malformed compact carrier', () => `selectedAssetIds=${A()}&roleOrder=%5B%5B`],
      ];
      for (const [lockLabel, lock] of LOCKS) {
        for (const [label, raw] of malformedBodies) {
          const name = `${lockLabel} / ${label}`;
          const release = persisted(name);
          // B is a missing saved member: it must still be listed.
          db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(B());
          lock(release);
          try {
            const result = await send(release.id, { body: withToken(raw()) });
            expect(result.res.status, name).toBe(422);
            expectUntouched(result, release, name);
            expect(result.sql.validation, name).toBe(0);
            expect(result.res.text, name).toMatch(/<div class="error-summary" role="alert">/);
            expect(result.res.text, name).toContain('img-0005.png');
            expect(result.res.text, name).toContain('img-0006.png');
            expect(result.res.text, name).toContain('<span class="release-asset-grid-role-value">Primary</span>');
            expect(result.res.text, name).toContain('<span class="release-asset-grid-role-value">Preview</span>');
            expect(result.res.text, name).not.toContain('data-release-assets-save-recovery-unavailable');
            expectNoSaveControls(result.res.text, name);
            expect(result.res.text, name).not.toContain(UNSAFE);
            // Unsupported media type: 415, no writes.
            expectUnsupported(await send(release.id, { contentTypes: ['text/plain'], body: raw(), csrfHeader: token }), release, `${name} text/plain`);
          } finally {
            db.prepare('UPDATE assets SET is_present = 1 WHERE id = ?').run(B());
            unlockProject();
          }
        }
      }
    }, C1_TIMEOUT_MS);

    // ── §16 large compact carrier control ─────────────────────────────────
    it('C1 carries a 300-member rejected compact draft through its retry and saves a 517-member compact Save exactly', async () => {
      const members = ids.slice(20, 320);
      const draft = members.map((assetId, index) => ({
        assetId,
        role: index === 0 ? 'primary' : (index === 150 ? 'bogus' : (index === 299 ? 'preview' : 'attachment')),
        sortOrder: 1000 - index,
      }));
      const release = persisted('large compact');
      // The expanded keyed shape of this draft is 1,201 fields: over the
      // unchanged 1,000-parameter parser limit, refused (413) before CSRF and
      // the route. This is why the retry form uses the compact carrier.
      const expanded = await send(release.id, {
        body: withToken(draft.flatMap(({ assetId, role, sortOrder }, index) => [
          `selectedAssetIds=${assetId}`, `roleAssetIds[${index}]=${assetId}`, `roles[${index}]=${role}`, `sortOrder[${index}]=${sortOrder}`,
        ]).join('&')),
      });
      expect(expanded.res.status).toBe(413);
      expectUntouched(expanded, release, 'large expanded keyed');
      expect(expanded.sql.begin).toBe(0);

      const compactDraft = JSON.stringify(draft.map(({ assetId, role, sortOrder }) => [assetId, role, sortOrder]));
      const body = withToken(`${members.map((id) => `selectedAssetIds=${id}`).join('&')}&roleOrder=${encodeURIComponent(compactDraft)}`);
      expect(body.split('&')).toHaveLength(302);
      const first = await send(release.id, { body });
      expect(first.seen.expressForm).toBe(FORM);
      expect(first.res.status).toBe(422);
      expect(first.res.text).toContain(`Asset ${members[150]} has an invalid role &quot;bogus&quot;.`);
      expectUntouched(first, release, 'large first');

      const retry = retryFormEntries(first.res.text);
      // _csrf + 300 selected IDs + one roleOrder: well inside 1,000 fields.
      expect(retry).toHaveLength(302);
      expect(selectedIds(retry).sort((x, y) => x - y)).toEqual([...members].sort((x, y) => x - y));
      const carrier = retry.filter(([name]) => name === 'roleOrder');
      expect(carrier).toHaveLength(1);
      expect(JSON.parse(carrier[0][1]).map(([assetId, role, sortOrder]) => ({ assetId, role, sortOrder }))).toEqual(draft);

      const unchanged = await send(release.id, { body: encode(retry) });
      expect(unchanged.res.status).toBe(422);
      expect(unchanged.res.status).not.toBe(413);
      expectUntouched(unchanged, release, 'large unchanged');

      const corrected = retry.map(([name, value]) => (name === 'roleOrder' ? [name, value.replace('"bogus"', '"attachment"')] : [name, value]));
      const saved = await send(release.id, { body: encode(corrected) });
      expectSaved(saved, release, 'large corrected', draft.map(({ assetId, role, sortOrder }) => [assetId, role === 'bogus' ? 'attachment' : role, sortOrder]));

      // 517 members with a compact carrier: 519 fields, saved exactly.
      const large = ids.slice(0, 517);
      const compact = large.map((assetId, index) => [assetId, index === 516 ? 'primary' : 'attachment', index * 2]);
      const bigRelease = createRelease('C1 517 compact');
      const big = await send(bigRelease.id, {
        body: withToken(`${large.map((id) => `selectedAssetIds=${id}`).join('&')}&roleOrder=${encodeURIComponent(JSON.stringify(compact))}`),
      });
      expect(big.requestBytes.toString('latin1').split('\r\n\r\n')[1].split('&')).toHaveLength(519);
      expect(big.sql.validation).toBe(2);
      expectSaved(big, bigRelease, 'large 517 compact', compact);
    }, C1_TIMEOUT_MS);
  });
});
