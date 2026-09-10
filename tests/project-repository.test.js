import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository, DASHBOARD_SORTS } from '../src/data/project-repository.js';
import { createTagRepository } from '../src/data/tag-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('project repository', () => {
  let tmpDir;
  let dbPath;
  let db;
  let repository;
  let tagRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-projects-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    repository = createProjectRepository(db);
    tagRepository = createTagRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a project without obsolete date fields', () => {
    const project = repository.create(sampleProject({ title: 'Sunset Sketch' }));
    expect(project.title).toBe('Sunset Sketch');
    expect(project.status).toBe('tbd');
    expect(project.project_type).toBe('images');
    expect(project).not.toHaveProperty('priority');
    expect(project).not.toHaveProperty('planned_date');
    expect(project).not.toHaveProperty('published_date');
    expect(project.slug).toBe('sunset-sketch');
    expect(project.archived_at).toBeNull();
  });

  it('finds a project by id', () => {
    const created = repository.create(sampleProject({ title: 'Portrait Study' }));
    const found = repository.findById(created.id);
    expect(found).toBeTruthy();
    expect(found.id).toBe(created.id);
    expect(found.project_type).toBe('images');
  });

  it('requires explicit Status and Project Type values at the create boundary', () => {
    expect(() => repository.create(sampleProject({ status: undefined })))
      .toThrow('Project creation requires an explicit status.');
    expect(() => repository.create(sampleProject({ projectType: undefined })))
      .toThrow('Project creation requires an explicit projectType.');
  });

  it('updates a project without obsolete date fields', () => {
    const created = repository.create(sampleProject({ title: 'Landscape', projectType: 'comic' }));
    const unchangedType = repository.update(created.id, {
      ...sampleProject({ title: 'Landscape', projectType: undefined }),
      status: 'in-progress',
    });
    expect(unchangedType.project_type).toBe('comic');

    const updated = repository.update(created.id, {
      ...sampleProject({ title: 'Mountain Landscape' }),
      status: 'in-progress',
      projectType: 'animation',
    });
    expect(updated.title).toBe('Mountain Landscape');
    expect(updated.status).toBe('in-progress');
    expect(updated.project_type).toBe('animation');
    expect(updated).not.toHaveProperty('priority');
    expect(updated).not.toHaveProperty('planned_date');
    expect(updated).not.toHaveProperty('published_date');
  });

  it('updates only active projects at the repository boundary', () => {
    const active = repository.create(sampleProject({ title: 'Active Project' }));
    const timestampArchived = repository.create(sampleProject({ title: 'Timestamp Archived' }));
    const legacyStatusArchived = repository.create(sampleProject({ title: 'Legacy Status Archived' }));
    repository.archive(timestampArchived.id);
    db.prepare("UPDATE projects SET status = 'archived', archived_at = NULL WHERE id = ?")
      .run(legacyStatusArchived.id);

    const activeResult = repository.update(active.id, sampleProject({ title: 'Active Updated' }));
    const timestampArchivedResult = repository.update(
      timestampArchived.id,
      sampleProject({ title: 'Timestamp Archived Updated' }),
    );
    const legacyStatusArchivedResult = repository.update(
      legacyStatusArchived.id,
      sampleProject({ title: 'Legacy Status Archived Updated' }),
    );

    expect(activeResult.title).toBe('Active Updated');
    expect(repository.findById(active.id).title).toBe('Active Updated');
    expect(timestampArchivedResult).toBeUndefined();
    expect(repository.findById(timestampArchived.id).title).toBe('Timestamp Archived');
    expect(legacyStatusArchivedResult).toBeUndefined();
    expect(repository.findById(legacyStatusArchived.id)).toMatchObject({
      title: 'Legacy Status Archived',
      status: 'archived',
      archived_at: null,
    });
  });

  it('archives a project and preserves the record', () => {
    const created = repository.create(sampleProject({ title: 'Old Work' }));
    const archived = repository.archive(created.id);
    expect(archived.status).toBe('archived');
    expect(archived.archived_at).toBeTruthy();
    const found = repository.findById(created.id);
    expect(found.archived_at).toBeTruthy();
  });

  it('creates and updates a project with the completed status', () => {
    const created = repository.create(sampleProject({ title: 'Finished Piece', status: 'completed' }));
    expect(created.status).toBe('completed');
    const found = repository.findById(created.id);
    expect(found.status).toBe('completed');

    const other = repository.create(sampleProject({ title: 'Transitioning' }));
    const updated = repository.update(other.id, {
      ...sampleProject({ title: 'Transitioning' }),
      status: 'completed',
    });
    expect(updated.status).toBe('completed');
  });

  it('detects slug conflicts', () => {
    repository.create(sampleProject({ title: 'Conflict Test' }));
    expect(repository.slugExists('conflict-test')).toBe(true);
    expect(repository.slugExists('conflict-test', { excludeId: 1 })).toBe(false);
    expect(repository.slugExists('unused')).toBe(false);
  });

  it('filters by status', () => {
    repository.create(sampleProject({ title: 'A', status: 'planned' }));
    repository.create(sampleProject({ title: 'B', status: 'ready' }));
    repository.create(sampleProject({ title: 'C', status: 'tbd' }));
    repository.create(sampleProject({ title: 'D', status: 'completed' }));

    const planned = repository.list({ status: 'planned' });
    expect(planned.rows).toHaveLength(1);
    expect(planned.rows[0].title).toBe('A');

    const completed = repository.list({ status: 'completed' });
    expect(completed.rows).toHaveLength(1);
    expect(completed.rows[0].title).toBe('D');

    const all = repository.list();
    expect(all.rows).toHaveLength(4);
  });

  it('filters by multiple statuses while retaining archived selection semantics', () => {
    const planned = repository.create(sampleProject({ title: 'Planned', status: 'planned' }));
    const ready = repository.create(sampleProject({ title: 'Ready', status: 'ready' }));
    repository.create(sampleProject({ title: 'TBD', status: 'tbd' }));
    const archived = repository.create(sampleProject({ title: 'Archived' }));
    repository.archive(archived.id);

    const active = repository.list({
      statuses: ['ready', 'planned', 'ready'],
      sortBy: 'title',
      order: 'asc',
    });
    expect(active.rows.map((project) => project.id)).toEqual([planned.id, ready.id]);

    const combined = repository.list({
      statuses: ['archived', 'planned'],
      includeArchived: true,
      sortBy: 'title',
      order: 'asc',
    });
    expect(combined.rows.map((project) => project.title)).toEqual(['Archived', 'Planned']);
  });

  it('filters by Project Type with OR semantics and composes it with status', () => {
    const images = repository.create(sampleProject({ title: 'Images', status: 'planned', projectType: 'images' }));
    const comic = repository.create(sampleProject({ title: 'Comic', status: 'planned', projectType: 'comic' }));
    const animation = repository.create(sampleProject({ title: 'Animation', status: 'ready', projectType: 'animation' }));
    const wallpaper = repository.create(sampleProject({ title: 'Wallpaper', status: 'ready', projectType: 'wallpaper' }));

    for (const [projectType, expected] of [
      ['images', images],
      ['comic', comic],
      ['animation', animation],
      ['wallpaper', wallpaper],
    ]) {
      expect(repository.list({ projectType }).rows.map((project) => project.id)).toEqual([expected.id]);
    }

    const multiple = repository.list({ projectTypes: ['wallpaper', 'comic', 'invalid'], sortBy: 'title', order: 'asc' });
    expect(multiple.rows.map((project) => project.id)).toEqual([comic.id, wallpaper.id]);

    const combined = repository.list({ projectTypes: ['images', 'comic'], status: 'planned', sortBy: 'title', order: 'asc' });
    expect(combined.rows.map((project) => project.id)).toEqual([comic.id, images.id]);

    const tag = tagRepository.create({ displayName: 'Project Type', normalizedName: 'project-type' });
    db.prepare('UPDATE projects SET description = ? WHERE id = ?').run('type search', images.id);
    tagRepository.assignToProject(images.id, tag.id);
    const composed = repository.list({
      projectTypes: ['images', 'comic'],
      status: 'planned',
      search: 'type search',
      tagId: tag.id,
    });
    expect(composed.rows.map((project) => project.id)).toEqual([images.id]);
  });

  it('searches title, description, and notes', () => {
    repository.create(sampleProject({ title: 'Alpha', description: 'first project', notes: '' }));
    repository.create(sampleProject({ title: 'Beta', description: '', notes: 'alpha notes here' }));
    repository.create(sampleProject({ title: 'Gamma', description: 'unrelated', notes: '' }));

    const result = repository.list({ search: 'alpha' });
    expect(result.rows.map((p) => p.title)).toEqual(['Alpha', 'Beta']);
  });

  it('filters by project tag without duplicate rows or asset-only matches', () => {
    const shared = tagRepository.create({ displayName: 'Shared', normalizedName: 'shared' });
    const additional = tagRepository.create({ displayName: 'Additional', normalizedName: 'additional' });
    const first = repository.create(sampleProject({ title: 'First Tagged' }));
    const second = repository.create(sampleProject({ title: 'Second Tagged' }));
    const assetOnlyProject = repository.create(sampleProject({ title: 'Asset Only Tag' }));
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename)
      VALUES (?, ?, ?)
    `).run(assetOnlyProject.id, 'source/asset-only.png', 'asset-only.png').lastInsertRowid);

    tagRepository.assignToProject(first.id, shared.id);
    tagRepository.assignToProject(first.id, additional.id);
    tagRepository.assignToProject(second.id, shared.id);
    tagRepository.assignToAsset(assetId, shared.id);

    const result = repository.list({ tagId: shared.id, sortBy: 'title', order: 'asc' });

    expect(result.total).toBe(2);
    expect(result.rows.map((project) => project.title)).toEqual(['First Tagged', 'Second Tagged']);
    expect(new Set(result.rows.map((project) => project.id)).size).toBe(result.rows.length);
  });

  it('filters by any selected project tag without matching asset-only assignments', () => {
    const shared = tagRepository.create({ displayName: 'Shared', normalizedName: 'shared' });
    const additional = tagRepository.create({ displayName: 'Additional', normalizedName: 'additional' });
    const sharedProject = repository.create(sampleProject({ title: 'Shared Project' }));
    const additionalProject = repository.create(sampleProject({ title: 'Additional Project' }));
    const assetOnlyProject = repository.create(sampleProject({ title: 'Asset Only Project' }));
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename)
      VALUES (?, ?, ?)
    `).run(assetOnlyProject.id, 'source/asset-only.png', 'asset-only.png').lastInsertRowid);

    tagRepository.assignToProject(sharedProject.id, shared.id);
    tagRepository.assignToProject(additionalProject.id, additional.id);
    tagRepository.assignToAsset(assetId, shared.id);

    const result = repository.list({ tagIds: [additional.id, shared.id], sortBy: 'title', order: 'asc' });

    expect(result.total).toBe(2);
    expect(result.rows.map((project) => project.title)).toEqual(['Additional Project', 'Shared Project']);
    expect(result.rows.map((project) => project.id)).not.toContain(assetOnlyProject.id);
  });

  it('filters by a single project id while excluding other projects', () => {
    const first = repository.create(sampleProject({ title: 'Project Filter First' }));
    const second = repository.create(sampleProject({ title: 'Project Filter Second' }));
    const third = repository.create(sampleProject({ title: 'Project Filter Third' }));

    const result = repository.list({ projectId: second.id, sortBy: 'title', order: 'asc' });

    expect(result.total).toBe(1);
    expect(result.rows.map((project) => project.id)).toEqual([second.id]);
    expect(result.rows.map((project) => project.id)).not.toContain(first.id);
    expect(result.rows.map((project) => project.id)).not.toContain(third.id);
  });

  it('composes project id filter with status, search, and tag predicates', () => {
    const tag = tagRepository.create({ displayName: 'Composed', normalizedName: 'composed' });
    const match = repository.create(sampleProject({
      title: 'Composed Match',
      status: 'planned',
      description: 'find me',
    }));
    const sameProjectWrongStatus = repository.create(sampleProject({
      title: 'Same Project Wrong Status',
      status: 'ready',
    }));
    const wrongProjectRightStatus = repository.create(sampleProject({
      title: 'Wrong Project Right Status',
      status: 'planned',
      description: 'find me',
    }));

    tagRepository.assignToProject(match.id, tag.id);
    tagRepository.assignToProject(sameProjectWrongStatus.id, tag.id);
    tagRepository.assignToProject(wrongProjectRightStatus.id, tag.id);

    const composed = repository.list({
      projectId: match.id,
      status: 'planned',
      search: 'find me',
      tagId: tag.id,
    });

    expect(composed.total).toBe(1);
    expect(composed.rows[0].id).toBe(match.id);
  });

  it('exposes only retained Project sorts and falls back from obsolete date sort keys', () => {
    expect(Object.keys(DASHBOARD_SORTS)).toEqual(['updated', 'created', 'title']);

    const older = repository.create(sampleProject({ title: 'Zulu' }));
    const newer = repository.create(sampleProject({ title: 'Alpha' }));
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run('2025-01-01 00:00:00', older.id);
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run('2025-02-01 00:00:00', newer.id);

    expect(repository.list({ sortBy: 'title', order: 'asc' }).rows.map((project) => project.id))
      .toEqual([newer.id, older.id]);
    for (const obsoleteSort of ['planned', 'published']) {
      expect(repository.list({ sortBy: obsoleteSort, order: 'asc' }).rows.map((project) => project.id))
        .toEqual([older.id, newer.id]);
    }
  });

  it('composes tag, search, status, and archived predicates and stops matching after tag deletion', () => {
    const tag = tagRepository.create({ displayName: 'Needle', normalizedName: 'needle' });
    const planned = repository.create(sampleProject({ title: 'Needle Planned', status: 'planned' }));
    const ready = repository.create(sampleProject({ title: 'Needle Ready', status: 'ready' }));
    repository.create(sampleProject({ title: 'Other Planned', status: 'planned' }));
    const archived = repository.create(sampleProject({ title: 'Needle Archived' }));
    repository.archive(archived.id);

    for (const project of [planned, ready, archived]) {
      tagRepository.assignToProject(project.id, tag.id);
    }

    const composed = repository.list({ tagId: tag.id, search: 'needle', status: 'planned' });
    expect(composed.total).toBe(1);
    expect(composed.rows.map((project) => project.id)).toEqual([planned.id]);

    const defaultList = repository.list({ tagId: tag.id });
    expect(defaultList.total).toBe(2);
    expect(defaultList.rows.map((project) => project.id)).not.toContain(archived.id);

    const archivedList = repository.list({ tagId: tag.id, status: 'archived', includeArchived: true });
    expect(archivedList.total).toBe(1);
    expect(archivedList.rows.map((project) => project.id)).toEqual([archived.id]);

    tagRepository.deleteById(tag.id);
    expect(repository.list({ tagId: tag.id }).total).toBe(0);
  });

  it('treats search wildcards as literal characters', () => {
    repository.create(sampleProject({ title: '100% Done', description: '', notes: '' }));
    repository.create(sampleProject({ title: 'A_B Test', description: '', notes: '' }));
    repository.create(sampleProject({ title: 'Path \\ Name', description: '', notes: '' }));
    repository.create(sampleProject({ title: 'Alpha', description: '', notes: '' }));

    const percent = repository.list({ search: '%' });
    expect(percent.rows).toHaveLength(1);
    expect(percent.rows[0].title).toBe('100% Done');

    const underscore = repository.list({ search: '_' });
    expect(underscore.rows).toHaveLength(1);
    expect(underscore.rows[0].title).toBe('A_B Test');

    const backslash = repository.list({ search: '\\' });
    expect(backslash.rows).toHaveLength(1);
    expect(backslash.rows[0].title).toBe('Path \\ Name');
  });

  it('paginates results', () => {
    for (let i = 1; i <= 30; i += 1) {
      repository.create(sampleProject({ title: `Project ${String(i).padStart(2, '0')}` }));
    }
    const page1 = repository.list({ limit: 25, offset: 0 });
    expect(page1.rows).toHaveLength(25);
    expect(page1.total).toBe(30);

    const page2 = repository.list({ limit: 25, offset: 25 });
    expect(page2.rows).toHaveLength(5);
  });

  it('paginates after applying the tag predicate', () => {
    const tag = tagRepository.create({ displayName: 'Paged', normalizedName: 'paged' });
    const matching = [1, 2, 3].map((number) => repository.create(
      sampleProject({ title: `Tagged ${String(number).padStart(2, '0')}` })
    ));
    repository.create(sampleProject({ title: 'Tagged 02.5 Unmatched' }));
    for (const project of matching) tagRepository.assignToProject(project.id, tag.id);

    const page1 = repository.list({ tagId: tag.id, sortBy: 'title', order: 'asc', limit: 2, offset: 0 });
    const page2 = repository.list({ tagId: tag.id, sortBy: 'title', order: 'asc', limit: 2, offset: 2 });

    expect(page1.total).toBe(3);
    expect(page1.rows.map((project) => project.title)).toEqual(['Tagged 01', 'Tagged 02']);
    expect(page2.total).toBe(3);
    expect(page2.rows.map((project) => project.title)).toEqual(['Tagged 03']);
  });

  it('counts projects by status', () => {
    repository.create(sampleProject({ title: 'TBD 1' }));
    repository.create(sampleProject({ title: 'TBD 2' }));
    repository.create(sampleProject({ title: 'Planned', status: 'planned' }));
    const archived = repository.create(sampleProject({ title: 'Archived' }));
    repository.create(sampleProject({ title: 'Legacy Status Archived', status: 'archived' }));
    repository.archive(archived.id);

    const counts = repository.countByStatus();
    expect(counts.tbd).toBe(2);
    expect(counts.planned).toBe(1);
    expect(counts.archived).toBe(2);
  });

  it('bulk reassigns Status and Type values across all matching Projects', () => {
    const active = repository.create(sampleProject({
      title: 'Active Custom', status: 'custom-status', projectType: 'custom-type',
    }));
    const archived = repository.create(sampleProject({
      title: 'Archived Custom', status: 'custom-status', projectType: 'custom-type',
    }));
    db.prepare(`
      UPDATE projects
      SET archived_at = '2025-01-01 00:00:00',
          description = 'preserve me',
          notes = 'still here',
          updated_at = '2025-01-01 00:00:00'
      WHERE id = ?
    `).run(archived.id);
    const unrelated = repository.create(sampleProject({
      title: 'Unrelated', status: 'ready', projectType: 'comic',
    }));

    expect(repository.countStatusValue('custom-status')).toBe(2);
    expect(repository.countProjectTypeValue('custom-type')).toBe(2);
    expect(repository.reassignStatusValue('custom-status', 'planned')).toBe(2);
    expect(repository.reassignProjectTypeValue('custom-type', 'images')).toBe(2);

    const activeAfter = repository.findById(active.id);
    const archivedAfter = repository.findById(archived.id);
    expect(activeAfter).toMatchObject({ status: 'planned', project_type: 'images' });
    expect(archivedAfter).toMatchObject({
      status: 'planned',
      project_type: 'images',
      archived_at: '2025-01-01 00:00:00',
      description: 'preserve me',
      notes: 'still here',
    });
    expect(archivedAfter.updated_at).not.toBe('2025-01-01 00:00:00');
    expect(repository.findById(unrelated.id)).toMatchObject({ status: 'ready', project_type: 'comic' });
    expect(repository.countStatusValue('custom-status')).toBe(0);
    expect(repository.countProjectTypeValue('custom-type')).toBe(0);
  });

  it('does not include archived projects in default list', () => {
    const active = repository.create(sampleProject({ title: 'Active' }));
    const archived = repository.create(sampleProject({ title: 'Archived' }));
    repository.archive(archived.id);

    const list = repository.list();
    expect(list.rows.map((p) => p.id)).toContain(active.id);
    expect(list.rows.map((p) => p.id)).not.toContain(archived.id);
  });

  it('returns archived projects only when requested', () => {
    const active = repository.create(sampleProject({ title: 'Active' }));
    const archived = repository.create(sampleProject({ title: 'Archived' }));
    const statusOnlyArchived = repository.create(sampleProject({
      title: 'Status Only Archived', status: 'archived',
    }));
    repository.archive(archived.id);

    const list = repository.list({ status: 'archived', includeArchived: true });
    expect(list.rows.map((p) => p.id)).toContain(archived.id);
    expect(list.rows.map((p) => p.id)).toContain(statusOnlyArchived.id);
    expect(list.rows.map((p) => p.id)).not.toContain(active.id);
    expect(repository.list().rows.map((p) => p.id)).not.toContain(statusOnlyArchived.id);
  });

  it('lists complete active asset-filter options with only ID and title', () => {
    const beta = repository.create(sampleProject({ title: 'Beta Option' }));
    const alpha = repository.create(sampleProject({ title: 'Alpha Option' }));
    const archived = repository.create(sampleProject({ title: 'Archived Option' }));
    const statusOnlyArchived = repository.create(sampleProject({
      title: 'Status Only Archived Option',
      status: 'archived',
    }));
    repository.archive(archived.id);

    const options = repository.listActiveAssetFilterOptions();
    expect(options).toEqual([
      { id: alpha.id, title: 'Alpha Option' },
      { id: beta.id, title: 'Beta Option' },
    ]);
    expect(options.map((option) => option.id)).not.toContain(statusOnlyArchived.id);
  });

  describe('searchAssetPickerProjects', () => {
    it('returns bounded, title-only matches including archived projects with deterministic continuation', () => {
      const titles = [
        'Alpha 01', 'Alpha 02', 'Alpha 03', 'Alpha 04', 'Alpha 05', 'Alpha 06',
      ];
      const projects = titles.map((title) => repository.create(sampleProject({ title })));
      const archived = repository.create(sampleProject({ title: 'Alpha Archived' }));
      repository.archive(archived.id);
      repository.create(sampleProject({ title: 'Beta Excluded' }));

      const first = repository.searchAssetPickerProjects({ query: 'ALPHA', limit: 3 });
      const second = repository.searchAssetPickerProjects({
        query: 'ALPHA', limit: 3, cursor: first.nextCursor,
      });
      const third = repository.searchAssetPickerProjects({
        query: 'ALPHA', limit: 3, cursor: second.nextCursor,
      });

      expect(first.rows).toHaveLength(3);
      expect(first.rows.map((project) => Object.keys(project).sort())).toEqual([
        ['id', 'is_archived', 'title'],
        ['id', 'is_archived', 'title'],
        ['id', 'is_archived', 'title'],
      ]);
      expect([...first.rows, ...second.rows, ...third.rows].map((project) => project.id)).toEqual([
        ...projects.map((project) => project.id), archived.id,
      ]);
      expect([...first.rows, ...second.rows, ...third.rows].find((project) => project.id === archived.id))
        .toMatchObject({ is_archived: 1 });
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(second.nextCursor).toEqual(expect.any(String));
      expect(third.nextCursor).toBeNull();
    });

    it('treats title LIKE metacharacters literally and rejects malformed or query-mismatched cursors', () => {
      const percent = repository.create(sampleProject({ title: '100% Complete' }));
      const underscore = repository.create(sampleProject({ title: 'A_B Project' }));
      repository.create(sampleProject({ title: 'Plain Project' }));

      expect(repository.searchAssetPickerProjects({ query: '%', limit: 10 }).rows.map((project) => project.id))
        .toEqual([percent.id]);
      expect(repository.searchAssetPickerProjects({ query: '_', limit: 10 }).rows.map((project) => project.id))
        .toEqual([underscore.id]);
      expect(() => repository.searchAssetPickerProjects({ cursor: 'not-a-cursor' }))
        .toThrow(/Invalid asset picker cursor/);

      const page = repository.searchAssetPickerProjects({ query: 'project', limit: 1 });
      expect(() => repository.searchAssetPickerProjects({
        query: 'plain', limit: 1, cursor: page.nextCursor,
      })).toThrow(/Invalid asset picker cursor/);
    });
  });

  describe('project_dir', () => {
    it('defaults to null for new projects', () => {
      const project = repository.create(sampleProject({ title: 'Dir Test' }));
      expect(project.project_dir).toBeNull();
    });

    it('can set and retrieve project_dir', () => {
      const project = repository.create(sampleProject({ title: 'Dir Update' }));
      const updated = repository.setProjectDir(project.id, '000001-dir-update');
      expect(updated.project_dir).toBe('000001-dir-update');

      const found = repository.findById(project.id);
      expect(found.project_dir).toBe('000001-dir-update');
    });

    it('can set project_dir to null', () => {
      const project = repository.create(sampleProject({ title: 'Dir Nullable' }));
      repository.setProjectDir(project.id, '000001-dir-nullable');
      const cleared = repository.setProjectDir(project.id, null);
      expect(cleared.project_dir).toBeNull();
    });

    it('preserves project_dir across an archive', () => {
      const project = repository.create(sampleProject({ title: 'Dir Archive' }));
      repository.setProjectDir(project.id, '000001-dir-archive');

      const archived = repository.archive(project.id);

      expect(archived.project_dir).toBe('000001-dir-archive');
      expect(repository.findById(project.id).project_dir).toBe('000001-dir-archive');
    });
  });

  describe('findDashboardProjectsByStatus', () => {
    it('returns every requested canonical status with its effective status', () => {
      const projects = ['tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived']
        .map((status) => repository.create(sampleProject({ title: `Status ${status}`, status })));

      const rows = repository.findDashboardProjectsByStatus({
        tbd: 1,
        planned: 1,
        'in-progress': 1,
        ready: 1,
        completed: 1,
        archived: 1,
      });

      for (const project of projects) {
        const matching = rows.filter((row) => row.effective_status === project.status);
        expect(matching.map((row) => row.id)).toEqual([project.id]);
      }
    });

    it('uses effective archived status and excludes archived projects from workflow sections', () => {
      const archivedByTimestamp = repository.create(sampleProject({
        title: 'Timestamp Archived', status: 'planned',
      }));
      db.prepare(`UPDATE projects SET archived_at = ? WHERE id = ?`)
        .run('2025-06-20 12:00:00', archivedByTimestamp.id);
      const archivedByStatus = repository.create(sampleProject({
        title: 'Status Archived', status: 'archived',
      }));
      const activePlanned = repository.create(sampleProject({
        title: 'Active Planned', status: 'planned',
      }));

      const rows = repository.findDashboardProjectsByStatus({ planned: 5, archived: 5 });

      expect(rows.filter((row) => row.effective_status === 'planned').map((row) => row.id))
        .toEqual([activePlanned.id]);
      expect(rows.filter((row) => row.effective_status === 'archived').map((row) => row.id).sort((a, b) => a - b))
        .toEqual([archivedByTimestamp.id, archivedByStatus.id].sort((a, b) => a - b));
    });

    it('orders each status by recently updated and breaks updated_at ties by descending id', () => {
      const older = repository.create(sampleProject({ title: 'Older', status: 'ready' }));
      const tiedLowerId = repository.create(sampleProject({ title: 'Tied Lower ID', status: 'ready' }));
      const tiedHigherId = repository.create(sampleProject({ title: 'Tied Higher ID', status: 'ready' }));
      db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run('2025-06-01 10:00:00', older.id);
      db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run('2025-06-02 10:00:00', tiedLowerId.id);
      db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run('2025-06-02 10:00:00', tiedHigherId.id);

      const rows = repository.findDashboardProjectsByStatus({ ready: 3 });

      expect(rows.map((row) => row.id)).toEqual([tiedHigherId.id, tiedLowerId.id, older.id]);
    });

    it('enforces each requested status limit independently', () => {
      for (const [status, count] of Object.entries({ tbd: 3, planned: 4, ready: 5 })) {
        for (let index = 0; index < count; index += 1) {
          repository.create(sampleProject({ title: `${status}-${index}`, status }));
        }
      }

      const rows = repository.findDashboardProjectsByStatus({ tbd: 1, planned: 2, ready: 3 });

      expect(rows.filter((row) => row.effective_status === 'tbd')).toHaveLength(1);
      expect(rows.filter((row) => row.effective_status === 'planned')).toHaveLength(2);
      expect(rows.filter((row) => row.effective_status === 'ready')).toHaveLength(3);
    });

    it('prepares one statement regardless of requested status count or project count', () => {
      for (let index = 0; index < 30; index += 1) {
        repository.create(sampleProject({ title: `Project ${index}`, status: index % 2 === 0 ? 'tbd' : 'planned' }));
      }
      const prepareSpy = vi.spyOn(db, 'prepare');

      try {
        for (const limits of [
          { tbd: 1 },
          { tbd: 1, planned: 2, 'in-progress': 3, ready: 4, completed: 5, archived: 6 },
          { tbd: 25, planned: 25 },
        ]) {
          prepareSpy.mockClear();
          repository.findDashboardProjectsByStatus(limits);
          expect(prepareSpy).toHaveBeenCalledTimes(1);
        }
      } finally {
        prepareSpy.mockRestore();
      }
    });

    it('returns no rows without a statement for empty, unsupported, or malformed requests', () => {
      const prepareSpy = vi.spyOn(db, 'prepare');

      try {
        for (const limits of [{}, { 'unsupported status!': 3 }, { tbd: 0 }, { planned: 26 }, { ready: '3' }, null]) {
          prepareSpy.mockClear();
          expect(repository.findDashboardProjectsByStatus(limits)).toEqual([]);
          expect(prepareSpy).not.toHaveBeenCalled();
        }
      } finally {
        prepareSpy.mockRestore();
      }
    });
  });

});

function sampleProject(overrides = {}) {
  const title = overrides.title ?? 'Untitled';
  return {
    title,
    slug: slugify(title, { lowercase: true }),
    description: '',
    notes: '',
    status: 'tbd',
    projectType: 'images',
    patreonUrl: null,
    ...overrides,
  };
}
