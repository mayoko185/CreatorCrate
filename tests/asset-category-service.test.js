import { describe, it, expect, vi } from 'vitest';
import {
  createAssetCategoryService,
  AssetCategoryValidationError,
  AssetCategoryNotFoundError,
} from '../src/services/asset-category-service.js';

function makeFakeRepository(overrides = {}) {
  return {
    listDefaults: vi.fn(() => []),
    findDefaultById: vi.fn(() => ({ id: 1, display_name: 'Source', directory_slug: 'source' })),
    addDefault: vi.fn((input) => ({ id: 99, ...input })),
    updateDefaultNameSlug: vi.fn((id, input) => ({ id, ...input })),
    setDefaultEnabled: vi.fn((id, enabled) => ({ id, enabled })),
    reorderDefaults: vi.fn((ids) => ids),
    deleteDefault: vi.fn(() => true),
    listProjectCategories: vi.fn(() => []),
    copyEnabledDefaultsForProject: vi.fn(() => []),
    ...overrides,
  };
}

describe('asset category service', () => {
  describe('dependency injection', () => {
    it('accepts the repository explicitly and uses only that instance', () => {
      const repo = makeFakeRepository();
      const service = createAssetCategoryService(repo);

      service.listDefaults();
      expect(repo.listDefaults).toHaveBeenCalledTimes(1);

      service.listProjectCategories(42);
      expect(repo.listProjectCategories).toHaveBeenCalledWith(42);
    });

    it('performs no filesystem operations for any orchestration method', () => {
      const repo = makeFakeRepository();
      const service = createAssetCategoryService(repo);

      // If the service touched the filesystem it would need a real path;
      // exercising every operation with only the fake repository in scope
      // and no fs mocks proves no fs calls occur (they'd throw/hang otherwise
      // in a sandboxed test environment lacking such paths).
      expect(() => {
        service.listDefaults();
        service.addDefault({ displayName: 'Raw', directorySlug: 'raw' });
        service.editDefault(1, { displayName: 'Source', directorySlug: 'source' });
        service.setDefaultEnabled(1, false);
        service.reorderDefaults([1]);
        service.deleteDefault(1);
        service.listProjectCategories(1);
        service.copyDefaultsForProject(1);
      }).not.toThrow();
    });
  });

  describe('display-name validation', () => {
    it('is independent from slug validation — an invalid slug does not surface a name error', () => {
      const repo = makeFakeRepository();
      const service = createAssetCategoryService(repo);

      try {
        service.addDefault({ displayName: 'My Cool Category!', directorySlug: 'Not Valid Slug' });
        throw new Error('expected validation to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AssetCategoryValidationError);
        expect(err.errors.displayName).toBeUndefined();
        expect(err.errors.directorySlug).toBeTruthy();
      }
    });

    it('accepts human-facing display names that would fail slug syntax', () => {
      const repo = makeFakeRepository();
      const service = createAssetCategoryService(repo);

      const result = service.addDefault({ displayName: "Client's Final Cuts!", directorySlug: 'client-final-cuts' });
      expect(repo.addDefault).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: "Client's Final Cuts!" })
      );
      expect(result).toBeTruthy();
    });

    it('rejects an empty display name', () => {
      const repo = makeFakeRepository();
      const service = createAssetCategoryService(repo);

      expect(() => service.addDefault({ displayName: '  ', directorySlug: 'valid-slug' }))
        .toThrow(AssetCategoryValidationError);
    });

    it('rejects an overly long display name', () => {
      const repo = makeFakeRepository();
      const service = createAssetCategoryService(repo);
      const longName = 'a'.repeat(101);

      try {
        service.addDefault({ displayName: longName, directorySlug: 'valid-slug' });
        throw new Error('expected validation to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AssetCategoryValidationError);
        expect(err.errors.displayName).toBeTruthy();
      }
    });
  });

  describe('directory-slug validation', () => {
    const repo = () => makeFakeRepository();

    function expectSlugRejected(slug) {
      const service = createAssetCategoryService(repo());
      try {
        service.addDefault({ displayName: 'Valid Name', directorySlug: slug });
        throw new Error(`expected slug "${slug}" to be rejected`);
      } catch (err) {
        expect(err).toBeInstanceOf(AssetCategoryValidationError);
        expect(err.errors.directorySlug).toBeTruthy();
      }
    }

    function expectSlugAccepted(slug) {
      const service = createAssetCategoryService(repo());
      expect(() => service.addDefault({ displayName: 'Valid Name', directorySlug: slug })).not.toThrow();
    }

    it('accepts the required pattern', () => {
      expectSlugAccepted('source');
      expectSlugAccepted('exports-full');
      expectSlugAccepted('a1-b2-c3');
    });

    it('rejects empty values', () => {
      expectSlugRejected('');
    });

    it('rejects "." and ".."', () => {
      expectSlugRejected('.');
      expectSlugRejected('..');
    });

    it('rejects absolute paths', () => {
      expectSlugRejected('/etc/passwd');
      expectSlugRejected('C:\\Windows');
      expectSlugRejected('C:/Windows');
    });

    it('rejects path separators', () => {
      expectSlugRejected('foo/bar');
      expectSlugRejected('foo\\bar');
    });

    it('rejects traversal input', () => {
      expectSlugRejected('../escape');
      expectSlugRejected('foo/../bar');
    });

    it('rejects NUL characters', () => {
      expectSlugRejected('foo\0bar');
    });

    it('rejects control characters', () => {
      expectSlugRejected('foo\tbar');
      expectSlugRejected('foo\nbar');
    });

    it('rejects trailing dots', () => {
      expectSlugRejected('source.');
    });

    it('rejects trailing spaces', () => {
      expectSlugRejected('source ');
    });

    it('rejects "project.json" case-insensitively', () => {
      expectSlugRejected('project.json');
      expectSlugRejected('PROJECT.JSON');
      expectSlugRejected('Project.Json');
    });

    it('rejects Windows reserved device names case-insensitively', () => {
      for (const name of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']) {
        expectSlugRejected(name);
        expectSlugRejected(name.toLowerCase());
      }
    });

    it('rejects uppercase letters and invalid characters per the required pattern', () => {
      expectSlugRejected('Source');
      expectSlugRejected('source_final');
      expectSlugRejected('source--final');
      expectSlugRejected('-source');
      expectSlugRejected('source-');
    });
  });

  describe('orchestration', () => {
    it('lists defaults via the repository', () => {
      const repo = makeFakeRepository({ listDefaults: vi.fn(() => [{ id: 1 }]) });
      const service = createAssetCategoryService(repo);
      expect(service.listDefaults()).toEqual([{ id: 1 }]);
    });

    it('throws AssetCategoryNotFoundError when editing a missing default', () => {
      const repo = makeFakeRepository({ findDefaultById: vi.fn(() => undefined) });
      const service = createAssetCategoryService(repo);
      expect(() => service.editDefault(404, { displayName: 'X', directorySlug: 'x' }))
        .toThrow(AssetCategoryNotFoundError);
    });

    it('throws AssetCategoryNotFoundError when deleting a missing default', () => {
      const repo = makeFakeRepository({ findDefaultById: vi.fn(() => undefined) });
      const service = createAssetCategoryService(repo);
      expect(() => service.deleteDefault(404)).toThrow(AssetCategoryNotFoundError);
    });

    it('throws AssetCategoryNotFoundError when enabling/disabling a missing default', () => {
      const repo = makeFakeRepository({ findDefaultById: vi.fn(() => undefined) });
      const service = createAssetCategoryService(repo);
      expect(() => service.setDefaultEnabled(404, true)).toThrow(AssetCategoryNotFoundError);
    });

    it('rejects reorder input that is not an array of integers', () => {
      const repo = makeFakeRepository();
      const service = createAssetCategoryService(repo);
      expect(() => service.reorderDefaults('not-an-array')).toThrow(AssetCategoryValidationError);
      expect(() => service.reorderDefaults([1, 'two', 3])).toThrow(AssetCategoryValidationError);
    });

    it('delegates a valid reorder to the repository', () => {
      const repo = makeFakeRepository();
      const service = createAssetCategoryService(repo);
      service.reorderDefaults([3, 1, 2]);
      expect(repo.reorderDefaults).toHaveBeenCalledWith([3, 1, 2]);
    });

    it('delegates copying defaults for a project to the repository', () => {
      const repo = makeFakeRepository({ copyEnabledDefaultsForProject: vi.fn(() => [{ id: 1 }]) });
      const service = createAssetCategoryService(repo);
      expect(service.copyDefaultsForProject(7)).toEqual([{ id: 1 }]);
      expect(repo.copyEnabledDefaultsForProject).toHaveBeenCalledWith(7);
    });
  });

  describe('strict input validation', () => {
    const INVALID_IDS = ['1', 0, -1, 1.5, NaN, Infinity, -Infinity, null, undefined, {}, []];

    it('rejects a null input object for addDefault', () => {
      const repo = makeFakeRepository();
      const service = createAssetCategoryService(repo);
      expect(() => service.addDefault(null)).toThrow(AssetCategoryValidationError);
      expect(repo.addDefault).not.toHaveBeenCalled();
    });

    it('rejects an array input for addDefault', () => {
      const repo = makeFakeRepository();
      const service = createAssetCategoryService(repo);
      expect(() => service.addDefault(['not', 'an', 'object'])).toThrow(AssetCategoryValidationError);
      expect(repo.addDefault).not.toHaveBeenCalled();
    });

    it('rejects a null input object for editDefault', () => {
      const repo = makeFakeRepository();
      const service = createAssetCategoryService(repo);
      expect(() => service.editDefault(1, null)).toThrow(AssetCategoryValidationError);
      expect(repo.updateDefaultNameSlug).not.toHaveBeenCalled();
    });

    describe('validation runs before repository access', () => {
      it('rejects editDefault(404, null) with a validation error, not a not-found error', () => {
        const repo = makeFakeRepository({ findDefaultById: vi.fn(() => undefined) });
        const service = createAssetCategoryService(repo);
        expect(() => service.editDefault(404, null)).toThrow(AssetCategoryValidationError);
      });

      it('performs no repository lookup for editDefault with a null input', () => {
        const repo = makeFakeRepository();
        const service = createAssetCategoryService(repo);
        expect(() => service.editDefault(1, null)).toThrow(AssetCategoryValidationError);
        expect(repo.findDefaultById).not.toHaveBeenCalled();
      });

      it('performs no repository lookup for editDefault with an invalid slug', () => {
        const repo = makeFakeRepository();
        const service = createAssetCategoryService(repo);
        expect(() => service.editDefault(1, { displayName: 'X', directorySlug: 'Not Valid' }))
          .toThrow(AssetCategoryValidationError);
        expect(repo.findDefaultById).not.toHaveBeenCalled();
      });

      it('rejects setDefaultEnabled(404, "false") with a validation error, not a not-found error', () => {
        const repo = makeFakeRepository({ findDefaultById: vi.fn(() => undefined) });
        const service = createAssetCategoryService(repo);
        expect(() => service.setDefaultEnabled(404, 'false')).toThrow(AssetCategoryValidationError);
      });

      it('performs no repository lookup for setDefaultEnabled with an invalid boolean', () => {
        const repo = makeFakeRepository();
        const service = createAssetCategoryService(repo);
        expect(() => service.setDefaultEnabled(1, 'false')).toThrow(AssetCategoryValidationError);
        expect(repo.findDefaultById).not.toHaveBeenCalled();
      });

      it('still performs the existence lookup and mutation for a fully valid editDefault payload', () => {
        const repo = makeFakeRepository();
        const service = createAssetCategoryService(repo);
        service.editDefault(1, { displayName: 'Source', directorySlug: 'source' });
        expect(repo.findDefaultById).toHaveBeenCalledWith(1);
        expect(repo.updateDefaultNameSlug).toHaveBeenCalledWith(1, {
          displayName: 'Source',
          directorySlug: 'source',
        });
      });

      it('still performs the existence lookup and mutation for a fully valid setDefaultEnabled payload', () => {
        const repo = makeFakeRepository();
        const service = createAssetCategoryService(repo);
        service.setDefaultEnabled(1, false);
        expect(repo.findDefaultById).toHaveBeenCalledWith(1);
        expect(repo.setDefaultEnabled).toHaveBeenCalledWith(1, false);
      });

      it('still reports not-found when all supplied inputs are otherwise valid', () => {
        const repo = makeFakeRepository({ findDefaultById: vi.fn(() => undefined) });
        const service = createAssetCategoryService(repo);
        expect(() => service.editDefault(404, { displayName: 'X', directorySlug: 'x' }))
          .toThrow(AssetCategoryNotFoundError);
        expect(() => service.setDefaultEnabled(404, true)).toThrow(AssetCategoryNotFoundError);
      });
    });

    describe.each([
      ['editDefault', (service, id) => service.editDefault(id, { displayName: 'X', directorySlug: 'x' })],
      ['setDefaultEnabled', (service, id) => service.setDefaultEnabled(id, true)],
      ['deleteDefault', (service, id) => service.deleteDefault(id)],
    ])('%s id validation', (name, call) => {
      it.each(INVALID_IDS)('rejects invalid id %p', (id) => {
        const repo = makeFakeRepository();
        const service = createAssetCategoryService(repo);
        expect(() => call(service, id)).toThrow(AssetCategoryValidationError);
        expect(repo.findDefaultById).not.toHaveBeenCalled();
      });
    });

    describe.each([
      ['listProjectCategories', (service, id) => service.listProjectCategories(id), 'listProjectCategories'],
      ['copyDefaultsForProject', (service, id) => service.copyDefaultsForProject(id), 'copyEnabledDefaultsForProject'],
    ])('%s project id validation', (name, call, repoMethod) => {
      it.each(INVALID_IDS)('rejects invalid project id %p', (id) => {
        const repo = makeFakeRepository();
        const service = createAssetCategoryService(repo);
        expect(() => call(service, id)).toThrow(AssetCategoryValidationError);
        expect(repo[repoMethod]).not.toHaveBeenCalled();
      });

      it('accepts a valid positive integer project id', () => {
        const repo = makeFakeRepository();
        const service = createAssetCategoryService(repo);
        expect(() => call(service, 7)).not.toThrow();
        expect(repo[repoMethod]).toHaveBeenCalledWith(7);
      });
    });

    describe('enabled boolean strictness', () => {
      const NON_BOOLEANS = ['false', 'true', 0, 1, null, 'on'];

      it.each(NON_BOOLEANS)('rejects non-boolean enabled value %p for setDefaultEnabled', (value) => {
        const repo = makeFakeRepository();
        const service = createAssetCategoryService(repo);
        expect(() => service.setDefaultEnabled(1, value)).toThrow(AssetCategoryValidationError);
        expect(repo.setDefaultEnabled).not.toHaveBeenCalled();
      });

      it('accepts true and false for setDefaultEnabled', () => {
        const repo = makeFakeRepository();
        const service = createAssetCategoryService(repo);
        expect(() => service.setDefaultEnabled(1, true)).not.toThrow();
        expect(() => service.setDefaultEnabled(1, false)).not.toThrow();
        expect(repo.setDefaultEnabled).toHaveBeenCalledWith(1, true);
        expect(repo.setDefaultEnabled).toHaveBeenCalledWith(1, false);
      });

      it.each(NON_BOOLEANS)('rejects non-boolean enabled value %p for addDefault', (value) => {
        const repo = makeFakeRepository();
        const service = createAssetCategoryService(repo);
        expect(() => service.addDefault({ displayName: 'Valid', directorySlug: 'valid', enabled: value }))
          .toThrow(AssetCategoryValidationError);
        expect(repo.addDefault).not.toHaveBeenCalled();
      });

      it('accepts true and false for addDefault, and defaults to true when omitted', () => {
        const repo = makeFakeRepository();
        const service = createAssetCategoryService(repo);
        service.addDefault({ displayName: 'A', directorySlug: 'a', enabled: false });
        expect(repo.addDefault).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
        service.addDefault({ displayName: 'B', directorySlug: 'b' });
        expect(repo.addDefault).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
      });
    });

    it('rejects reorder IDs that are not positive integers before calling the repository', () => {
      const repo = makeFakeRepository();
      const service = createAssetCategoryService(repo);
      expect(() => service.reorderDefaults([1, 0, 2])).toThrow(AssetCategoryValidationError);
      expect(() => service.reorderDefaults([1, -2, 3])).toThrow(AssetCategoryValidationError);
      expect(() => service.reorderDefaults([1, 1.5, 3])).toThrow(AssetCategoryValidationError);
      expect(repo.reorderDefaults).not.toHaveBeenCalled();
    });
  });
});
