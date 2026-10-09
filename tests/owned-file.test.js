import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  copyTrustedFileToOwnedFile,
  createOwnedFile,
  OWNED_FILE_FAILURE,
  OwnedFileError,
  ownedFileSourceChangeEvidence,
  removeFileIfExactIdentityMatches,
} from '../src/services/owned-file.js';
import { formatGeneratedOutputProvenance } from '../src/services/asset-processing-shared.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function writeBytes(bytes) {
  return (descriptor) => new Promise((resolve, reject) => {
    fs.writeFile(descriptor, bytes, (err) => (err ? reject(err) : resolve()));
  });
}

// Rewrites bigint stat fields per path: `lstat(absPath)` for pathname stats and
// `fstat(absPath, callIndex)` for stats of a descriptor opened on that path. Each returns
// the fields to override, or undefined to keep the real values.
function overrideStats({ lstat = () => undefined, fstat = () => undefined }) {
  const realLstat = fs.lstatSync.bind(fs);
  const realOpen = fs.openSync.bind(fs);
  const realFstat = fs.fstatSync.bind(fs);
  const descriptors = new Map();
  const fstatCalls = new Map();
  const apply = (stats, fields) => {
    if (!fields || typeof stats.ino !== 'bigint') return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, fields);
  };
  const spies = [
    vi.spyOn(fs, 'lstatSync').mockImplementation((filePath, ...args) => (
      apply(realLstat(filePath, ...args), lstat(path.resolve(filePath)))
    )),
    vi.spyOn(fs, 'openSync').mockImplementation((filePath, ...args) => {
      const descriptor = realOpen(filePath, ...args);
      descriptors.set(descriptor, path.resolve(filePath));
      return descriptor;
    }),
    vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
      const stats = realFstat(descriptor, ...args);
      const filePath = descriptors.get(descriptor);
      if (!filePath) return stats;
      const index = fstatCalls.get(filePath) ?? 0;
      fstatCalls.set(filePath, index + 1);
      return apply(stats, fstat(filePath, index));
    }),
  ];
  return () => spies.reverse().forEach((spy) => spy.mockRestore());
}

describe('owned file primitive', () => {
  let tmpDir;
  let restoreMocks = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-owned-file-'));
    restoreMocks = [];
  });

  afterEach(() => {
    restoreMocks.reverse().forEach((restore) => restore());
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const mock = (restore) => { restoreMocks.push(restore); return restore; };

  describe('createOwnedFile', () => {
    it('roots ownership in the exclusive descriptor before writing and proves the path after close', async () => {
      const target = path.join(tmpDir, 'owned.bin');
      const events = [];
      const openSpy = vi.spyOn(fs, 'openSync');
      const result = await createOwnedFile(target, async (descriptor) => {
        events.push('write');
        await writeBytes(Buffer.from('generated'))(descriptor);
      }, { onOwned: (identity) => events.push(['owned', identity]) });

      expect(openSpy).toHaveBeenCalledWith(target, 'wx', undefined);
      const pathStats = fs.lstatSync(target, { bigint: true });
      expect(result.exactIdentity).toEqual({ dev: pathStats.dev, ino: pathStats.ino });
      expect(typeof result.exactIdentity.dev).toBe('bigint');
      expect(typeof result.exactIdentity.ino).toBe('bigint');
      expect(events).toEqual([['owned', result.exactIdentity], 'write']);
      expect(result.pathContinuity).toBe('matched');
      expect(typeof result.birthtimeNs).toBe('bigint');
      expect(result).not.toHaveProperty('content');
      expect(fs.readFileSync(target, 'utf8')).toBe('generated');
    });

    it('verifies read-back content through the descriptor without treating it as ownership', async () => {
      const target = path.join(tmpDir, 'verified.bin');
      const bytes = Buffer.from('verified bytes');
      const openSpy = vi.spyOn(fs, 'openSync');
      const result = await createOwnedFile(target, writeBytes(bytes), {
        expectedContent: { size: bytes.length, sha256: sha256(bytes) },
      });
      expect(openSpy).toHaveBeenCalledWith(target, 'wx+', undefined);
      expect(result.content).toEqual({ size: BigInt(bytes.length), sha256: sha256(bytes) });
      expect(result.exactIdentity).toBeDefined();
    });

    it('fails closed on EEXIST without adopting, overwriting or removing the existing path', async () => {
      const target = path.join(tmpDir, 'existing.bin');
      fs.writeFileSync(target, 'foreign');
      const before = fs.lstatSync(target, { bigint: true });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const onOwned = vi.fn();
      const write = vi.fn();

      await expect(createOwnedFile(target, write, { onOwned })).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(copyTrustedFileToOwnedFile({
        sourcePath: target, destinationPath: target, onOwned,
      })).rejects.toMatchObject({ code: 'EEXIST' });

      expect(onOwned).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(unlinkSpy).not.toHaveBeenCalled();
      const after = fs.lstatSync(target, { bigint: true });
      expect(fs.readFileSync(target, 'utf8')).toBe('foreign');
      expect({ dev: after.dev, ino: after.ino, mtimeNs: after.mtimeNs })
        .toEqual({ dev: before.dev, ino: before.ino, mtimeNs: before.mtimeNs });
    });

    it('never claims a descriptor with an unknown (zero) identity and never cleans its path', async () => {
      const target = path.join(tmpDir, 'unknown.bin');
      mock(overrideStats({
        fstat: (filePath) => (filePath === target ? { ino: 0n } : undefined),
        lstat: (filePath) => (filePath === target ? { ino: 0n } : undefined),
      }));
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const closeSpy = vi.spyOn(fs, 'closeSync');
      const onOwned = vi.fn();
      const write = vi.fn();

      const failure = await createOwnedFile(target, write, { onOwned }).catch((err) => err);
      expect(failure).toBeInstanceOf(OwnedFileError);
      expect(failure.reason).toBe(OWNED_FILE_FAILURE.identityUnknown);
      expect(onOwned).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalledTimes(1);
      // Residue stays: nothing authorizes removing it, even with its adopted path identity.
      expect(fs.existsSync(target)).toBe(true);
      expect(removeFileIfExactIdentityMatches(target, { dev: 0n, ino: 0n })).toBe(false);
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(target)).toBe(true);
    });

    it('reports creation before descriptor inspection, and creation alone never means owned', async () => {
      const target = path.join(tmpDir, 'created.bin');
      const events = [];
      const realFstat = fs.fstatSync.bind(fs);
      vi.spyOn(fs, 'fstatSync').mockImplementation((...args) => {
        events.push('fstat');
        return realFstat(...args);
      });
      const result = await createOwnedFile(target, async (descriptor) => {
        events.push('write');
        await writeBytes(Buffer.from('created'))(descriptor);
      }, {
        onCreated: () => events.push('created'),
        onOwned: () => events.push('owned'),
      });

      expect(events.slice(0, 4)).toEqual(['created', 'fstat', 'owned', 'write']);
      expect(events.filter((event) => event === 'created')).toHaveLength(1);
      expect(result.exactIdentity).toBeDefined();
    });

    it('reports a created but unclaimed path when the first descriptor inspection fails', async () => {
      const target = path.join(tmpDir, 'uninspectable.bin');
      const realOpen = fs.openSync.bind(fs);
      const realFstat = fs.fstatSync.bind(fs);
      let created;
      vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
        const descriptor = realOpen(...args);
        if (path.resolve(String(args[0])) === target) created = descriptor;
        return descriptor;
      });
      vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
        if (descriptor === created) throw Object.assign(new Error('injected fstat EIO'), { code: 'EIO' });
        return realFstat(descriptor, ...args);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const onCreated = vi.fn();
      const onOwned = vi.fn();
      const write = vi.fn();

      const failure = await createOwnedFile(target, write, { onCreated, onOwned }).catch((err) => err);
      expect(failure).toMatchObject({ code: 'EIO' });
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onOwned).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      // The created path is never adopted or removed by pathname.
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(target)).toBe(true);
    });

    it('reports creation for a zero-identity descriptor without claiming it', async () => {
      const target = path.join(tmpDir, 'created-unknown.bin');
      mock(overrideStats({ fstat: (filePath) => (filePath === target ? { ino: 0n } : undefined) }));
      const onCreated = vi.fn();
      const onOwned = vi.fn();

      const failure = await createOwnedFile(target, vi.fn(), { onCreated, onOwned }).catch((err) => err);
      expect(failure.reason).toBe(OWNED_FILE_FAILURE.identityUnknown);
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onOwned).not.toHaveBeenCalled();
      expect(fs.existsSync(target)).toBe(true);
    });

    it('never reports creation when the exclusive open fails', async () => {
      const target = path.join(tmpDir, 'existing-created.bin');
      fs.writeFileSync(target, 'foreign');
      const onCreated = vi.fn();

      await expect(createOwnedFile(target, vi.fn(), { onCreated })).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(copyTrustedFileToOwnedFile({
        sourcePath: target, destinationPath: target, onCreated,
      })).rejects.toMatchObject({ code: 'EEXIST' });
      expect(onCreated).not.toHaveBeenCalled();
      expect(fs.readFileSync(target, 'utf8')).toBe('foreign');
    });

    it('keeps exact bigint identities above Number.MAX_SAFE_INTEGER without rounding', async () => {
      const target = path.join(tmpDir, 'large.bin');
      const dev = 2n ** 62n + 3n;
      const ino = 2n ** 60n + 1n;
      expect(Number(ino)).toBe(Number(ino - 1n));
      mock(overrideStats({
        fstat: (filePath) => (filePath === target ? { dev, ino } : undefined),
        lstat: (filePath) => (filePath === target ? { dev, ino } : undefined),
      }));
      const result = await createOwnedFile(target, writeBytes(Buffer.from('x')));
      expect(result.exactIdentity).toEqual({ dev, ino });
      // A rounded neighbour is a different object and never matches.
      expect(removeFileIfExactIdentityMatches(target, { dev, ino: ino - 1n })).toBe(false);
      expect(fs.existsSync(target)).toBe(true);
      expect(removeFileIfExactIdentityMatches(target, result.exactIdentity)).toBe(true);
    });

    it('rejects a pathname whose identity only equals the descriptor identity after Number rounding', async () => {
      const target = path.join(tmpDir, 'rounded.bin');
      const ino = 2n ** 60n + 1n;
      mock(overrideStats({
        fstat: (filePath) => (filePath === target ? { ino } : undefined),
        lstat: (filePath) => (filePath === target ? { ino: ino - 1n } : undefined),
      }));
      const failure = await createOwnedFile(target, writeBytes(Buffer.from('x'))).catch((err) => err);
      expect(failure.reason).toBe(OWNED_FILE_FAILURE.pathnameChanged);
    });

    it('fails closed when the owned descriptor reports a different identity after writing', async () => {
      const target = path.join(tmpDir, 'descriptor-changed.bin');
      mock(overrideStats({
        fstat: (filePath, index) => (filePath === target ? { dev: 77n, ino: index === 0 ? 500n : 501n } : undefined),
      }));
      const closeSpy = vi.spyOn(fs, 'closeSync');
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      let owned;
      const failure = await createOwnedFile(target, writeBytes(Buffer.from('x')), {
        onOwned: (identity) => { owned = identity; },
      }).catch((err) => err);
      expect(failure.reason).toBe(OWNED_FILE_FAILURE.descriptorChanged);
      expect(owned).toEqual({ dev: 77n, ino: 500n });
      expect(closeSpy).toHaveBeenCalledTimes(1);
      // Evidence is retained: the primitive never removes the path itself.
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(target)).toBe(true);
    });

    it('never claims or unlinks a foreign file that replaced the pathname after close', async () => {
      const target = path.join(tmpDir, 'replaced.bin');
      const realClose = fs.closeSync.bind(fs);
      vi.spyOn(fs, 'closeSync').mockImplementationOnce((descriptor) => {
        realClose(descriptor);
        fs.rmSync(target);
        fs.writeFileSync(target, 'foreign');
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      let owned;
      const failure = await createOwnedFile(target, writeBytes(Buffer.from('ours')), {
        onOwned: (identity) => { owned = identity; },
      }).catch((err) => err);

      expect(failure.reason).toBe(OWNED_FILE_FAILURE.pathnameChanged);
      expect(removeFileIfExactIdentityMatches(target, owned)).toBe(false);
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(target, 'utf8')).toBe('foreign');
    });

    it('keeps the writer error and lets ownership-gated cleanup remove only the owned file', async () => {
      const target = path.join(tmpDir, 'write-failure.bin');
      const realClose = fs.closeSync.bind(fs);
      vi.spyOn(fs, 'closeSync').mockImplementationOnce((descriptor) => {
        realClose(descriptor);
        throw Object.assign(new Error('close failed'), { code: 'EIO' });
      });
      const writerError = new Error('renderer failed');
      let owned;
      const failure = await createOwnedFile(target, async (descriptor) => {
        await writeBytes(Buffer.from('partial'))(descriptor);
        throw writerError;
      }, { onOwned: (identity) => { owned = identity; } }).catch((err) => err);

      expect(failure).toBe(writerError);
      expect(fs.existsSync(target)).toBe(true);
      expect(removeFileIfExactIdentityMatches(target, owned)).toBe(true);
      expect(fs.existsSync(target)).toBe(false);
    });

    it('leaves a foreign replacement in place when the writer fails after the path was replaced', async () => {
      const target = path.join(tmpDir, 'write-failure-replaced.bin');
      let owned;
      const failure = await createOwnedFile(target, async () => {
        fs.rmSync(target);
        fs.writeFileSync(target, 'foreign');
        throw new Error('renderer failed');
      }, { onOwned: (identity) => { owned = identity; } }).catch((err) => err);

      expect(failure.message).toBe('renderer failed');
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      expect(removeFileIfExactIdentityMatches(target, owned)).toBe(false);
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(target, 'utf8')).toBe('foreign');
    });

    it('rejects content that does not match the expected size or hash', async () => {
      const bytes = Buffer.from('actual');
      for (const [name, expectedContent] of [
        ['size.bin', { size: bytes.length + 1 }],
        ['hash.bin', { sha256: sha256(Buffer.from('other')) }],
      ]) {
        const target = path.join(tmpDir, name);
        let owned;
        const failure = await createOwnedFile(target, writeBytes(bytes), {
          expectedContent, onOwned: (identity) => { owned = identity; },
        }).catch((err) => err);
        expect(failure.reason).toBe(OWNED_FILE_FAILURE.contentMismatch);
        expect(removeFileIfExactIdentityMatches(target, owned)).toBe(true);
      }
    });

    it('applies the requested mode through the owned descriptor before writing', async () => {
      const target = path.join(tmpDir, 'mode.bin');
      const events = [];
      const fchmodSpy = vi.spyOn(fs, 'fchmodSync').mockImplementation((...args) => {
        events.push(['fchmod', args[1]]);
      });
      await createOwnedFile(target, async (descriptor) => {
        events.push('write');
        await writeBytes(Buffer.from('x'))(descriptor);
      }, { mode: 0o640 });
      expect(fchmodSpy).toHaveBeenCalledTimes(1);
      expect(events).toEqual([['fchmod', 0o640], 'write']);
    });

    it.skipIf(process.platform === 'win32')('creates the file with the requested POSIX mode', async () => {
      const target = path.join(tmpDir, 'posix-mode.bin');
      await createOwnedFile(target, writeBytes(Buffer.from('x')), { mode: 0o640 });
      expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    });

    it('applies requested times through the owned descriptor after writing and verification', async () => {
      const target = path.join(tmpDir, 'times.bin');
      const mtime = new Date('2024-05-06T07:08:09.123Z');
      const events = [];
      const realFutimes = fs.futimesSync.bind(fs);
      const futimesSpy = vi.spyOn(fs, 'futimesSync').mockImplementation((descriptor, ...args) => {
        events.push('futimes');
        return realFutimes(descriptor, ...args);
      });
      const result = await createOwnedFile(target, async (descriptor) => {
        events.push('write');
        await writeBytes(Buffer.from('timed'))(descriptor);
      }, {
        expectedContent: { size: 5, sha256: sha256(Buffer.from('timed')) },
        times: { atime: mtime.getTime() / 1000, mtime: mtime.getTime() / 1000 },
      });
      expect(futimesSpy).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['write', 'futimes']);
      expect(fs.statSync(target).mtime.toISOString()).toBe(mtime.toISOString());
      expect(result.pathContinuity).toBe('matched');
    });

    it('keeps the owned identity and leaves the path when applying times fails', async () => {
      const target = path.join(tmpDir, 'times-failure.bin');
      vi.spyOn(fs, 'futimesSync').mockImplementation(() => {
        throw Object.assign(new Error('injected futimes failure'), { code: 'EPERM' });
      });
      let owned;
      await expect(createOwnedFile(target, writeBytes(Buffer.from('x')), {
        times: { atime: 1, mtime: 1 },
        onOwned: (identity) => { owned = identity; },
      })).rejects.toMatchObject({ code: 'EPERM' });
      expect(fs.existsSync(target)).toBe(true);
      expect(removeFileIfExactIdentityMatches(target, owned)).toBe(true);
    });

    it('exposes the descriptor birth time as a provenance candidate without making zero durable', async () => {
      const target = path.join(tmpDir, 'zero-birthtime.bin');
      mock(overrideStats({ fstat: (filePath) => (filePath === target ? { birthtimeNs: 0n } : undefined) }));
      const result = await createOwnedFile(target, writeBytes(Buffer.from('x')));
      expect(result.birthtimeNs).toBe(0n);
      expect(result.exactIdentity).toBeDefined();
      expect(formatGeneratedOutputProvenance({ ...result.exactIdentity, birthtimeNs: result.birthtimeNs })).toBeNull();
    });

    it('reports birth time and ctime from the same final descriptor stat', async () => {
      const target = path.join(tmpDir, 'ctime-mirror.bin');
      // A platform whose birth time merely mirrors ctime: the caller must be able to see that.
      mock(overrideStats({
        fstat: (filePath) => (filePath === target ? { birthtimeNs: 1700000000000000007n, ctimeNs: 1700000000000000007n } : undefined),
      }));
      const result = await createOwnedFile(target, writeBytes(Buffer.from('x')));
      expect(result.birthtimeNs).toBe(1700000000000000007n);
      expect(result.ctimeNs).toBe(1700000000000000007n);
    });
  });

  describe('SMB hard-link identities are irrelevant to ownership', () => {
    const SOURCE = { dev: 77n, ino: 10775n };
    const DESTINATION = { dev: 77n, ino: 1842051n };

    function mockSmbIdentities(sourcePath, destinationPath) {
      const pick = (filePath) => {
        if (filePath === sourcePath) return SOURCE;
        if (filePath === destinationPath) return DESTINATION;
        return undefined;
      };
      mock(overrideStats({ lstat: pick, fstat: pick }));
    }

    it('owns a copied .original by its own descriptor identity, never the source identity', async () => {
      const sourcePath = path.join(tmpDir, 'image.png');
      const destinationPath = path.join(tmpDir, 'image.png.original');
      const bytes = Buffer.from('original bytes');
      fs.writeFileSync(sourcePath, bytes);
      mockSmbIdentities(sourcePath, destinationPath);
      const linkSpy = vi.spyOn(fs, 'linkSync');
      let owned;

      const result = await copyTrustedFileToOwnedFile({
        sourcePath,
        sourceExactIdentity: SOURCE,
        destinationPath,
        expectedSha256: sha256(bytes),
        onOwned: (identity) => { owned = identity; },
      });

      expect(linkSpy).not.toHaveBeenCalled();
      expect(owned).toEqual(DESTINATION);
      expect(result.exactIdentity).toEqual(DESTINATION);
      expect(result.exactIdentity).not.toEqual(SOURCE);
      expect(result.content).toEqual({ size: BigInt(bytes.length), sha256: sha256(bytes) });
      expect(fs.readFileSync(destinationPath)).toEqual(bytes);
      // Only the destination's own identity authorizes removal; the source identity never does.
      expect(removeFileIfExactIdentityMatches(destinationPath, SOURCE)).toBe(false);
      expect(fs.existsSync(destinationPath)).toBe(true);
      expect(removeFileIfExactIdentityMatches(destinationPath, result.exactIdentity)).toBe(true);
      expect(fs.readFileSync(sourcePath)).toEqual(bytes);
    });

    it('owns generated output by its own descriptor identity with no source involved', async () => {
      const sourcePath = path.join(tmpDir, 'image.png');
      const destinationPath = path.join(tmpDir, 'image.watermarked.png');
      fs.writeFileSync(sourcePath, 'source');
      mockSmbIdentities(sourcePath, destinationPath);
      const result = await createOwnedFile(destinationPath, writeBytes(Buffer.from('generated')));
      expect(result.exactIdentity).toEqual(DESTINATION);
    });
  });

  describe('copyTrustedFileToOwnedFile', () => {
    it('rejects a source that is not the trusted exact identity before creating anything', async () => {
      const sourcePath = path.join(tmpDir, 'source.bin');
      const destinationPath = path.join(tmpDir, 'destination.bin');
      fs.writeFileSync(sourcePath, 'bytes');
      const real = fs.lstatSync(sourcePath, { bigint: true });
      const failure = await copyTrustedFileToOwnedFile({
        sourcePath, sourceExactIdentity: { dev: real.dev, ino: real.ino + 1n }, destinationPath,
      }).catch((err) => err);
      expect(failure.reason).toBe(OWNED_FILE_FAILURE.sourceUnsafe);
      expect(fs.existsSync(destinationPath)).toBe(false);

      const unknown = await copyTrustedFileToOwnedFile({
        sourcePath, sourceExactIdentity: { dev: 0n, ino: 0n }, destinationPath,
      }).catch((err) => err);
      expect(unknown.reason).toBe(OWNED_FILE_FAILURE.sourceUnsafe);
      expect(fs.existsSync(destinationPath)).toBe(false);
    });

    it('rejects a source whose content does not match the expected hash; the hash grants no ownership', async () => {
      const sourcePath = path.join(tmpDir, 'source.bin');
      const destinationPath = path.join(tmpDir, 'destination.bin');
      fs.writeFileSync(sourcePath, 'tampered');
      let owned;
      const failure = await copyTrustedFileToOwnedFile({
        sourcePath,
        destinationPath,
        expectedSha256: sha256(Buffer.from('expected')),
        onOwned: (identity) => { owned = identity; },
      }).catch((err) => err);
      expect(failure.reason).toBe(OWNED_FILE_FAILURE.contentMismatch);
      expect(removeFileIfExactIdentityMatches(destinationPath, owned)).toBe(true);

      // A foreign file with identical bytes is still not ours.
      const foreign = path.join(tmpDir, 'foreign.bin');
      fs.writeFileSync(foreign, 'tampered');
      expect(removeFileIfExactIdentityMatches(foreign, owned)).toBe(false);
      expect(fs.existsSync(foreign)).toBe(true);
    });

    it('rejects an unexpected source size before creating the destination', async () => {
      const sourcePath = path.join(tmpDir, 'source.bin');
      const destinationPath = path.join(tmpDir, 'destination.bin');
      fs.writeFileSync(sourcePath, 'bytes');
      const failure = await copyTrustedFileToOwnedFile({
        sourcePath, destinationPath, expectedSize: 99,
      }).catch((err) => err);
      expect(failure.reason).toBe(OWNED_FILE_FAILURE.contentMismatch);
      expect(fs.existsSync(destinationPath)).toBe(false);
    });

    it('fails closed when the source changes while it is copied', async () => {
      const sourcePath = path.join(tmpDir, 'source.bin');
      const destinationPath = path.join(tmpDir, 'destination.bin');
      fs.writeFileSync(sourcePath, 'bytes');
      mock(overrideStats({
        fstat: (filePath, index) => (filePath === sourcePath && index > 0 ? { mtimeNs: 1n } : undefined),
      }));
      let owned;
      const failure = await copyTrustedFileToOwnedFile({
        sourcePath, destinationPath, onOwned: (identity) => { owned = identity; },
      }).catch((err) => err);
      expect(failure.reason).toBe(OWNED_FILE_FAILURE.sourceChanged);
      expect(removeFileIfExactIdentityMatches(destinationPath, owned)).toBe(true);
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe('bytes');
    });

    // WP1 diagnostics: the evidence names the failing comparison and every drifted field.
    it('reports which after-copy comparison and stat fields decided a source-changed failure', async () => {
      const sourcePath = path.join(tmpDir, 'source.bin');
      const destinationPath = path.join(tmpDir, 'destination.bin');
      fs.writeFileSync(sourcePath, 'bytes');
      const real = fs.lstatSync(sourcePath, { bigint: true });
      // Only the descriptor's post-copy metadata moves; identity, size, bytes and path hold.
      mock(overrideStats({
        fstat: (filePath, index) => (filePath === sourcePath && index > 0
          ? { mtimeNs: real.mtimeNs + 1n, ctimeNs: real.ctimeNs + 1n } : undefined),
      }));
      const failure = await copyTrustedFileToOwnedFile({
        sourcePath, destinationPath, expectedSha256: sha256(Buffer.from('bytes')),
      }).catch((err) => err);
      expect(failure.reason).toBe(OWNED_FILE_FAILURE.sourceChanged);
      const evidence = ownedFileSourceChangeEvidence(failure);
      expect(evidence).toMatchObject({
        phase: 'source-after-copy',
        failed: ['descriptor-continuity'],
        identityKnown: true,
        pathDescriptorIdentity: 'matched',
        changed: { 'opened-fstat/after-fstat': ['mtimeNs', 'ctimeNs'], 'opened-fstat/after-lstat': [] },
        involved: ['mtime', 'ctime'],
        copiedSize: '5',
        copiedContent: 'matched',
      });
      expect(Object.keys(evidence.observations))
        .toEqual(['before-lstat', 'opened-fstat', 'after-fstat', 'after-lstat']);
      expect(evidence.observations['after-fstat'].mtimeNs).toBe(String(real.mtimeNs + 1n));
      expect(evidence.observations['after-lstat'].mtimeNs).toBe(String(real.mtimeNs));
      expect(JSON.stringify(evidence)).not.toContain(tmpDir);
    });

    it('reports a pathname/descriptor identity mismatch when the source is opened', async () => {
      const sourcePath = path.join(tmpDir, 'source.bin');
      const destinationPath = path.join(tmpDir, 'destination.bin');
      fs.writeFileSync(sourcePath, 'bytes');
      const real = fs.lstatSync(sourcePath, { bigint: true });
      mock(overrideStats({
        lstat: (filePath) => (filePath === sourcePath ? { ino: real.ino + 1n } : undefined),
      }));
      const failure = await copyTrustedFileToOwnedFile({ sourcePath, destinationPath }).catch((err) => err);
      expect(failure.reason).toBe(OWNED_FILE_FAILURE.sourceChanged);
      expect(fs.existsSync(destinationPath)).toBe(false);
      expect(ownedFileSourceChangeEvidence(failure)).toMatchObject({
        phase: 'source-open',
        failed: ['open-continuity'],
        pathDescriptorIdentity: 'mismatched',
        changed: { 'before-lstat/opened-fstat': ['ino'] },
        involved: ['identity'],
      });
    });

    it('refuses a source that is not a regular file', async () => {
      const destinationPath = path.join(tmpDir, 'destination.bin');
      const failure = await copyTrustedFileToOwnedFile({
        sourcePath: tmpDir, destinationPath,
      }).catch((err) => err);
      expect(failure.reason).toBe(OWNED_FILE_FAILURE.sourceUnsafe);
      expect(fs.existsSync(destinationPath)).toBe(false);
    });

    it('applies requested times to the owned copy without changing the source', async () => {
      const sourcePath = path.join(tmpDir, 'timed-source.bin');
      const destinationPath = path.join(tmpDir, 'timed-destination.bin');
      const bytes = Buffer.from('timed copy');
      fs.writeFileSync(sourcePath, bytes);
      const sourceMtime = fs.statSync(sourcePath).mtime.toISOString();
      const mtime = new Date('2023-01-02T03:04:05.678Z');
      await copyTrustedFileToOwnedFile({
        sourcePath,
        destinationPath,
        expectedSha256: sha256(bytes),
        times: { atime: mtime.getTime() / 1000, mtime: mtime.getTime() / 1000 },
      });
      expect(fs.statSync(destinationPath).mtime.toISOString()).toBe(mtime.toISOString());
      expect(fs.statSync(sourcePath).mtime.toISOString()).toBe(sourceMtime);
      expect(fs.readFileSync(destinationPath)).toEqual(bytes);
    });

    it('copies multi-chunk content exactly and closes the source descriptor', async () => {
      const sourcePath = path.join(tmpDir, 'large-source.bin');
      const destinationPath = path.join(tmpDir, 'large-destination.bin');
      const bytes = Buffer.alloc(2.5 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) & 0xff;
      fs.writeFileSync(sourcePath, bytes);
      const closeSpy = vi.spyOn(fs, 'closeSync');
      const result = await copyTrustedFileToOwnedFile({
        sourcePath, destinationPath, expectedSha256: sha256(bytes), expectedSize: bytes.length,
      });
      // Source and destination descriptors, before readFileSync adds its own.
      expect(closeSpy).toHaveBeenCalledTimes(2);
      expect(result.content.sha256).toBe(sha256(bytes));
      expect(fs.readFileSync(destinationPath).equals(bytes)).toBe(true);
    });

    // WP3 C2 production trace (project 41, asset 3167, output 8): the publication copy's
    // pathname lstat of CreatorCrate's private stage and the descriptor it then opened agreed
    // on dev/ino, size and birth time, but the descriptor reported later mtime/ctime.
    describe('pinned owned source (WP3 C2)', () => {
      const PRODUCTION_ID = { dev: 77n, ino: 4069076n };
      const BIRTH = 1791508504536747700n;
      const PATH_TIME = 1791508504628750200n;
      const DESCRIPTOR_TIME = 1791508505669399100n;
      const bytes = Buffer.from('staged watermark output bytes');
      let sourcePath;
      let destinationPath;

      beforeEach(() => {
        sourcePath = path.join(tmpDir, 'stage.output');
        destinationPath = path.join(tmpDir, 'published.png');
        fs.writeFileSync(sourcePath, bytes);
      });

      // Every source stat reports the production identity and birth time; the first pathname
      // lstat (before open) reports PATH_TIME, everything later DESCRIPTOR_TIME. `lstat(index)`
      // and `fstat(index)` add per-call overrides on top.
      const productionStats = ({ lstat = () => ({}), fstat = () => ({}) } = {}) => {
        let lstats = 0;
        const times = (time) => ({ mtimeNs: time, ctimeNs: time });
        return mock(overrideStats({
          lstat: (filePath) => {
            if (filePath !== sourcePath) return undefined;
            const index = lstats;
            lstats += 1;
            return {
              ...PRODUCTION_ID, birthtimeNs: BIRTH, ...times(index === 0 ? PATH_TIME : DESCRIPTOR_TIME),
              ...lstat(index),
            };
          },
          fstat: (filePath, index) => (filePath === sourcePath
            ? { ...PRODUCTION_ID, birthtimeNs: BIRTH, ...times(DESCRIPTOR_TIME), ...fstat(index) } : undefined),
        }));
      };
      const unmock = () => restoreMocks.pop()();
      const pinnedCopy = (overrides = {}) => {
        let owned;
        return copyTrustedFileToOwnedFile({
          sourcePath,
          sourceExactIdentity: PRODUCTION_ID,
          destinationPath,
          expectedSha256: sha256(bytes),
          expectedSize: bytes.length,
          pinnedOwnedSource: true,
          onOwned: (identity) => { owned = identity; },
          ...overrides,
        }).then((result) => ({ result, owned }), (failure) => ({ failure, owned }));
      };

      it('reproduces the production open comparison: rejected unpinned, published when pinned', async () => {
        productionStats();
        const unpinned = await pinnedCopy({ pinnedOwnedSource: false });
        expect(unpinned.failure.reason).toBe(OWNED_FILE_FAILURE.sourceChanged);
        expect(fs.existsSync(destinationPath)).toBe(false);
        expect(ownedFileSourceChangeEvidence(unpinned.failure)).toMatchObject({
          phase: 'source-open',
          failed: ['open-continuity'],
          identityKnown: true,
          pathDescriptorIdentity: 'matched',
          changed: { 'before-lstat/opened-fstat': ['mtimeNs', 'ctimeNs'] },
          involved: ['mtime', 'ctime'],
          observations: {
            'before-lstat': { dev: '77', ino: '4069076', mtimeNs: String(PATH_TIME), birthtimeNs: String(BIRTH) },
            'opened-fstat': {
              dev: '77', ino: '4069076', mtimeNs: String(DESCRIPTOR_TIME), birthtimeNs: String(BIRTH),
            },
          },
        });
        unmock();

        productionStats();
        const { result, failure } = await pinnedCopy();
        expect(failure).toBeUndefined();
        expect(result.content).toEqual({ size: BigInt(bytes.length), sha256: sha256(bytes) });
        expect(fs.readFileSync(destinationPath).equals(bytes)).toBe(true);
        expect(fs.readFileSync(sourcePath).equals(bytes)).toBe(true);
      });

      it('rejects same-size changed source bytes under the same metadata disagreement', async () => {
        fs.writeFileSync(sourcePath, Buffer.from('staged watermark output BYTES'));
        productionStats();
        const { failure, owned } = await pinnedCopy();
        expect(failure.reason).toBe(OWNED_FILE_FAILURE.contentMismatch);
        // The partial destination is left for the caller's ownership-gated cleanup.
        expect(removeFileIfExactIdentityMatches(destinationPath, owned)).toBe(true);
      });

      it('rejects a foreign replacement at the pathname or behind the descriptor', async () => {
        productionStats({ lstat: (index) => (index === 0 ? { ino: PRODUCTION_ID.ino + 1n } : {}) });
        const pathForeign = await pinnedCopy();
        expect(pathForeign.failure.reason).toBe(OWNED_FILE_FAILURE.sourceChanged);
        expect(ownedFileSourceChangeEvidence(pathForeign.failure)).toMatchObject({
          phase: 'source-open', failed: ['open-continuity'], pathDescriptorIdentity: 'mismatched',
        });
        expect(fs.existsSync(destinationPath)).toBe(false);
        unmock();

        // Path and descriptor agree with each other but are not the owned stage.
        productionStats({ lstat: () => ({ ino: 9n }), fstat: () => ({ ino: 9n }) });
        const swapped = await pinnedCopy();
        expect(swapped.failure.reason).toBe(OWNED_FILE_FAILURE.sourceUnsafe);
        expect(fs.existsSync(destinationPath)).toBe(false);
      });

      it('rejects a differing birth time or size at open, and an unknown identity', async () => {
        productionStats({ lstat: (index) => (index === 0 ? { birthtimeNs: BIRTH + 1n } : {}) });
        const reborn = await pinnedCopy();
        expect(reborn.failure.reason).toBe(OWNED_FILE_FAILURE.sourceChanged);
        expect(ownedFileSourceChangeEvidence(reborn.failure).failed).toEqual(['open-continuity']);
        unmock();

        productionStats({ lstat: (index) => (index === 0 ? { size: BigInt(bytes.length + 1) } : {}) });
        const resized = await pinnedCopy();
        expect(resized.failure.reason).toBe(OWNED_FILE_FAILURE.sourceChanged);
        unmock();

        productionStats({ lstat: () => ({ dev: 0n, ino: 0n }), fstat: () => ({ dev: 0n, ino: 0n }) });
        const unknown = await pinnedCopy();
        expect(unknown.failure.reason).toBe(OWNED_FILE_FAILURE.sourceChanged);
        expect(fs.existsSync(destinationPath)).toBe(false);
      });

      it('rejects modification during the copy at the descriptor or the pathname', async () => {
        productionStats({ fstat: (index) => (index > 0 ? { mtimeNs: DESCRIPTOR_TIME + 1n } : {}) });
        const descriptorMoved = await pinnedCopy();
        expect(descriptorMoved.failure.reason).toBe(OWNED_FILE_FAILURE.sourceChanged);
        expect(ownedFileSourceChangeEvidence(descriptorMoved.failure).failed).toEqual(['descriptor-continuity']);
        expect(removeFileIfExactIdentityMatches(destinationPath, descriptorMoved.owned)).toBe(true);
        unmock();

        // After open the pathname must equal the opened descriptor exactly, write times included.
        productionStats({ lstat: (index) => (index > 0 ? { mtimeNs: PATH_TIME, ctimeNs: PATH_TIME } : {}) });
        const pathMoved = await pinnedCopy();
        expect(pathMoved.failure.reason).toBe(OWNED_FILE_FAILURE.sourceChanged);
        expect(ownedFileSourceChangeEvidence(pathMoved.failure).failed).toEqual(['path-continuity']);
        expect(removeFileIfExactIdentityMatches(destinationPath, pathMoved.owned)).toBe(true);
      });

      it('rejects an unexpected copied length', async () => {
        const reported = () => ({ size: BigInt(bytes.length + 1) });
        productionStats({ lstat: reported, fstat: reported });
        const { failure, owned } = await pinnedCopy({ expectedSize: bytes.length + 1 });
        expect(failure.reason).toBe(OWNED_FILE_FAILURE.sourceChanged);
        expect(ownedFileSourceChangeEvidence(failure).failed).toEqual(['copied-length']);
        expect(removeFileIfExactIdentityMatches(destinationPath, owned)).toBe(true);
      });

      it('refuses to pin a source without identity, size or SHA-256 proof', async () => {
        productionStats();
        for (const missing of [
          { sourceExactIdentity: undefined },
          { expectedSize: undefined },
          { expectedSha256: undefined },
          { expectedSha256: 'not-a-sha256' },
        ]) {
          const { failure } = await pinnedCopy(missing);
          expect(failure.reason).toBe(OWNED_FILE_FAILURE.sourceUnsafe);
          expect(fs.existsSync(destinationPath)).toBe(false);
        }
      });
    });
  });
});
