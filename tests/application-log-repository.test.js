import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import {
  APPLICATION_LOG_DEFAULT_PAGE_SIZE,
  APPLICATION_LOG_MAX_RECORDS,
  APPLICATION_LOG_MAX_PAGE_SIZE,
  ApplicationLogRepositoryError,
  createApplicationLogRepository,
} from '../src/data/application-log-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

describe('application log repository', () => {
  let db;
  let repository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    repository = createApplicationLogRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
  });

  function log(overrides = {}) {
    return {
      occurredAtMs: 1_000,
      level: 'info',
      kind: 'runtime',
      subsystem: 'http',
      event: 'request.completed',
      message: 'Request completed.',
      context: { requestId: 'abc' },
      ...overrides,
    };
  }

  it('inserts records and retrieves newest-first by timestamp then ID', () => {
    const oldest = repository.insert(log({ occurredAtMs: 1_000, event: 'oldest' }));
    const firstSameTime = repository.insert(log({ occurredAtMs: 2_000, event: 'first' }));
    const newestSameTime = repository.insert(log({ occurredAtMs: 2_000, event: 'newest' }));

    expect(repository.findPage().map((row) => row.id)).toEqual([
      newestSameTime.id,
      firstSameTime.id,
      oldest.id,
    ]);
  });

  it('bounds and deterministically orders distinct filter metadata', () => {
    for (let index = 149; index >= 0; index -= 1) {
      const value = String(index).padStart(3, '0');
      repository.insert(log({
        level: `level-${value}`,
        kind: `kind-${value}`,
        subsystem: `subsystem-${value}`,
        event: `event-${value}`,
      }));
    }

    const expected = Array.from({ length: 100 }, (_, index) => String(index).padStart(3, '0'));
    const first = repository.listFilterOptions();

    expect(first.levels).toEqual(expected.map((value) => `level-${value}`));
    expect(first.kinds).toEqual(expected.map((value) => `kind-${value}`));
    expect(first.subsystems).toEqual(expected.map((value) => `subsystem-${value}`));
    expect(repository.listFilterOptions()).toEqual(first);
  });

  it('filters exactly by level, kind, subsystem, and every combination', () => {
    const first = repository.insert(log({ level: 'warn', kind: 'runtime', subsystem: 'http', event: 'first' }));
    const second = repository.insert(log({ level: 'warn', kind: 'job', subsystem: 'processing', event: 'second' }));
    const third = repository.insert(log({ level: 'error', kind: 'runtime', subsystem: 'processing', event: 'third' }));

    expect(repository.findPage({ level: 'warn' }).map((row) => row.id)).toEqual([second.id, first.id]);
    expect(repository.findPage({ kind: 'runtime' }).map((row) => row.id)).toEqual([third.id, first.id]);
    expect(repository.findPage({ subsystem: 'processing' }).map((row) => row.id)).toEqual([third.id, second.id]);
    expect(repository.findPage({ level: 'warn', kind: 'job', subsystem: 'processing' }).map((row) => row.id))
      .toEqual([second.id]);
  });

  it('uses page one and 50 records by default, while capping page size at 100', () => {
    for (let index = 0; index < 105; index += 1) {
      repository.insert(log({ occurredAtMs: index, event: `event-${index}` }));
    }

    expect(repository.findPage()).toHaveLength(APPLICATION_LOG_DEFAULT_PAGE_SIZE);
    expect(repository.findPage({ pageSize: 10, page: 2 }).map((row) => row.event))
      .toEqual(['event-94', 'event-93', 'event-92', 'event-91', 'event-90', 'event-89', 'event-88', 'event-87', 'event-86', 'event-85']);
    expect(repository.findPage({ pageSize: APPLICATION_LOG_MAX_PAGE_SIZE + 1 })).toHaveLength(APPLICATION_LOG_MAX_PAGE_SIZE);
    expect(repository.findPage({ pageSize: 200, page: 2 })).toHaveLength(5);
  });

  it('round-trips nullable project and correlation values', () => {
    const inserted = repository.insert(log({ projectId: null, correlationId: null, context: {} }));

    expect(repository.findPage()).toEqual([expect.objectContaining({
      id: inserted.id,
      project_id: null,
      correlation_id: null,
      context_json: '{}',
    })]);
  });

  it('clears all logs transactionally and returns the deleted count', () => {
    repository.insert(log({ event: 'one' }));
    repository.insert(log({ event: 'two' }));

    expect(repository.clear()).toBe(2);
    expect(repository.findPage()).toEqual([]);
    expect(repository.clear()).toBe(0);
  });

  it('prunes records older than 90 days but preserves records at the cutoff', () => {
    const nowMs = 200 * DAY_MS;
    const expired = repository.insert(log({ occurredAtMs: nowMs - 90 * DAY_MS - 1, event: 'expired' }));
    const cutoff = repository.insert(log({ occurredAtMs: nowMs - 90 * DAY_MS, event: 'cutoff' }));
    const recent = repository.insert(log({ occurredAtMs: nowMs - DAY_MS, event: 'recent' }));

    expect(repository.prune({ nowMs })).toEqual({ ageDeleted: 1, countDeleted: 0, deletedCount: 1 });
    expect(repository.findPage().map((row) => row.id)).toEqual([recent.id, cutoff.id]);
    expect(repository.findPage().map((row) => row.id)).not.toContain(expired.id);
  });

  it('prunes the oldest rows to enforce the 50,000-record cap', () => {
    const nowMs = 200 * DAY_MS;
    const insert = db.prepare(`
      INSERT INTO application_logs (
        occurred_at_ms, level, kind, subsystem, event, message, project_id, correlation_id, context_json
      ) VALUES (?, 'info', 'runtime', 'test', 'fixture', 'fixture', NULL, NULL, '{}')
    `);
    db.transaction(() => {
      for (let index = 0; index <= APPLICATION_LOG_MAX_RECORDS; index += 1) {
        insert.run(nowMs - DAY_MS + index);
      }
    })();

    expect(repository.prune({ nowMs })).toEqual({ ageDeleted: 0, countDeleted: 1, deletedCount: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM application_logs').get().count).toBe(APPLICATION_LOG_MAX_RECORDS);
    expect(db.prepare('SELECT MIN(id) AS id FROM application_logs').get().id).toBe(2);
  });

  it('rejects malformed or over-limit persisted values before insertion', () => {
    expect(() => repository.insert(log({ occurredAtMs: -1 }))).toThrow(ApplicationLogRepositoryError);
    expect(() => repository.insert(log({ message: 'x'.repeat(4_097) }))).toThrow(ApplicationLogRepositoryError);
    expect(() => repository.insert(log({ context: 'not-an-object' }))).toThrow(ApplicationLogRepositoryError);
    expect(() => repository.insert(log({ context: { payload: 'x'.repeat(16_384) } }))).toThrow(ApplicationLogRepositoryError);
    expect(() => repository.findPage({ page: 0 })).toThrow(ApplicationLogRepositoryError);
    expect(() => repository.findPage({ pageSize: 0 })).toThrow(ApplicationLogRepositoryError);
    const insertOversizedContext = db.prepare(`
      INSERT INTO application_logs (
        occurred_at_ms, level, kind, subsystem, event, message, context_json
      ) VALUES (1, 'info', 'runtime', 'test', 'fixture', 'fixture', ?)
    `);
    expect(() => insertOversizedContext.run('x'.repeat(16_385))).toThrow(/CHECK constraint failed/i);
  });

  it('retains historical logs after their project is deleted', () => {
    const projects = createProjectRepository(db);
    const project = projects.create({
      title: 'Deleted project',
      slug: 'deleted-project',
      description: '',
      notes: '',
      status: 'tbd',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });
    const inserted = repository.insert(log({ projectId: project.id, correlationId: 'correlation-1' }));

    expect(projects.deleteById(project.id)).toBe(true);
    expect(repository.findPage()).toEqual([expect.objectContaining({
      id: inserted.id,
      project_id: project.id,
      correlation_id: 'correlation-1',
    })]);
  });

  it('filters by an inclusive lower timestamp bound with other filters and counts the same range', () => {
    const before = repository.insert(log({ occurredAtMs: 9_999, level: 'warn', kind: 'runtime', subsystem: 'http', event: 'before' }));
    const boundary = repository.insert(log({ occurredAtMs: 10_000, level: 'warn', kind: 'runtime', subsystem: 'http', event: 'boundary' }));
    const after = repository.insert(log({ occurredAtMs: 10_001, level: 'error', kind: 'runtime', subsystem: 'http', event: 'after' }));

    expect(repository.findPage({ sinceMs: 10_000 }).map((row) => row.id)).toEqual([after.id, boundary.id]);
    expect(repository.findPage({ sinceMs: 10_000, level: 'warn' }).map((row) => row.id)).toEqual([boundary.id]);
    expect(repository.count({ sinceMs: 10_000, subsystem: 'http' })).toBe(2);
    expect(() => repository.findPage({ sinceMs: -1 })).toThrow(ApplicationLogRepositoryError);
    expect(() => repository.findPage({ sinceMs: '10000' })).toThrow(ApplicationLogRepositoryError);
    expect(repository.findPage({ sinceMs: 10_000 }).map((row) => row.id)).not.toContain(before.id);
  });
});
