import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectPageDefaultRepository } from '../src/data/project-page-default-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const PROJECT_DEFAULTS_MIGRATION_FILENAME = '024_add_project_page_defaults.sql';
const PAGE_SCOPE_MIGRATION_FILENAME = '035_add_project_page_default_scopes.sql';

function createProject(repository, title) {
  return repository.create({
    title,
    slug: title.toLowerCase().replaceAll(' ', '-'),
    description: '',
    notes: '',
    status: 'tbd',
    projectType: 'images',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
  });
}

function createPreProjectPageDefaultsMigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-project-page-defaults-migrations');
  fs.mkdirSync(legacyDir);

  for (const filename of fs.readdirSync(MIGRATIONS_DIR)) {
    if (filename.endsWith('.sql') && Number.parseInt(filename, 10) < 24) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
    }
  }

  return legacyDir;
}

function createPrePageScopeMigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-page-scope-migrations');
  fs.mkdirSync(legacyDir);

  for (const filename of fs.readdirSync(MIGRATIONS_DIR)) {
    if (filename.endsWith('.sql') && Number.parseInt(filename, 10) < 35) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
    }
  }

  return legacyDir;
}

describe('project page-default repository', () => {
  let tmpDir;
  let db;
  let repository;
  let projectRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-page-defaults-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createProjectPageDefaultRepository(db);
    projectRepository = createProjectRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts and reads individual and complete page options', () => {
    const project = createProject(projectRepository, 'Project One');

    expect(repository.getOption(project.id, 'projectAssets', 'sort')).toBeUndefined();

    expect(repository.setOption(project.id, 'projectAssets', 'sort', 'modified')).toBe('modified');

    expect(repository.getOption(project.id, 'projectAssets', 'sort')).toBe('modified');
    expect(repository.getPageOptions(project.id, 'projectAssets')).toEqual({ sort: 'modified' });
    expect(repository.hasPageOptions(project.id, 'projectAssets')).toBe(true);
  });

  it('upserts the composite-key row instead of duplicating it', () => {
    const project = createProject(projectRepository, 'Project One');

    repository.setOption(project.id, 'projectAssets', 'sort', 'filename');
    repository.setOption(project.id, 'projectAssets', 'sort', 'modified');

    expect(repository.getOption(project.id, 'projectAssets', 'sort')).toBe('modified');
    expect(db.prepare(`
      SELECT COUNT(*) AS count
      FROM project_page_defaults
      WHERE project_id = ? AND page_key = ? AND option_key = ?
    `).get(project.id, 'projectAssets', 'sort').count).toBe(1);
  });

  it('reads, inserts, and upserts active scope by project and page', () => {
    const projectOne = createProject(projectRepository, 'Project One');
    const projectTwo = createProject(projectRepository, 'Project Two');

    expect(repository.getPageScope(projectOne.id, 'projectAssets')).toBeUndefined();
    expect(repository.setPageScope(projectOne.id, 'projectAssets', 'global')).toBe('global');

    db.prepare(`
      UPDATE project_page_default_scopes
      SET updated_at = '2000-01-01 00:00:00'
      WHERE project_id = ? AND page_key = ?
    `).run(projectOne.id, 'projectAssets');

    expect(repository.setPageScope(projectOne.id, 'projectAssets', 'project')).toBe('project');
    expect(repository.setPageScope(projectOne.id, 'assetViewer', 'global')).toBe('global');
    expect(repository.setPageScope(projectTwo.id, 'projectAssets', 'global')).toBe('global');

    expect(repository.getPageScope(projectOne.id, 'projectAssets')).toBe('project');
    expect(repository.getPageScope(projectOne.id, 'assetViewer')).toBe('global');
    expect(repository.getPageScope(projectTwo.id, 'projectAssets')).toBe('global');
    expect(db.prepare(`
      SELECT COUNT(*)
      FROM project_page_default_scopes
      WHERE project_id = ? AND page_key = ?
    `).pluck().get(projectOne.id, 'projectAssets')).toBe(1);
    expect(db.prepare(`
      SELECT updated_at
      FROM project_page_default_scopes
      WHERE project_id = ? AND page_key = ?
    `).pluck().get(projectOne.id, 'projectAssets')).not.toBe('2000-01-01 00:00:00');
  });

  it('keeps active scope isolated from page options and global storage', () => {
    const project = createProject(projectRepository, 'Project One');
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('page_defaults.project_assets.sort', 'modified')").run();
    repository.setOption(project.id, 'projectAssets', 'sort', 'size');

    repository.setPageScope(project.id, 'projectAssets', 'global');

    expect(repository.getOption(project.id, 'projectAssets', 'sort')).toBe('size');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck()
      .get('page_defaults.project_assets.sort')).toBe('modified');
  });

  it('rejects unsupported active scopes without persisting them', () => {
    const project = createProject(projectRepository, 'Project One');

    expect(() => repository.setPageScope(project.id, 'projectAssets', 'retired'))
      .toThrow(/CHECK constraint failed/i);
    expect(repository.getPageScope(project.id, 'projectAssets')).toBeUndefined();
  });

  it('isolates options by project and page key', () => {
    const projectOne = createProject(projectRepository, 'Project One');
    const projectTwo = createProject(projectRepository, 'Project Two');

    repository.setOption(projectOne.id, 'projectAssets', 'sort', 'filename');
    repository.setOption(projectTwo.id, 'projectAssets', 'sort', 'modified');
    repository.setOption(projectOne.id, 'assetViewer', 'sort', 'size');

    expect(repository.getPageOptions(projectOne.id, 'projectAssets')).toEqual({ sort: 'filename' });
    expect(repository.getPageOptions(projectTwo.id, 'projectAssets')).toEqual({ sort: 'modified' });
    expect(repository.getPageOptions(projectOne.id, 'assetViewer')).toEqual({ sort: 'size' });
  });

  it('lists exact project-scoped references for one saved option value', () => {
    const projectOne = createProject(projectRepository, 'Project One');
    const projectTwo = createProject(projectRepository, 'Project Two');
    repository.setOption(projectOne.id, 'projects', 'status', 'custom');
    repository.setOption(projectTwo.id, 'projects', 'status', 'custom');
    repository.setOption(projectOne.id, 'projects', 'projectType', 'custom');

    expect(repository.listOptionValueReferences('projects', 'status', 'custom')).toEqual([
      { project_id: projectOne.id },
      { project_id: projectTwo.id },
    ]);
    expect(repository.listOptionValueReferences('projects', 'projectType', 'custom')).toEqual([
      { project_id: projectOne.id },
    ]);
  });

  it('deletes only one project and page option set', () => {
    const projectOne = createProject(projectRepository, 'Project One');
    const projectTwo = createProject(projectRepository, 'Project Two');

    repository.setOption(projectOne.id, 'projectAssets', 'sort', 'filename');
    repository.setOption(projectOne.id, 'assetViewer', 'sort', 'size');
    repository.setOption(projectTwo.id, 'projectAssets', 'sort', 'modified');

    expect(repository.deletePageOptions(projectOne.id, 'projectAssets')).toBe(true);
    expect(repository.deletePageOptions(projectOne.id, 'projectAssets')).toBe(false);

    expect(repository.getPageOptions(projectOne.id, 'projectAssets')).toEqual({});
    expect(repository.getPageOptions(projectOne.id, 'assetViewer')).toEqual({ sort: 'size' });
    expect(repository.getPageOptions(projectTwo.id, 'projectAssets')).toEqual({ sort: 'modified' });
  });

  it('cascades page-default rows when a project is deleted', () => {
    const project = createProject(projectRepository, 'Project One');

    repository.setOption(project.id, 'projectAssets', 'sort', 'filename');
    repository.setPageScope(project.id, 'projectAssets', 'project');
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);

    expect(db.prepare('SELECT COUNT(*) AS count FROM project_page_defaults WHERE project_id = ?').get(project.id).count)
      .toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_page_default_scopes WHERE project_id = ?')
      .get(project.id).count).toBe(0);
  });

  it('backfills active scopes without changing existing defaults, projects, or sequence state', () => {
    closeDatabase(db);
    db = undefined;

    const dbPath = path.join(tmpDir, 'pre-page-scope.db');
    const legacyDir = createPrePageScopeMigrationsDir(tmpDir);
    db = openDatabase(dbPath);
    runMigrations(db, legacyDir);
    projectRepository = createProjectRepository(db);
    const projectWithRows = createProject(projectRepository, 'Project With Rows');
    const projectWithoutRows = createProject(projectRepository, 'Project Without Rows');
    const archivedProject = createProject(projectRepository, 'Archived Project');
    db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(archivedProject.id);
    db.prepare(`
      INSERT INTO project_page_defaults (project_id, page_key, option_key, value)
      VALUES (?, 'projectAssets', 'sort', 'size'),
             (?, 'projectAssets', 'view', 'list')
    `).run(projectWithRows.id, archivedProject.id);
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES ('page_defaults.project_assets.sort', 'modified')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    const sequenceBefore = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'projects'").pluck().get();

    runMigrations(db, MIGRATIONS_DIR);
    repository = createProjectPageDefaultRepository(db);

    expect(db.pragma("table_info('project_page_default_scopes')").map(({ name }) => name)).toEqual([
      'project_id',
      'page_key',
      'active_scope',
      'created_at',
      'updated_at',
    ]);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").pluck()
      .get('project_page_default_scopes')).toMatch(/active_scope IN \('global', 'project'\)/);
    expect(repository.getPageScope(projectWithRows.id, 'projectAssets')).toBe('project');
    expect(repository.getPageScope(projectWithoutRows.id, 'projectAssets')).toBe('global');
    expect(repository.getPageScope(archivedProject.id, 'projectAssets')).toBe('project');
    expect(db.prepare('SELECT COUNT(*) FROM project_page_default_scopes').pluck().get()).toBe(3);
    expect(repository.getOption(projectWithRows.id, 'projectAssets', 'sort')).toBe('size');
    expect(repository.getOption(archivedProject.id, 'projectAssets', 'view')).toBe('list');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck()
      .get('page_defaults.project_assets.sort')).toBe('modified');
    expect(db.prepare('SELECT id FROM projects ORDER BY id').pluck().all()).toEqual([
      projectWithRows.id,
      projectWithoutRows.id,
      archivedProject.id,
    ]);
    expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'projects'").pluck().get())
      .toBe(sequenceBefore);
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?').pluck()
      .get(PAGE_SCOPE_MIGRATION_FILENAME)).toBe(PAGE_SCOPE_MIGRATION_FILENAME);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    runMigrations(db, MIGRATIONS_DIR);
    expect(db.prepare('SELECT COUNT(*) FROM project_page_default_scopes').pluck().get()).toBe(3);
  });

  it('applies to an existing installation without altering global defaults', () => {
    closeDatabase(db);
    db = undefined;

    const dbPath = path.join(tmpDir, 'existing.db');
    const legacyDir = createPreProjectPageDefaultsMigrationsDir(tmpDir);
    db = openDatabase(dbPath);
    runMigrations(db, legacyDir);
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES ('page_defaults.projects.view', 'list'),
             ('asset_browser.default_category', 'exports')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get('page_defaults.projects.view'))
      .toBe('list');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get('asset_browser.default_category'))
      .toBe('exports');
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?').pluck()
      .get(PROJECT_DEFAULTS_MIGRATION_FILENAME)).toBe(PROJECT_DEFAULTS_MIGRATION_FILENAME);
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_page_defaults').get().count).toBe(0);
  });
});
