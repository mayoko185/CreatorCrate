import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';

// Runs `replace(stagePath)` once, immediately after CreatorCrate closes the descriptor it
// opened exclusively ('wx') for a stage path accepted by `matches`: the boundary where stage
// ownership used to be captured from whatever the pathname then held.
export function replaceStageAfterClose(matches, replace) {
  const realOpen = fs.openSync.bind(fs);
  const realClose = fs.closeSync.bind(fs);
  const exclusive = new Map();
  let replacedPath;
  const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, ...args) => {
    const descriptor = realOpen(filePath, flags, ...args);
    if (typeof filePath === 'string' && flags === 'wx' && matches(path.resolve(filePath))) {
      exclusive.set(descriptor, path.resolve(filePath));
    }
    return descriptor;
  });
  const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor, ...args) => {
    const result = realClose(descriptor, ...args);
    const stagePath = exclusive.get(descriptor);
    exclusive.delete(descriptor);
    if (stagePath && !replacedPath) {
      replacedPath = stagePath;
      replace(stagePath);
    }
    return result;
  });
  return {
    get path() { return replacedPath; },
    restore() {
      closeSpy.mockRestore();
      openSpy.mockRestore();
    },
  };
}

// Replaces the file at `stagePath` with a distinct foreign file holding `bytes`. Uses rmSync
// so unlinkSync spies only observe CreatorCrate's own unlinks.
export function replaceWithForeignFile(stagePath, bytes) {
  fs.rmSync(stagePath);
  fs.writeFileSync(stagePath, bytes);
}

// Replaces the directory at `dirPath` with a distinct, empty foreign directory.
export function replaceWithForeignDirectory(dirPath) {
  fs.rmSync(dirPath, { recursive: true });
  fs.mkdirSync(dirPath);
}
