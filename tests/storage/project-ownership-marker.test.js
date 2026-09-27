import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROJECT_OWNERSHIP_MARKER_FILENAME,
  PROJECT_OWNERSHIP_MARKER_MAX_BYTES,
  PROJECT_OWNERSHIP_MARKER_SIZE,
  ProjectOwnershipMarkerError,
  createProjectOwnershipMarker,
  PROJECT_OWNERSHIP_MARKER_QUARANTINE_PREFIX,
  generateProjectOwnershipToken,
  inspectProjectOwnershipMarker,
  isProjectOwnershipMarkerName,
  isValidProjectOwnershipToken,
  parseProjectOwnershipMarker,
  projectOwnershipMarkerPath,
  quarantineProjectOwnershipMarker,
  readProjectOwnershipMarker,
  restoreQuarantinedProjectOwnershipMarker,
  serializeProjectOwnershipMarker,
  verifyProjectOwnershipMarker,
} from '../../src/storage/project-ownership-marker.js';

// Version-1 on-disk format: "creatorcrate-owner/1 <64 lowercase hex>\n".
const TOKEN_X = 'a'.repeat(64);
const TOKEN_Y = 'b'.repeat(64);
const MARKER_X = `creatorcrate-owner/1 ${TOKEN_X}\n`;

function trySymlink(target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) return false;
    throw err;
  }
}

describe('project ownership marker', () => {
  let tmpDir;
  let projectDir;
  let markerPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-owner-marker-'));
    projectDir = path.join(tmpDir, '000001-project');
    fs.mkdirSync(projectDir);
    markerPath = path.join(projectDir, PROJECT_OWNERSHIP_MARKER_FILENAME);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('token', () => {
    it('generates valid, distinct tokens', () => {
      const tokens = Array.from({ length: 8 }, () => generateProjectOwnershipToken());
      for (const token of tokens) expect(isValidProjectOwnershipToken(token)).toBe(true);
      expect(new Set(tokens).size).toBe(tokens.length);
    });

    it('rejects malformed tokens', () => {
      for (const value of [
        '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}g`,
        ` ${'a'.repeat(63)}`, `${'a'.repeat(64)}\n`, null, undefined, 42,
      ]) {
        expect(isValidProjectOwnershipToken(value)).toBe(false);
      }
    });
  });

  describe('format', () => {
    it('serializes the exact version-1 representation', () => {
      expect(serializeProjectOwnershipMarker(TOKEN_X)).toBe(MARKER_X);
      expect(Buffer.byteLength(MARKER_X)).toBe(PROJECT_OWNERSHIP_MARKER_SIZE);
      expect(() => serializeProjectOwnershipMarker('nope')).toThrow(ProjectOwnershipMarkerError);
    });

    it('parses only the exact representation', () => {
      expect(parseProjectOwnershipMarker(Buffer.from(MARKER_X))).toBe(TOKEN_X);
      for (const text of [
        '',
        MARKER_X.trimEnd(),
        `${MARKER_X}\n`,
        MARKER_X.replace('\n', '\r\n'),
        `﻿${MARKER_X}`,
        ` ${MARKER_X}`,
        MARKER_X.replace('/1 ', '/2 '),
        MARKER_X.replace('/1 ', '/1  ').slice(0, -2) + '\n',
        MARKER_X.replace(TOKEN_X, TOKEN_X.toUpperCase()),
        `creatorcrate-owner/1 ${'a'.repeat(63)}\n`,
      ]) {
        expect(parseProjectOwnershipMarker(Buffer.from(text))).toBeNull();
      }
      const invalidUtf8 = Buffer.from(MARKER_X);
      invalidUtf8[25] = 0xff;
      expect(parseProjectOwnershipMarker(invalidUtf8)).toBeNull();
    });

    it('recognizes the reserved name in any casing only', () => {
      expect(isProjectOwnershipMarkerName('.creatorcrate-owner')).toBe(true);
      expect(isProjectOwnershipMarkerName('.CreatorCrate-Owner')).toBe(true);
      expect(isProjectOwnershipMarkerName('.creatorcrate-owner.tmp')).toBe(false);
      expect(isProjectOwnershipMarkerName('creatorcrate-owner')).toBe(false);
    });

    it('places the marker directly inside the project directory', () => {
      expect(projectOwnershipMarkerPath(projectDir)).toBe(markerPath);
      expect(() => projectOwnershipMarkerPath('relative/dir')).toThrow(ProjectOwnershipMarkerError);
    });
  });

  describe('create and read', () => {
    it('creates, reads, and verifies a marker', () => {
      expect(createProjectOwnershipMarker(projectDir, TOKEN_X)).toEqual({ status: 'created' });
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_X);
      expect(fs.readdirSync(projectDir)).toEqual([PROJECT_OWNERSHIP_MARKER_FILENAME]);
      expect(readProjectOwnershipMarker(projectDir)).toEqual({ status: 'valid', token: TOKEN_X });
    });

    it('never overwrites an existing marker', () => {
      createProjectOwnershipMarker(projectDir, TOKEN_Y);
      expect(createProjectOwnershipMarker(projectDir, TOKEN_X)).toEqual({ status: 'exists' });
      expect(createProjectOwnershipMarker(projectDir, TOKEN_Y)).toEqual({ status: 'exists' });
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(`creatorcrate-owner/1 ${TOKEN_Y}\n`);
    });

    it('never overwrites a malformed file or directory at the marker path', () => {
      fs.writeFileSync(markerPath, 'not a marker');
      expect(createProjectOwnershipMarker(projectDir, TOKEN_X)).toEqual({ status: 'exists' });
      expect(fs.readFileSync(markerPath, 'utf8')).toBe('not a marker');

      fs.rmSync(markerPath);
      fs.mkdirSync(markerPath);
      expect(createProjectOwnershipMarker(projectDir, TOKEN_X)).toEqual({ status: 'exists' });
      expect(fs.statSync(markerPath).isDirectory()).toBe(true);
    });

    it('rejects an invalid token before touching the filesystem', () => {
      expect(() => createProjectOwnershipMarker(projectDir, 'bad')).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOKEN' }),
      );
      expect(fs.existsSync(markerPath)).toBe(false);
    });

    it('refuses a missing or non-directory project directory', () => {
      const missing = path.join(tmpDir, 'missing');
      expect(() => createProjectOwnershipMarker(missing, TOKEN_X)).toThrowError(
        expect.objectContaining({ code: 'PROJECT_DIRECTORY_UNSAFE' }),
      );
      const file = path.join(tmpDir, 'file');
      fs.writeFileSync(file, '');
      expect(() => createProjectOwnershipMarker(file, TOKEN_X)).toThrowError(
        expect.objectContaining({ code: 'PROJECT_DIRECTORY_UNSAFE' }),
      );
      expect(readProjectOwnershipMarker(file)).toMatchObject({ status: 'unsafe' });
    });

    describe('failure after the marker pathname is exposed', () => {
      const MARKER_FOREIGN = `creatorcrate-owner/1 ${'c'.repeat(64)}\n`;
      const eio = () => Object.assign(new Error('EIO'), { code: 'EIO' });
      const isMarkerPath = (target) => String(target) === markerPath;

      // Fail the first call to `method`, delegating every other call.
      function failOnce(method, before = () => {}) {
        const real = fs[method];
        let failed = false;
        return vi.spyOn(fs, method).mockImplementation((...args) => {
          if (failed) return real(...args);
          failed = true;
          before(real, args);
          throw eio();
        });
      }

      function expectRetained(expectedCause) {
        let error;
        try {
          createProjectOwnershipMarker(projectDir, TOKEN_X);
        } catch (err) {
          error = err;
        }
        expect(error).toBeInstanceOf(ProjectOwnershipMarkerError);
        expect(error.code).toBe('RECOVERY_REQUIRED');
        expect(error.cause).toMatchObject({ name: 'ProjectOwnershipMarkerError', code: expectedCause });
        expect(error.message).not.toContain(projectDir);
        expect(fs.statSync(markerPath).isFile()).toBe(true);
        return error;
      }

      it('retains the marker when the initial identity stat fails', () => {
        failOnce('fstatSync');
        expectRetained('WRITE_FAILED');
        expect(fs.statSync(markerPath).size).toBe(0);
      });

      it('retains the marker when the first write fails', () => {
        failOnce('writeSync');
        expect(expectRetained('WRITE_FAILED').cause.cause).toMatchObject({ code: 'EIO' });
        expect(fs.statSync(markerPath).size).toBe(0);
      });

      it('retains a partially written marker', () => {
        const realWrite = fs.writeSync;
        let calls = 0;
        vi.spyOn(fs, 'writeSync').mockImplementation((fd, buffer, offset, length, ...rest) => {
          calls += 1;
          if (calls === 1) return realWrite(fd, buffer, offset, Math.min(length, 10), ...rest);
          throw eio();
        });
        expectRetained('WRITE_FAILED');
        expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_X.slice(0, 10));
        expect(readProjectOwnershipMarker(projectDir)).toEqual({ status: 'malformed', reason: 'invalid-format' });
      });

      it('retains the marker when fsync fails', () => {
        failOnce('fsyncSync');
        expectRetained('WRITE_FAILED');
        expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_X);
      });

      it('retains the marker when close fails', () => {
        // The descriptor really closes; only the reply is lost.
        failOnce('closeSync', (real, args) => real(...args));
        expectRetained('WRITE_FAILED');
        expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_X);
      });

      it('retains the marker when the read-back fails', () => {
        vi.spyOn(fs, 'readSync').mockImplementation(() => { throw eio(); });
        expectRetained('VERIFY_FAILED');
        vi.restoreAllMocks();
        expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_X);
      });

      it('retains a marker whose read-back content does not match the token', () => {
        // Same file, rewritten in place with another token after close.
        const realClose = fs.closeSync;
        let swapped = false;
        vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
          realClose(fd);
          if (swapped) return;
          swapped = true;
          fs.writeFileSync(markerPath, MARKER_FOREIGN, { flag: 'r+' });
        });
        expectRetained('VERIFY_FAILED');
        expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_FOREIGN);
      });

      it('retains the marker when the final validation stat fails', () => {
        const realLstat = fs.lstatSync;
        let markerStats = 0;
        vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) => {
          // First marker lstat is the read-back; the second is final validation.
          if (isMarkerPath(target) && ++markerStats === 2) throw eio();
          return realLstat(target, ...rest);
        });
        expectRetained('VERIFY_FAILED');
        vi.restoreAllMocks();
        expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_X);
      });

      it('retains the marker when the filesystem reports a zero file ID', () => {
        const realFstat = fs.fstatSync;
        let first = true;
        vi.spyOn(fs, 'fstatSync').mockImplementation((...args) => {
          const stats = realFstat(...args);
          if (!first) return stats;
          first = false;
          return { dev: stats.dev, ino: 0n };
        });
        failOnce('fsyncSync');
        expectRetained('WRITE_FAILED');
        expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_X);
      });

      // After close, the first lstat of the marker pathname returns what is
      // there, then a foreign process replaces the entry. With the old
      // identity-check-then-unlink cleanup this lstat was the cleanup's
      // observation and the following unlink deleted the replacement.
      function replaceAfterObservation({ afterMarkerLstats = 0 } = {}) {
        const realClose = fs.closeSync;
        const realLstat = fs.lstatSync;
        let closed = false;
        let seen = 0;
        let replaced = false;
        vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
          realClose(fd);
          closed = true;
        });
        vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) => {
          const stats = realLstat(target, ...rest);
          if (closed && !replaced && isMarkerPath(target) && ++seen > afterMarkerLstats) {
            replaced = true;
            fs.unlinkSync(markerPath);
            fs.writeFileSync(markerPath, MARKER_FOREIGN);
          }
          return stats;
        });
        const unlink = vi.spyOn(fs, 'unlinkSync');
        const rename = vi.spyOn(fs, 'renameSync');
        return {
          markerUnlinks: () => unlink.mock.calls.filter(([target]) => isMarkerPath(target)).length
            - (replaced ? 1 : 0),
          rename,
          replaced: () => replaced,
        };
      }

      it('never unlinks the public marker after a write failure (late foreign replacement)', () => {
        failOnce('fsyncSync');
        const probe = replaceAfterObservation();
        expectRetained('WRITE_FAILED');
        expect(probe.replaced()).toBe(false);
        expect(probe.markerUnlinks()).toBe(0);
        expect(probe.rename).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        // No pathname was inspected for cleanup, so the retained entry is
        // this operation's own complete but unconfirmed marker.
        expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_X);
      });

      it('keeps a foreign replacement byte-for-byte when verification fails', () => {
        vi.spyOn(fs, 'readSync').mockImplementation(() => { throw eio(); });
        // Replace at the final-validation lstat (the last marker observation).
        const probe = replaceAfterObservation({ afterMarkerLstats: 1 });
        expectRetained('VERIFY_FAILED');
        expect(probe.replaced()).toBe(true);
        expect(probe.markerUnlinks()).toBe(0);
        expect(probe.rename).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        expect(fs.readFileSync(markerPath)).toEqual(Buffer.from(MARKER_FOREIGN, 'ascii'));
      });
    });

    it('reports a missing marker', () => {
      expect(readProjectOwnershipMarker(projectDir)).toEqual({ status: 'missing' });
    });

    it('reports malformed and oversized markers', () => {
      fs.writeFileSync(markerPath, MARKER_X.replace('\n', '\r\n'));
      expect(readProjectOwnershipMarker(projectDir)).toEqual({ status: 'malformed', reason: 'invalid-format' });

      fs.writeFileSync(markerPath, '');
      expect(readProjectOwnershipMarker(projectDir)).toEqual({ status: 'malformed', reason: 'invalid-format' });

      fs.writeFileSync(markerPath, MARKER_X.repeat(4));
      expect(Buffer.byteLength(MARKER_X.repeat(4))).toBeGreaterThan(PROJECT_OWNERSHIP_MARKER_MAX_BYTES);
      expect(readProjectOwnershipMarker(projectDir)).toEqual({ status: 'malformed', reason: 'oversized' });
    });

    it('reports a directory at the marker path as unsafe', () => {
      fs.mkdirSync(markerPath);
      expect(readProjectOwnershipMarker(projectDir)).toEqual({ status: 'unsafe', reason: 'not-regular-file' });
    });

    it('reports a symlinked marker as unsafe without following it', (ctx) => {
      const target = path.join(tmpDir, 'elsewhere');
      fs.writeFileSync(target, MARKER_X);
      if (!trySymlink(target, markerPath, 'file')) ctx.skip();
      expect(readProjectOwnershipMarker(projectDir)).toEqual({ status: 'unsafe', reason: 'symlink' });
      expect(verifyProjectOwnershipMarker(projectDir, TOKEN_X)).toEqual({ status: 'unsafe', reason: 'symlink' });
      expect(createProjectOwnershipMarker(projectDir, TOKEN_Y)).toEqual({ status: 'exists' });
      expect(fs.readFileSync(target, 'utf8')).toBe(MARKER_X);
    });

    it('reports a symlinked project directory as unsafe', (ctx) => {
      fs.writeFileSync(markerPath, MARKER_X);
      const linkedDir = path.join(tmpDir, 'linked');
      if (!trySymlink(projectDir, linkedDir, 'junction')) ctx.skip();
      expect(readProjectOwnershipMarker(linkedDir)).toMatchObject({ status: 'unsafe' });
    });

    it('keeps I/O failure distinct from a mismatch', () => {
      fs.writeFileSync(markerPath, MARKER_X);
      vi.spyOn(fs, 'readSync').mockImplementation(() => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      });
      expect(readProjectOwnershipMarker(projectDir)).toEqual({ status: 'unreadable', code: 'EIO' });
      expect(verifyProjectOwnershipMarker(projectDir, TOKEN_Y)).toEqual({ status: 'unreadable', code: 'EIO' });
    });

    it('keeps a permission failure on open distinct from a mismatch', () => {
      fs.writeFileSync(markerPath, MARKER_X);
      vi.spyOn(fs, 'openSync').mockImplementation(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });
      expect(readProjectOwnershipMarker(projectDir)).toEqual({ status: 'unreadable', code: 'EACCES' });
    });
  });

  describe('verify', () => {
    it('distinguishes match, mismatch, missing, malformed, and unsafe', () => {
      expect(verifyProjectOwnershipMarker(projectDir, TOKEN_X)).toEqual({ status: 'missing' });

      createProjectOwnershipMarker(projectDir, TOKEN_X);
      expect(verifyProjectOwnershipMarker(projectDir, TOKEN_X)).toEqual({ status: 'match' });
      expect(verifyProjectOwnershipMarker(projectDir, TOKEN_Y)).toEqual({ status: 'mismatch' });

      fs.writeFileSync(markerPath, 'garbage');
      expect(verifyProjectOwnershipMarker(projectDir, TOKEN_X)).toMatchObject({ status: 'malformed' });

      fs.rmSync(markerPath);
      fs.mkdirSync(markerPath);
      expect(verifyProjectOwnershipMarker(projectDir, TOKEN_X)).toMatchObject({ status: 'unsafe' });
    });

    it('never modifies a mismatching marker', () => {
      createProjectOwnershipMarker(projectDir, TOKEN_Y);
      verifyProjectOwnershipMarker(projectDir, TOKEN_X);
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(`creatorcrate-owner/1 ${TOKEN_Y}\n`);
    });

    it('rejects an invalid expected token', () => {
      expect(() => verifyProjectOwnershipMarker(projectDir, 'bad')).toThrow(ProjectOwnershipMarkerError);
    });
  });

  describe('logical portability', () => {
    it('keeps the token when the project directory is renamed or moved', () => {
      createProjectOwnershipMarker(projectDir, TOKEN_X);
      const renamed = path.join(tmpDir, '000001-renamed');
      fs.renameSync(projectDir, renamed);
      expect(verifyProjectOwnershipMarker(renamed, TOKEN_X)).toEqual({ status: 'match' });

      const otherRoot = path.join(tmpDir, 'other-root');
      fs.mkdirSync(otherRoot);
      const moved = path.join(otherRoot, '000001-renamed');
      fs.renameSync(renamed, moved);
      expect(readProjectOwnershipMarker(moved)).toEqual({ status: 'valid', token: TOKEN_X });
    });

    it('carries the same logical token in a marker-preserving copy', () => {
      createProjectOwnershipMarker(projectDir, TOKEN_X);
      const copy = path.join(tmpDir, 'copy');
      fs.cpSync(projectDir, copy, { recursive: true });
      expect(readProjectOwnershipMarker(copy)).toEqual({ status: 'valid', token: TOKEN_X });
    });
  });
  describe('quarantine restore (explicit recovery)', () => {
    const MARKER_Y = `creatorcrate-owner/1 ${TOKEN_Y}
`;
    const isCreate = (flags) => typeof flags === 'number' && (flags & fs.constants.O_CREAT) !== 0;
    const isMarker = (target) => path.basename(String(target)) === PROJECT_OWNERSHIP_MARKER_FILENAME;
    const quarantined = () => fs.readdirSync(projectDir).filter((name) => name.startsWith(PROJECT_OWNERSHIP_MARKER_QUARANTINE_PREFIX));

    function quarantineOld(content = MARKER_X) {
      fs.writeFileSync(markerPath, content);
      const moved = quarantineProjectOwnershipMarker(projectDir, inspectProjectOwnershipMarker(projectDir).evidence);
      expect(moved.status).toBe('quarantined');
      expect(fs.existsSync(markerPath)).toBe(false);
      return moved.quarantine;
    }

    // A share without link(2): restore must use the exclusive-create fallback.
    function withoutHardLinks() {
      vi.spyOn(fs, 'linkSync').mockImplementation(() => {
        throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' });
      });
    }

    function eio() {
      return Object.assign(new Error('EIO'), { code: 'EIO' });
    }

    it('hard link: restores the exact marker and removes the quarantine', () => {
      const quarantine = quarantineOld();
      expect(restoreQuarantinedProjectOwnershipMarker(projectDir, quarantine)).toBe('restored');
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_X);
      expect(quarantined()).toEqual([]);
    });

    it('hard link: never replaces a marker that appeared, and keeps the quarantine', () => {
      const quarantine = quarantineOld();
      fs.writeFileSync(markerPath, MARKER_Y);
      expect(restoreQuarantinedProjectOwnershipMarker(projectDir, quarantine)).toBe('occupied');
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_Y);
      expect(fs.readFileSync(quarantine.path, 'utf8')).toBe(MARKER_X);
    });

    it('no hard links: restores the exact bytes when the marker path stays free', () => {
      const quarantine = quarantineOld('old-malformed-bytes');
      withoutHardLinks();
      expect(restoreQuarantinedProjectOwnershipMarker(projectDir, quarantine)).toBe('restored');
      expect(fs.readFileSync(markerPath, 'utf8')).toBe('old-malformed-bytes');
      expect(quarantined()).toEqual([]);
    });

    it('no hard links: a marker created just before the exclusive create is never overwritten', () => {
      const quarantine = quarantineOld();
      withoutHardLinks();
      const realOpen = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        if (isMarker(target) && isCreate(flags) && !fs.existsSync(target)) fs.writeFileSync(target, MARKER_Y);
        return realOpen(target, flags, ...rest);
      });
      expect(restoreQuarantinedProjectOwnershipMarker(projectDir, quarantine)).toBe('occupied');
      vi.restoreAllMocks();
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_Y);
      expect(fs.readFileSync(quarantine.path, 'utf8')).toBe(MARKER_X);
    });

    // Exclusive-copy fallback with a fault injected on the restoration copy's
    // own descriptor (opened with O_CREAT on the marker path). Returns the
    // public-path unlink spy so callers can prove no pathname cleanup ran.
    function faultCopy(method, fault = () => { throw eio(); }) {
      withoutHardLinks();
      const realOpen = fs.openSync;
      const realMethod = fs[method];
      const copy = { fd: null };
      vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        const fd = realOpen(target, flags, ...rest);
        if (isMarker(target) && isCreate(flags)) copy.fd = fd;
        return fd;
      });
      vi.spyOn(fs, method).mockImplementation((fd, ...rest) => (
        fd === copy.fd ? fault(realMethod, fd, ...rest) : realMethod(fd, ...rest)
      ));
      const realUnlink = fs.unlinkSync;
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => realUnlink(target));
      return { copy, publicUnlinks: () => unlinkSpy.mock.calls.filter(([target]) => isMarker(target)) };
    }

    // Once the copy is visible at the marker path, an unverified restore keeps
    // it exactly as found (even when it is provably this call's own file),
    // keeps the quarantine, and reports failure.
    it.each([
      ['write', 'writeSync'],
      ['fsync', 'fsyncSync'],
      ['close', 'closeSync'],
    ])('no hard links: a %s failure retains the exposed copy and the quarantine', (_label, method) => {
      const quarantine = quarantineOld();
      const { publicUnlinks } = faultCopy(method, (real, fd, ...rest) => {
        if (method === 'closeSync') real(fd, ...rest); // closed, but reported as failed
        throw eio();
      });
      expect(restoreQuarantinedProjectOwnershipMarker(projectDir, quarantine)).toBe('failed');
      expect(publicUnlinks()).toEqual([]);
      vi.restoreAllMocks();
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(fs.readFileSync(quarantine.path, 'utf8')).toBe(MARKER_X);
    });

    it('no hard links: a read-back failure retains the copy and the quarantine', () => {
      const quarantine = quarantineOld();
      withoutHardLinks();
      const realOpen = fs.openSync;
      const realRead = fs.readSync;
      const realUnlink = fs.unlinkSync;
      let created = false;
      let readBackFd = null;
      vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...rest) => {
        const fd = realOpen(target, flags, ...rest);
        if (isMarker(target) && isCreate(flags)) created = true;
        else if (isMarker(target) && created) readBackFd = fd;
        return fd;
      });
      vi.spyOn(fs, 'readSync').mockImplementation((fd, ...rest) => {
        if (fd === readBackFd) throw eio();
        return realRead(fd, ...rest);
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => realUnlink(target));
      expect(restoreQuarantinedProjectOwnershipMarker(projectDir, quarantine)).toBe('failed');
      expect(unlinkSpy.mock.calls.filter(([target]) => isMarker(target))).toEqual([]);
      vi.restoreAllMocks();
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_X);
      expect(fs.readFileSync(quarantine.path, 'utf8')).toBe(MARKER_X);
    });

    it('no hard links: a copy whose content does not verify is retained with the quarantine', () => {
      const quarantine = quarantineOld();
      // The share acknowledges the write but stores different bytes.
      faultCopy('writeSync', (real, fd, buffer, offset, length) => {
        real(fd, Buffer.from(MARKER_Y), 0, MARKER_Y.length);
        return length;
      });
      expect(restoreQuarantinedProjectOwnershipMarker(projectDir, quarantine)).toBe('failed');
      vi.restoreAllMocks();
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(MARKER_Y);
      expect(fs.readFileSync(quarantine.path, 'utf8')).toBe(MARKER_X);
    });

    it('no hard links: with a zero/unknown file ID a failed copy is still retained', () => {
      const quarantine = quarantineOld();
      const { copy, publicUnlinks } = faultCopy('fsyncSync');
      const realFstat = fs.fstatSync;
      vi.spyOn(fs, 'fstatSync').mockImplementation((fd, ...rest) => {
        const stat = realFstat(fd, ...rest);
        if (fd === copy.fd) stat.ino = typeof stat.ino === 'bigint' ? 0n : 0;
        return stat;
      });
      expect(restoreQuarantinedProjectOwnershipMarker(projectDir, quarantine)).toBe('failed');
      expect(publicUnlinks()).toEqual([]);
      vi.restoreAllMocks();
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(fs.readFileSync(quarantine.path, 'utf8')).toBe(MARKER_X);
    });

    // Late race: the old rollback re-checked the copy's identity by pathname
    // and then unlinked the pathname. A foreign marker that replaces the copy
    // between that check and the unlink must survive.
    it('no hard links: a foreign marker that replaces a failed copy after its last identity check survives', () => {
      const quarantine = quarantineOld();
      const { copy, publicUnlinks } = faultCopy('fsyncSync');
      const realFstat = fs.fstatSync;
      const realLstat = fs.lstatSync;
      const realRename = fs.renameSync;
      let copyIdentity = null;
      let sawOwnCopy = false;
      let replaced = false;
      vi.spyOn(fs, 'fstatSync').mockImplementation((fd, ...rest) => {
        const stat = realFstat(fd, ...rest);
        if (fd === copy.fd) copyIdentity = { dev: stat.dev, ino: stat.ino };
        return stat;
      });
      const replaceWithForeign = () => {
        const staged = path.join(projectDir, 'foreign-staging');
        fs.writeFileSync(staged, MARKER_Y);
        realRename(staged, markerPath);
        replaced = true;
      };
      vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) => {
        const stat = realLstat(target, ...rest);
        if (!replaced && copyIdentity && isMarker(target)) {
          // The check still sees this operation's copy...
          sawOwnCopy = stat.dev === copyIdentity.dev && stat.ino === copyIdentity.ino;
          // ...and the copy is replaced immediately afterwards.
          replaceWithForeign();
        }
        return stat;
      });
      expect(restoreQuarantinedProjectOwnershipMarker(projectDir, quarantine)).toBe('failed');
      if (!replaced) replaceWithForeign(); // no pathname check ran: replace after the failure instead
      else expect(sawOwnCopy).toBe(true);
      const unlinks = publicUnlinks();
      vi.restoreAllMocks();
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(fs.readFileSync(markerPath)).toEqual(Buffer.from(MARKER_Y));
      expect(fs.readFileSync(quarantine.path, 'utf8')).toBe(MARKER_X);
      expect(unlinks).toEqual([]);
    });

    it('no hard links: a quarantine that is no longer the entry set aside is left alone', () => {
      const quarantine = quarantineOld();
      fs.writeFileSync(quarantine.path, MARKER_Y);
      withoutHardLinks();
      expect(restoreQuarantinedProjectOwnershipMarker(projectDir, quarantine)).toBe('failed');
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.readFileSync(quarantine.path, 'utf8')).toBe(MARKER_Y);
    });
  });
});
