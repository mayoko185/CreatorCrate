import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import {
  createDashboardDefaultsService,
  DASHBOARD_DEFAULTS_KEY,
  getDashboardSectionDefaultSorting,
} from '../src/services/dashboard-defaults-service.js';
import { createTestProjectOptionCatalogueService } from './helpers/project-option-catalogue.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const defaultSection = () => ({
  visible: true,
  itemCount: 8,
  ...getDashboardSectionDefaultSorting(),
});

describe('dashboard defaults service', () => {
  let tmpDir;
  let db;
  let repository;
  let catalogueService;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-defaults-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createAppMetaRepository(db);
    catalogueService = createTestProjectOptionCatalogueService(db);
    service = createDashboardDefaultsService({
      appMetaRepository: repository,
      projectOptionCatalogueService: catalogueService,
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function sectionIds() {
    return service.getSectionRegistry().map(({ id }) => id);
  }

  it('uses live catalogue order and appends the independent system Archived section', () => {
    expect(catalogueService.getStatusCatalogue().map(({ value }) => value)).not.toContain('archived');
    expect(service.getSectionRegistry()).toEqual([
      { id: 'recently-updated', label: 'Recently updated projects' },
      { id: 'status:tbd', label: 'Tbd', status: 'tbd' },
      { id: 'status:planned', label: 'Planned', status: 'planned' },
      { id: 'status:in-progress', label: 'In Progress', status: 'in-progress' },
      { id: 'status:ready', label: 'Ready', status: 'ready' },
      { id: 'status:completed', label: 'Completed', status: 'completed' },
      { id: 'status:archived', label: 'Archived', status: 'archived' },
    ]);
    const ids = sectionIds();
    expect(service.getDefaults()).toEqual({
      version: 1,
      order: ids,
      sections: Object.fromEntries(ids.map((id) => [id, defaultSection()])),
    });
  });

  it.each([
    ['malformed JSON', '{invalid'],
    ['unsupported version', JSON.stringify({ version: 2, order: [], sections: {} })],
    ['non-object document', JSON.stringify([])],
  ])('falls back to complete current defaults for %s without rewriting storage', (_label, storedValue) => {
    repository.setValue(DASHBOARD_DEFAULTS_KEY, storedValue);

    expect(service.getDefaults().order).toEqual(sectionIds());
    expect(repository.getValue(DASHBOARD_DEFAULTS_KEY)).toBe(storedValue);
  });

  it('normalizes duplicate, malformed, stale, and missing entries with existing field fallbacks', () => {
    repository.setValue(DASHBOARD_DEFAULTS_KEY, JSON.stringify({
      version: 1,
      order: [
        'status:ready', 'status:archived', 12, 'status:ready', 'status:archived', 'removed-section',
      ],
      sections: {
        'status:ready': { visible: false, itemCount: 12, sort: 'title', order: 'asc' },
        'status:archived': { visible: false, itemCount: 7, sort: 'created', order: 'asc' },
        'status:planned': { visible: 'yes', itemCount: 0, sort: 'unsupported', order: 'sideways' },
        'removed-section': { visible: false, itemCount: 2, sort: 'title', order: 'asc' },
      },
    }));

    const defaults = service.getDefaults();
    expect(defaults.order).toEqual([
      'status:ready',
      'status:archived',
      ...sectionIds().filter((id) => !['status:ready', 'status:archived'].includes(id)),
    ]);
    expect(defaults.order.filter((id) => id === 'status:archived')).toHaveLength(1);
    expect(defaults.sections).not.toHaveProperty('removed-section');
    expect(defaults.sections['status:ready']).toEqual({
      visible: false, itemCount: 12, sort: 'title', order: 'asc',
    });
    expect(defaults.sections['status:planned']).toEqual(defaultSection());
    expect(defaults.sections['status:archived']).toEqual({
      visible: false, itemCount: 7, sort: 'created', order: 'asc',
    });
  });

  it('observes add, delete, and reorder mutations live while preserving saved Dashboard order', () => {
    catalogueService.addOption('status', { name: 'Quality Review', color: '#123456' });
    catalogueService.addOption('status', { name: 'Waiting Client', color: '#654321' });

    const added = service.getConfiguration();
    expect(added.sectionRegistry.slice(-3, -1)).toEqual([
      { id: 'status:quality-review', label: 'Quality Review', status: 'quality-review' },
      { id: 'status:waiting-client', label: 'Waiting Client', status: 'waiting-client' },
    ]);
    service.saveDefaults({
      ...added.defaults,
      order: [
        'status:waiting-client',
        'status:quality-review',
        ...added.defaults.order.filter((id) => ![
          'status:waiting-client', 'status:quality-review',
        ].includes(id)),
      ],
    });

    const catalogueOrder = catalogueService.getStatusCatalogue().map(({ value }) => value);
    catalogueService.reorderOptions('status', [
      'quality-review',
      ...catalogueOrder.filter((value) => value !== 'quality-review'),
    ]);
    catalogueService.addOption('status', { name: 'Needs Polish', color: '#ABCDEF' });

    const afterReorderAndAdd = service.getDefaults();
    expect(afterReorderAndAdd.order.slice(0, 2)).toEqual([
      'status:waiting-client',
      'status:quality-review',
    ]);
    expect(afterReorderAndAdd.order.at(-1)).toBe('status:needs-polish');

    catalogueService.deleteOption('status', 'quality-review');
    const afterDelete = service.getDefaults();
    expect(afterDelete.order).not.toContain('status:quality-review');
    expect(afterDelete.sections).not.toHaveProperty('status:quality-review');
    expect(afterDelete.order.slice(0, 1)).toEqual(['status:waiting-client']);
  });

  it('appends multiple new statuses in their current catalogue order', () => {
    const initial = service.getDefaults();
    service.saveDefaults({ ...initial, order: [...initial.order].reverse() });

    catalogueService.addOption('status', { name: 'First Custom', color: '#112233' });
    catalogueService.addOption('status', { name: 'Second Custom', color: '#334455' });

    expect(service.getDefaults().order).toEqual([
      ...[...initial.order].reverse(),
      'status:first-custom',
      'status:second-custom',
    ]);
  });

  it('saves a complete normalized document with independent section settings', () => {
    const ids = sectionIds();
    const saved = service.saveDefaults({
      version: 1,
      order: ['status:ready', 'recently-updated'],
      sections: {
        'recently-updated': { visible: false, itemCount: 5 },
        'status:ready': { visible: true, itemCount: 12, sort: 'title', order: 'asc' },
      },
    });

    expect(saved.order).toEqual([
      'status:ready',
      'recently-updated',
      ...ids.filter((id) => !['status:ready', 'recently-updated'].includes(id)),
    ]);
    expect(saved.sections['recently-updated']).toEqual({
      ...defaultSection(), visible: false, itemCount: 5,
    });
    expect(saved.sections['status:ready']).toEqual({
      visible: true, itemCount: 12, sort: 'title', order: 'asc',
    });
    expect(JSON.parse(repository.getValue(DASHBOARD_DEFAULTS_KEY))).toEqual(saved);
  });
});
