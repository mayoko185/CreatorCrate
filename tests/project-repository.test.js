import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('project repository', () => {
  let tmpDir;
  let dbPath;
  let db;
  let repository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-projects-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    repository = createProjectRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a project with explicitly supplied status and priority', () => {
    const project = repository.create(sampleProject({ title: 'Sunset Sketch' }));
    expect(project.title).toBe('Sunset Sketch');
    expect(project.status).toBe('tbd');
    expect(project.priority).toBe('normal');
    expect(project.slug).toBe('sunset-sketch');
    expect(project.archived_at).toBeNull();
  });

  it('finds a project by id', () => {
    const created = repository.create(sampleProject({ title: 'Portrait Study' }));
    const found = repository.findById(created.id);
    expect(found).toBeTruthy();
    expect(found.id).toBe(created.id);
  });

  it('updates a project', () => {
    const created = repository.create(sampleProject({ title: 'Landscape' }));
    const updated = repository.update(created.id, {
      ...sampleProject({ title: 'Mountain Landscape' }),
      status: 'in-progress',
      priority: 'high',
    });
    expect(updated.title).toBe('Mountain Landscape');
    expect(updated.status).toBe('in-progress');
  });

  it('archives a project and preserves the record', () => {
    const created = repository.create(sampleProject({ title: 'Old Work' }));
    const archived = repository.archive(created.id);
    expect(archived.status).toBe('archived');
    expect(archived.archived_at).toBeTruthy();
    const found = repository.findById(created.id);
    expect(found.archived_at).toBeTruthy();
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
    repository.create(sampleProject({ title: 'C', status: 'published' }));

    const planned = repository.list({ status: 'planned' });
    expect(planned.rows).toHaveLength(1);
    expect(planned.rows[0].title).toBe('A');

    const all = repository.list();
    expect(all.rows).toHaveLength(3);
  });

  it('searches title, description, and notes', () => {
    repository.create(sampleProject({ title: 'Alpha', description: 'first project', notes: '' }));
    repository.create(sampleProject({ title: 'Beta', description: '', notes: 'alpha notes here' }));
    repository.create(sampleProject({ title: 'Gamma', description: 'unrelated', notes: '' }));

    const result = repository.list({ search: 'alpha' });
    expect(result.rows.map((p) => p.title)).toEqual(['Alpha', 'Beta']);
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

  it('counts projects by status', () => {
    repository.create(sampleProject({ title: 'TBD 1' }));
    repository.create(sampleProject({ title: 'TBD 2' }));
    repository.create(sampleProject({ title: 'Planned', status: 'planned' }));
    const archived = repository.create(sampleProject({ title: 'Archived' }));
    repository.archive(archived.id);

    const counts = repository.countByStatus();
    expect(counts.tbd).toBe(2);
    expect(counts.planned).toBe(1);
    expect(counts.archived).toBe(1);
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
    repository.archive(archived.id);

    const list = repository.list({ status: 'archived', includeArchived: true });
    expect(list.rows.map((p) => p.id)).toContain(archived.id);
    expect(list.rows.map((p) => p.id)).not.toContain(active.id);
  });

  describe('project_dir', () => {
    it('defaults to null for new projects', () => {
      const project = repository.create(sampleProject({ title: 'Dir Test' }));
      expect(project.project_dir).toBeNull();
    });

    it('can set and retrieve project_dir', () => {
      const project = repository.create(sampleProject({ title: 'Dir Update' }));
      const updated = repository.setProjectDir(project.id, 'active/dir-update');
      expect(updated.project_dir).toBe('active/dir-update');

      const found = repository.findById(project.id);
      expect(found.project_dir).toBe('active/dir-update');
    });

    it('can set project_dir to null', () => {
      const project = repository.create(sampleProject({ title: 'Dir Nullable' }));
      repository.setProjectDir(project.id, 'tbd/some-path');
      const cleared = repository.setProjectDir(project.id, null);
      expect(cleared.project_dir).toBeNull();
    });

    it('finds projects without project_dir', () => {
      const withDir = repository.create(sampleProject({ title: 'Has Dir' }));
      repository.setProjectDir(withDir.id, 'tbd/has-dir');

      const without = repository.create(sampleProject({ title: 'No Dir' }));

      const nullRows = repository.findByProjectDirNull();
      const ids = nullRows.map((p) => p.id);
      expect(ids).not.toContain(withDir.id);
      expect(ids).toContain(without.id);
    });

    it('returns empty array when all projects have project_dir', () => {
      const p1 = repository.create(sampleProject({ title: 'A' }));
      const p2 = repository.create(sampleProject({ title: 'B' }));
      repository.setProjectDir(p1.id, 'tbd/a');
      repository.setProjectDir(p2.id, 'tbd/b');

      expect(repository.findByProjectDirNull()).toHaveLength(0);
    });
  });

  describe('findCalendarRange', () => {
    it('includes tbd/planned/in-progress/ready projects using planned_date', () => {
      for (const status of ['tbd', 'planned', 'in-progress', 'ready']) {
        repository.create(sampleProject({ title: `P-${status}`, status, plannedDate: '2025-06-10' }));
      }
      const rows = repository.findCalendarRange('2025-06-01', '2025-07-01');
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.effective_date).toBe('2025-06-10');
      }
    });

    it('published project uses published_date', () => {
      repository.create(sampleProject({
        title: 'Published',
        status: 'published',
        plannedDate: '2025-06-01',
        publishedDate: '2025-06-20',
      }));
      const rows = repository.findCalendarRange('2025-06-01', '2025-07-01');
      expect(rows).toHaveLength(1);
      expect(rows[0].effective_date).toBe('2025-06-20');
    });

    it('published project without published_date falls back to planned_date', () => {
      repository.create(sampleProject({
        title: 'Published No Pub Date',
        status: 'published',
        plannedDate: '2025-06-15',
        publishedDate: null,
      }));
      const rows = repository.findCalendarRange('2025-06-01', '2025-07-01');
      expect(rows).toHaveLength(1);
      expect(rows[0].effective_date).toBe('2025-06-15');
    });

    it('excludes archived projects (archived_at set)', () => {
      const p = repository.create(sampleProject({ title: 'Archived', plannedDate: '2025-06-05' }));
      repository.archive(p.id);
      const rows = repository.findCalendarRange('2025-06-01', '2025-07-01');
      expect(rows).toHaveLength(0);
    });

    it('excludes archived-status projects even when archived_at is null', () => {
      // status can be 'archived' while archived_at is still null — e.g. a
      // transient state between marking status and setting the timestamp.
      // The calendar query must not rely on archived_at alone.
      repository.create(sampleProject({
        title: 'Archived Status Only', status: 'archived', plannedDate: '2025-06-05',
      }));
      const rows = repository.findCalendarRange('2025-06-01', '2025-07-01');
      expect(rows).toHaveLength(0);
    });

    it('excludes projects with no applicable date', () => {
      repository.create(sampleProject({ title: 'No Date', plannedDate: null, publishedDate: null }));
      const rows = repository.findCalendarRange('2025-06-01', '2025-07-01');
      expect(rows).toHaveLength(0);
    });

    it('respects month boundaries (inclusive start, exclusive end)', () => {
      repository.create(sampleProject({ title: 'First Day', plannedDate: '2025-06-01' }));
      repository.create(sampleProject({ title: 'Last Day', plannedDate: '2025-06-30' }));
      repository.create(sampleProject({ title: 'Next Month', plannedDate: '2025-07-01' }));
      repository.create(sampleProject({ title: 'Prev Month', plannedDate: '2025-05-31' }));
      const rows = repository.findCalendarRange('2025-06-01', '2025-07-01');
      const titles = rows.map((r) => r.title).sort();
      expect(titles).toEqual(['First Day', 'Last Day']);
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
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
    ...overrides,
  };
}
