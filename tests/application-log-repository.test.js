import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import {
  APPLICATION_LOG_DEFAULT_PAGE_SIZE,
  APPLICATION_LOG_EXPORT_MAX_RECORDS,
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

  function exportIds(filters) {
    const ids = [];
    const result = repository.forEachExportRecord(filters, (row) => ids.push(row.id));
    expect(result.count).toBe(ids.length);
    return ids;
  }

  function insertFixtures(count, level = 'info') {
    const insert = db.prepare(`
      INSERT INTO application_logs (
        occurred_at_ms, level, kind, subsystem, event, message, project_id, correlation_id, context_json
      ) VALUES (?, ?, 'runtime', 'test', 'fixture', 'fixture', NULL, NULL, '{}')
    `);
    db.transaction(() => {
      for (let index = 0; index < count; index += 1) insert.run(index, level);
    })();
  }

  it('exports every matching record across UI pages with combined filters and tied timestamps', () => {
    for (let index = 0; index < 130; index += 1) {
      repository.insert(log({
        occurredAtMs: 10_000 + Math.floor(index / 3),
        level: index % 2 === 0 ? 'warn' : 'info',
        subsystem: index % 5 === 0 ? 'processing' : 'http',
        event: `event-${index}`,
      }));
    }
    repository.insert(log({ occurredAtMs: 9_999, level: 'warn', event: 'too-old' }));

    const filters = { level: 'warn', kind: 'runtime', subsystem: 'http', sinceMs: 10_000 };
    const paged = [1, 2, 3].flatMap((page) => repository.findPage({ ...filters, page, pageSize: 25 }));
    const ids = exportIds(filters);

    expect(paged.length).toBeGreaterThan(25);
    expect(ids).toEqual(paged.map((row) => row.id));
    expect(ids).toHaveLength(repository.count(filters));
    expect(exportIds({}).length).toBe(131);

    const rows = [];
    repository.forEachExportRecord({}, (row, index) => rows.push({ row, index }));
    rows.forEach(({ index }, position) => expect(index).toBe(position));
    for (let index = 1; index < rows.length; index += 1) {
      const [previous, current] = [rows[index - 1].row, rows[index].row];
      expect(previous.occurred_at_ms > current.occurred_at_ms
        || (previous.occurred_at_ms === current.occurred_at_ms && previous.id > current.id)).toBe(true);
    }
    expect(rows[0].row).toEqual(repository.findPage()[0]);
  });

  it('exports exactly the record limit and rejects one more without visiting rows', () => {
    insertFixtures(APPLICATION_LOG_EXPORT_MAX_RECORDS);
    repository.insert(log({ level: 'debug', event: 'filtered-out' }));

    let visited = 0;
    expect(repository.forEachExportRecord({ level: 'info' }, () => { visited += 1; }))
      .toEqual({ count: APPLICATION_LOG_EXPORT_MAX_RECORDS });
    expect(visited).toBe(APPLICATION_LOG_EXPORT_MAX_RECORDS);

    repository.insert(log({ level: 'info', event: 'one-too-many' }));
    visited = 0;
    expect(() => repository.forEachExportRecord({ level: 'info' }, () => { visited += 1; }))
      .toThrow(expect.objectContaining({ code: 'EXPORT_LIMIT_EXCEEDED' }));
    expect(visited).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  it('releases the read transaction and statement when the visitor fails', () => {
    repository.insert(log({ event: 'one' }));
    repository.insert(log({ event: 'two' }));

    expect(() => repository.forEachExportRecord({}, () => {
      throw new Error('formatter failed');
    })).toThrow('formatter failed');
    expect(db.inTransaction).toBe(false);
    expect(repository.insert(log({ event: 'three' }))).toEqual(expect.objectContaining({ event: 'three' }));
    expect(exportIds({})).toHaveLength(3);
    expect(() => repository.forEachExportRecord({}, null)).toThrow(ApplicationLogRepositoryError);
    expect(() => repository.forEachExportRecord({ sinceMs: -1 }, () => {})).toThrow(ApplicationLogRepositoryError);
  });

  it('reads one snapshot while another connection inserts during the export', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-log-export-'));
    const databasePath = path.join(tmpDir, 'logs.sqlite');
    const reader = openDatabase(databasePath);
    let writer;
    try {
      runMigrations(reader, MIGRATIONS_DIR);
      writer = openDatabase(databasePath);
      const readerRepository = createApplicationLogRepository(reader);
      const writerRepository = createApplicationLogRepository(writer);
      for (let index = 0; index < 5; index += 1) {
        writerRepository.insert(log({ occurredAtMs: 1_000 + index, event: `before-${index}` }));
      }

      const events = [];
      const result = readerRepository.forEachExportRecord({}, (row, index) => {
        events.push(row.event);
        if (index === 0) {
          writerRepository.insert(log({ occurredAtMs: 5_000, event: 'concurrent-newest' }));
          writerRepository.insert(log({ occurredAtMs: 1_002, event: 'concurrent-tied' }));
        }
      });

      expect(result).toEqual({ count: 5 });
      expect(events).toEqual(['before-4', 'before-3', 'before-2', 'before-1', 'before-0']);
      expect(readerRepository.count()).toBe(7);
    } finally {
      if (writer) closeDatabase(writer);
      closeDatabase(reader);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
