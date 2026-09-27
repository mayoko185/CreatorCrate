import fs from 'node:fs';
import path from 'node:path';
import { createProjectDirectoryOwnershipRepository } from '../../src/data/project-directory-ownership-repository.js';
import {
  createProjectOwnershipMarker,
  generateProjectOwnershipToken,
  PROJECT_OWNERSHIP_MARKER_FILENAME,
} from '../../src/storage/project-ownership-marker.js';

/**
 * Bind a fixture project created directly through the project repository the
 * way real project creation does: a pending SQLite token, the on-disk marker,
 * then `bound`. Returns the token.
 */
export function bindTestProjectOwnership(db, projectId, absPath) {
  const repository = createProjectDirectoryOwnershipRepository(db);
  const token = generateProjectOwnershipToken();
  repository.createPending(projectId, token);
  createProjectOwnershipMarker(absPath, token);
  repository.markBound(projectId, token);
  return token;
}

/**
 * Put project B's directory (with B's marker) at project A's stored pathname,
 * keeping A's original directory aside so the test can restore it. This is
 * the whole-root substitution PM-1B must refuse.
 */
export function substituteProjectRoot(aAbsPath, bAbsPath) {
  const aside = `${aAbsPath}.aside`;
  fs.renameSync(aAbsPath, aside);
  fs.cpSync(bAbsPath, aAbsPath, { recursive: true });
  return {
    aside,
    restore() {
      fs.rmSync(aAbsPath, { recursive: true, force: true });
      fs.renameSync(aside, aAbsPath);
    },
  };
}

/** Snapshot every file under `dir` as relative path → bytes (hex). */
export function snapshotTree(dir) {
  const out = {};
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(childAbs, childRel);
      else out[childRel] = fs.readFileSync(childAbs).toString('hex');
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Count real ownership-marker opens made through `fs.openSync` while `fn`
 * runs. Uses a spy on the shared `node:fs` default export, which the marker
 * reader calls, so this counts actual file opens rather than verifier calls.
 */
export async function countMarkerOpens(vi, fn) {
  const spy = vi.spyOn(fs, 'openSync');
  try {
    await fn();
    return spy.mock.calls.filter(([target]) => (
      typeof target === 'string' && path.basename(target) === PROJECT_OWNERSHIP_MARKER_FILENAME
    )).length;
  } finally {
    spy.mockRestore();
  }
}
