import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createTagRepository } from '../src/data/tag-repository.js';
import {
  createProjectTagService,
  ProjectNotFoundError,
  ProjectTagValidationError,
  TagNotFoundError,
} from '../src/services/project-tag-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MISSING_ID = 999999;
const INVALID_IDS = [
  undefined,
  null,
  0,
  -1,
  1.5,
  '1',
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
];

describe('project tag service', () => {
  let tmpDir;
  let db;
  let projectRepository;
  let tagRepository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-tag-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectRepository = createProjectRepository(db);
    tagRepository = createTagRepository(db);
    service = createProjectTagService({ tagRepository, projectRepository });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(title = 'Project Tag Service Project') {
    return Number(db.prepare(`
      INSERT INTO projects (
        title, slug, description, notes, status,
        planned_date, published_date, patreon_url
      ) VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)
    `).run(title, title.toLowerCase().replaceAll(' ', '-')).lastInsertRowid);
  }

  function createTag(displayName, normalizedName = displayName.toLowerCase()) {
    return tagRepository.create({ displayName, normalizedName });
  }

  function assignmentRows(projectId) {
    return db.prepare(`
      SELECT project_id, tag_id, created_at
      FROM project_tags
      WHERE project_id = ?
      ORDER BY tag_id
    `).all(projectId);
  }

  function snapshot(projectId) {
    return {
      project: projectRepository.findById(projectId),
      tags: tagRepository.list(),
      assignments: assignmentRows(projectId),
    };
  }

  it('returns an empty list for an existing project with no tags', () => {
    const projectId = createProject();

    expect(service.listProjectTags(projectId)).toEqual([]);
  });

  it('preserves repository ordering when listing project tags', () => {
    const projectId = createProject();
    const beta = createTag('beta', 'beta-z');
    const upperBeta = createTag('Beta', 'beta-a');
    const alpha = createTag('Alpha');

    for (const tag of [beta, alpha, upperBeta]) {
      tagRepository.assignToProject(projectId, tag.id);
    }

    expect(service.listProjectTags(projectId)).toEqual([alpha, upperBeta, beta]);
  });

  it('throws ProjectNotFoundError when listing a missing project', () => {
    expect(() => service.listProjectTags(MISSING_ID)).toThrow(ProjectNotFoundError);
  });

  it('assigns a tag once and returns false for a duplicate assignment', () => {
    const projectId = createProject();
    const tag = createTag('Character Art');
    const projectBefore = projectRepository.findById(projectId);
    const tagsBefore = tagRepository.list();

    expect(service.assignTagToProject(projectId, tag.id)).toBe(true);
    expect(service.assignTagToProject(projectId, tag.id)).toBe(false);
    expect(assignmentRows(projectId)).toEqual([{
      project_id: projectId,
      tag_id: tag.id,
      created_at: expect.any(String),
    }]);
    expect(projectRepository.findById(projectId)).toEqual(projectBefore);
    expect(tagRepository.list()).toEqual(tagsBefore);
  });

  it.each(INVALID_IDS)('rejects invalid project ID %p before assignment mutation', (projectId) => {
    const existingProjectId = createProject();
    const tag = createTag('Existing');
    const before = snapshot(existingProjectId);
    const assign = vi.spyOn(tagRepository, 'assignToProject');
    const remove = vi.spyOn(tagRepository, 'removeFromProject');
    const replace = vi.spyOn(tagRepository, 'replaceForProject');

    expect(() => service.listProjectTags(projectId)).toThrow(ProjectTagValidationError);
    expect(() => service.assignTagToProject(projectId, tag.id)).toThrow(ProjectTagValidationError);
    expect(() => service.removeTagFromProject(projectId, tag.id)).toThrow(ProjectTagValidationError);
    expect(() => service.replaceProjectTags(projectId, [tag.id])).toThrow(ProjectTagValidationError);

    expect(assign).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(existingProjectId)).toEqual(before);
  });

  it.each(INVALID_IDS)('rejects invalid tag ID %p before assignment mutation', (tagId) => {
    const projectId = createProject();
    const before = snapshot(projectId);
    const assign = vi.spyOn(tagRepository, 'assignToProject');
    const remove = vi.spyOn(tagRepository, 'removeFromProject');
    const replace = vi.spyOn(tagRepository, 'replaceForProject');

    expect(() => service.assignTagToProject(projectId, tagId)).toThrow(ProjectTagValidationError);
    expect(() => service.removeTagFromProject(projectId, tagId)).toThrow(ProjectTagValidationError);
    expect(() => service.replaceProjectTags(projectId, [tagId])).toThrow(ProjectTagValidationError);

    expect(assign).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(projectId)).toEqual(before);
  });

  it('rejects a missing project for every method without changing existing data', () => {
    const existingProjectId = createProject();
    const tag = createTag('Existing');
    tagRepository.assignToProject(existingProjectId, tag.id);
    const before = snapshot(existingProjectId);
    const assign = vi.spyOn(tagRepository, 'assignToProject');
    const remove = vi.spyOn(tagRepository, 'removeFromProject');
    const replace = vi.spyOn(tagRepository, 'replaceForProject');

    expect(() => service.listProjectTags(MISSING_ID)).toThrow(ProjectNotFoundError);
    expect(() => service.assignTagToProject(MISSING_ID, tag.id)).toThrow(ProjectNotFoundError);
    expect(() => service.removeTagFromProject(MISSING_ID, tag.id)).toThrow(ProjectNotFoundError);
    expect(() => service.replaceProjectTags(MISSING_ID, [tag.id])).toThrow(ProjectNotFoundError);

    expect(assign).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(existingProjectId)).toEqual(before);
  });

  it('rejects a missing tag for assignment, removal, and replacement without changes', () => {
    const projectId = createProject();
    const existingTag = createTag('Existing');
    tagRepository.assignToProject(projectId, existingTag.id);
    const before = snapshot(projectId);
    const assign = vi.spyOn(tagRepository, 'assignToProject');
    const remove = vi.spyOn(tagRepository, 'removeFromProject');
    const replace = vi.spyOn(tagRepository, 'replaceForProject');

    expect(() => service.assignTagToProject(projectId, MISSING_ID)).toThrow(TagNotFoundError);
    expect(() => service.removeTagFromProject(projectId, MISSING_ID)).toThrow(TagNotFoundError);
    expect(() => service.replaceProjectTags(projectId, [existingTag.id, MISSING_ID]))
      .toThrow(TagNotFoundError);

    expect(assign).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(projectId)).toEqual(before);
  });

  it('removes an assigned tag and returns false when it is not assigned', () => {
    const projectId = createProject();
    const tag = createTag('Temporary');
    tagRepository.assignToProject(projectId, tag.id);
    const projectBefore = projectRepository.findById(projectId);
    const tagsBefore = tagRepository.list();

    expect(service.removeTagFromProject(projectId, tag.id)).toBe(true);
    expect(service.removeTagFromProject(projectId, tag.id)).toBe(false);
    expect(service.listProjectTags(projectId)).toEqual([]);
    expect(projectRepository.findById(projectId)).toEqual(projectBefore);
    expect(tagRepository.list()).toEqual(tagsBefore);
  });

  it('replaces assignments with the exact requested set and keeps project and tag rows unchanged', () => {
    const projectId = createProject();
    const unchanged = createTag('Unchanged');
    const removed = createTag('Removed');
    const added = createTag('Added');
    tagRepository.assignToProject(projectId, unchanged.id);
    tagRepository.assignToProject(projectId, removed.id);
    const projectBefore = projectRepository.findById(projectId);
    const tagsBefore = tagRepository.list();

    expect(service.replaceProjectTags(projectId, [unchanged.id, added.id])).toEqual([added, unchanged]);
    expect(service.listProjectTags(projectId)).toEqual([added, unchanged]);
    expect(assignmentRows(projectId).map(({ tag_id: tagId }) => tagId))
      .toEqual([added.id, unchanged.id].sort((a, b) => a - b));
    expect(projectRepository.findById(projectId)).toEqual(projectBefore);
    expect(tagRepository.list()).toEqual(tagsBefore);
    expect(tagRepository.findById(removed.id)).toEqual(removed);
  });

  it('deduplicates replacement IDs before calling the atomic repository method', () => {
    const projectId = createProject();
    const first = createTag('First');
    const second = createTag('Second');
    const replace = vi.spyOn(tagRepository, 'replaceForProject');

    service.replaceProjectTags(projectId, [first.id, first.id, second.id, second.id]);

    expect(replace).toHaveBeenCalledWith(projectId, [first.id, second.id]);
    expect(assignmentRows(projectId).map(({ tag_id: tagId }) => tagId))
      .toEqual([first.id, second.id]);
  });

  it('removes every assignment when replacement receives an empty array', () => {
    const projectId = createProject();
    const first = createTag('First');
    const second = createTag('Second');
    tagRepository.assignToProject(projectId, first.id);
    tagRepository.assignToProject(projectId, second.id);
    const before = snapshot(projectId);

    expect(service.replaceProjectTags(projectId, [])).toEqual([]);
    expect(service.listProjectTags(projectId)).toEqual([]);
    expect(assignmentRows(projectId)).toEqual([]);
    expect(projectRepository.findById(projectId)).toEqual(before.project);
    expect(tagRepository.list()).toEqual(before.tags);
  });

  it('rejects non-array replacement input before mutation', () => {
    const projectId = createProject();
    const tag = createTag('Existing');
    tagRepository.assignToProject(projectId, tag.id);
    const before = snapshot(projectId);
    const replace = vi.spyOn(tagRepository, 'replaceForProject');

    expect(() => service.replaceProjectTags(projectId, null)).toThrow(ProjectTagValidationError);
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(projectId)).toEqual(before);
  });

  it('does not partially change assignments when one replacement ID is malformed', () => {
    const projectId = createProject();
    const first = createTag('First');
    const second = createTag('Second');
    tagRepository.assignToProject(projectId, first.id);
    tagRepository.assignToProject(projectId, second.id);
    const before = snapshot(projectId);
    const replace = vi.spyOn(tagRepository, 'replaceForProject');

    expect(() => service.replaceProjectTags(projectId, [second.id, 'malformed']))
      .toThrow(ProjectTagValidationError);
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(projectId)).toEqual(before);
  });
});
