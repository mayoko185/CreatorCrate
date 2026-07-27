import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import {
  createProjectService,
  ProjectValidationError,
  ProjectNotFoundError,
} from '../src/services/project-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('project service', () => {
  let tmpDir;
  let db;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-service-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    service = createProjectService(db);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a missing title', () => {
    expect(() => service.create(validInput({ title: '' }))).toThrow(ProjectValidationError);
    try {
      service.create(validInput({ title: '' }));
    } catch (err) {
      expect(err.errors.title).toBe('Title is required.');
    }
  });

  it('rejects archived status on create', () => {
    expect(() => service.create(validInput({ status: 'archived' }))).toThrow(ProjectValidationError);
  });

  it('rejects archived status on update', () => {
    const created = service.create(validInput({ title: 'Archive Test' }));
    expect(() => service.update(created.id, validInput({ status: 'archived' }))).toThrow(
      ProjectValidationError
    );
  });

  it('rejects an invalid status', () => {
    expect(() => service.create(validInput({ status: 'banana' }))).toThrow(ProjectValidationError);
  });

  it('rejects an invalid priority', () => {
    expect(() => service.create(validInput({ priority: 'urgent' }))).toThrow(ProjectValidationError);
  });

  it.each([
    { date: 'tomorrow', label: 'non-numeric' },
    { date: '2024-02-30', label: 'invalid February' },
    { date: '2023-02-29', label: 'non-leap year' },
    { date: '2024-04-31', label: 'invalid 30-day month' },
    { date: '2024-13-01', label: 'invalid month' },
    { date: '2024-00-10', label: 'zero month' },
    { date: '2024-01-00', label: 'zero day' },
  ])('rejects impossible date $label ($date)', ({ date }) => {
    expect(() => service.create(validInput({ plannedDate: date }))).toThrow(ProjectValidationError);
    expect(() => service.create(validInput({ publishedDate: date }))).toThrow(
      ProjectValidationError
    );
  });

  it.each([
    { date: '2024-01-01', label: 'year start' },
    { date: '2024-12-31', label: 'year end' },
    { date: '2024-02-29', label: 'leap day' },
  ])('accepts valid date $label ($date)', ({ date }) => {
    const project = service.create(validInput({ plannedDate: date, publishedDate: date }));
    expect(project.planned_date).toBe(date);
    expect(project.published_date).toBe(date);
  });

  it('accepts empty optional dates', () => {
    const project = service.create(validInput({ plannedDate: null, publishedDate: '' }));
    expect(project.planned_date).toBeNull();
    expect(project.published_date).toBeNull();
  });

  it('rejects an invalid Patreon URL', () => {
    expect(() => service.create(validInput({ patreonUrl: 'http://patreon.com/foo' }))).toThrow(
      ProjectValidationError
    );
    expect(() => service.create(validInput({ patreonUrl: 'https://example.com' }))).toThrow(
      ProjectValidationError
    );
  });

  it('generates a slug from the title', () => {
    const project = service.create(validInput({ title: 'Hello World!' }));
    expect(project.slug).toBe('hello-world');
  });

  it('handles slug collisions by rejecting the title', () => {
    service.create(validInput({ title: 'Collision' }));
    expect(() => service.create(validInput({ title: 'Collision' }))).toThrow(
      ProjectValidationError
    );
  });

  it('translates a database slug unique-constraint error into a validation error', () => {
    service.create(validInput({ title: 'Collision' }));
    const realSlugExists = service.repository.slugExists;
    service.repository.slugExists = () => false;
    try {
      expect(() => service.create(validInput({ title: 'Collision' }))).toThrow(
        ProjectValidationError
      );
      try {
        service.create(validInput({ title: 'Collision' }));
      } catch (err) {
        expect(err.errors.title).toBe('A project with this title already exists.');
      }
    } finally {
      service.repository.slugExists = realSlugExists;
    }
  });

  it('does not treat the same project as a slug collision on update', () => {
    const created = service.create(validInput({ title: 'Unchanged Title' }));
    const updated = service.update(created.id, validInput({ title: 'Unchanged Title' }));
    expect(updated.id).toBe(created.id);
  });

  it('throws ProjectNotFoundError when updating a missing project', () => {
    expect(() => service.update(999, validInput())).toThrow(ProjectNotFoundError);
  });

  it('archives an existing project', () => {
    const created = service.create(validInput());
    const archived = service.archive(created.id);
    expect(archived.status).toBe('archived');
    expect(archived.archived_at).toBeTruthy();
  });

  it('throws ProjectNotFoundError when archiving a missing project', () => {
    expect(() => service.archive(999)).toThrow(ProjectNotFoundError);
  });
});

function validInput(overrides = {}) {
  return {
    title: 'Valid Project',
    description: 'A description',
    notes: 'Some notes',
    status: 'tbd',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
    ...overrides,
  };
}
