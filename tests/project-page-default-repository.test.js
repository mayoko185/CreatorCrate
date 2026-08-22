import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createProjectPageDefaultRepository } from '../src/data/project-page-default-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_FILENAME = '024_add_project_page_defaults.sql';

function createProject(repository, title) {
  return repository.create({
    title,
    slug: title.toLowerCase().replaceAll(' ', '-'),
    description: '',
    notes: '',
    status: 'tbd',
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
    if (filename.endsWith('.sql') && filename !== MIGRATION_FILENAME) {
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
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);

    expect(db.prepare('SELECT COUNT(*) AS count FROM project_page_defaults WHERE project_id = ?').get(project.id).count)
      .toBe(0);
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
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?').pluck().get(MIGRATION_FILENAME))
      .toBe(MIGRATION_FILENAME);
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_page_defaults').get().count).toBe(0);
  });
});
