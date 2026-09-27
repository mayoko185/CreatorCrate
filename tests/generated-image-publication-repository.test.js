import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import {
  createGeneratedImagePublicationRepository,
  InvalidGeneratedImagePublicationError,
} from '../src/data/generated-image-publication-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const REVISION_A = '0123456789abcdef';
const REVISION_B = 'fedcba9876543210';

describe('generated-image publication repository', () => {
  let tmpDir;
  let db;
  let repository;
  let projectId;
  let assetId;
  let otherProjectId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-generated-publication-repository-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createGeneratedImagePublicationRepository(db);
    projectId = insertProject('publication-project');
    otherProjectId = insertProject('other-project');
    assetId = insertAsset(projectId, 'art.png');
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertProject(slug) {
    return Number(db.prepare("INSERT INTO projects (title, slug, status, project_type) VALUES (?, ?, 'tbd', 'images')").run(slug, slug).lastInsertRowid);
  }

  function insertAsset(ownerId, relativePath) {
    return Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename) VALUES (?, ?, ?)
    `).run(ownerId, relativePath, relativePath).lastInsertRowid);
  }

  function publication(overrides = {}, derivativeOverrides = {}) {
    const revision = overrides.revision ?? REVISION_A;
    return {
      projectId,
      assetId,
      directoryName: `r-${revision}-a1b2c3d4`,
      revision,
      generatedAt: '2026-09-26T10:00:00.000Z',
      cacheSchemaVersion: 1,
      derivativeConfigVersion: 1,
      sourceRelativePath: 'art.png',
      sourceSizeBytes: 4096,
      sourceMtime: '2026-09-25T10:00:00.000Z',
      sourceGeneration: 0,
      policyFingerprint: 'aaaaaaaaaaaaaaaa',
      animated: false,
      frameCount: 1,
      sourcePreviewQuality: null,
      generationIdentityVersion: 1,
      derivatives: {
        thumbnail: {
          format: 'webp', width: 320, height: 240, sizeBytes: 1000, generationIdentity: '1111111111111111',
          ...derivativeOverrides.thumbnail,
        },
        preview: {
          format: 'png', width: 1600, height: 1200, sizeBytes: 90000, generationIdentity: '2222222222222222',
          ...derivativeOverrides.preview,
        },
      },
      ...overrides,
    };
  }

  function intentFor(input, overrides = {}) {
    return {
      projectId: input.projectId,
      assetId: input.assetId,
      candidateDirectoryName: input.directoryName,
      stagingDirectoryName: 'tmp-abcdef012345',
      expectedRevision: input.revision,
      previousDirectoryName: null,
      ...overrides,
    };
  }

  function commit(input) {
    const intent = repository.acquireIntent(intentFor(input));
    expect(repository.finalizePublication(intent.intentId, input)).toBe(true);
    return intent;
  }

  function counts() {
    return {
      publications: db.prepare('SELECT COUNT(*) FROM generated_image_publications').pluck().get(),
      derivatives: db.prepare('SELECT COUNT(*) FROM generated_image_derivatives').pluck().get(),
      intents: db.prepare('SELECT COUNT(*) FROM generated_image_publication_intents').pluck().get(),
    };
  }

  describe('committed snapshot', () => {
    it('round-trips a complete thumbnail and preview snapshot', () => {
      const input = publication();
      commit(input);

      expect(repository.findPublication(projectId, assetId)).toEqual(input);
      expect(repository.findPublication(otherProjectId, assetId)).toBeNull();
      expect(counts()).toEqual({ publications: 1, derivatives: 2, intents: 0 });
    });

    it('keeps absent legacy metadata null instead of inventing defaults', () => {
      const input = publication({
        policyFingerprint: undefined,
        animated: undefined,
        frameCount: undefined,
        sourcePreviewQuality: undefined,
        generationIdentityVersion: undefined,
      }, {
        thumbnail: { generationIdentity: undefined },
        preview: { format: 'webp', generationIdentity: undefined },
      });
      commit(input);

      const snapshot = repository.findPublication(projectId, assetId);
      expect(snapshot).toMatchObject({
        policyFingerprint: null,
        animated: null,
        frameCount: null,
        sourcePreviewQuality: null,
        generationIdentityVersion: null,
      });
      expect(snapshot.derivatives.thumbnail.generationIdentity).toBeNull();
      expect(snapshot.derivatives.preview.generationIdentity).toBeNull();
      expect(db.prepare('SELECT animated FROM generated_image_publications').pluck().get()).toBeNull();
    });

    it('never returns a parent without its complete derivative pair', () => {
      commit(publication());
      db.prepare("DELETE FROM generated_image_derivatives WHERE kind = 'preview'").run();

      expect(repository.findPublication(projectId, assetId)).toBeNull();
    });

    it('rejects malformed or incomplete snapshots before any write', () => {
      const input = publication();
      const intent = repository.acquireIntent(intentFor(input));
      const rejected = [
        { ...input, derivatives: { thumbnail: input.derivatives.thumbnail } },
        { ...input, derivatives: { ...input.derivatives, original: input.derivatives.preview } },
        publication({}, { preview: { format: 'jpeg' } }),
        publication({}, { thumbnail: { width: 0 } }),
        publication({}, { thumbnail: { height: 1.5 } }),
        publication({}, { preview: { sizeBytes: -1 } }),
        publication({}, { preview: { generationIdentity: null } }),
        publication({ sourceGeneration: -1 }),
        publication({ sourceSizeBytes: -1 }),
        publication({ sourceRelativePath: '' }),
        publication({ directoryName: '../r-0123456789abcdef-a1b2c3d4' }),
        publication({ directoryName: `r-${REVISION_B}-a1b2c3d4` }),
        publication({ revision: 'not-a-revision' }),
        publication({ animated: 1 }),
        publication({ sourcePreviewQuality: 'full' }),
      ];
      for (const candidate of rejected) {
        expect(() => repository.finalizePublication(intent.intentId, candidate))
          .toThrow(InvalidGeneratedImagePublicationError);
      }
      expect(counts()).toEqual({ publications: 0, derivatives: 0, intents: 1 });
    });

    it('cascades committed rows and intents when the asset is deleted', () => {
      commit(publication());
      repository.acquireIntent(intentFor(publication({ revision: REVISION_B })));

      db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);

      expect(counts()).toEqual({ publications: 0, derivatives: 0, intents: 0 });
    });
  });

  describe('publication intents', () => {
    it('allows one unresolved intent per asset and never overwrites it', () => {
      const first = repository.acquireIntent(intentFor(publication(), {
        previousDirectoryName: `r-${REVISION_B}-00aa11bb`,
      }));
      expect(first).toMatchObject({
        projectId,
        assetId,
        candidateDirectoryName: `r-${REVISION_A}-a1b2c3d4`,
        stagingDirectoryName: 'tmp-abcdef012345',
        expectedRevision: REVISION_A,
        previousDirectoryName: `r-${REVISION_B}-00aa11bb`,
      });
      expect(first.intentId).toEqual(expect.any(String));
      expect(first.createdAt).toEqual(expect.any(String));

      const competing = repository.acquireIntent(intentFor(publication({ revision: REVISION_B })));
      expect(competing).toBeNull();
      expect(repository.findIntent(projectId, assetId)).toEqual(first);
      expect(repository.listIntents()).toEqual([first]);
    });

    it('rejects an intent for an asset outside the named project', () => {
      expect(() => repository.acquireIntent(intentFor(publication({ projectId: otherProjectId }))))
        .toThrow(/FOREIGN KEY/);
      expect(repository.listIntents()).toEqual([]);
    });

    it('rejects invalid directory identities', () => {
      const input = publication();
      for (const overrides of [
        { stagingDirectoryName: 'tmp-../x' },
        { candidateDirectoryName: `r-${REVISION_B}-a1b2c3d4` },
        { previousDirectoryName: input.directoryName },
        { previousDirectoryName: 'r-bad' },
      ]) {
        expect(() => repository.acquireIntent(intentFor(input, overrides)))
          .toThrow(InvalidGeneratedImagePublicationError);
      }
    });

    it('lists every unresolved intent for targeted recovery', () => {
      const secondAssetId = insertAsset(projectId, 'second.png');
      const first = repository.acquireIntent(intentFor(publication()));
      const second = repository.acquireIntent(intentFor(publication({ assetId: secondAssetId })));

      expect(repository.listIntents()).toEqual([first, second]);
    });

    it('clears an intent only for its owning intent ID', () => {
      const intent = repository.acquireIntent(intentFor(publication()));

      expect(repository.clearIntent(projectId, assetId, 'stale-intent')).toBe(false);
      expect(repository.clearIntent(otherProjectId, assetId, intent.intentId)).toBe(false);
      expect(repository.findIntent(projectId, assetId)).toEqual(intent);

      expect(repository.clearIntent(projectId, assetId, intent.intentId)).toBe(true);
      expect(repository.findIntent(projectId, assetId)).toBeNull();

      const newer = repository.acquireIntent(intentFor(publication()));
      expect(repository.clearIntent(projectId, assetId, intent.intentId)).toBe(false);
      expect(repository.findIntent(projectId, assetId)).toEqual(newer);
    });
  });

  describe('atomic finalization', () => {
    it('replaces the complete snapshot and resolves the matching intent', () => {
      commit(publication());
      const replacement = publication({ revision: REVISION_B, sourceGeneration: 2, animated: true, frameCount: 4 }, {
        thumbnail: { format: 'png', width: 200, height: 100, sizeBytes: 50, generationIdentity: '3333333333333333' },
        preview: { format: 'webp', width: 800, height: 400, sizeBytes: 500, generationIdentity: '4444444444444444' },
      });
      const intent = repository.acquireIntent(intentFor(replacement, {
        previousDirectoryName: `r-${REVISION_A}-a1b2c3d4`,
      }));

      expect(repository.finalizePublication(intent.intentId, replacement)).toBe(true);

      expect(repository.findPublication(projectId, assetId)).toEqual(replacement);
      expect(repository.findIntent(projectId, assetId)).toBeNull();
      expect(counts()).toEqual({ publications: 1, derivatives: 2, intents: 0 });
    });

    it('keeps directory identity distinct when the revision token is unchanged', () => {
      const original = publication();
      commit(original);
      const regenerated = publication({ directoryName: `r-${REVISION_A}-99887766` });
      const intent = repository.acquireIntent(intentFor(regenerated, {
        previousDirectoryName: original.directoryName,
      }));

      expect(repository.finalizePublication(intent.intentId, regenerated)).toBe(true);

      const snapshot = repository.findPublication(projectId, assetId);
      expect(snapshot.revision).toBe(REVISION_A);
      expect(snapshot.directoryName).toBe(`r-${REVISION_A}-99887766`);
    });

    it('does nothing for a stale or unknown intent ID', () => {
      const original = publication();
      commit(original);
      const replacement = publication({ revision: REVISION_B });
      const intent = repository.acquireIntent(intentFor(replacement));

      expect(repository.finalizePublication('stale-intent', replacement)).toBe(false);
      expect(repository.finalizePublication(intent.intentId, { ...replacement, projectId: otherProjectId }))
        .toBe(false);

      expect(repository.findPublication(projectId, assetId)).toEqual(original);
      expect(repository.findIntent(projectId, assetId)).toEqual(intent);
    });

    it('refuses a publication other than the candidate its intent recorded', () => {
      const original = publication();
      commit(original);
      const intent = repository.acquireIntent(intentFor(publication({ revision: REVISION_B })));

      expect(() => repository.finalizePublication(
        intent.intentId,
        publication({ revision: REVISION_B, directoryName: `r-${REVISION_B}-deadbeef` }),
      )).toThrow(InvalidGeneratedImagePublicationError);

      expect(repository.findPublication(projectId, assetId)).toEqual(original);
      expect(repository.findIntent(projectId, assetId)).toEqual(intent);
    });

    it.each([
      ['a derivative insert', `CREATE TEMP TRIGGER inject_failure
        BEFORE INSERT ON generated_image_derivatives WHEN NEW.kind = 'preview'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END`],
      ['intent removal', `CREATE TEMP TRIGGER inject_failure
        BEFORE DELETE ON generated_image_publication_intents
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END`],
    ])('rolls back completely when %s fails', (_label, trigger) => {
      const original = publication();
      commit(original);
      const replacement = publication({ revision: REVISION_B, sourceGeneration: 1 }, {
        thumbnail: { width: 10 },
      });
      const intent = repository.acquireIntent(intentFor(replacement));
      db.exec(trigger);

      expect(() => repository.finalizePublication(intent.intentId, replacement)).toThrow('injected failure');
      db.exec('DROP TRIGGER inject_failure');

      expect(repository.findPublication(projectId, assetId)).toEqual(original);
      expect(repository.findIntent(projectId, assetId)).toEqual(intent);
      expect(counts()).toEqual({ publications: 1, derivatives: 2, intents: 1 });
    });
  });

  it('keeps serving the committed snapshot while a candidate intent is pending', () => {
    const original = publication();
    commit(original);

    repository.acquireIntent(intentFor(publication({ revision: REVISION_B }), {
      previousDirectoryName: original.directoryName,
    }));

    expect(repository.findPublication(projectId, assetId)).toEqual(original);
  });
});
