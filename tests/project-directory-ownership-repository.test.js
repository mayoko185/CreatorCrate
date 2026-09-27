import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import {
  createProjectDirectoryOwnershipRepository,
  InvalidProjectOwnershipError,
  ProjectOwnershipTokenConflictError,
} from '../src/data/project-directory-ownership-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const TOKEN_X = '0'.repeat(63) + '1';
const TOKEN_Y = '0'.repeat(63) + '2';
const TOKEN_Z = '0'.repeat(63) + '3';

describe('project directory ownership repository', () => {
  let tmpDir;
  let db;
  let repo;
  let projectA;
  let projectB;

  function insertProject(slug) {
    return Number(db.prepare(`
      INSERT INTO projects (title, slug, status, project_type) VALUES (?, ?, 'tbd', 'images')
    `).run(slug, slug).lastInsertRowid);
  }

  function rows() {
    return db.prepare('SELECT project_id, token, state FROM project_directory_ownership ORDER BY project_id').all();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-ownership-repo-'));
    db = openDatabase(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db, MIGRATIONS_DIR);
    repo = createProjectDirectoryOwnershipRepository(db);
    projectA = insertProject('project-a');
    projectB = insertProject('project-b');
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds nothing for an unbound project', () => {
    expect(repo.findByProjectId(projectA)).toBeNull();
    expect(repo.listPending()).toEqual([]);
  });

  it('creates a pending binding and reads it back', () => {
    expect(repo.createPending(projectA, TOKEN_X)).toEqual({ projectId: projectA, token: TOKEN_X, state: 'pending' });
    expect(repo.findByProjectId(projectA)).toEqual({ projectId: projectA, token: TOKEN_X, state: 'pending' });
    expect(repo.listPending()).toEqual([{ projectId: projectA, token: TOKEN_X, state: 'pending' }]);
  });

  it('rejects invalid input before persistence', () => {
    for (const token of ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}g`, null, 42]) {
      expect(() => repo.createPending(projectA, token)).toThrow(InvalidProjectOwnershipError);
    }
    expect(() => repo.createPending(0, TOKEN_X)).toThrow(InvalidProjectOwnershipError);
    expect(() => repo.markBound(projectA, 'bad')).toThrow(InvalidProjectOwnershipError);
    expect(() => repo.deletePending(projectA, 'bad')).toThrow(InvalidProjectOwnershipError);
    expect(rows()).toEqual([]);
  });

  it('never replaces an existing binding for the same project', () => {
    repo.createPending(projectA, TOKEN_X);
    expect(repo.createPending(projectA, TOKEN_Y)).toBeNull();
    repo.markBound(projectA, TOKEN_X);
    expect(repo.createPending(projectA, TOKEN_Z)).toBeNull();
    expect(repo.findByProjectId(projectA)).toEqual({ projectId: projectA, token: TOKEN_X, state: 'bound' });
  });

  it('rejects a token already used by another project', () => {
    repo.createPending(projectA, TOKEN_X);
    expect(() => repo.createPending(projectB, TOKEN_X)).toThrow(ProjectOwnershipTokenConflictError);
    expect(repo.findByProjectId(projectB)).toBeNull();
  });

  it('requires an existing project', () => {
    expect(() => repo.createPending(projectB + 100, TOKEN_X)).toThrow(/FOREIGN KEY/);
  });

  it('binds only the matching pending token', () => {
    repo.createPending(projectA, TOKEN_X);
    repo.createPending(projectB, TOKEN_Y);

    expect(repo.markBound(projectA, TOKEN_Y)).toBe(false);
    expect(repo.markBound(projectA, TOKEN_Z)).toBe(false);
    expect(repo.findByProjectId(projectA).state).toBe('pending');

    expect(repo.markBound(projectA, TOKEN_X)).toBe(true);
    expect(repo.findByProjectId(projectA)).toEqual({ projectId: projectA, token: TOKEN_X, state: 'bound' });
    expect(repo.findByProjectId(projectB).state).toBe('pending');
    expect(repo.listPending()).toEqual([{ projectId: projectB, token: TOKEN_Y, state: 'pending' }]);
  });

  it('does not rebind an already-bound row', () => {
    repo.createPending(projectA, TOKEN_X);
    expect(repo.markBound(projectA, TOKEN_X)).toBe(true);
    expect(repo.markBound(projectA, TOKEN_X)).toBe(false);
    expect(repo.markBound(projectA, TOKEN_Y)).toBe(false);
    expect(repo.findByProjectId(projectA)).toEqual({ projectId: projectA, token: TOKEN_X, state: 'bound' });
  });

  it('removes only the exactly matching pending row', () => {
    repo.createPending(projectA, TOKEN_X);
    repo.createPending(projectB, TOKEN_Y);

    expect(repo.deletePending(projectA, TOKEN_Y)).toBe(false);
    expect(repo.deletePending(projectB, TOKEN_X)).toBe(false);
    expect(rows()).toHaveLength(2);

    expect(repo.deletePending(projectA, TOKEN_X)).toBe(true);
    expect(repo.findByProjectId(projectA)).toBeNull();
    expect(repo.findByProjectId(projectB)).toEqual({ projectId: projectB, token: TOKEN_Y, state: 'pending' });
    expect(repo.deletePending(projectA, TOKEN_X)).toBe(false);
  });

  it('never removes a bound row', () => {
    repo.createPending(projectA, TOKEN_X);
    repo.markBound(projectA, TOKEN_X);
    expect(repo.deletePending(projectA, TOKEN_X)).toBe(false);
    expect(repo.findByProjectId(projectA)).toEqual({ projectId: projectA, token: TOKEN_X, state: 'bound' });
  });

  it('drops the binding with its project', () => {
    repo.createPending(projectA, TOKEN_X);
    repo.markBound(projectA, TOKEN_X);
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectA);
    expect(repo.findByProjectId(projectA)).toBeNull();
    expect(rows()).toEqual([]);
  });
});
