import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectPageDefaultRepository } from '../src/data/project-page-default-repository.js';
import {
  createProjectOptionCatalogueService,
  PROJECT_STATUS_CATALOGUE_KEY,
  PROJECT_TYPE_CATALOGUE_KEY,
  ProjectOptionCatalogueConflictError,
  ProjectOptionCatalogueIntegrityError,
  ProjectOptionCatalogueValidationError,
} from '../src/services/project-option-catalogue-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function buildService(db, overrides = {}) {
  const appMetaRepository = overrides.appMetaRepository ?? createAppMetaRepository(db);
  const projectRepository = overrides.projectRepository ?? createProjectRepository(db);
  const projectPageDefaultRepository = overrides.projectPageDefaultRepository
    ?? createProjectPageDefaultRepository(db);
  return {
    appMetaRepository,
    projectRepository,
    projectPageDefaultRepository,
    service: createProjectOptionCatalogueService({
      db,
      appMetaRepository,
      projectRepository,
      projectPageDefaultRepository,
    }),
  };
}

function rawDocument(db, key) {
  return JSON.parse(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(key));
}

function insertProject(db, { slug, status = 'tbd', projectType = 'images', archived = false }) {
  return db.prepare(`
    INSERT INTO projects (title, slug, status, project_type, archived_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(slug, slug, status, projectType, archived ? '2026-09-09 00:00:00' : null);
}

describe('Project option catalogue service', () => {
  let tmpDir;
  let db;
  let repository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-option-catalogue-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    ({ appMetaRepository: repository, service } = buildService(db));
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads valid versioned catalogues and preserves their persisted order and colors', () => {
    expect(service.getStatusCatalogue().map(({ value }) => value)).toEqual([
      'tbd', 'planned', 'in-progress', 'ready', 'completed',
    ]);
    expect(service.getProjectTypeCatalogue().map(({ value }) => value)).toEqual([
      'images', 'comic', 'animation', 'wallpaper',
    ]);

    service.addOption('status', { name: 'Needs Review', color: '#123abc' });
    service.reorderOptions('status', [
      'needs-review', 'tbd', 'planned', 'in-progress', 'ready', 'completed',
    ]);
    service.updateOptionColor('status', { value: 'needs-review', color: ' #abcdef ' });

    expect(buildService(db).service.getStatusCatalogue()[0]).toEqual({
      value: 'needs-review', label: 'Needs Review', color: '#ABCDEF',
    });
    expect(rawDocument(db, PROJECT_STATUS_CATALOGUE_KEY).version).toBe(1);
  });

  it('rejects missing, malformed, unsupported-version, and structurally invalid stored documents', () => {
    const invalidDocuments = [
      undefined,
      '{not json',
      JSON.stringify({ version: 2, entries: [] }),
      JSON.stringify({ version: 1, entries: [{ value: 'bad value', label: 'Bad', color: '#123456' }] }),
      JSON.stringify({ version: 1, entries: [
        { value: 'same', label: 'Same', color: '#123456' },
        { value: 'same', label: 'Other', color: '#654321' },
      ] }),
    ];

    for (const stored of invalidDocuments) {
      if (stored === undefined) {
        db.prepare('DELETE FROM app_meta WHERE key = ?').run(PROJECT_STATUS_CATALOGUE_KEY);
      } else {
        repository.setValue(PROJECT_STATUS_CATALOGUE_KEY, stored);
      }
      expect(() => service.getStatusCatalogue()).toThrow(ProjectOptionCatalogueIntegrityError);
      if (stored === undefined) {
        expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PROJECT_STATUS_CATALOGUE_KEY))
          .toBeUndefined();
      }
    }
  });

  it('adds Status and Type options with one-time labels, stable slugified values, and normalized colors', () => {
    expect(service.addOption('status', { name: '  Awaiting Client Review  ', color: '#0a1b2c' }))
      .toEqual({ value: 'awaiting-client-review', label: 'Awaiting Client Review', color: '#0A1B2C' });
    expect(service.addOption('projectType', { name: 'Interactive Story', color: '#fedcba' }))
      .toEqual({ value: 'interactive-story', label: 'Interactive Story', color: '#FEDCBA' });
    expect(buildService(db).service.getProjectTypeCatalogue().at(-1)).toEqual({
      value: 'interactive-story', label: 'Interactive Story', color: '#FEDCBA',
    });
  });

  it('rejects blank, oversized, invalid, duplicate, and reserved additions', () => {
    const attempts = [
      { name: '   ', color: '#123456' },
      { name: 'x'.repeat(101), color: '#123456' },
      { name: '🚀', color: '#123456' },
      { name: 'ALL', color: '#123456' },
      { name: 'Archived', color: '#123456' },
      { name: 'Ready', color: '#123456' },
      { name: 'ready', color: '#123456' },
      { name: 'Valid', color: '#123' },
      { name: 'Valid', color: 'red' },
    ];
    for (const input of attempts) {
      expect(() => service.addOption('status', input)).toThrow(ProjectOptionCatalogueValidationError);
    }
    expect(service.getStatusCatalogue()).toHaveLength(5);
  });

  it('updates color only and rejects forged label/value fields', () => {
    const before = service.getStatusCatalogue();
    expect(service.updateOptionColor('status', { value: 'ready', color: '#010203' }))
      .toEqual({ value: 'ready', label: 'Ready', color: '#010203' });
    expect(() => service.updateOptionColor('status', {
      value: 'ready', label: 'Renamed', color: '#112233',
    })).toThrow(ProjectOptionCatalogueValidationError);
    expect(service.getStatusCatalogue().map(({ value, label }) => ({ value, label })))
      .toEqual(before.map(({ value, label }) => ({ value, label })));
  });

  it('accepts only exact reorder permutations and changes order only', () => {
    const before = service.getProjectTypeCatalogue();
    const ordered = ['wallpaper', 'animation', 'comic', 'images'];
    expect(service.reorderOptions('projectType', ordered).map(({ value }) => value)).toEqual(ordered);
    expect(new Map(service.getProjectTypeCatalogue().map((entry) => [entry.value, entry])))
      .toEqual(new Map(before.map((entry) => [entry.value, entry])));

    for (const malformed of [
      ['wallpaper', 'animation', 'comic'],
      ['wallpaper', 'animation', 'comic', 'comic'],
      ['wallpaper', 'animation', 'comic', 'unknown'],
      ['wallpaper', 'animation', 'comic', 'tbd'],
    ]) {
      expect(() => service.reorderOptions('projectType', malformed))
        .toThrow(ProjectOptionCatalogueValidationError);
    }
    expect(service.getProjectTypeCatalogue().map(({ value }) => value)).toEqual(ordered);
  });

  it('keeps archived outside the editable Status catalogue and reserves its identity', () => {
    expect(service.getStatusCatalogue().some(({ value }) => value === 'archived')).toBe(false);
    expect(() => service.addOption('status', { name: 'Archived', color: '#123456' }))
      .toThrowError(expect.objectContaining({ errors: { name: 'The value "archived" is reserved.' } }));
    expect(() => service.deleteOption('status', 'archived'))
      .toThrow(ProjectOptionCatalogueValidationError);
  });

  it.each([
    ['status', 'tbd', 'page_defaults.new_project.status', 'planned', 'NEW_PROJECT_STATUS_DEFAULT'],
    ['projectType', 'images', 'page_defaults.new_project.project_type', 'comic', 'NEW_PROJECT_TYPE_DEFAULT'],
  ])('blocks former seeded %s option %s only while the configured creation default references it', (
    kind, value, defaultKey, replacement, blockerCode,
  ) => {
    const before = service.getDeletionMetadata(kind).find((entry) => entry.value === value);
    expect(before.deletion).not.toHaveProperty('protected');
    expect(before.deletion.savedDefaultBlockers.map(({ code }) => code)).toContain(blockerCode);
    expect(() => service.deleteOption(kind, value)).toThrowError(
      expect.objectContaining({ code: 'OPTION_DEFAULT_REFERENCED' }),
    );

    repository.setValue(defaultKey, replacement);
    expect(service.deleteOption(kind, value)).toBe(true);
    const catalogue = kind === 'status'
      ? service.getStatusCatalogue()
      : service.getProjectTypeCatalogue();
    expect(catalogue.some((entry) => entry.value === value)).toBe(false);
  });

  it.each([
    ['status', 'tbd', 'page_defaults.new_project.status', 'planned'],
    ['projectType', 'images', 'page_defaults.new_project.project_type', 'comic'],
  ])('reassigns every Project from former seeded %s option %s after its default changes', (
    kind, value, defaultKey, replacement,
  ) => {
    repository.setValue(defaultKey, replacement);
    insertProject(db, {
      slug: `${value}-one`,
      status: kind === 'status' ? value : 'planned',
      projectType: kind === 'projectType' ? value : 'comic',
    });
    insertProject(db, {
      slug: `${value}-two`,
      status: kind === 'status' ? value : 'planned',
      projectType: kind === 'projectType' ? value : 'comic',
      archived: true,
    });

    expect(service.deleteOption(kind, value, replacement)).toBe(true);
    const column = kind === 'status' ? 'status' : 'project_type';
    expect(db.prepare(`SELECT ${column} FROM projects WHERE slug LIKE ? ORDER BY slug`)
      .pluck().all(`${value}-%`)).toEqual([replacement, replacement]);
  });

  it('atomically reassigns active and archived Project references before deletion', () => {
    service.addOption('status', { name: 'Blocked Active', color: '#123456' });
    service.addOption('projectType', { name: 'Archived Type', color: '#654321' });
    insertProject(db, { slug: 'active', status: 'blocked-active' });
    insertProject(db, { slug: 'second', status: 'blocked-active' });
    insertProject(db, { slug: 'archived', projectType: 'archived-type', archived: true });

    expect(service.deleteOption('status', 'blocked-active', 'tbd')).toBe(true);
    expect(service.deleteOption('projectType', 'archived-type', 'images')).toBe(true);
    expect(db.prepare("SELECT status FROM projects WHERE slug IN ('active', 'second') ORDER BY slug")
      .pluck().all()).toEqual(['tbd', 'tbd']);
    expect(db.prepare("SELECT project_type FROM projects WHERE slug = 'archived'").pluck().get())
      .toBe('images');
    expect(db.prepare("SELECT archived_at FROM projects WHERE slug = 'archived'").pluck().get())
      .toBe('2026-09-09 00:00:00');
    expect(service.getStatusCatalogue().some(({ value }) => value === 'blocked-active')).toBe(false);
    expect(service.getProjectTypeCatalogue().some(({ value }) => value === 'archived-type')).toBe(false);
  });

  it('requires, validates, and rejects stale or inapplicable replacements', () => {
    const { value: source } = service.addOption('status', { name: 'Replace Source', color: '#123456' });
    const { value: stale } = service.addOption('status', { name: 'Stale Target', color: '#654321' });
    insertProject(db, { slug: 'referenced', status: source });

    expect(() => service.deleteOption('status', source)).toThrowError(
      expect.objectContaining({ code: 'OPTION_REPLACEMENT_REQUIRED' }),
    );
    for (const replacement of [source, 'unknown', 'comic', 'archived', ['planned']]) {
      expect(() => service.deleteOption('status', source, replacement)).toThrowError(
        expect.objectContaining({ code: 'OPTION_REPLACEMENT_INVALID' }),
      );
    }
    expect(service.deleteOption('status', stale)).toBe(true);
    expect(() => service.deleteOption('status', source, stale)).toThrowError(
      expect.objectContaining({ code: 'OPTION_REPLACEMENT_INVALID' }),
    );
    expect(db.prepare("SELECT status FROM projects WHERE slug = 'referenced'").pluck().get())
      .toBe(source);

    db.prepare('UPDATE projects SET status = ? WHERE status = ?').run('planned', source);
    expect(() => service.deleteOption('status', source, 'tbd')).toThrowError(
      expect.objectContaining({ code: 'OPTION_REPLACEMENT_UNEXPECTED' }),
    );
    expect(service.getStatusCatalogue().some(({ value }) => value === source)).toBe(true);
  });

  it('deletes an unused option only when no replacement is supplied', () => {
    const { value } = service.addOption('projectType', { name: 'Unused Type', color: '#123456' });
    const projectsBefore = db.prepare('SELECT * FROM projects ORDER BY id').all();
    expect(() => service.deleteOption('projectType', value, 'images')).toThrowError(
      expect.objectContaining({ code: 'OPTION_REPLACEMENT_UNEXPECTED' }),
    );
    expect(db.prepare('SELECT * FROM projects ORDER BY id').all()).toEqual(projectsBefore);
    expect(service.deleteOption('projectType', value)).toBe(true);
  });

  it.each([
    ['status', 'New Default Status', 'page_defaults.new_project.status', null],
    ['projectType', 'New Default Type', 'page_defaults.new_project.project_type', null],
    ['status', 'Filter Status', 'page_defaults.projects.status', null],
    ['projectType', 'Filter Type', 'page_defaults.projects.project_type', null],
    ['status', 'Scoped Status', null, ['projects', 'status']],
    ['projectType', 'Scoped Type', null, ['projects', 'projectType']],
  ])('blocks %s option %s selected by a saved default', (kind, name, globalKey, scoped) => {
    const { value } = service.addOption(kind, { name, color: '#123456' });
    if (globalKey) repository.setValue(globalKey, value);
    if (scoped) {
      const projectId = Number(insertProject(db, { slug: `owner-${value}` }).lastInsertRowid);
      db.prepare(`
        INSERT INTO project_page_defaults (project_id, page_key, option_key, value)
        VALUES (?, ?, ?, ?)
      `).run(projectId, scoped[0], scoped[1], value);
    }

    insertProject(db, { slug: `referenced-${value}`, status: kind === 'status' ? value : 'tbd', projectType: kind === 'projectType' ? value : 'images' });
    expect(() => service.deleteOption(kind, value, kind === 'status' ? 'tbd' : 'images')).toThrowError(
      expect.objectContaining({ code: 'OPTION_DEFAULT_REFERENCED' }),
    );
    expect((kind === 'status' ? service.getStatusCatalogue() : service.getProjectTypeCatalogue())
      .some((entry) => entry.value === value)).toBe(true);
    const project = db.prepare('SELECT status, project_type FROM projects WHERE slug = ?')
      .get(`referenced-${value}`);
    expect(project[kind === 'status' ? 'status' : 'project_type']).toBe(value);
  });

  it('blocks a saved default even when no Project references the option', () => {
    const { value } = service.addOption('projectType', { name: 'Default Only', color: '#123456' });
    repository.setValue('page_defaults.projects.project_type', value);

    expect(() => service.deleteOption('projectType', value)).toThrowError(
      expect.objectContaining({ code: 'OPTION_DEFAULT_REFERENCED' }),
    );
    expect(service.getProjectTypeCatalogue().some((entry) => entry.value === value)).toBe(true);
  });

  it('builds authoritative deletion metadata with counts, blockers, and ordered replacements', () => {
    const { value } = service.addOption('status', { name: 'Metadata Source', color: '#123456' });
    insertProject(db, { slug: 'metadata-one', status: value });
    insertProject(db, { slug: 'metadata-two', status: value });
    repository.setValue('page_defaults.new_project.status', value);
    repository.setValue('page_defaults.projects.status', value);
    const scopedOwner = Number(insertProject(db, { slug: 'metadata-owner' }).lastInsertRowid);
    db.prepare(`
      INSERT INTO project_page_defaults (project_id, page_key, option_key, value)
      VALUES (?, 'projects', 'status', ?)
    `).run(scopedOwner, value);

    const metadata = service.getDeletionMetadata('status');
    const source = metadata.find((entry) => entry.value === value);
    expect(source.deletion).not.toHaveProperty('protected');
    expect(source.deletion.projectReferenceCount).toBe(2);
    expect(source.deletion.savedDefaultBlockers.map(({ code, referenceCount }) => ({ code, referenceCount })))
      .toEqual([
        { code: 'NEW_PROJECT_STATUS_DEFAULT', referenceCount: 1 },
        { code: 'PROJECTS_GLOBAL_STATUS_DEFAULT', referenceCount: 1 },
        { code: 'PROJECTS_PROJECT_STATUS_DEFAULT', referenceCount: 1 },
      ]);
    expect(source.deletion.savedDefaultBlockers[0].remediation)
      .toEqual({ href: '/settings/defaults#defaults-new-projects', label: 'Settings Defaults — New Projects' });
    expect(source.deletion.savedDefaultBlockers[2]).not.toHaveProperty('remediation');
    expect(source.deletion.eligibleReplacements).toEqual(
      service.getStatusCatalogue()
        .filter((entry) => entry.value !== value && entry.value !== 'archived')
        .map(({ value: replacementValue, label }) => ({ value: replacementValue, label })),
    );
    expect(metadata.every((entry) => !Object.hasOwn(entry.deletion, 'protected'))).toBe(true);
  });

  it('ignores Dashboard-only saved section state and deletes an otherwise unused option', () => {
    const { value } = service.addOption('status', { name: 'Dashboard Only', color: '#123456' });
    repository.setValue('page_defaults.dashboard', JSON.stringify({
      version: 1,
      order: [`status:${value}`],
      sections: { [`status:${value}`]: { visible: true, itemCount: 8 } },
    }));

    expect(service.deleteOption('status', value)).toBe(true);
    expect(service.getStatusCatalogue().some((entry) => entry.value === value)).toBe(false);
  });

  it('keeps a default-blocked deletion unchanged', () => {
    const before = rawDocument(db, PROJECT_STATUS_CATALOGUE_KEY);
    expect(() => service.deleteOption('status', 'tbd')).toThrow(ProjectOptionCatalogueConflictError);
    expect(rawDocument(db, PROJECT_STATUS_CATALOGUE_KEY)).toEqual(before);
  });

  it('checks references and writes deletion within one synchronous transaction', () => {
    service.addOption('status', { name: 'Transactional', color: '#123456' });
    const actualAppMeta = createAppMetaRepository(db);
    const actualProjects = createProjectRepository(db);
    const actualDefaults = createProjectPageDefaultRepository(db);
    const appMetaRepository = {
      getValue: vi.fn((key) => {
        expect(db.inTransaction).toBe(true);
        return actualAppMeta.getValue(key);
      }),
      setValue: vi.fn((key, value) => {
        expect(db.inTransaction).toBe(true);
        return actualAppMeta.setValue(key, value);
      }),
    };
    const projectRepository = {
      countStatusValue: vi.fn((value) => {
        expect(db.inTransaction).toBe(true);
        return actualProjects.countStatusValue(value);
      }),
      countProjectTypeValue: actualProjects.countProjectTypeValue,
      reassignStatusValue: actualProjects.reassignStatusValue,
      reassignProjectTypeValue: actualProjects.reassignProjectTypeValue,
    };
    const projectPageDefaultRepository = {
      listOptionValueReferences: vi.fn((...args) => {
        expect(db.inTransaction).toBe(true);
        return actualDefaults.listOptionValueReferences(...args);
      }),
    };
    const transactionalService = buildService(db, {
      appMetaRepository, projectRepository, projectPageDefaultRepository,
    }).service;

    expect(transactionalService.deleteOption('status', 'transactional')).toBe(true);
    expect(projectRepository.countStatusValue).toHaveBeenCalledOnce();
    expect(projectPageDefaultRepository.listOptionValueReferences).toHaveBeenCalledOnce();
    expect(appMetaRepository.setValue).toHaveBeenCalledOnce();
  });

  it('uses the established immediate write-reservation transaction mode', () => {
    service.addOption('projectType', { name: 'Immediate', color: '#123456' });
    let immediate;
    const transactionDb = {
      transaction(callback) {
        const transaction = db.transaction(callback);
        immediate = vi.fn((...args) => transaction.immediate(...args));
        return { immediate };
      },
    };
    const immediateService = createProjectOptionCatalogueService({
      db: transactionDb,
      appMetaRepository: createAppMetaRepository(db),
      projectRepository: createProjectRepository(db),
      projectPageDefaultRepository: createProjectPageDefaultRepository(db),
    });

    expect(immediateService.deleteOption('projectType', 'immediate')).toBe(true);
    expect(immediate).toHaveBeenCalledOnce();
  });

  it('rolls back Project reassignment when catalogue persistence fails', () => {
    const { value } = service.addOption('status', { name: 'Rollback Source', color: '#123456' });
    insertProject(db, { slug: 'rollback-one', status: value });
    insertProject(db, { slug: 'rollback-two', status: value });
    const actualAppMeta = createAppMetaRepository(db);
    const failingAppMeta = {
      getValue: actualAppMeta.getValue,
      setValue: vi.fn(() => { throw new Error('injected catalogue write failure'); }),
    };
    const rollbackService = buildService(db, { appMetaRepository: failingAppMeta }).service;

    expect(() => rollbackService.deleteOption('status', value, 'planned'))
      .toThrow('injected catalogue write failure');
    expect(db.prepare('SELECT status FROM projects WHERE status = ? ORDER BY id').pluck().all(value))
      .toEqual([value, value]);
    expect(service.getStatusCatalogue().some((entry) => entry.value === value)).toBe(true);
  });

  it('rolls back when the bulk-update affected count violates the observed reference count', () => {
    const { value } = service.addOption('status', { name: 'Count Mismatch', color: '#123456' });
    insertProject(db, { slug: 'count-mismatch', status: value });
    const actualProjects = createProjectRepository(db);
    const mismatchedProjects = {
      countStatusValue: actualProjects.countStatusValue,
      countProjectTypeValue: actualProjects.countProjectTypeValue,
      reassignStatusValue(source, replacement) {
        actualProjects.reassignStatusValue(source, replacement);
        return 0;
      },
      reassignProjectTypeValue: actualProjects.reassignProjectTypeValue,
    };
    const integrityService = buildService(db, { projectRepository: mismatchedProjects }).service;

    expect(() => integrityService.deleteOption('status', value, 'planned')).toThrowError(
      expect.objectContaining({ code: 'CATALOGUE_REFERENCE_INTEGRITY' }),
    );
    expect(db.prepare("SELECT status FROM projects WHERE slug = 'count-mismatch'").pluck().get())
      .toBe(value);
    expect(service.getStatusCatalogue().some((entry) => entry.value === value)).toBe(true);
  });

  it('does not regenerate a deliberately deleted custom option after reopening', () => {
    const databasePath = path.join(tmpDir, 'test.db');
    const { value } = service.addOption('projectType', { name: 'Interactive', color: '#123456' });
    expect(service.deleteOption('projectType', value)).toBe(true);

    closeDatabase(db);
    db = openDatabase(databasePath);
    runMigrations(db, MIGRATIONS_DIR);
    service = buildService(db).service;

    expect(service.getProjectTypeCatalogue().some((entry) => entry.value === value)).toBe(false);
    expect(rawDocument(db, PROJECT_TYPE_CATALOGUE_KEY).entries).toHaveLength(4);
  });
});
