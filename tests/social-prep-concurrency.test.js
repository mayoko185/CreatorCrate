import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createSocialPrepRepository } from '../src/data/social-prep-repository.js';
import { createReleaseService } from '../src/services/release-service.js';
import { createSocialPrepService, SocialPrepServiceError } from '../src/services/social-prep-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('social preparation activation serialization', () => {
  function setup() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-prep-'));
    const databasePath = path.join(directory, 'social.db');
    const db = openDatabase(databasePath);
    const rivalDb = openDatabase(databasePath);
    runMigrations(db, MIGRATIONS_DIR);
    return { directory, db, rivalDb };
  }

  function dispose({ directory, db, rivalDb }) {
    closeDatabase(rivalDb);
    closeDatabase(db);
    fs.rmSync(directory, { recursive: true, force: true });
  }

  function createService(db) {
    const projectId = Number(db.prepare(`INSERT INTO projects (title, slug, description, notes, status)
      VALUES ('Project', 'project', '', '', 'ready')`).run().lastInsertRowid);
    const releaseId = Number(db.prepare(`INSERT INTO releases (project_id, title, description, published_date)
      VALUES (?, 'Release', '', '2030-01-01')`).run(projectId).lastInsertRowid);
    const repository = createSocialPrepRepository(db);
    repository.ensurePlatforms(releaseId, ['x'], { now: new Date('2030-01-01T00:00:00Z') });
    return {
      releaseId,
      repository,
      service: createSocialPrepService({
        db, socialPrepRepository: repository, releaseService: createReleaseService({ db }),
        socialPrepSettingsService: { isEnabled: () => true, getPlatforms: () => ['x'] },
        now: () => new Date('2030-01-01T00:00:00Z'),
      }),
    };
  }

  it('maps a competing connection’s live session to attempt_in_progress without an orphan session', () => {
    const state = setup();
    try {
      const { releaseId, repository, service } = createService(state.db);
      // The pre-existing issued row models a rival activation that committed first.
      createSocialPrepRepository(state.rivalDb).insertSession({ id: 'rival', releaseId, kind: 'initial', intentHash: 'rival', expiresAt: new Date('2030-01-01T00:15:00Z'), now: new Date('2030-01-01T00:00:00Z') });
      expect(() => service.activate({ releaseId, platforms: ['x'], intentHash: 'ours', expiresAt: new Date('2030-01-01T00:15:00Z') }))
        .toThrowError(expect.objectContaining({ code: 'attempt_in_progress' }));
      expect(state.db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions').get().count).toBe(1);
      expect(repository.listPlatformsByReleaseId(releaseId)[0].attempts).toBe(0);
    } finally { dispose(state); }
  });

  it('maps a forced SQLite busy lock from a second connection to attempt_in_progress', () => {
    const state = setup();
    try {
      const { releaseId, repository, service } = createService(state.db);
      state.db.pragma('busy_timeout = 1');
      state.rivalDb.exec('BEGIN IMMEDIATE');
      try {
        expect(() => service.activate({ releaseId, platforms: ['x'], intentHash: 'ours', expiresAt: new Date('2030-01-01T00:15:00Z') }))
          .toThrowError(expect.objectContaining({ code: 'attempt_in_progress' }));
      } finally {
        state.rivalDb.exec('ROLLBACK');
      }
      expect(repository.listPlatformsByReleaseId(releaseId)[0].attempts).toBe(0);
      expect(state.db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions').get().count).toBe(0);
    } finally { dispose(state); }
  });
});
