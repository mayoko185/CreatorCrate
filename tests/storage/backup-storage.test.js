import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveBackupDir,
  resolveBackupFile,
  generateBackupFilename,
  formatBackupTimestamp,
  isManagedBackupFilename,
} from '../../src/storage/backup-storage.js';
import { StorageError } from '../../src/storage/path-manager.js';

function symlinksSupported() {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-symlink-test-'));
    const target = path.join(tmp, 'target');
    const link = path.join(tmp, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'junction');
    fs.rmSync(tmp, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

describe('backup-storage', () => {
  let appDataRoot;

  beforeEach(() => {
    appDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-backup-storage-'));
  });

  afterEach(() => {
    fs.rmSync(appDataRoot, { recursive: true, force: true });
  });

  describe('formatBackupTimestamp', () => {
    it('produces a filesystem-safe UTC timestamp', () => {
      const ts = formatBackupTimestamp(new Date('2026-07-29T19:24:47.123Z'));
      expect(ts).toBe('2026-07-29T192447Z');
      expect(ts).not.toMatch(/:/);
    });
  });

  describe('resolveBackupDir', () => {
    it('creates the backup directory beneath APP_DATA_ROOT if missing', () => {
      const dir = resolveBackupDir(appDataRoot);
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
      expect(path.dirname(dir)).toBe(path.resolve(appDataRoot));
    });

    it('is idempotent when the directory already exists', () => {
      const dir1 = resolveBackupDir(appDataRoot);
      const dir2 = resolveBackupDir(appDataRoot);
      expect(dir1).toBe(dir2);
    });

    it('rejects a backup directory that is a symlink', () => {
      if (!symlinksSupported()) return;
      const realDir = path.join(appDataRoot, 'real-backups');
      fs.mkdirSync(realDir);
      const linkDir = path.join(appDataRoot, 'backups');
      fs.symlinkSync(realDir, linkDir, 'junction');

      expect(() => resolveBackupDir(appDataRoot)).toThrow(StorageError);
    });

    it('rejects a path that exists but is not a directory', () => {
      fs.writeFileSync(path.join(appDataRoot, 'backups'), 'not a dir');
      expect(() => resolveBackupDir(appDataRoot)).toThrow(StorageError);
    });
  });

  describe('generateBackupFilename', () => {
    it('generates a timestamped, portable filename', () => {
      const dir = resolveBackupDir(appDataRoot);
      const name = generateBackupFilename(dir, new Date('2026-07-29T19:24:47Z'));
      expect(name).toBe('creatorcrate-2026-07-29T192447Z.sqlite');
      expect(isManagedBackupFilename(name)).toBe(true);
    });

    it('is collision-safe when called twice for the same second', () => {
      const dir = resolveBackupDir(appDataRoot);
      const date = new Date('2026-07-29T19:24:47Z');
      const first = generateBackupFilename(dir, date);
      fs.writeFileSync(path.join(dir, first), 'x');
      const second = generateBackupFilename(dir, date);
      expect(second).not.toBe(first);
      expect(second).toBe('creatorcrate-2026-07-29T192447Z-1.sqlite');
    });
  });

  describe('isManagedBackupFilename', () => {
    it('accepts application-generated names', () => {
      expect(isManagedBackupFilename('creatorcrate-2026-07-29T192447Z.sqlite')).toBe(true);
      expect(isManagedBackupFilename('creatorcrate-2026-07-29T192447Z-3.sqlite')).toBe(true);
    });

    it('rejects unmanaged names, including staging/rollback artifacts', () => {
      expect(isManagedBackupFilename('creatorcrate-2026-07-29T192447Z.sqlite.staging')).toBe(false);
      expect(isManagedBackupFilename('creatorcrate.db.rollback')).toBe(false);
      expect(isManagedBackupFilename('random.sqlite')).toBe(false);
      expect(isManagedBackupFilename('../../etc/passwd')).toBe(false);
    });
  });

  describe('resolveBackupFile', () => {
    it('resolves a managed filename within the backup directory', () => {
      const dir = resolveBackupDir(appDataRoot);
      const name = generateBackupFilename(dir);
      fs.writeFileSync(path.join(dir, name), 'x');
      const resolved = resolveBackupFile(dir, name);
      expect(resolved).toBe(path.join(dir, name));
    });

    it('rejects traversal filenames', () => {
      const dir = resolveBackupDir(appDataRoot);
      expect(() => resolveBackupFile(dir, '../../etc/passwd')).toThrow(StorageError);
      expect(() => resolveBackupFile(dir, '..\\..\\creatorcrate.db')).toThrow(StorageError);
    });

    it('rejects absolute path filenames', () => {
      const dir = resolveBackupDir(appDataRoot);
      const absolute = path.resolve(appDataRoot, 'creatorcrate-2026-07-29T192447Z.sqlite');
      expect(() => resolveBackupFile(dir, absolute)).toThrow(StorageError);
    });

    it('rejects filenames not matching the managed naming contract', () => {
      const dir = resolveBackupDir(appDataRoot);
      expect(() => resolveBackupFile(dir, 'evil.sqlite')).toThrow(StorageError);
    });

    it('rejects a symlinked backup file', () => {
      if (!symlinksSupported()) return;
      const dir = resolveBackupDir(appDataRoot);
      const real = path.join(appDataRoot, 'elsewhere.sqlite');
      fs.writeFileSync(real, 'x');
      const name = 'creatorcrate-2026-07-29T192447Z.sqlite';
      fs.symlinkSync(real, path.join(dir, name), 'file');

      expect(() => resolveBackupFile(dir, name)).toThrow(StorageError);
    });
  });
});
