import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import {
  PROJECT_STATUS_CATALOGUE_KEY,
  PROJECT_TYPE_CATALOGUE_KEY,
  ProjectOptionCatalogueIntegrityError,
} from '../src/services/project-option-catalogue-service.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function readDocument(db, key) {
  return JSON.parse(dbTemplate(db).get(key));
}

function dbTemplate(db) {
  return db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck();
}

function writeMeta(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function editorMarkup(html, routeId) {
  const start = html.indexOf(`data-settings-project-option-editor="${routeId}"`);
  if (start < 0) return '';
  const sectionStart = html.lastIndexOf('<section', start);
  const sectionEnd = html.indexOf('</section>', start);
  return html.slice(sectionStart, sectionEnd + '</section>'.length);
}

function optionCardMarkup(html, routeId, value) {
  const editor = editorMarkup(html, routeId);
  const marker = `data-project-option-value="${value}"`;
  const markerIndex = editor.indexOf(marker);
  if (markerIndex < 0) return '';
  const start = editor.lastIndexOf('<li', markerIndex);
  const end = editor.indexOf('</li>', markerIndex);
  return editor.slice(start, end + '</li>'.length);
}

function insertProject(db, { slug, status = 'tbd', projectType = 'images' }) {
  return db.prepare(`
    INSERT INTO projects (title, slug, status, project_type)
    VALUES (?, ?, ?, ?)
  `).run(slug, slug, status, projectType);
}

describe('settings — Project option catalogues HTTP', () => {
  let tmpDir;
  let db;
  let app;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-settings-project-options-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders ordered Status and Type editors outside the ordinary Defaults form', async () => {
    app.locals.projectOptionCatalogueService.addOption('status', {
      name: 'Awaiting Review',
      color: '#123456',
    });
    app.locals.projectOptionCatalogueService.addOption('projectType', {
      name: 'Lightbox Story',
      color: '#F5F5F5',
    });
    const res = await agent.get('/settings/defaults').expect(200);
    const defaultsForm = res.text.match(
      /<form id="settings-defaults-form"[\s\S]*?<\/form>/,
    )?.[0] || '';
    const status = editorMarkup(res.text, 'status');
    const projectType = editorMarkup(res.text, 'project-type');

    expect(status).toContain('<h3 id="defaults-project-status-heading">Project Status</h3>');
    expect(projectType).toContain('<h3 id="defaults-project-type-heading">Project Type</h3>');
    expect(res.text.indexOf('</form>')).toBeLessThan(
      res.text.indexOf('data-settings-project-option-editor="status"'),
    );
    expect(defaultsForm).not.toContain('data-settings-project-option-editor');
    expect(defaultsForm).not.toContain('projectType');
    expect(dbTemplate(db).get('page_defaults.new_project.project_type')).toBe('images');

    const expectedStatuses = app.locals.projectOptionCatalogueService
      .getStatusCatalogue()
      .map(({ value }) => value);
    const renderedStatuses = [...status.matchAll(/data-project-option-value="([^"]+)"/g)]
      .map((match) => match[1]);
    expect(renderedStatuses).toEqual(expectedStatuses);
    expect(status).toContain('Awaiting Review');
    expect(status).not.toContain('awaiting-review</span>');
    expect(status).toContain('style="--project-option-color: #123456"');
    expect(status).not.toContain('type="color"');
    expect(optionCardMarkup(res.text, 'status', 'tbd')).toContain(
      'class="status-badge project-option-badge project-status-badge status-badge--neutral"',
    );
    expect(optionCardMarkup(res.text, 'status', 'awaiting-review')).toContain(
      'style="--project-badge-bg: #123456; --project-badge-tint: 18%; --project-badge-fg: #8495A7">Awaiting Review</span>',
    );
    expect(optionCardMarkup(res.text, 'project-type', 'images')).toContain(
      'class="status-badge project-option-badge project-type-badge"',
    );
    expect(optionCardMarkup(res.text, 'project-type', 'images')).not.toContain('project-type-badge--images');
    expect(optionCardMarkup(res.text, 'project-type', 'lightbox-story')).toContain(
      'style="--project-badge-bg: #F5F5F5; --project-badge-tint: 18%; --project-badge-fg: #F5F5F5">Lightbox Story</span>',
    );

    for (const editor of [status, projectType]) {
      const cards = [...editor.matchAll(
        /<li[\s\S]*?data-project-option-card[\s\S]*?<\/li>/g,
      )].map((match) => match[0]);
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        expect(card).toContain('data-project-option-value=');
        expect(card).toContain('data-project-option-color-trigger');
        expect(card).toContain('data-project-option-delete');
        expect(card.indexOf('data-project-option-color-trigger'))
          .toBeLessThan(card.indexOf('data-project-option-delete'));
        expect(card).toMatch(/aria-label="Delete [^"]+"/);
        expect(card).not.toMatch(/<input[^>]+name="(?:name|label|value)"/);
      }
      expect(editor).toContain('data-project-option-add-form');
      expect(editor).toMatch(/<input[^>]+name="name"[^>]+type="text"/);
      expect((editor.match(/data-project-option-color-control/g) || []).length)
        .toBeGreaterThan(1);
      expect(editor).toContain('<button type="submit" class="button button-primary">Add</button>');
      expect(editor).not.toMatch(/rename|data-project-option-edit/i);
    }
  });

  it.each([
    ['status', PROJECT_STATUS_CATALOGUE_KEY],
    ['project-type', PROJECT_TYPE_CATALOGUE_KEY],
  ])('adds a valid %s option through the reviewed service', async (routeId, key) => {
    const res = await agent
      .post(`/settings/defaults/project-options/${routeId}/add`)
      .type('form')
      .send({ name: 'Client Work', color: '#12ab34', _csrf: csrfToken })
      .expect(302);

    expect(res.headers.location).toBe(
      `/settings/defaults?catalogue=${routeId}&notice=project_option_added`,
    );
    expect(readDocument(db, key).entries.at(-1)).toEqual({
      value: 'client-work',
      label: 'Client Work',
      color: '#12AB34',
    });
    const refreshed = await agent.get(res.headers.location).expect(200);
    const target = editorMarkup(refreshed.text, routeId);
    const other = editorMarkup(refreshed.text, routeId === 'status' ? 'project-type' : 'status');
    expect(target).toContain('data-project-option-feedback-code="SUCCESS"');
    expect(other).not.toContain('data-project-option-feedback-code="SUCCESS"');
  });

  it('ignores forged add-only authority fields and still derives identity from name', async () => {
    await agent
      .post('/settings/defaults/project-options/status/add')
      .type('form')
      .send({
        name: 'Needs Approval',
        color: '#123456',
        value: 'forged',
        label: 'Forged Label',
        protected: 'true',
        key: 'some.other.meta.key',
        _csrf: csrfToken,
      })
      .expect(302);

    expect(readDocument(db, PROJECT_STATUS_CATALOGUE_KEY).entries.at(-1)).toEqual({
      value: 'needs-approval',
      label: 'Needs Approval',
      color: '#123456',
    });
  });

  it.each([
    ['reserved', { name: 'all', color: '#123456' }, 'reserved'],
    ['reserved system Status', { name: 'Archived', color: '#123456' }, 'reserved'],
    ['invalid color', { name: 'Blocked', color: 'red' }, 'six-digit hexadecimal'],
    ['duplicate', { name: 'TBD', color: '#123456' }, 'already exists'],
  ])('returns a useful validation region for %s add input', async (_label, body, message) => {
    const before = readDocument(db, PROJECT_STATUS_CATALOGUE_KEY);
    const res = await agent
      .post('/settings/defaults/project-options/status/add')
      .type('form')
      .send({ ...body, _csrf: csrfToken })
      .expect(422);

    expect(res.text).toContain('data-settings-project-option-editor="status"');
    expect(res.text).not.toContain('data-settings-project-option-editor="project-type"');
    expect(res.text).toContain('data-project-option-feedback-code="VALIDATION_ERROR"');
    expect(res.text).toContain(message);
    expect(readDocument(db, PROJECT_STATUS_CATALOGUE_KEY)).toEqual(before);
  });

  it('updates only color even when rename and alternate identity fields are forged', async () => {
    const service = app.locals.projectOptionCatalogueService;
    service.addOption('status', { name: 'Color Target', color: '#123456' });

    await agent
      .post('/settings/defaults/project-options/status/color-target/color')
      .type('form')
      .send({
        color: '#abcdef',
        value: 'tbd',
        name: 'Renamed',
        label: 'Renamed',
        _csrf: csrfToken,
      })
      .expect(302);

    const target = service.getStatusCatalogue().find(({ value }) => value === 'color-target');
    expect(target).toEqual({ value: 'color-target', label: 'Color Target', color: '#ABCDEF' });
    expect(service.getStatusCatalogue().find(({ value }) => value === 'tbd').label).toBe('Tbd');
  });

  it('rejects invalid color without changing the catalogue', async () => {
    const before = readDocument(db, PROJECT_STATUS_CATALOGUE_KEY);
    const res = await agent
      .post('/settings/defaults/project-options/status/tbd/color')
      .type('form')
      .send({ color: '#12345G', label: 'Forged', _csrf: csrfToken })
      .expect(422);

    expect(res.text).toContain('data-project-option-feedback-code="VALIDATION_ERROR"');
    expect(readDocument(db, PROJECT_STATUS_CATALOGUE_KEY)).toEqual(before);
  });

  it('accepts only an exact ordered stable-value list', async () => {
    const service = app.locals.projectOptionCatalogueService;
    const order = service.getStatusCatalogue().map(({ value }) => value).reverse();
    await agent
      .post('/settings/defaults/project-options/status/reorder')
      .type('form')
      .send({ orderedValues: order, _csrf: csrfToken })
      .expect(302);
    expect(service.getStatusCatalogue().map(({ value }) => value)).toEqual(order);
  });

  it.each([
    ['malformed', 'tbd'],
    ['missing', ['tbd', 'planned']],
    ['duplicate', ['tbd', 'tbd']],
    ['unknown', ['tbd', 'planned', 'in-progress', 'ready', 'completed', 'unknown']],
  ])('rejects %s reorder membership unchanged', async (_label, orderedValues) => {
    const before = readDocument(db, PROJECT_STATUS_CATALOGUE_KEY);
    const res = await agent
      .post('/settings/defaults/project-options/status/reorder')
      .type('form')
      .send({ orderedValues, _csrf: csrfToken })
      .expect(422);
    expect(res.text).toContain('data-project-option-feedback-code="VALIDATION_ERROR"');
    expect(readDocument(db, PROJECT_STATUS_CATALOGUE_KEY)).toEqual(before);
  });

  it('deletes a safe custom option without remapping Projects', async () => {
    const service = app.locals.projectOptionCatalogueService;
    service.addOption('status', { name: 'Disposable', color: '#123456' });
    const projectsBefore = db.prepare('SELECT id, status, project_type FROM projects ORDER BY id').all();

    await agent
      .post('/settings/defaults/project-options/status/disposable/delete')
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    expect(service.getStatusCatalogue().some(({ value }) => value === 'disposable')).toBe(false);
    expect(db.prepare('SELECT id, status, project_type FROM projects ORDER BY id').all())
      .toEqual(projectsBefore);
  });

  it.each([
    ['status', 'tbd', 'page_defaults.new_project.status', 'planned'],
    ['project-type', 'images', 'page_defaults.new_project.project_type', 'comic'],
  ])('blocks former seeded %s option %s by its configured creation default, then deletes it after the default changes', async (
    routeId, value, defaultKey, replacement,
  ) => {
    const service = app.locals.projectOptionCatalogueService;
    const blocked = await agent
      .post(`/settings/defaults/project-options/${routeId}/${value}/delete`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(409);
    expect(blocked.text).toContain('data-project-option-feedback-code="OPTION_DEFAULT_REFERENCED"');

    writeMeta(db, defaultKey, replacement);
    const deleted = await agent
      .post(`/settings/defaults/project-options/${routeId}/${value}/delete`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);
    const catalogue = routeId === 'status'
      ? service.getStatusCatalogue()
      : service.getProjectTypeCatalogue();
    expect(catalogue.some((entry) => entry.value === value)).toBe(false);
    await agent.get(deleted.headers.location).expect(200);
  });

  it('reassigns every referenced Project and returns the authoritative catalogue region', async () => {
    const service = app.locals.projectOptionCatalogueService;
    service.addOption('projectType', { name: 'Replace Me', color: '#123456' });
    insertProject(db, { slug: 'active-reference', projectType: 'replace-me' });
    const archivedId = Number(insertProject(db, {
      slug: 'archived-reference', projectType: 'replace-me',
    }).lastInsertRowid);
    db.prepare("UPDATE projects SET archived_at = '2026-09-09 00:00:00' WHERE id = ?")
      .run(archivedId);

    const res = await agent
      .post('/settings/defaults/project-options/project-type/replace-me/delete')
      .type('form')
      .send({ replacement: 'images', _csrf: csrfToken })
      .expect(302);

    expect(res.headers.location).toBe(
      '/settings/defaults?catalogue=project-type&notice=project_option_deleted',
    );
    expect(db.prepare("SELECT project_type FROM projects WHERE slug LIKE '%-reference' ORDER BY slug")
      .pluck().all()).toEqual(['images', 'images']);
    expect(service.getProjectTypeCatalogue().some(({ value }) => value === 'replace-me')).toBe(false);
    const refreshed = await agent.get(res.headers.location).expect(200);
    expect(editorMarkup(refreshed.text, 'project-type')).toContain(
      'data-project-option-feedback-code="SUCCESS"',
    );
    expect(editorMarkup(refreshed.text, 'status')).not.toContain(
      'data-project-option-feedback-code="SUCCESS"',
    );
  });

  it.each([
    ['multiple replacement values', { replacement: ['tbd', 'planned'] }],
    ['an extra force field', { force: 'true' }],
    ['an extra destination field', { replacement: 'tbd', destinationCatalogue: 'status' }],
  ])('rejects delete requests with %s', async (_label, body) => {
    const service = app.locals.projectOptionCatalogueService;
    service.addOption('status', { name: 'Request Shape', color: '#123456' });
    const res = await agent
      .post('/settings/defaults/project-options/status/request-shape/delete')
      .type('form')
      .send({ ...body, _csrf: csrfToken })
      .expect(422);

    expect(res.text).toContain('data-project-option-feedback-code="VALIDATION_ERROR"');
    expect(service.getStatusCatalogue().some(({ value }) => value === 'request-shape')).toBe(true);
  });

  it('returns distinct validation, replacement-required, and saved-default failures', async () => {
    const service = app.locals.projectOptionCatalogueService;
    service.addOption('status', { name: 'Used Project', color: '#123456' });
    service.addOption('projectType', { name: 'Saved Type', color: '#654321' });
    insertProject(db, { slug: 'used-project', status: 'used-project' });
    writeMeta(db, 'page_defaults.projects.project_type', 'saved-type');

    const cases = [
      ['status/archived', 422, 'VALIDATION_ERROR'],
      ['status/tbd', 409, 'OPTION_DEFAULT_REFERENCED'],
      ['status/used-project', 409, 'OPTION_REPLACEMENT_REQUIRED'],
      ['project-type/saved-type', 409, 'OPTION_DEFAULT_REFERENCED'],
    ];
    for (const [target, status, code] of cases) {
      const res = await agent
        .post(`/settings/defaults/project-options/${target}/delete`)
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(status);
      expect(res.text).toContain(`data-project-option-feedback-code="${code}"`);
    }

    expect(service.getStatusCatalogue().some(({ value }) => value === 'archived')).toBe(false);
    expect(service.getStatusCatalogue().some(({ value }) => value === 'used-project')).toBe(true);
    expect(service.getProjectTypeCatalogue().some(({ value }) => value === 'saved-type')).toBe(true);
    expect(db.prepare("SELECT status FROM projects WHERE slug = 'used-project'").pluck().get())
      .toBe('used-project');
  });

  it('returns authoritative stale-state errors for unexpected and vanished replacements', async () => {
    const service = app.locals.projectOptionCatalogueService;
    service.addOption('status', { name: 'Now Unused', color: '#123456' });
    service.addOption('status', { name: 'Still Used', color: '#654321' });
    service.addOption('status', { name: 'Vanished Target', color: '#112233' });
    const noLongerUsed = insertProject(db, { slug: 'no-longer-used', status: 'now-unused' });
    insertProject(db, { slug: 'still-used', status: 'still-used' });
    await agent.get('/settings/defaults').expect(200);
    db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('planned', noLongerUsed.lastInsertRowid);
    service.deleteOption('status', 'vanished-target');

    const unexpected = await agent
      .post('/settings/defaults/project-options/status/now-unused/delete')
      .type('form')
      .send({ replacement: 'tbd', _csrf: csrfToken })
      .expect(409);
    expect(unexpected.text).toContain('data-project-option-feedback-code="OPTION_REPLACEMENT_UNEXPECTED"');
    expect(unexpected.text).toContain('data-project-option-value="now-unused"');

    const invalid = await agent
      .post('/settings/defaults/project-options/status/still-used/delete')
      .type('form')
      .send({ replacement: 'vanished-target', _csrf: csrfToken })
      .expect(409);
    expect(invalid.text).toContain('data-project-option-feedback-code="OPTION_REPLACEMENT_INVALID"');
    expect(db.prepare("SELECT status FROM projects WHERE slug = 'still-used'").pluck().get())
      .toBe('still-used');
  });

  it('uses server-owned deletion metadata for Settings editor rendering', async () => {
    const service = app.locals.projectOptionCatalogueService;
    const metadata = vi.spyOn(service, 'getDeletionMetadata');

    await agent.get('/settings/defaults').expect(200);

    expect(metadata).toHaveBeenCalledWith('status');
    expect(metadata).toHaveBeenCalledWith('projectType');
  });

  it('renders the four authoritative deletion interactions without a protected mode', async () => {
    const service = app.locals.projectOptionCatalogueService;
    service.addOption('status', { name: 'Unused Custom', color: '#111111' });
    service.addOption('status', { name: 'Used Status', color: '#222222' });
    service.addOption('status', { name: 'Hand Crafted', color: '#333333' });
    service.addOption('status', { name: 'Default Status', color: '#444444' });
    service.addOption('status', { name: 'Combined Status', color: '#555555' });
    service.addOption('projectType', { name: 'Used Type', color: '#666666' });
    insertProject(db, { slug: 'used-one', status: 'used-status' });
    insertProject(db, { slug: 'used-two', status: 'used-status' });
    insertProject(db, { slug: 'used-type-owner', projectType: 'used-type' });
    const ownerId = Number(insertProject(db, { slug: 'combined-owner', status: 'combined-status' }).lastInsertRowid);
    writeMeta(db, 'page_defaults.new_project.status', 'default-status');
    db.prepare(`
      INSERT INTO project_page_defaults (project_id, page_key, option_key, value)
      VALUES (?, 'projects', 'status', 'combined-status')
    `).run(ownerId);

    const res = await agent.get('/settings/defaults').expect(200);
    const unused = optionCardMarkup(res.text, 'status', 'unused-custom');
    const formerSeeded = optionCardMarkup(res.text, 'status', 'tbd');
    const creationDefaultType = optionCardMarkup(res.text, 'project-type', 'images');
    const referenced = optionCardMarkup(res.text, 'status', 'used-status');
    const referencedType = optionCardMarkup(res.text, 'project-type', 'used-type');
    const blocked = optionCardMarkup(res.text, 'status', 'default-status');
    const combined = optionCardMarkup(res.text, 'status', 'combined-status');

    expect(unused).toContain('data-project-option-delete-mode="unused"');
    expect(unused).toContain('data-project-option-delete-message="This cannot be undone."');
    expect(unused).not.toContain('data-project-option-delete-replacement-template');
    expect(formerSeeded).toContain('data-project-option-delete-mode="referenced"');
    expect(formerSeeded).toContain('data-project-option-delete-replacement-template');
    expect(creationDefaultType).toContain('data-project-option-delete-mode="blocked"');
    expect(creationDefaultType).toContain('New Project Type default');
    expect(creationDefaultType).not.toContain('data-project-option-delete-replacement-template');
    expect(referenced).toContain('data-project-option-delete-mode="referenced"');
    expect(referenced).toContain('2 Projects currently use this status');
    expect(referenced).toContain('data-project-option-delete-confirm-label="Reassign and delete"');
    expect(referenced).toContain('<template data-project-option-delete-replacement-template>');
    expect(referenced).toContain('data-cc-dropdown data-cc-dropdown-mode="single"');
    expect(referenced).toContain('data-cc-dropdown-dispatch-native-change');
    expect(referenced).toMatch(/<legend>Replacement status <span class="required" aria-label="required">\*<\/span><\/legend>/);
    expect(referenced).toMatch(/<select id="project-option-status-used-status-delete-replacement" name="replacement"[^>]+data-cc-dropdown-native-select[^>]+required[^>]*>/);
    expect(referenced).toContain('id="project-option-status-used-status-delete-replacement-dropdown"');
    expect(referenced).toContain('autofocus');
    const replacementValues = [...referenced.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
      .map(([, value, label]) => ({ value, label }));
    expect(replacementValues).toEqual(
      service.getDeletionMetadata('status')
        .find(entry => entry.value === 'used-status')
        .deletion.eligibleReplacements,
    );
    expect(replacementValues).toContainEqual({ value: 'hand-crafted', label: 'Hand Crafted' });
    expect(replacementValues.map(({ value }) => value)).not.toContain('used-status');
    expect(replacementValues.map(({ value }) => value)).not.toContain('archived');
    expect(referencedType).toContain('<template data-project-option-delete-replacement-template>');
    expect(referencedType).toContain('id="project-option-project-type-used-type-delete-replacement"');
    const replacementTemplateIds = [referenced, referencedType]
      .flatMap(markup => [...markup.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id))
      .filter(id => id.includes('delete-replacement'));
    expect(new Set(replacementTemplateIds).size).toBe(replacementTemplateIds.length);
    expect(blocked).toContain('data-project-option-delete-mode="blocked"');
    expect(blocked).toContain('New Project Status default');
    expect(blocked).not.toContain('data-project-option-delete-replacement-template');
    expect(combined).toContain('data-project-option-delete-mode="blocked"');
    expect(combined).toContain('Project-scoped Projects Status filter default');
    expect(combined).toContain('1 Project also currently uses this status');
    expect(combined).not.toContain('Reassign and delete');
    expect(optionCardMarkup(res.text, 'status', 'archived')).toBe('');
    expect(res.text).not.toContain('data-project-option-delete-mode="protected"');
    expect(res.text).not.toContain('required by CreatorCrate');
    expect(res.text).not.toContain('This is only allowed when no Project or saved default uses it.');
  });

  it('returns bounded catalogue-integrity and unexpected-failure regions', async () => {
    writeMeta(db, PROJECT_STATUS_CATALOGUE_KEY, '{bad json');
    const integrity = await agent
      .post('/settings/defaults/project-options/status/tbd/color')
      .type('form')
      .send({ color: '#123456', _csrf: csrfToken })
      .expect(500);
    expect(integrity.text).toContain('data-project-option-feedback-code="CATALOGUE_INVALID"');
    expect(integrity.text).not.toContain(PROJECT_STATUS_CATALOGUE_KEY);

    app.locals.projectOptionCatalogueService.addOption = () => {
      throw new Error('database internals');
    };
    const unexpected = await agent
      .post('/settings/defaults/project-options/project-type/add')
      .type('form')
      .send({ name: 'Failure', color: '#123456', _csrf: csrfToken })
      .expect(500);
    expect(unexpected.text).toContain('data-project-option-feedback-code="UNEXPECTED_ERROR"');
    expect(unexpected.text).not.toContain('database internals');
  });

  it('returns a safe live region for reassignment integrity failures', async () => {
    const service = app.locals.projectOptionCatalogueService;
    service.addOption('status', { name: 'Integrity Source', color: '#123456' });
    service.deleteOption = () => {
      throw new ProjectOptionCatalogueIntegrityError('internal detail', {
        code: 'CATALOGUE_REFERENCE_INTEGRITY',
      });
    };

    const res = await agent
      .post('/settings/defaults/project-options/status/integrity-source/delete')
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(500);

    expect(res.text).toContain('data-project-option-feedback-code="CATALOGUE_REFERENCE_INTEGRITY"');
    expect(res.text).toContain('data-project-option-value="integrity-source"');
    expect(res.text).not.toContain('internal detail');
  });

  it('rejects unknown catalogue identities and requires CSRF', async () => {
    await agent
      .post('/settings/defaults/project-options/arbitrary/add')
      .type('form')
      .send({ name: 'Nope', color: '#123456', _csrf: csrfToken })
      .expect(404);
    await agent
      .post('/settings/defaults/project-options/status/add')
      .type('form')
      .send({ name: 'No CSRF', color: '#123456' })
      .expect(403);
    app.locals.projectOptionCatalogueService.addOption('status', {
      name: 'Delete No CSRF', color: '#123456',
    });
    await agent
      .post('/settings/defaults/project-options/status/delete-no-csrf/delete')
      .type('form')
      .send({})
      .expect(403);
  });
});
