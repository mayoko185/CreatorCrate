import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { STATUSES } from '../src/data/project-repository.js';
import {
  createDashboardDefaultsService,
  DASHBOARD_DEFAULTS_KEY,
  DASHBOARD_SECTION_REGISTRY,
} from '../src/services/dashboard-defaults-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const CANONICAL_IDS = DASHBOARD_SECTION_REGISTRY.map(({ id }) => id);

describe('dashboard defaults service', () => {
  let tmpDir;
  let db;
  let repository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-defaults-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createAppMetaRepository(db);
    service = createDashboardDefaultsService({ appMetaRepository: repository });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses all nine canonical sections with visible 8-item defaults when nothing is stored', () => {
    expect(service.getDefaults()).toEqual({
      version: 1,
      order: CANONICAL_IDS,
      sections: Object.fromEntries(CANONICAL_IDS.map((id) => [id, { visible: true, itemCount: 8 }])),
    });
  });

  it.each([
    ['malformed JSON', '{invalid'],
    ['unsupported version', JSON.stringify({ version: 2, order: [], sections: {} })],
    ['non-object document', JSON.stringify([])],
  ])('falls back to complete canonical defaults for %s without rewriting storage', (_label, storedValue) => {
    repository.setValue(DASHBOARD_DEFAULTS_KEY, storedValue);

    expect(service.getDefaults().order).toEqual(CANONICAL_IDS);
    expect(service.getDefaults().sections).toEqual(
      Object.fromEntries(CANONICAL_IDS.map((id) => [id, { visible: true, itemCount: 8 }]))
    );
    expect(repository.getValue(DASHBOARD_DEFAULTS_KEY)).toBe(storedValue);
  });

  it('normalizes duplicate, stale, and missing order entries without changing persisted data', () => {
    const stored = {
      version: 1,
      order: ['status:ready', 'overdue', 'status:ready', 'removed-section'],
      sections: {},
    };
    const storedValue = JSON.stringify(stored);
    repository.setValue(DASHBOARD_DEFAULTS_KEY, storedValue);

    expect(service.getDefaults().order).toEqual([
      'status:ready',
      'overdue',
      ...CANONICAL_IDS.filter((id) => !['status:ready', 'overdue'].includes(id)),
    ]);
    expect(repository.getValue(DASHBOARD_DEFAULTS_KEY)).toBe(storedValue);
  });

  it('fills missing settings and normalizes visibility and item counts independently', () => {
    repository.setValue(DASHBOARD_DEFAULTS_KEY, JSON.stringify({
      version: 1,
      order: CANONICAL_IDS,
      sections: {
        overdue: { visible: false, itemCount: 1 },
        upcoming: { visible: true, itemCount: 25 },
        'recently-updated': { visible: 'yes', itemCount: 0 },
        'status:tbd': { visible: null, itemCount: 26 },
        'status:planned': { visible: true, itemCount: 3.5 },
        'status:ready': { visible: true, itemCount: 12 },
      },
    }));

    const defaults = service.getDefaults();
    expect(defaults.sections.overdue).toEqual({ visible: false, itemCount: 1 });
    expect(defaults.sections.upcoming).toEqual({ visible: true, itemCount: 25 });
    expect(defaults.sections['recently-updated']).toEqual({ visible: true, itemCount: 8 });
    expect(defaults.sections['status:tbd']).toEqual({ visible: true, itemCount: 8 });
    expect(defaults.sections['status:planned']).toEqual({ visible: true, itemCount: 8 });
    expect(defaults.sections['status:ready']).toEqual({ visible: true, itemCount: 12 });
    expect(defaults.sections['status:completed']).toEqual({ visible: true, itemCount: 8 });
  });

  it('saves a complete normalized document while preserving independent per-section item counts', () => {
    const saved = service.saveDefaults({
      version: 1,
      order: ['status:ready', 'overdue'],
      sections: {
        overdue: { visible: false, itemCount: 5 },
        'status:ready': { visible: true, itemCount: 12 },
      },
    });

    expect(saved.order).toEqual([
      'status:ready',
      'overdue',
      ...CANONICAL_IDS.filter((id) => !['status:ready', 'overdue'].includes(id)),
    ]);
    expect(saved.sections.overdue).toEqual({ visible: false, itemCount: 5 });
    expect(saved.sections['status:ready']).toEqual({ visible: true, itemCount: 12 });
    expect(saved.sections.upcoming).toEqual({ visible: true, itemCount: 8 });
    expect(JSON.parse(repository.getValue(DASHBOARD_DEFAULTS_KEY))).toEqual(saved);
  });

  it('adds a complete default section for an unmapped future canonical status', async () => {
    const futureStatus = 'quality-review';
    STATUSES.push(futureStatus);

    try {
      const futureStatusModule = await import('../src/services/dashboard-defaults-service.js?future-status');
      const futureSectionId = `status:${futureStatus}`;

      expect(futureStatusModule.DASHBOARD_SECTION_REGISTRY.at(-1)).toEqual({
        id: futureSectionId,
        label: 'Quality review',
        status: futureStatus,
      });
      expect(futureStatusModule.normalizeDashboardDefaults(undefined)).toEqual({
        version: 1,
        order: [...CANONICAL_IDS, futureSectionId],
        sections: {
          ...Object.fromEntries(CANONICAL_IDS.map((id) => [id, { visible: true, itemCount: 8 }])),
          [futureSectionId]: { visible: true, itemCount: 8 },
        },
      });
    } finally {
      STATUSES.pop();
    }
  });

  it('uses the canonical project status order and Dashboard labels', () => {
    expect(DASHBOARD_SECTION_REGISTRY).toEqual([
      { id: 'overdue', label: 'Overdue' },
      { id: 'upcoming', label: 'Upcoming releases' },
      { id: 'recently-updated', label: 'Recently updated projects' },
      { id: 'status:tbd', label: 'TBD', status: 'tbd' },
      { id: 'status:planned', label: 'Planned', status: 'planned' },
      { id: 'status:in-progress', label: 'In progress', status: 'in-progress' },
      { id: 'status:ready', label: 'Ready', status: 'ready' },
      { id: 'status:completed', label: 'Completed', status: 'completed' },
      { id: 'status:archived', label: 'Archived', status: 'archived' },
    ]);
  });
});
