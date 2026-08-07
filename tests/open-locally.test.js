/**
 * Tests for the CreatorCrate "Open locally" URI builder.
 *
 * Contract (v2):
 *   creatorcrate-open://open?v=2&path=<absolute-windows-path>&select=<0|1>
 *
 * The utility is pure: it must never emit PROJECTS_ROOT, /data/projects, or
 * any absolute container path, and must reject invalid inputs with null.
 */
import { describe, it, expect } from 'vitest';
import { buildOpenLocallyUri, buildOpenLocallyPath } from '../src/util/open-locally.js';

const WINDOWS_ROOT = 'D:\\example';

describe('buildOpenLocallyUri', () => {
  it('builds a project folder URI with select=0', () => {
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project' })).toBe(
      'creatorcrate-open://open?v=2&path=D%3A%5Cexample%5C000042-my-project&select=0'
    );
  });

  it('builds an asset URI with select=1', () => {
    expect(buildOpenLocallyUri({
      windowsRoot: WINDOWS_ROOT,
      projectDir: '000042-my-project',
      assetRelativePath: 'sketches/thumb.png',
    })).toBe(
      'creatorcrate-open://open?v=2&path=D%3A%5Cexample%5C000042-my-project%5Csketches%2Fthumb.png&select=1'
    );
  });

  it('uses select=0 for a project folder and select=1 for an asset', () => {
    const project = buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project' });
    const asset = buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', assetRelativePath: 'a.png' });
    expect(project).toContain('&select=0');
    expect(asset).toContain('&select=1');
  });

  it('preserves spaces through URL encoding', () => {
    expect(buildOpenLocallyUri({ windowsRoot: 'D:\\example', projectDir: '000042-my project' })).toBe(
      'creatorcrate-open://open?v=2&path=D%3A%5Cexample%5C000042-my%20project&select=0'
    );
    expect(buildOpenLocallyUri({
      windowsRoot: WINDOWS_ROOT,
      projectDir: '000042-my-project',
      assetRelativePath: 'my folder/art file.png',
    })).toBe(
      'creatorcrate-open://open?v=2&path=D%3A%5Cexample%5C000042-my-project%5Cmy%20folder%2Fart%20file.png&select=1'
    );
  });

  it('preserves Unicode through URL encoding', () => {
    expect(buildOpenLocallyUri({ windowsRoot: 'D:\\Proyectos', projectDir: '000042-café' })).toBe(
      'creatorcrate-open://open?v=2&path=D%3A%5CProyectos%5C000042-caf%C3%A9&select=0'
    );
    expect(buildOpenLocallyUri({
      windowsRoot: WINDOWS_ROOT,
      projectDir: '000042-my-project',
      assetRelativePath: '絵/スケッチ.png',
    })).toBe(
      'creatorcrate-open://open?v=2&path=D%3A%5Cexample%5C000042-my-project%5C%E7%B5%B5%2F%E3%82%B9%E3%82%B1%E3%83%83%E3%83%81.png&select=1'
    );
  });

  it('supports nested asset relative paths', () => {
    expect(buildOpenLocallyUri({
      windowsRoot: WINDOWS_ROOT,
      projectDir: '000042-my-project',
      assetRelativePath: 'a/b/c/file.png',
    })).toBe(
      'creatorcrate-open://open?v=2&path=D%3A%5Cexample%5C000042-my-project%5Ca%2Fb%2Fc%2Ffile.png&select=1'
    );
  });

  it('normalizes backslashes to forward slashes in asset relative paths', () => {
    expect(buildOpenLocallyUri({
      windowsRoot: WINDOWS_ROOT,
      projectDir: '000042-my-project',
      assetRelativePath: 'a\\b\\file.png',
    })).toBe(
      'creatorcrate-open://open?v=2&path=D%3A%5Cexample%5C000042-my-project%5Ca%2Fb%2Ffile.png&select=1'
    );
  });

  it('builds a category folder URI with select=0', () => {
    expect(buildOpenLocallyUri({
      windowsRoot: WINDOWS_ROOT,
      projectDir: '000042-my-project',
      categoryDir: 'wm-lq',
    })).toBe(
      'creatorcrate-open://open?v=2&path=D%3A%5Cexample%5C000042-my-project%5Cwm-lq&select=0'
    );
  });

  it('ignores categoryDir when an asset relative path is given (asset wins, select=1)', () => {
    expect(buildOpenLocallyUri({
      windowsRoot: WINDOWS_ROOT,
      projectDir: '000042-my-project',
      categoryDir: 'final',
      assetRelativePath: 'final/hero.png',
    })).toBe(
      'creatorcrate-open://open?v=2&path=D%3A%5Cexample%5C000042-my-project%5Cfinal%2Fhero.png&select=1'
    );
  });

  it('rejects invalid category directories', () => {
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', categoryDir: 'a/b' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', categoryDir: 'a\\b' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', categoryDir: '..' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', categoryDir: '/abs' })).toBeNull();
  });

  it('opens the project folder when categoryDir is null or undefined', () => {
    const expected = 'creatorcrate-open://open?v=2&path=D%3A%5Cexample%5C000042-my-project&select=0';
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', categoryDir: null })).toBe(expected);
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', categoryDir: undefined })).toBe(expected);
  });

  it('is deterministic for the same input', () => {
    const input = { windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', assetRelativePath: 'sketches/thumb.png' };
    expect(buildOpenLocallyUri(input)).toBe(buildOpenLocallyUri(input));
  });

  it('returns null for a missing or empty windows root', () => {
    expect(buildOpenLocallyUri({ projectDir: '000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: undefined, projectDir: '000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: null, projectDir: '000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: '', projectDir: '000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: 42, projectDir: '000042-my-project' })).toBeNull();
  });

  it('returns null for a missing or empty project directory', () => {
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: undefined })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: null })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: 42 })).toBeNull();
  });

  it('rejects non-drive windows roots', () => {
    expect(buildOpenLocallyUri({ windowsRoot: '/data/projects', projectDir: '000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: '\\\\server\\share', projectDir: '000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: 'relative/path', projectDir: '000042-my-project' })).toBeNull();
  });

  it('rejects the bare drive root, which is not a usable absolute path', () => {
    // "C:\" normalizes to "C:", which is no longer an absolute Windows path;
    // the settings service rejects it at save time, and the URI builder must
    // never compose a path from it.
    for (const windowsRoot of ['C:\\', 'C:/', 'c:\\', 'c:/', 'C:']) {
      expect(buildOpenLocallyUri({ windowsRoot, projectDir: '000042-my-project' })).toBeNull();
    }
  });

  it('rejects absolute project directories', () => {
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '/data/projects/000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: 'C:\\projects\\000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: 'C:/projects/000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '\\\\server\\share\\000042-my-project' })).toBeNull();
  });

  it('rejects absolute asset relative paths', () => {
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', assetRelativePath: '/etc/passwd' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', assetRelativePath: 'C:\\Windows\\system32' })).toBeNull();
  });

  it('rejects traversal in windows roots, project directories, and asset paths', () => {
    expect(buildOpenLocallyUri({ windowsRoot: 'N:\\AI\\..\\Project Files', projectDir: '000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: 'N:\\AI\\.\\Project Files', projectDir: '000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '..' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '../000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', assetRelativePath: '../secret.png' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', assetRelativePath: 'a/../../secret.png' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', assetRelativePath: '..\\secret.png' })).toBeNull();
  });

  it('rejects project directories that are not a single segment', () => {
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: 'nested/000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: 'nested\\000042-my-project' })).toBeNull();
  });

  it('rejects control characters in paths', () => {
    expect(buildOpenLocallyUri({ windowsRoot: 'N:\\AI\u0007Project', projectDir: '000042-my-project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my\u0000project' })).toBeNull();
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', assetRelativePath: 'a\u0007b.png' })).toBeNull();
  });

  it('rejects asset relative paths containing a colon (alternate data stream syntax)', () => {
    expect(buildOpenLocallyUri({
      windowsRoot: WINDOWS_ROOT,
      projectDir: '000042-my-project',
      assetRelativePath: 'revisions/v2:final.png',
    })).toBeNull();
    expect(buildOpenLocallyUri({
      windowsRoot: WINDOWS_ROOT,
      projectDir: '000042-my-project',
      assetRelativePath: 'a\\b:c\\file.png',
    })).toBeNull();
  });

  it('rejects project directories containing a colon (alternate data stream syntax)', () => {
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my:project' })).toBeNull();
  });

  it('still emits v2 URIs for valid project and asset paths', () => {
    expect(buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project' })).toMatch(
      /^creatorcrate-open:\/\/open\?v=2&path=.*&select=0$/
    );
    expect(buildOpenLocallyUri({
      windowsRoot: WINDOWS_ROOT,
      projectDir: '000042-my-project',
      assetRelativePath: 'revisions/v2/final.png',
    })).toMatch(/^creatorcrate-open:\/\/open\?v=2&path=.*&select=1$/);
  });

  it('normalizes trailing separators on the windows root', () => {
    expect(buildOpenLocallyUri({ windowsRoot: 'D:\\example\\', projectDir: '000042-my-project' })).toBe(
      'creatorcrate-open://open?v=2&path=D%3A%5Cexample%5C000042-my-project&select=0'
    );
    expect(buildOpenLocallyUri({ windowsRoot: 'D:/example/', projectDir: '000042-my-project' })).toBe(
      'creatorcrate-open://open?v=2&path=D%3A%5Cexample%5C000042-my-project&select=0'
    );
  });

  it('never emits a container root or absolute path in the URI', () => {
    const uris = [
      buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project' }),
      buildOpenLocallyUri({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', assetRelativePath: 'sketches/thumb.png' }),
    ];
    for (const uri of uris) {
      expect(uri).not.toContain('PROJECTS_ROOT');
      expect(uri).not.toContain('/data/projects');
    }
  });
});

describe('buildOpenLocallyPath', () => {
  it('returns the absolute project folder path', () => {
    expect(buildOpenLocallyPath({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project' }))
      .toBe('D:\\example\\000042-my-project');
  });

  it('returns the absolute asset path', () => {
    expect(buildOpenLocallyPath({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', assetRelativePath: 'sketches/thumb.png' }))
      .toBe('D:\\example\\000042-my-project\\sketches/thumb.png');
  });

  it('returns null for invalid input', () => {
    expect(buildOpenLocallyPath({})).toBeNull();
    expect(buildOpenLocallyPath({ projectDir: '000042-my-project' })).toBeNull();
    expect(buildOpenLocallyPath({ windowsRoot: WINDOWS_ROOT, projectDir: '/data/projects/000042-my-project' })).toBeNull();
    expect(buildOpenLocallyPath({ windowsRoot: WINDOWS_ROOT, projectDir: '000042-my-project', assetRelativePath: '../x.png' })).toBeNull();
  });
});
