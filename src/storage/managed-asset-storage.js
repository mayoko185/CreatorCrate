import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Birth time can be a mutable ctime fallback. Only stable filesystem IDs prove
// identity; missing IDs fail closed rather than falling back to path/timestamps.
const same = (a, b) => a && b && typeof a.dev === 'bigint' && a.dev >= 0n
  && typeof a.ino === 'bigint' && a.ino > 0n && a.dev === b.dev && a.ino === b.ino;
const stat = (p) => fs.lstatSync(p, { bigint: true });

/** Private generated paths only. No Project storage dependencies or replacement writes. */
export function createManagedAssetStorage({ managedAssetRoot }) {
  const root = path.resolve(managedAssetRoot);
  function directory(p) {
    const s = stat(p);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Unsafe managed directory.');
    return s;
  }
  function parents(p) {
    const relative = path.relative(root, p);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe managed path.');
    directory(root);
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      directory(current);
    }
  }
  function ensure(p) {
    try { fs.mkdirSync(p, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    directory(p);
  }
  function removeFile(p, identity) {
    try {
      parents(path.dirname(p));
      const current = stat(p);
      if (!current.isFile() || current.isSymbolicLink() || !same(current, identity)) return false;
      fs.unlinkSync(p);
      return true;
    } catch (e) { return e.code === 'ENOENT'; }
  }
  function cleanStaging(op) {
    try {
      parents(path.dirname(op.stageDir));
      if (!same(directory(op.stageDir), op.stageIdentity)) return false;
      if (!removeFile(op.stagePath, op.fileIdentity)) return false;
      fs.rmdirSync(op.stageDir);
      return true;
    } catch (e) { return e.code === 'ENOENT'; }
  }
  return Object.freeze({
    stage(bytes, id) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid generated identity.');
      // Root parent is configuration-owned; reject links at/below the managed root.
      fs.mkdirSync(path.dirname(root), { recursive: true });
      ensure(root);
      ensure(path.join(root, '.staging'));
      ensure(path.join(root, 'book-covers'));
      const stageDir = fs.mkdtempSync(path.join(root, '.staging', 'operation-'));
      const op = { id, stageDir, stagePath: path.join(stageDir, 'source'), published: false };
      let fd;
      try {
        op.stageIdentity = directory(stageDir);
        fd = fs.openSync(op.stagePath, 'wx', 0o600);
        op.fileIdentity = fs.fstatSync(fd, { bigint: true });
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        return op;
      } catch (e) {
        let clean = true;
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { clean = false; }
        }
        clean = cleanStaging(op) && clean;
        if (!clean) {
          const failure = new Error('Managed staging recovery required.');
          failure.code = 'RECOVERY_REQUIRED';
          throw failure;
        }
        throw e;
      }
    },
    publish(op, extension, expectedSha) {
      if (!['png', 'jpg', 'webp'].includes(extension)) throw new Error('Invalid verified extension.');
      parents(op.stageDir);
      if (!same(directory(op.stageDir), op.stageIdentity)) throw new Error('Staging changed.');
      const current = stat(op.stagePath);
      if (!current.isFile() || current.isSymbolicLink() || !same(current, op.fileIdentity)
        || crypto.createHash('sha256').update(fs.readFileSync(op.stagePath)).digest('hex') !== expectedSha) throw new Error('Staging changed.');
      parents(path.join(root, 'book-covers'));
      op.finalDir = path.join(root, 'book-covers', op.id);
      fs.mkdirSync(op.finalDir, { mode: 0o700 }); // Directory collision also fails closed.
      op.finalDirCreated = true;
      op.finalDirIdentity = directory(op.finalDir);
      op.finalPath = path.join(op.finalDir, `source.${extension}`);
      fs.linkSync(op.stagePath, op.finalPath); // Atomic no-replace publication on this filesystem.
      op.published = true;
      if (!same(stat(op.finalPath), op.fileIdentity)) throw new Error('Publication changed.');
      return `book-covers/${op.id}/source.${extension}`;
    },
    cleanStaging,
    compensate(op) {
      try {
        if (!op.finalDirCreated) return true;
        if (!op.finalDirIdentity) return false;
        parents(path.dirname(op.finalDir));
        if (!same(directory(op.finalDir), op.finalDirIdentity)) return false;
        if (op.published && !removeFile(op.finalPath, op.fileIdentity)) return false;
        fs.rmdirSync(op.finalDir); // Never recursive; unexpected contents require recovery.
        return true;
      } catch (e) { return e.code === 'ENOENT'; }
    },
  });
}
