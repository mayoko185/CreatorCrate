import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensurePreviewRoot,
  StorageError,
} from '../../src/storage/path-manager.js';

// ─── ensurePreviewRoot ───────────────────────────────────────────────────

describe('ensurePreviewRoot', () => {
  let tmpDir;
  let appDataRoot;
  let previewRoot;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-preview-'));
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    previewRoot = path.join(appDataRoot, 'previews');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the preview root when it does not exist', () => {
    expect(fs.existsSync(previewRoot)).toBe(false);
    ensurePreviewRoot(previewRoot);
    expect(fs.existsSync(previewRoot)).toBe(true);
    expect(fs.statSync(previewRoot).isDirectory()).toBe(true);
  });

  it('is idempotent (accepts an existing valid directory)', () => {
    fs.mkdirSync(previewRoot, { recursive: true });
    fs.writeFileSync(path.join(previewRoot, 'existing-file'), 'x');
    expect(() => ensurePreviewRoot(previewRoot)).not.toThrow();
    expect(fs.existsSync(path.join(previewRoot, 'existing-file'))).toBe(true);
  });

  it('rejects a path that exists as a file', () => {
    fs.writeFileSync(previewRoot, 'not-a-dir');
    expect(() => ensurePreviewRoot(previewRoot)).toThrow(StorageError);
  });

  it('error messages do not leak absolute paths', () => {
    fs.writeFileSync(previewRoot, 'not-a-dir');
    try {
      ensurePreviewRoot(previewRoot);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.message).not.toContain(previewRoot);
      expect(err.message).not.toContain(tmpDir);
    }
  });
});
