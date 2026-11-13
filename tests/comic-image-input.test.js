import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getEventListeners } from 'node:events';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { makeZip } from './helpers/zip-fixture.js';
import { bindTestProjectOwnership } from './helpers/project-ownership.js';
import { makeAnimatedWebp } from './helpers/animated-webp.js';

const observed = vi.hoisted(() => ({ handles: [], closed: 0, beforeClose: null, afterOpen: null, duringRead: null, reads: [], extracted: null }));
vi.mock('../src/storage/asset-file.js', async (original) => {
  const actual = await original();
  return { ...actual,
    openAssetFileAsync: async (...args) => {
      const opened = await actual.openAssetFileAsync(...args);
      const handle = opened.handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        try { await observed.beforeClose?.(); }
        finally { await close(); observed.closed++; }
      };
      observed.handles.push(handle);
      await observed.afterOpen?.(opened);
      return opened;
    },
  };
});
vi.mock('../src/services/cbz-page-reader.js', async (original) => {
  const actual = await original();
  return { ...actual, readCbzPage: async (...args) => {
    observed.reads.push(args[1]);
    const pending = actual.readCbzPage(...args);
    observed.duringRead?.();
    const result = await pending;
    observed.extracted = result.bytes;
    return result;
  } };
});
vi.mock('../src/services/cbr-cb7-page-reader.js', async (original) => {
  const actual = await original();
  return { ...actual, readCbrCb7Page: async (...args) => {
    observed.reads.push(args[1]);
    const pending = actual.readCbrCb7Page(...args);
    observed.duringRead?.();
    const result = await pending;
    observed.extracted = result.bytes;
    return result;
  } };
});

const { openDatabase, runMigrations, closeDatabase } = await import('../src/db.js');
const { createProjectRepository } = await import('../src/data/project-repository.js');
const { createAssetRepository } = await import('../src/data/asset-repository.js');
const { createPreviewService } = await import('../src/services/preview-service.js');
const { createComicMediaService } = await import('../src/services/comic-media-service.js');
const { createComicAdmission } = await import('../src/services/comic-admission.js');
const { createProcessingConcurrencyService } = await import('../src/services/processing-concurrency-service.js');
const { createComicRenditionSupervisor } = await import('../src/services/comic-rendition-process.js');
const { projectImageGeneratedOutput } = await import('../src/services/project-image-policy.js');
const { encodeImageDerivative, generateDerivative } = await import('../src/services/image-derivative.js');
const SevenZip = createRequire(import.meta.url)('7z-wasm');
const fixtures = fileURLToPath(new URL('./fixtures/comic-archives/', import.meta.url));
const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
const policy = { thumbnail: { format: 'webp', webpQuality: 23, maxDimension: 128 },
  preview: { format: 'png', webpQuality: 91, maxDimension: 1024 } };
const output = projectImageGeneratedOutput(policy, false);
const images = {};
let h;
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  const raw = Buffer.alloc(1200 * 800 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + Math.floor(i / 101)) & 255;
  images.png = await sharp(raw, { raw: { width: 1200, height: 800, channels: 3 } }).png().toBuffer();
  images.portrait = await sharp(raw, { raw: { width: 1200, height: 800, channels: 3 } })
    .resize(1200, 1800, { fit: 'fill' }).png().toBuffer();
  images.jpeg = await sharp(images.png).jpeg({ quality: 94 }).toBuffer();
  images.animated = await makeAnimatedWebp(3, { width: 20, height: 30 });
  images.truncated = images.jpeg.subarray(0, Math.floor(images.jpeg.length / 3));
});
afterAll(() => { for (const key of Object.keys(images)) delete images[key]; });

beforeEach(() => {
  observed.handles.length = 0; observed.closed = 0; observed.beforeClose = null; observed.afterOpen = null;
  observed.duringRead = null;
  observed.reads.length = 0; observed.extracted = null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cover-input-'));
  const projectsRoot = path.join(root, 'projects');
  fs.mkdirSync(projectsRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, migrations);
  const projectRepo = createProjectRepository(db);
  let project = projectRepo.create({ title: 'Cover input', projectType: 'images', slug: 'cover-input',
    description: '', notes: '', status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null });
  const projectDir = `${project.id}-cover-input`;
  const directory = path.join(projectsRoot, projectDir);
  fs.mkdirSync(directory);
  project = projectRepo.setProjectDir(project.id, projectDir);
  bindTestProjectOwnership(db, project.id, directory);
  const assetRepo = createAssetRepository(db);
  const children = [];
  const renditions = createComicRenditionSupervisor({ hooks: {
    spawned: ({ pid }) => children.push({ pid, exited: false }),
    exited: ({ pid }) => { children.find(x => x.pid === pid).exited = true; },
  } });
  const previewService = createPreviewService({ db, projectsRoot, previewRoot: path.join(root, 'previews') });
  const admission = createComicAdmission();
  const service = (options = {}) => createComicMediaService({ previewService, projectsRoot, admission, renditions, ...options });
  function add(bytes, extension = 'cbz') {
    const relativePath = `book.${extension}`;
    const full = path.join(directory, relativePath);
    fs.writeFileSync(full, bytes);
    const stat = fs.statSync(full);
    const asset = assetRepo.upsert(project.id, relativePath, { filename: relativePath, extension,
      mimeType: extension === 'cbz' ? 'application/vnd.comicbook+zip' : 'application/octet-stream',
      sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    return { asset, full };
  }
  h = { root, directory, db, project, service, add, renditions, admission, children, previewService };
});

afterEach(async () => {
  await h.renditions.close();
  expect(h.renditions.snapshot()).toMatchObject({ active: 0, terminating: 0 });
  expect(h.admission.snapshot()).toMatchObject({ active: 0 });
  for (const child of h.children) {
    expect(child.exited).toBe(true);
    expect(() => process.kill(child.pid, 0)).toThrow();
  }
  expect(observed.closed).toBe(observed.handles.length);
  for (const handle of observed.handles) expect(handle.fd).toBe(-1);
  closeDatabase(h.db);
  if (!path.resolve(h.root).startsWith(path.resolve(os.tmpdir()) + path.sep)
    || !path.basename(h.root).startsWith('cc-cover-input-')) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(h.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  expect(fs.existsSync(h.root)).toBe(false);
});

function archive(first = images.png, name = 'ch1/page1.png') {
  return makeZip([{ name: 'ch10/page1.png', data: images.png },
    { name: 'ch1/page10.jpg', data: images.jpeg }, { name, data: first },
    { name: 'ch1/page2.jpg', data: images.jpeg }, { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo/>') }]);
}
async function cover(service, asset, work, options = {}) {
  try { return await service.withComicCoverSource(h.project.id, asset.id, options, work); }
  catch (error) {
    // A callback assertion is a test failure, even though the media boundary correctly
    // hides arbitrary callback errors from HTTP consumers.
    if (error.cause?.name === 'AssertionError') throw error.cause;
    throw error;
  }
}
async function make7z() {
  const module = await SevenZip({ print() {}, printErr() {} });
  module.FS.mkdirTree('/w/ch1'); module.FS.mkdirTree('/w/ch10'); module.FS.chdir('/w');
  module.FS.writeFile('/w/ch1/page10.jpg', images.jpeg);
  module.FS.writeFile('/w/ch1/page1.png', images.png);
  module.FS.writeFile('/w/ch10/page1.png', images.png);
  const code = module.callMain(['a', '-t7z', '-mmt=1', '-bsp0', '-bso0', '-bse0', '/out.7z',
    'ch10/page1.png', 'ch1/page10.jpg', 'ch1/page1.png']);
  if (code) throw new Error(`7z failed: ${code}`);
  return Buffer.from(module.FS.readFile('/out.7z'));
}

describe('scoped canonical original comic input', () => {
  it.each(['cbz', 'cbr', 'cb7'])('proves %s source and full catalogue without reading a page or prepared lease', async format => {
    const bytes = format === 'cbz' ? archive() : format === 'cb7' ? await make7z()
      : fs.readFileSync(path.join(fixtures, 'comic-rar5-solid.cbr'));
    const { asset } = h.add(bytes, format);
    const lease = vi.fn(() => { throw new Error('Proof must not acquire image bytes'); });
    const service = h.service({ preparationCache: { lease, state: () => 'ready', schedule: vi.fn(),
      invalidate: vi.fn(), protects: () => true, stagingRoot: path.join(h.root, 'preparation') } });
    let escaped;
    const operation = service.startComicCoverSource(h.project.id, asset.id, {}, async input => {
      escaped = input;
      expect(input.revision).toMatch(/^[a-f0-9]{32}$/);
      expect(input.page).toMatchObject({ position: 1, frame: 0 });
      expect(input).not.toHaveProperty('bytes');
      expect(input).not.toHaveProperty('image');
      expect(input).not.toHaveProperty('sourceAnimated');
      expect(input).not.toHaveProperty('prepared');
      expect(observed.reads).toEqual([]);
      return input.acceptCurrent(identity => identity.revision);
    });
    expect(await operation.result).toMatch(/^[a-f0-9]{32}$/);
    await operation.retired;
    expect(operation.graphAuthority.isLive()).toBe(true);
    expect(observed.reads).toEqual([]);
    expect(lease).not.toHaveBeenCalled();
    expect(h.children).toEqual([]);
    await expect(escaped.read()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('memoizes simultaneous explicit original reads and refuses reads after acceptance', async () => {
    const { asset } = h.add(archive());
    await cover(h.service(), asset, async input => {
      const [first, second] = await Promise.all([input.read(), input.read()]);
      expect(first).toBe(second);
      expect(first.buffer).toBe(observed.extracted);
      expect(first.buffer.equals(images.png)).toBe(true);
      expect(await input.read()).toBe(first);
      expect(observed.reads).toEqual([1]);
      await input.acceptCurrent(() => {});
      await expect(input.read()).rejects.toThrow('scoped');
    });
    expect(observed.reads).toEqual([1]);
  });

  it('retains an abandoned lazy read until it settles and never returns bytes after work fails', async () => {
    const { asset } = h.add(archive());
    const entered = deferred(), release = deferred(), delivered = vi.fn();
    const service = h.service({ _hooks: { afterRead: async () => { entered.resolve(); await release.promise; } } });
    let settled = false;
    const operation = service.startComicCoverSource(h.project.id, asset.id, {}, async input => {
      void input.read().then(delivered, () => {});
      await entered.promise;
      throw new Error('Work abandoned the read');
    });
    const outcome = operation.result.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try {
      await entered.promise;
      await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(h.admission.snapshot().active).toBe(1);
      expect(observed.handles.at(-1).fd).toBeGreaterThanOrEqual(0);
      expect(service.isIdle()).toBe(false);
      expect(delivered).not.toHaveBeenCalled();
    } finally { release.resolve(); }
    expect(await outcome).toMatchObject({ error: { code: 'INTERNAL', cause: { message: 'Work abandoned the read' } } });
    await operation.retired;
    expect(delivered).not.toHaveBeenCalled();
    expect(h.children).toEqual([]);
    expect(service.isIdle()).toBe(true);
  });

  it.each(['webp', 'png', 'original'])('matches ordinary generator bytes and dimensions for portrait %s policy', async format => {
    const { asset } = h.add(archive(images.portrait));
    const effectivePolicy = { thumbnail: { format: 'webp', maxDimension: 128, webpQuality: 61 },
      preview: { format, maxDimension: 960, webpQuality: 73 } };
    await cover(h.service(), asset, async input => {
      const original = await input.read();
      expect(original.buffer.equals(images.portrait)).toBe(true);
      for (const kind of ['thumbnail', 'preview']) {
        const expected = await generateDerivative(images.portrait, kind, false, effectivePolicy);
        const actual = await input.encode(kind, effectivePolicy);
        expect(actual).toEqual(expected);
        expect(await sharp(actual.buffer).metadata()).toMatchObject({
          format: expected.format, width: expected.width, height: expected.height,
        });
        if (kind === 'thumbnail') expect(actual).toMatchObject({ width: 85, height: 128 });
        else expect(actual).toMatchObject(format === 'original'
          ? { width: 1067, height: 1600, format: 'webp' } : { width: 640, height: 960, format });
      }
    });
    expect(observed.reads).toEqual([1]);
  });

  it('uses original canonical CBZ bytes and distinct existing Thumbnail/Preview outputs', async () => {
    const { asset } = h.add(archive());
    const service = h.service();
    const manifest = await service.getComicManifest(h.project.id, asset.id);
    const rows = () => ['assets', 'generated_artifacts', 'generated_image_publications'].map(table => h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    const before = rows();
    let escaped;
    await cover(service, asset, async (input) => {
      escaped = input;
      expect((await input.read()).buffer.equals(images.png)).toBe(true);
      expect((await input.read()).buffer).toBe(observed.extracted);
      expect(input).toMatchObject({ format: 'cbz', revision: manifest.revision, pageCount: 4,
        page: { position: 1, entryIndex: 2, path: 'ch1/page1.png', frame: 0 },
      });
      expect(await input.read()).toMatchObject({ image: { format: 'png', width: 1200, height: 800 }, prepared: false });
      expect(input).not.toHaveProperty('opened'); expect(input).not.toHaveProperty('relativePath');
      expect(input).not.toHaveProperty('absolutePath'); expect(input).not.toHaveProperty('member');
      expect(h.admission.snapshot().active).toBe(1);
      const thumbnail = await input.encode('thumbnail', policy);
      const preview = await input.encode('preview', policy);
      expect(thumbnail).toMatchObject({ format: 'webp', width: 128, height: 85, filename: 'thumbnail.webp' });
      expect(preview).toMatchObject({ format: 'png', width: 1024, height: 683, filename: 'preview.png' });
      expect((await sharp(preview.buffer).metadata()).pages ?? 1).toBe(1);
      await input.acceptCurrent((identity) => {
        expect(observed.handles.every(handle => handle.fd === -1)).toBe(true);
        expect(identity.revision).toBe(manifest.revision);
        expect(identity.sourceRevision).toMatch(/^[a-f0-9]{16}$/);
        expect(identity.sourceIdentity).toBe(identity.revision.slice(0, 16));
        expect(h.admission.snapshot().active).toBe(1);
      });
    });
    expect(observed.reads).toEqual([1]);
    expect(rows()).toEqual(before);
    expect(fs.readdirSync(h.directory).filter(x => !x.startsWith('.'))).toEqual(['book.cbz']);
    expect(service.isIdle()).toBe(true);
    expect(() => escaped.checkpoint()).toThrow();
    await expect(escaped.encode('preview', policy)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it.each(['comic-rar4.cbr', 'comic-rar4-solid.cbr', 'comic-rar5.cbr', 'comic-rar5-solid.cbr'])('selects canonical original CBR input from %s without preparation', async (fixture) => {
    const { asset } = h.add(fs.readFileSync(path.join(fixtures, fixture)), 'cbr');
    const schedule = vi.fn();
    const preparationCache = { schedule, lease: () => null, state: () => null, invalidate: vi.fn(), protects: () => true,
      stagingRoot: path.join(h.root, 'preparation') };
    const service = h.service({ preparationCache });
    await cover(service, asset, async input => {
      expect(input).toMatchObject({ format: 'cbr', pageCount: 6, page: { position: 1, path: 'ch1/page1.jpg' },
      });
      expect(await input.read()).toMatchObject({ image: { format: 'jpeg', width: 48, height: 64 } });
      expect((await input.read()).buffer).toBe(observed.extracted);
      expect((await input.read()).buffer[0]).toBe(255);
      const expected = await generateDerivative((await input.read()).buffer, 'preview', false, policy);
      expect(await input.encode('preview', policy)).toEqual(expected);
      expect(expected).toMatchObject({ width: 48, height: 64, format: 'png' });
    });
    expect(observed.reads).toEqual([1]);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('uses the canonical nested CB7 first member without scheduling solid preparation', async () => {
    const { asset } = h.add(await make7z(), 'cb7');
    const schedule = vi.fn();
    const service = h.service({ preparationCache: { schedule, lease: () => null, state: () => null,
      invalidate: vi.fn(), protects: () => true, stagingRoot: path.join(h.root, 'preparation') } });
    await cover(service, asset, async input => {
      expect(input.page.path).toBe('ch1/page1.png');
      expect((await input.read()).buffer.equals(images.png)).toBe(true);
      const expected = await generateDerivative(images.png, 'preview', false, policy);
      expect(await input.encode('preview', policy)).toEqual(expected);
      expect(expected).toMatchObject({ width: 1024, height: 683, format: 'png' });
    });
    expect(observed.reads).toEqual([1]);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('reuses a verified prepared original page with fresh catalogue proof and releases its lease', async () => {
    const { asset, full } = h.add(fs.readFileSync(path.join(fixtures, 'comic-rar5-solid.cbr')), 'cbr');
    const { readCbrCb7Page } = await import('../src/services/cbr-cb7-page-reader.js');
    const handle = await fs.promises.open(full, 'r');
    let original;
    try { original = await readCbrCb7Page({ handle, stat: await handle.stat() }, 1, { format: 'cbr' }); }
    finally { await handle.close(); }
    observed.reads.length = 0;
    const release = vi.fn(), schedule = vi.fn();
    const prepared = { ...original.catalog, slots: original.catalog.pages.map(() => ({ status: 'ready' })),
      read: vi.fn(async () => original) };
    const lease = vi.fn(() => ({ prepared, release, discard: vi.fn() }));
    const service = h.service({ preparationCache: { schedule, lease, state: () => 'ready',
      invalidate: vi.fn(), protects: () => true, stagingRoot: path.join(h.root, 'preparation') } });
    await cover(service, asset, async input => {
      expect((await input.read()).prepared).toBe(true);
      expect((await input.read()).buffer.equals(original.bytes)).toBe(true);
      await input.encode('preview', policy);
    });
    expect(observed.reads).toEqual([]);
    expect(prepared.read).toHaveBeenCalledWith(1);
    expect(release).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each(['corrupt', 'unsupported', 'missing'])('refuses a %s canonical first page without selecting a later page', async (mode) => {
    const bytes = mode === 'missing' ? makeZip([{ name: 'ComicInfo.xml', data: Buffer.from('no pages') }])
      : archive(mode === 'corrupt' ? images.truncated : Buffer.from('<svg width="48" height="64"/>'),
        mode === 'corrupt' ? 'ch1/page1.jpg' : 'ch1/page1.png');
    const { asset } = h.add(bytes);
    await expect(cover(h.service(), asset, input => input.encode('preview', policy))).rejects.toMatchObject({
      code: mode === 'missing' ? 'PAGE_NOT_FOUND' : 'PAGE_UNAVAILABLE' });
    expect(observed.reads.every(position => position === 1)).toBe(true);
  });

  it('selects animation frame zero and leaves original reader-page delivery independent', async () => {
    const { asset } = h.add(archive(images.animated, 'ch1/page1.webp'));
    const service = h.service();
    const manifest = await service.getComicManifest(h.project.id, asset.id);
    const page = () => service.getComicPage(h.project.id, asset.id, { revision: manifest.revision, position: 1 });
    const before = await page();
    await cover(service, asset, async input => {
      expect((await input.read()).buffer.equals(images.animated)).toBe(true);
      const result = await input.encode('preview', policy);
      const expected = await encodeImageDerivative(images.animated, { kind: 'preview', width: 1024, height: 1024,
        quality: null, animated: false, format: 'png' });
      expect(result.buffer.equals(expected.buffer)).toBe(true);
      expect(result).toMatchObject({ animated: false, frameCount: 1, format: 'png' });
    });
    const after = await page();
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after).toMatchObject({ revision: before.revision, mimeType: before.mimeType, width: before.width, height: before.height });
  });

  it('rejects arbitrary member selectors and paths before opening a source', async () => {
    const { asset } = h.add(archive());
    const service = h.service();
    for (const options of [{ position: 2 }, { member: 'ch1/page2.jpg' }, { path: 'C:/secret.png' }]) {
      await expect(cover(service, asset, () => {}, options)).rejects.toThrow(TypeError);
    }
    expect(observed.handles).toHaveLength(0);
  });
});

describe('cover source lifetime and final authority', () => {
  it('cancels before extraction without opening a handle', async () => {
    const { asset } = h.add(archive());
    const controller = new AbortController(); controller.abort();
    await expect(cover(h.service(), asset, () => {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(observed.handles).toHaveLength(0);
  });
  it('cancels during a real CBR extraction and waits for cleanup', async () => {
    const { asset } = h.add(fs.readFileSync(path.join(fixtures, 'comic-rar5-solid.cbr')), 'cbr');
    const controller = new AbortController();
    observed.duringRead = () => controller.abort();
    await expect(cover(h.service(), asset, input => input.read(), { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(observed.reads).toEqual([1]);
  });
  it.each(['metadata', 'stats', 'convert'])('cancels native execution at %s', async phase => {
    const { asset } = h.add(archive());
    const controller = new AbortController();
    const service = h.service({ _hooks: { renditionPhase: ({ phase: current }) => { if (current === phase) controller.abort(); } } });
    await expect(cover(service, asset, input => input.encode('preview', policy), { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(h.children).toHaveLength(1);
    expect(h.children[0].exited).toBe(true);
  });
  it.each(['format', 'generation', 'file'])('rejects a post-close %s authority change before acceptance', async change => {
    const { asset, full } = h.add(archive());
    const accepted = vi.fn();
    observed.beforeClose = () => {
      if (change === 'format') h.db.prepare("UPDATE assets SET extension = 'cbr' WHERE id = ?").run(asset.id);
      if (change === 'generation') h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(asset.id);
      if (change === 'file') fs.appendFileSync(full, Buffer.from('changed'));
    };
    await expect(cover(h.service(), asset, input => input.acceptCurrent(accepted))).rejects.toMatchObject({ code: 'REVISION_STALE' });
    expect(accepted).not.toHaveBeenCalled();
  });
  it('rejects source generation changes during work', async () => {
    const { asset } = h.add(archive());
    await expect(cover(h.service(), asset, async input => {
      const result = await input.encode('preview', policy);
      h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(asset.id);
      return result;
    })).rejects.toMatchObject({ code: 'REVISION_STALE' });
  });
  it('rejects cancellation during handle cleanup', async () => {
    const { asset } = h.add(archive());
    const controller = new AbortController();
    observed.beforeClose = () => controller.abort();
    await expect(cover(h.service(), asset, () => 'candidate', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it('owns the deadline through native execution and waits for child termination', async () => {
    const { asset } = h.add(archive());
    const phases = [];
    const supervisor = createComicRenditionSupervisor({
      childModule: fileURLToPath(new URL('./helpers/fake-rendition-child.js', import.meta.url)),
      childArgs: ['derivative-hang'], hooks: {
        spawned: ({ pid }) => h.children.push({ pid, exited: false }),
        exited: ({ pid }) => { h.children.find(child => child.pid === pid).exited = true; },
      },
    });
    try {
      const service = h.service({ renditions: supervisor, _hooks: { renditionPhase: ({ phase }) => phases.push(phase) } });
      await expect(cover(service, asset, input => input.encode('preview', policy), { deadlineMs: 1500 }))
        .rejects.toMatchObject({ code: 'DECODER_UNAVAILABLE', reason: 'TIMEOUT' });
      expect(phases).toContain('stats');
      expect(supervisor.snapshot()).toMatchObject({ active: 0, terminating: 0, launched: 1, exited: 1 });
    } finally { await supervisor.close(); }
  });
  it('keeps graph maintenance pending until scoped work and native cleanup settle', async () => {
    const { asset } = h.add(archive());
    const service = h.service({ _hooks: { renditionPhase: ({ phase }) => { if (phase === 'stats') service.stop(); } } });
    await expect(cover(service, asset, input => input.encode('preview', policy))).rejects.toMatchObject({ code: 'BUSY', reason: 'MAINTENANCE' });
    expect(service.isIdle()).toBe(true);
    expect(h.children[0].exited).toBe(true);
  });
  it('closes sources when work throws and prevents unawaited native work from outliving the scope', async () => {
    const { asset } = h.add(archive());
    const entered = deferred();
    const service = h.service({ _hooks: { renditionPhase: () => entered.resolve() } });
    await expect(cover(service, asset, async input => {
      void input.encode('preview', policy).catch(() => {});
      await entered.promise;
      throw new Error('callback failed');
    })).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(service.isIdle()).toBe(true);
    expect(h.children[0].exited).toBe(true);
  });
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function closeError() {
  return Object.assign(new Error('Injected source close EIO'), { code: 'EIO' });
}

describe('cover source close failure ownership', () => {
  it('rejects real encoded output when source close leaves the handle open', async () => {
    const { asset } = h.add(archive());
    const service = h.service(), accepted = vi.fn(() => 'accepted');
    let handle, close, openAtFailure = false, attempts = 0;
    const result = await cover(service, asset, async input => {
      const encoded = await input.encode('preview', policy);
      expect((await sharp(encoded.buffer).metadata()).format).toBe('png');
      expect(h.children[0].exited).toBe(true);
      handle = observed.handles.at(-1);
      close = handle.close.bind(handle);
      handle.close = async () => {
        if (++attempts === 1) {
          openAtFailure = handle.fd >= 0 && fs.fstatSync(handle.fd).isFile();
          throw closeError();
        }
        await close();
      };
      return input.acceptCurrent(accepted);
    }).then(value => ({ value }), error => ({ error }));
    const state = { fd: handle.fd, active: h.admission.snapshot().active, accepted: accepted.mock.calls.length };
    try {
      expect(openAtFailure).toBe(true);
      expect(result).toMatchObject({ error: { code: 'INTERNAL', cause: { code: 'EIO' } } });
      expect(state).toEqual({ fd: -1, active: 0, accepted: 0 });
      expect(attempts).toBe(2);
      expect(service.isIdle()).toBe(true);
    } finally { if (handle.fd >= 0) await close(); }
  });

  it('rejects a real post-encoding close failure and holds admission through final retirement', async () => {
    const { asset } = h.add(archive());
    const service = h.service();
    const entered = deferred(), release = deferred();
    const accepted = vi.fn();
    let attempts = 0, handle, settled = false;
    const operation = cover(service, asset, async input => {
      const encoded = await input.encode('preview', policy);
      expect(encoded).toMatchObject({ format: 'png', width: 1024, height: 683 });
      expect((await sharp(encoded.buffer).metadata()).format).toBe('png');
      expect(h.children[0].exited).toBe(true);
      handle = observed.handles.at(-1);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        if (++attempts === 1) { expect(handle.fd).toBeGreaterThanOrEqual(0); throw closeError(); }
        entered.resolve();
        await release.promise;
        await close();
      };
      return input.acceptCurrent(accepted);
    });
    const outcome = operation.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try {
      await entered.promise;
      expect(attempts).toBe(2);
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      expect(h.admission.snapshot().active).toBe(1);
      expect(service.isIdle()).toBe(false);
      expect(settled).toBe(false);
      expect(accepted).not.toHaveBeenCalled();
    } finally { release.resolve(); }
    expect(await outcome).toMatchObject({ error: { code: 'INTERNAL', expose: false, cause: { code: 'EIO' } } });
    expect(handle.fd).toBe(-1);
    expect(accepted).not.toHaveBeenCalled();
    expect(h.admission.snapshot()).toMatchObject({ active: 0, reservedBytes: 0 });
    expect(service.isIdle()).toBe(true);
    await cover(service, asset, input => input.acceptCurrent(accepted));
    expect(accepted).toHaveBeenCalledOnce();
  });

  it.each(['pause', 'stop', 'uncertain'])('retains an unresolved source and reservation until %s retirement confirms closure', async mode => {
    const { asset } = h.add(archive());
    const admission = createComicAdmission({ maxActive: 1 });
    const service = h.service({ admission });
    const accepted = vi.fn();
    let handle, close, fd, attempts = 0;
    await expect(cover(service, asset, async input => {
      await input.encode('preview', policy);
      handle = observed.handles.at(-1);
      fd = handle.fd;
      close = handle.close.bind(handle);
      handle.close = async () => {
        attempts++;
        if (mode === 'uncertain' && attempts > 1) return;
        if (mode === 'uncertain') Object.defineProperty(handle, 'fd', { configurable: true, get: () => -1 });
        throw closeError();
      };
      return input.acceptCurrent(accepted);
    })).rejects.toMatchObject({ code: 'INTERNAL', cause: { code: 'EIO' } });
    try {
      expect(attempts).toBe(2);
      expect(fs.fstatSync(fd).isFile()).toBe(true);
      expect(service.isIdle()).toBe(false);
      expect(admission.snapshot().active).toBe(1);
      expect(accepted).not.toHaveBeenCalled();
      let acquired = false;
      const later = admission.run(() => { acquired = true; expect(handle.fd).toBe(-1); }, { weightBytes: 1 });
      expect(admission.snapshot().queued).toBe(1);
      expect(acquired).toBe(false);
      const entered = deferred(), release = deferred();
      if (mode === 'uncertain') delete handle.fd;
      handle.close = async () => { entered.resolve(); await release.promise; await close(); };
      const pause = service.pauseForMaintenance();
      if (mode === 'stop') service.stop();
      let idle = false;
      const idleResult = pause.waitForIdle().then(() => { idle = true; });
      try {
        await entered.promise;
        expect(idle).toBe(false);
        expect(acquired).toBe(false);
        expect(admission.snapshot().active).toBe(1);
      } finally { release.resolve(); }
      await idleResult;
      await later;
      expect(acquired).toBe(true);
      expect(handle.fd).toBe(-1);
      expect(admission.snapshot()).toMatchObject({ active: 0, reservedBytes: 0 });
      expect(accepted).not.toHaveBeenCalled();
      pause.release();
      if (mode !== 'stop') await cover(service, asset, input => input.acceptCurrent(accepted));
      else await expect(cover(service, asset, () => {})).rejects.toMatchObject({ code: 'BUSY' });
    } finally {
      if (mode === 'uncertain' && Object.hasOwn(handle, 'fd')) delete handle.fd;
      handle.close = close;
      const pause = service.pauseForMaintenance();
      await pause.waitForIdle();
      pause.release();
    }
  });

  it('rejects even when a failed close independently proves the descriptor already retired', async () => {
    const { asset } = h.add(archive());
    const accepted = vi.fn();
    let attempts = 0;
    await expect(cover(h.service(), asset, async input => {
      await input.encode('preview', policy);
      const handle = observed.handles.at(-1), close = handle.close.bind(handle), fd = handle.fd;
      handle.close = async () => {
        attempts++;
        await close();
        expect(() => fs.fstatSync(fd)).toThrow();
        throw closeError();
      };
      // A caught close failure still cannot turn this candidate into usable output.
      await input.acceptCurrent(accepted).catch(() => {});
      return 'unpublishable';
    })).rejects.toMatchObject({ code: 'INTERNAL', cause: { code: 'EIO' } });
    expect(attempts).toBe(1);
    expect(accepted).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'deadline', 'generation', 'format', 'replacement', 'pause', 'stop'])('keeps %s failure and close diagnostics together after encoding', async mode => {
    const { asset, full } = h.add(archive());
    const service = h.service();
    const accepted = vi.fn(), controller = new AbortController();
    const now = performance.now.bind(performance);
    let clock, pause;
    try {
      let failure;
      try { await cover(service, asset, async input => {
        await input.encode('preview', policy);
        const handle = observed.handles.at(-1), close = handle.close.bind(handle);
        let attempts = 0;
        handle.close = async () => {
          if (++attempts !== 1) return close();
          if (mode === 'cancel') controller.abort();
          if (mode === 'deadline') clock = vi.spyOn(performance, 'now').mockReturnValue(now() + 60_000);
          if (mode === 'generation') h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(asset.id);
          if (mode === 'format') h.db.prepare("UPDATE assets SET extension = 'cbr' WHERE id = ?").run(asset.id);
          if (mode === 'replacement') { fs.renameSync(full, full + '.old'); fs.writeFileSync(full, archive()); }
          if (mode === 'pause') pause = service.pauseForMaintenance();
          if (mode === 'stop') service.stop();
          throw closeError();
        };
        return input.acceptCurrent(accepted);
      }, { signal: controller.signal }); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: mode === 'cancel' ? 'CANCELLED'
        : mode === 'deadline' ? 'DECODER_UNAVAILABLE' : ['pause', 'stop'].includes(mode) ? 'BUSY' : 'REVISION_STALE' });
      const diagnostics = failure.cleanupError ?? failure.cause?.cleanupError;
      expect(diagnostics).toMatchObject({ code: 'INTERNAL', cause: { code: 'EIO' } });
      expect(accepted).not.toHaveBeenCalled();
    } finally { clock?.mockRestore(); pause?.release(); }
  });

  it.each(['encoder', 'callback'])('preserves the prior %s error when final cleanup also fails', async mode => {
    const { asset } = h.add(archive());
    const prior = new Error('Scoped work failed');
    const service = h.service();
    let failure;
    try {
      await cover(service, asset, async input => {
        const handle = observed.handles.at(-1), close = handle.close.bind(handle);
        let attempts = 0;
        handle.close = async () => { if (++attempts === 1) throw closeError(); return close(); };
        if (mode === 'encoder') await input.encode('preview', { ...policy, preview: { ...policy.preview, format: 'invalid' } });
        throw prior;
      });
    } catch (error) { failure = error; }
    expect(failure.code).toBeDefined();
    expect(failure.cleanupError).toMatchObject({ code: 'INTERNAL', cause: { code: 'EIO' } });
    expect(h.admission.snapshot().active).toBe(1);
    const pause = service.pauseForMaintenance();
    await pause.waitForIdle();
    pause.release();
    expect(service.isIdle()).toBe(true);
    expect(h.admission.snapshot().active).toBe(0);
    if (mode === 'callback') expect(failure.cause).toBe(prior);
  });

  it.each(['cancel', 'deadline', 'pause', 'stop'])('refuses acceptance when %s occurs during deferred successful cleanup', async mode => {
    const { asset } = h.add(archive());
    const service = h.service(), controller = new AbortController(), accepted = vi.fn();
    const entered = deferred(), release = deferred();
    const now = performance.now.bind(performance);
    let clock, pause;
    observed.beforeClose = async () => { entered.resolve(); await release.promise; };
    const operation = cover(service, asset, input => input.acceptCurrent(accepted), { signal: controller.signal });
    const result = operation.then(value => ({ value }), error => ({ error }));
    try {
      await entered.promise;
      if (mode === 'cancel') controller.abort();
      if (mode === 'deadline') clock = vi.spyOn(performance, 'now').mockReturnValue(now() + 60_000);
      if (mode === 'pause') pause = service.pauseForMaintenance();
      if (mode === 'stop') service.stop();
      expect(service.isIdle()).toBe(false);
      expect(h.admission.snapshot().active).toBe(1);
      expect(observed.handles.at(-1).fd).toBeGreaterThanOrEqual(0);
    } finally { release.resolve(); }
    try {
      expect(await result).toMatchObject({ error: { code: mode === 'cancel' ? 'CANCELLED'
        : mode === 'deadline' ? 'DECODER_UNAVAILABLE' : 'BUSY' } });
      expect(accepted).not.toHaveBeenCalled();
      expect(service.isIdle()).toBe(true);
    } finally { clock?.mockRestore(); pause?.release(); }
  });

  it('keeps a throwing acceptance single-use and rejects escaped callbacks', async () => {
    const { asset } = h.add(archive());
    const accepted = vi.fn(() => { throw new Error('Acceptance failed'); });
    let escaped;
    await expect(cover(h.service(), asset, async input => {
      escaped = input;
      await input.acceptCurrent(accepted);
    })).rejects.toMatchObject({ code: 'INTERNAL', cause: { message: 'Acceptance failed' } });
    expect(accepted).toHaveBeenCalledOnce();
    await expect(escaped.acceptCurrent(accepted)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(accepted).toHaveBeenCalledOnce();
  });

  it('awaits an unawaited acceptance and prevents it from escaping a throwing work callback', async () => {
    const { asset } = h.add(archive());
    const service = h.service(), accepted = vi.fn();
    await expect(cover(service, asset, input => {
      void input.acceptCurrent(accepted).catch(() => {});
      throw new Error('Work failed');
    })).rejects.toMatchObject({ code: 'INTERNAL', cause: { message: 'Work failed' } });
    expect(accepted).not.toHaveBeenCalled();
    expect(service.isIdle()).toBe(true);
  });

  it('allows final acceptance at most once', async () => {
    const { asset } = h.add(archive());
    const accepted = vi.fn();
    await cover(h.service(), asset, async input => {
      await input.acceptCurrent(accepted);
      await expect(input.acceptCurrent(accepted)).rejects.toThrow('Invalid cover acceptance');
    });
    expect(accepted).toHaveBeenCalledOnce();
  });

  it('awaits acceptance already in cleanup when its work callback throws', async () => {
    const { asset } = h.add(archive());
    const entered = deferred(), release = deferred(), accepted = vi.fn();
    const service = h.service({ _hooks: { coverAuthority: async () => {
      entered.resolve(); await release.promise;
    } } });
    const operation = cover(service, asset, async input => {
      void input.acceptCurrent(accepted).catch(() => {});
      await entered.promise;
      throw new Error('Work failed after close');
    });
    const result = operation.then(value => ({ value }), error => ({ error }));
    try {
      await entered.promise;
      expect(observed.handles.at(-1).fd).toBe(-1);
      expect(service.isIdle()).toBe(false);
      expect(h.admission.snapshot().active).toBe(1);
      expect(accepted).not.toHaveBeenCalled();
    } finally { release.resolve(); }
    expect(await result).toMatchObject({ error: { code: 'INTERNAL', cause: { message: 'Work failed after close' } } });
    expect(accepted).not.toHaveBeenCalled();
    expect(service.isIdle()).toBe(true);
  });
});

describe('post-retirement graph authority', () => {
  it('captures authority before extraction and checks late stop after real encoding and retirement without reopening scope', async () => {
    const { asset } = h.add(archive());
    const service = h.service(), caller = new AbortController();
    const entered = deferred(), release = deferred();
    let escaped, encoded;
    const watch = observeCover(service, asset, async input => {
      escaped = input;
      entered.resolve();
      await release.promise;
      encoded = await input.encode('preview', policy);
      return input.acceptCurrent(() => 'accepted');
    }, { signal: caller.signal });
    const authority = watch.operation.graphAuthority;
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.keys(authority)).toEqual(['isLive']);
    expect(authority.isLive()).toBe(true);
    expect(observed.handles).toHaveLength(0);
    try {
      await entered.promise;
      expect(authority.isLive()).toBe(true);
      expect(watch.state.notifications).toBe(0);
    } finally { release.resolve(); }
    expect(await watch.result).toEqual({ value: 'accepted' });
    expect(watch.state.notifications, 'normal success follows confirmed resource retirement').toBe(1);
    await watch.retired;
    expect(authority.isLive()).toBe(true);
    expect((await sharp(encoded.buffer).metadata()).format).toBe('png');
    expect(watch.state.atRetirement).toEqual({ active: 0, idle: true, liveChildren: 0 });
    expect(observed.handles).toHaveLength(1);
    expect(observed.handles[0].fd).toBe(-1);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    expect(escaped.signal.aborted).toBe(false);
    expect(() => escaped.checkpoint()).toThrow();
    await expect(escaped.acceptCurrent(() => 'expired')).rejects.toMatchObject({ code: 'CANCELLED' });
    const admission = h.admission.snapshot(), opened = observed.handles.length;
    const stat = vi.spyOn(fs, 'statSync');
    const open = vi.spyOn(fs.promises, 'open');
    try {
      for (let i = 0; i < 100; i++) expect(authority.isLive()).toBe(true);
      service.stop();
      expect(authority.isLive(), 'late stop must invalidate a retired operation').toBe(false);
      service.stop();
      expect(authority.isLive()).toBe(false);
      expect(stat).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally { stat.mockRestore(); open.mockRestore(); }
    expect(escaped.signal.aborted, 'the expired operation signal is not the graph fence').toBe(false);
    expect(observed.handles).toHaveLength(opened);
    expect(h.admission.snapshot()).toEqual(admission);
    expect(watch.state.notifications).toBe(1);
    expect(await watch.operation.result).toBe('accepted');
    expect(await watch.operation.retired).toBeUndefined();
  });

  it('invalidates captured authority during lazy extraction before original bytes are returned', async () => {
    const { asset } = h.add(archive());
    const delivered = vi.fn();
    const service = h.service(), work = vi.fn(async input => delivered(await input.read()));
    let liveBefore, liveAfter;
    const watch = observeCover(service, asset, work);
    observed.duringRead = () => {
      liveBefore = watch.operation.graphAuthority.isLive();
      service.stop();
      liveAfter = watch.operation.graphAuthority.isLive();
    };
    expect(await watch.result).toMatchObject({ error: { status: 503 } });
    await watch.retired;
    expect(liveBefore).toBe(true);
    expect(liveAfter).toBe(false);
    expect(work).toHaveBeenCalledOnce();
    expect(delivered).not.toHaveBeenCalled();
    expect(watch.operation.graphAuthority.isLive()).toBe(false);
    expect(watch.state.notifications).toBe(1);
  });

  it.each(['metadata', 'stats', 'convert'])('invalidates authority during native %s and keeps ownership until child exit', async phase => {
    const { asset } = h.add(archive());
    let atStop;
    const service = h.service({ _hooks: { renditionPhase: ({ phase: current }) => {
      if (current !== phase) return;
      service.stop();
      atStop = { live: watch.operation.graphAuthority.isLive(), active: h.admission.snapshot().active,
        idle: service.isIdle(), retired: watch.state.notifications };
    } } });
    const watch = observeCover(service, asset, input => input.encode('preview', policy));
    expect(await watch.result).toMatchObject({ error: { status: 503 } });
    await watch.retired;
    expect(atStop).toEqual({ live: false, active: 1, idle: false, retired: 0 });
    expect(h.children).toHaveLength(1);
    expect(h.children[0].exited).toBe(true);
    expect(watch.state.notifications).toBe(1);
    expect(watch.operation.graphAuthority.isLive()).toBe(false);
  });

  it('keeps graph liveness separate from a rejected operation and from normal caller completion', async () => {
    const { asset } = h.add(archive());
    const service = h.service(), caller = new AbortController();
    const watch = observeCover(service, asset, () => { throw new Error('Work failed'); }, { signal: caller.signal });
    expect(await watch.result).toMatchObject({ error: { code: 'INTERNAL' } });
    await watch.retired;
    expect(watch.operation.graphAuthority.isLive()).toBe(true);
    caller.abort();
    expect(watch.operation.graphAuthority.isLive()).toBe(true);
    service.stop();
    expect(watch.operation.graphAuthority.isLive()).toBe(false);
  });

  it('invalidates after source close while the result callback still owns admission', async () => {
    const { asset } = h.add(archive());
    const service = h.service(), closed = deferred(), release = deferred();
    const watch = observeCover(service, asset, async input => {
      await input.encode('preview', policy);
      await input.acceptCurrent(() => 'accepted');
      closed.resolve();
      await release.promise;
      return 'late';
    });
    try {
      await closed.promise;
      expect(observed.handles.at(-1).fd).toBe(-1);
      expect(watch.operation.graphAuthority.isLive()).toBe(true);
      service.stop();
      expect(watch.operation.graphAuthority.isLive()).toBe(false);
      expect(watch.state.notifications).toBe(0);
      expect(h.admission.snapshot().active).toBe(1);
      expect(service.isIdle()).toBe(false);
    } finally { release.resolve(); }
    expect(await watch.result).toMatchObject({ error: { status: 503 } });
    await watch.retired;
    expect(watch.state.notifications).toBe(1);
  });

  it.each(['opening', 'encoded'])('invalidates %s failure authority without releasing resources or the processing permit before confirmed retirement', async mode => {
    const { asset, full } = h.add(archive());
    const service = h.service(), pool = createProcessingConcurrencyService({ concurrency: 1 });
    let fault, handle, close, encoded, watch, permitReleased = false, nextRan = false;
    if (mode === 'opening') {
      fault = interceptSourceOpen(full, record => {
        record.handle.stat = async () => { throw closeError(); };
        record.handle.close = async () => { throw closeError(); };
      });
    }
    const ready = deferred();
    const worker = pool.run(async () => {
      watch = observeCover(service, asset, async input => {
        encoded = await input.encode('preview', policy);
        handle = observed.handles.at(-1);
        close = handle.close.bind(handle);
        handle.close = async () => { throw closeError(); };
        return input.acceptCurrent(() => 'unexpected');
      });
      ready.resolve();
      await watch.operation.retired;
      permitReleased = true;
    });
    await ready.promise;
    try {
      expect(await watch.result).toHaveProperty('error');
      const owned = mode === 'opening' ? fault.record.handle : handle;
      expect(fs.fstatSync(owned.fd).isFile()).toBe(true);
      if (mode === 'encoded') expect((await sharp(encoded.buffer).metadata()).format).toBe('png');
      expect(watch.operation.graphAuthority.isLive()).toBe(true);
      service.stop();
      expect(watch.operation.graphAuthority.isLive()).toBe(false);
      await new Promise(resolve => setImmediate(resolve));
      expect(fs.fstatSync(owned.fd).isFile()).toBe(true);
      expect(watch.state.notifications).toBe(0);
      expect(h.admission.snapshot().active).toBe(1);
      expect(service.isIdle()).toBe(false);
      expect(permitReleased).toBe(false);
      expect(pool.tryRun(() => { nextRan = true; })).toBeNull();
      expect(nextRan).toBe(false);
    } finally {
      if (fault) fault.restore();
      if (handle) handle.close = close;
      service.stop();
      await worker;
      await watch.retired;
    }
    expect(permitReleased).toBe(true);
    expect(watch.state.notifications).toBe(1);
    expect(service.isIdle()).toBe(true);
    expect(h.admission.snapshot().active).toBe(0);
    expect(watch.operation.graphAuthority.isLive()).toBe(false);
    await pool.tryRun(() => { nextRan = true; });
    expect(nextRan).toBe(true);
  });

  it('keeps old generations invalid across nested maintenance, resume and graph replacement', async () => {
    const { asset } = h.add(archive());
    const service = h.service();
    const old = observeCover(service, asset, () => 'old');
    expect(await old.result).toEqual({ value: 'old' });
    await old.retired;
    const pause = service.pauseForMaintenance(), nested = service.pauseForMaintenance();
    expect(old.operation.graphAuthority.isLive()).toBe(false);
    const refused = observeCover(service, asset, () => 'unexpected');
    expect(refused.operation.graphAuthority.isLive()).toBe(false);
    expect(await refused.result).toMatchObject({ error: { status: 503 } });
    await refused.retired;
    pause.release(); pause.release();
    expect(old.operation.graphAuthority.isLive()).toBe(false);
    nested.release();
    const resumed = observeCover(service, asset, () => 'resumed');
    expect(await resumed.result).toEqual({ value: 'resumed' });
    await resumed.retired;
    expect(resumed.operation.graphAuthority.isLive()).toBe(true);
    expect(old.operation.graphAuthority.isLive(), 'old generation cannot revive after resume').toBe(false);
    expect(refused.operation.graphAuthority.isLive()).toBe(false);
    service.stop();
    const replacement = h.service();
    const fresh = observeCover(replacement, asset, () => 'replacement');
    expect(await fresh.result).toEqual({ value: 'replacement' });
    await fresh.retired;
    expect(fresh.operation.graphAuthority).not.toBe(old.operation.graphAuthority);
    expect(fresh.operation.graphAuthority.isLive()).toBe(true);
    expect(old.operation.graphAuthority.isLive(), 'replacement cannot revive the old graph').toBe(false);
    expect(resumed.operation.graphAuthority.isLive()).toBe(false);
    const stopped = observeCover(service, asset, () => 'unexpected');
    expect(stopped.operation.graphAuthority.isLive()).toBe(false);
    expect(await stopped.result).toMatchObject({ error: { status: 503 } });
    await stopped.retired;
    replacement.stop();
    expect(fresh.operation.graphAuthority.isLive()).toBe(false);
  });

  it('does not move an operation captured before execution onto a resumed graph generation', async () => {
    const { asset } = h.add(archive());
    const service = h.service(), work = vi.fn();
    const old = observeCover(service, asset, work);
    const pause = service.pauseForMaintenance();
    pause.release();
    expect(old.operation.graphAuthority.isLive()).toBe(false);
    expect(await old.result).toMatchObject({ error: { status: 503 } });
    await old.retired;
    expect(work).not.toHaveBeenCalled();
    expect(observed.handles).toHaveLength(0);
    const fresh = observeCover(service, asset, () => 'current');
    expect(await fresh.result).toEqual({ value: 'current' });
    await fresh.retired;
    expect(fresh.operation.graphAuthority.isLive()).toBe(true);
    expect(old.operation.graphAuthority.isLive()).toBe(false);
  });

  it('isolates two graphs and their operation retirement on the same source', async () => {
    const { asset } = h.add(archive());
    const a = h.service(), b = h.service();
    const first = observeCover(a, asset, () => 'a'), second = observeCover(b, asset, () => 'b');
    expect(await first.result).toEqual({ value: 'a' });
    expect(await second.result).toEqual({ value: 'b' });
    await Promise.all([first.retired, second.retired]);
    a.stop();
    expect(first.operation.graphAuthority.isLive()).toBe(false);
    expect(second.operation.graphAuthority.isLive()).toBe(true);
    b.stop();
    expect(second.operation.graphAuthority.isLive()).toBe(false);
    expect(first.state.notifications).toBe(1);
    expect(second.state.notifications).toBe(1);
  });

  it('never revives a stopped graph token when a replacement graph starts', async () => {
    const { asset } = h.add(archive());
    const oldGraph = h.service();
    const old = observeCover(oldGraph, asset, () => 'old');
    expect(await old.result).toEqual({ value: 'old' });
    await old.retired;
    oldGraph.stop();
    expect(old.operation.graphAuthority.isLive()).toBe(false);
    const newGraph = h.service();
    const fresh = observeCover(newGraph, asset, () => 'fresh');
    expect(await fresh.result).toEqual({ value: 'fresh' });
    await fresh.retired;
    expect(fresh.operation.graphAuthority.isLive()).toBe(true);
    expect(old.operation.graphAuthority.isLive(), 'replacement must reject prior graph authority').toBe(false);
    newGraph.stop();
  });

  it.each(['format', 'generation', 'withdrawal', 'first page', 'policy'])('does not misrepresent live graph authority as fresh %s authority', async change => {
    const { asset, full } = h.add(archive());
    const service = h.service();
    const watch = observeCover(service, asset, input => ({ format: input.format, revision: input.revision }));
    const prior = await watch.result;
    await watch.retired;
    if (change === 'format') h.db.prepare("UPDATE assets SET extension = 'cbr' WHERE id = ?").run(asset.id);
    if (change === 'generation') h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(asset.id);
    if (change === 'withdrawal') h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
    if (change === 'first page') {
      fs.writeFileSync(full, archive(images.jpeg, 'a-first.jpg'));
      const stat = fs.statSync(full);
      h.db.prepare('UPDATE assets SET size_bytes = ?, modified_at = ? WHERE id = ?')
        .run(stat.size, stat.mtime.toISOString(), asset.id);
    }
    if (change === 'policy') h.db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('images.preview.max_dimension', '640')").run();
    expect(watch.operation.graphAuthority.isLive()).toBe(true);
    // Only a new authorized operation can establish the current source/catalogue identity.
    if (change === 'format' || change === 'withdrawal') {
      const fresh = observeCover(service, asset, () => 'unexpected');
      expect(await fresh.result).toHaveProperty('error');
      await fresh.retired;
    } else {
      const fresh = observeCover(service, asset, input => ({ format: input.format, revision: input.revision }));
      const current = await fresh.result;
      await fresh.retired;
      if (change === 'policy') {
        expect(current).toEqual(prior);
        expect(h.db.prepare("SELECT value FROM app_meta WHERE key = 'images.preview.max_dimension'").get().value).toBe('640');
      } else expect(current.value.revision).not.toBe(prior.value.revision);
    }
    expect(watch.operation.graphAuthority.isLive()).toBe(true);
    service.stop();
    expect(watch.operation.graphAuthority.isLive()).toBe(false);
  });

  it('retains no completed abort listeners or source work for repeated synchronous checks', async () => {
    const { asset } = h.add(archive());
    const service = h.service(), signals = new Set();
    const add = AbortSignal.prototype.addEventListener;
    const spy = vi.spyOn(AbortSignal.prototype, 'addEventListener').mockImplementation(function (...args) {
      if (args[0] === 'abort') signals.add(this);
      return add.apply(this, args);
    });
    try {
      for (let i = 0; i < 8; i++) {
        const watch = observeCover(service, asset, () => 'current');
        expect(await watch.result).toEqual({ value: 'current' });
        await watch.retired;
        const additions = spy.mock.calls.length;
        for (let j = 0; j < 100; j++) expect(watch.operation.graphAuthority.isLive()).toBe(true);
        expect(spy).toHaveBeenCalledTimes(additions);
        for (const signal of signals) expect(getEventListeners(signal, 'abort')).toHaveLength(0);
      }
    } finally { spy.mockRestore(); }
    expect(observed.handles).toHaveLength(8);
    expect(observed.closed).toBe(8);
    expect(service.isIdle()).toBe(true);
  });
});

function observeCover(service, asset, work, options = {}) {
  const operation = service.startComicCoverSource(h.project.id, asset.id, options, work);
  const state = { notifications: 0, permitHeld: true, atRetirement: null };
  const retired = operation.retired.then(() => {
    state.notifications++;
    state.permitHeld = false;
    state.atRetirement = { active: h.admission.snapshot().active, idle: service.isIdle(),
      liveChildren: h.children.filter(child => !child.exited).length };
  });
  const result = operation.result.then(value => ({ value }), error => ({ error }));
  return { operation, result, retired, state };
}

async function recoverCover(service) {
  const pause = service.pauseForMaintenance();
  try { await pause.waitForIdle(); }
  finally { pause.release(); }
}

describe('per-operation cover retirement', () => {
  it('registers ownership before execution and retires once after normal native and source cleanup', async () => {
    const { asset } = h.add(archive());
    const service = h.service(), controller = new AbortController(), accepted = vi.fn(() => 'accepted');
    let entered = false, registered = false, encoded;
    const watch = observeCover(service, asset, async input => {
      entered = registered;
      encoded = await input.encode('preview', policy);
      return input.acceptCurrent(accepted);
    }, { signal: controller.signal });
    expect(entered).toBe(false);
    expect(Object.isFrozen(watch.operation)).toBe(true);
    expect(Object.keys(watch.operation)).toEqual(['result', 'retired', 'graphAuthority']);
    registered = true;
    expect(await watch.result).toEqual({ value: 'accepted' });
    await watch.retired;
    expect(await watch.operation.retired).toBeUndefined();
    expect(entered).toBe(true);
    expect(encoded).toMatchObject({ format: 'png', width: 1024, height: 683 });
    expect(accepted).toHaveBeenCalledOnce();
    expect(watch.state).toMatchObject({ notifications: 1, permitHeld: false,
      atRetirement: { active: 0, idle: true, liveChildren: 0 } });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await recoverCover(service);
    service.stop();
    await watch.operation.retired;
    expect(watch.state.notifications).toBe(1);
  });

  it.each(['options', 'callback', 'deadline', 'asset', 'cancel', 'pause', 'stop'])('retires a %s refusal before resource acquisition', async mode => {
    const { asset } = h.add(archive());
    const service = h.service(), controller = new AbortController(), work = vi.fn();
    let pause;
    if (mode === 'cancel') controller.abort();
    if (mode === 'pause') pause = service.pauseForMaintenance();
    if (mode === 'stop') service.stop();
    const watch = observeCover(service, mode === 'asset' ? { id: -1 } : asset,
      mode === 'callback' ? null : work,
      mode === 'options' ? { member: 'private' } : mode === 'deadline' ? { deadlineMs: 0 } : { signal: controller.signal });
    try {
      expect(await watch.result).toHaveProperty('error');
      await watch.retired;
      expect(watch.state).toMatchObject({ notifications: 1, permitHeld: false,
        atRetirement: { active: 0, idle: true, liveChildren: 0 } });
      expect(work).not.toHaveBeenCalled();
      expect(observed.handles).toHaveLength(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally { pause?.release(); }
  });

  it('keeps the processing permit held after real encoding and a rejected result until confirmed recovery', async () => {
    const { asset } = h.add(archive());
    const service = h.service(), accepted = vi.fn();
    let handle, close, encoded, attempts = 0, permitHeld = true, notifications = 0;
    // The legacy fallback reproduces the result-only caller's permit gap in scratch controls.
    const start = service.startComicCoverSource?.bind(service)
      ?? ((...args) => ({ result: service.withComicCoverSource(...args) }));
    const operation = start(h.project.id, asset.id, {}, async input => {
      encoded = await input.encode('preview', policy);
      handle = observed.handles.at(-1);
      close = handle.close.bind(handle);
      handle.close = async () => { attempts++; throw closeError(); };
      return input.acceptCurrent(accepted);
    });
    const retired = (operation.retired ?? operation.result.catch(() => {})).then(() => {
      permitHeld = false; notifications++;
    });
    try {
      await expect(operation.result).rejects.toMatchObject({ code: 'INTERNAL', cause: { code: 'EIO' } });
      await Promise.resolve();
      expect((await sharp(encoded.buffer).metadata()).format).toBe('png');
      expect(observed.extracted.equals(images.png)).toBe(true);
      expect(h.children).toHaveLength(1);
      expect(h.children[0].exited).toBe(true);
      expect(() => process.kill(h.children[0].pid, 0)).toThrow();
      expect(attempts).toBe(2);
      expect(fs.fstatSync(handle.fd).isFile()).toBe(true);
      expect(h.admission.snapshot().active).toBe(1);
      expect(service.isIdle()).toBe(false);
      expect(accepted).not.toHaveBeenCalled();
      expect(permitHeld, 'processing permit must remain held while the source is still owned').toBe(true);
      expect(notifications).toBe(0);
      expect(operation.retired).toBeInstanceOf(Promise);
    } finally {
      handle.close = close;
      await recoverCover(service);
      await retired;
    }
    expect(handle.fd).toBe(-1);
    expect(h.admission.snapshot()).toMatchObject({ active: 0, reservedBytes: 0 });
    expect(permitHeld).toBe(false);
    expect(notifications).toBe(1);
    await recoverCover(service);
    service.stop();
    await retired;
    expect(notifications).toBe(1);
    expect(accepted).not.toHaveBeenCalled();
  });

  it.each(['open', 'uncertain'])('keeps %s ownership pending through failed maintenance and stop retries', async mode => {
    const { asset } = h.add(archive());
    const service = h.service(), accepted = vi.fn();
    let handle, close, fd, attempts = 0, pause;
    const watch = observeCover(service, asset, input => {
      handle = observed.handles.at(-1); fd = handle.fd; close = handle.close.bind(handle);
      handle.close = async () => {
        attempts++;
        if (mode === 'uncertain') {
          Object.defineProperty(handle, 'fd', { configurable: true, get: () => -1 });
          if (attempts > 1) return;
        }
        throw closeError();
      };
      return input.acceptCurrent(accepted);
    });
    try {
      expect(await watch.result).toMatchObject({ error: { code: 'INTERNAL' } });
      const retryDone = deferred();
      const faultyClose = handle.close;
      handle.close = async () => { try { await faultyClose(); } finally { retryDone.resolve(); } };
      pause = service.pauseForMaintenance();
      await retryDone.promise;
      await new Promise(resolve => setImmediate(resolve));
      service.stop();
      await new Promise(resolve => setImmediate(resolve));
      expect(fs.fstatSync(fd).isFile()).toBe(true);
      expect(watch.state).toMatchObject({ permitHeld: true, notifications: 0 });
      expect(h.admission.snapshot().active).toBe(1);
      expect(service.isIdle()).toBe(false);
      expect(accepted).not.toHaveBeenCalled();
    } finally {
      await new Promise(resolve => setImmediate(resolve));
      if (mode === 'uncertain') delete handle.fd;
      handle.close = close;
      pause?.release();
      await recoverCover(service);
      await watch.retired;
    }
    expect(watch.state.notifications).toBe(1);
    expect(handle.fd).toBe(-1);
    expect(service.isIdle()).toBe(true);
  });

  it('retires independently confirmed closure even though the result rejects', async () => {
    const { asset } = h.add(archive());
    const accepted = vi.fn();
    const watch = observeCover(h.service(), asset, input => {
      const handle = observed.handles.at(-1), close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw closeError(); };
      return input.acceptCurrent(accepted);
    });
    expect(await watch.result).toMatchObject({ error: { code: 'INTERNAL', cause: { code: 'EIO' } } });
    await watch.retired;
    expect(watch.state.notifications).toBe(1);
    expect(accepted).not.toHaveBeenCalled();
  });

  it('retains a handle when source validation fails before the work callback', async () => {
    const { asset } = h.add(archive());
    const service = h.service(), work = vi.fn();
    let handle, close;
    observed.afterOpen = opened => {
      handle = opened.handle; close = handle.close.bind(handle);
      opened.stat = { ...opened.stat, size: opened.stat.size + 1 };
      handle.close = async () => { throw closeError(); };
    };
    const watch = observeCover(service, asset, work);
    try {
      expect(await watch.result).toHaveProperty('error');
      expect(work).not.toHaveBeenCalled();
      expect(fs.fstatSync(handle.fd).isFile()).toBe(true);
      expect(watch.state).toMatchObject({ permitHeld: true, notifications: 0 });
      expect(h.admission.snapshot().active).toBe(1);
      expect(service.isIdle()).toBe(false);
    } finally {
      handle.close = close;
      await recoverCover(service);
      await watch.retired;
    }
    expect(watch.state.notifications).toBe(1);
  });

  it('retires queued cancellation independently without acquiring a source', async () => {
    const { asset } = h.add(archive());
    const admission = createComicAdmission({ maxActive: 1 });
    const service = h.service({ admission }), controller = new AbortController();
    const entered = deferred(), release = deferred();
    const blocker = admission.run(async () => { entered.resolve(); await release.promise; }, { weightBytes: 1 });
    await entered.promise;
    const watch = observeCover(service, asset, vi.fn(), { signal: controller.signal });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1 });
      expect(watch.state.permitHeld).toBe(true);
      controller.abort();
      expect(await watch.result).toMatchObject({ error: { code: 'CANCELLED' } });
      await watch.retired;
      expect(watch.state.notifications).toBe(1);
      expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 });
      expect(observed.handles).toHaveLength(0);
      expect(service.isIdle()).toBe(true);
    } finally { release.resolve(); await blocker; }
  });

  it.each(['cancel', 'deadline', 'format', 'generation', 'pause', 'stop'])('keeps retirement pending during %s at deferred cleanup', async mode => {
    const { asset } = h.add(archive());
    const service = h.service(), controller = new AbortController(), accepted = vi.fn();
    const entered = deferred(), release = deferred();
    const now = performance.now.bind(performance);
    let clock, pause;
    observed.beforeClose = async () => { entered.resolve(); await release.promise; };
    const watch = observeCover(service, asset, input => input.acceptCurrent(accepted), { signal: controller.signal });
    try {
      await entered.promise;
      if (mode === 'cancel') controller.abort();
      if (mode === 'deadline') clock = vi.spyOn(performance, 'now').mockReturnValue(now() + 60_000);
      if (mode === 'format') h.db.prepare("UPDATE assets SET extension = 'cbr' WHERE id = ?").run(asset.id);
      if (mode === 'generation') h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(asset.id);
      if (mode === 'pause') pause = service.pauseForMaintenance();
      if (mode === 'stop') service.stop();
      expect(watch.state).toMatchObject({ permitHeld: true, notifications: 0 });
      expect(h.admission.snapshot().active).toBe(1);
      expect(observed.handles.at(-1).fd).toBeGreaterThanOrEqual(0);
    } finally { release.resolve(); }
    try {
      expect(await watch.result).toMatchObject({ error: { code: mode === 'cancel' ? 'CANCELLED'
        : mode === 'deadline' ? 'DECODER_UNAVAILABLE' : ['pause', 'stop'].includes(mode) ? 'BUSY' : 'REVISION_STALE' } });
      await watch.retired;
      expect(watch.state.notifications).toBe(1);
      expect(accepted).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally { clock?.mockRestore(); pause?.release(); }
  });

  it('retires operation B independently while operation A still owns an unconfirmed handle', async () => {
    const { asset } = h.add(archive());
    const service = h.service(), acceptedA = vi.fn(), acceptedB = vi.fn();
    let handleA, closeA;
    const a = observeCover(service, asset, input => {
      handleA = observed.handles.at(-1); closeA = handleA.close.bind(handleA);
      handleA.close = async () => { throw closeError(); };
      return input.acceptCurrent(acceptedA);
    });
    try {
      expect(await a.result).toMatchObject({ error: { code: 'INTERNAL' } });
      const b = observeCover(service, asset, async input => {
        await input.encode('thumbnail', policy);
        return input.acceptCurrent(acceptedB);
      });
      expect(a.operation.retired).not.toBe(b.operation.retired);
      expect(await b.result).toEqual({ value: undefined });
      await Promise.resolve();
      expect(b.state.notifications, 'B must retire without a global idle transition').toBe(1);
      expect(b.state.atRetirement).toEqual({ active: 1, idle: false, liveChildren: 0 });
      expect(a.state).toMatchObject({ notifications: 0, permitHeld: true });
      expect(fs.fstatSync(handleA.fd).isFile()).toBe(true);
      expect(acceptedA).not.toHaveBeenCalled();
      expect(acceptedB).toHaveBeenCalledOnce();
      await b.retired;
      handleA.close = closeA;
      await recoverCover(service);
      await a.retired;
      await recoverCover(service);
      expect(a.state.notifications).toBe(1);
      expect(b.state.notifications).toBe(1);
    } finally {
      handleA.close = closeA;
      await recoverCover(service);
      await a.retired;
    }
  });

  it.each(['work', 'acceptance', 'before-callback'])('retires after a %s exception without duplicate acceptance', async mode => {
    const { asset } = h.add(mode === 'before-callback' ? makeZip([{ name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo/>') }]) : archive());
    const accepted = vi.fn(() => { throw new Error('Acceptance failure'); }), work = vi.fn(async input => {
      if (mode === 'work') { void input.encode('preview', policy).catch(() => {}); throw new Error('Work failure'); }
      await input.acceptCurrent(accepted);
    });
    const watch = observeCover(h.service(), asset, work);
    expect(await watch.result).toHaveProperty('error');
    await watch.retired;
    expect(watch.state).toMatchObject({ notifications: 1, permitHeld: false,
      atRetirement: { active: 0, idle: true, liveChildren: 0 } });
    expect(accepted).toHaveBeenCalledTimes(mode === 'acceptance' ? 1 : 0);
    if (mode === 'before-callback') expect(work).not.toHaveBeenCalled();
  });

  it.each(['metadata', 'stats', 'convert'])('retains ownership until confirmed child exit after cancellation at %s', async phase => {
    const { asset } = h.add(archive());
    const controller = new AbortController();
    const checkpoints = [];
    const service = h.service({ _hooks: { renditionPhase: ({ phase: current }) => {
      checkpoints.push({ current, held: watch.state.permitHeld, retired: watch.state.notifications });
      if (current === phase) controller.abort();
    } } });
    const watch = observeCover(service, asset, input => input.encode('preview', policy), { signal: controller.signal });
    expect(await watch.result).toMatchObject({ error: { code: 'CANCELLED' } });
    await watch.retired;
    expect(checkpoints.find(check => check.current === phase)).toMatchObject({ held: true, retired: 0 });
    expect(watch.state.atRetirement.liveChildren).toBe(0);
    expect(watch.state.notifications).toBe(1);
  });

  it('retires after cancellation from a lazy archive read before returning bytes', async () => {
    const { asset } = h.add(archive());
    const controller = new AbortController(), delivered = vi.fn();
    const work = vi.fn(async input => delivered(await input.read()));
    let readStarted = false;
    observed.duringRead = () => { readStarted = true; controller.abort(); };
    const watch = observeCover(h.service(), asset, work, { signal: controller.signal });
    expect(await watch.result).toMatchObject({ error: { code: 'CANCELLED' } });
    await watch.retired;
    expect(readStarted).toBe(true);
    expect(work).toHaveBeenCalledOnce();
    expect(delivered).not.toHaveBeenCalled();
    expect(watch.state.atRetirement).toMatchObject({ active: 0, idle: true, liveChildren: 0 });
  });

  it('retires an expired extraction lifetime before encoding starts', async () => {
    const { asset } = h.add(archive());
    const work = vi.fn(input => input.encode('preview', policy)), now = performance.now.bind(performance);
    let clock;
    const service = h.service({ _hooks: { afterRead: () => {
      clock = vi.spyOn(performance, 'now').mockReturnValue(now() + 60_000);
    } } });
    const watch = observeCover(service, asset, work);
    try {
      expect(await watch.result).toMatchObject({ error: { code: 'DECODER_UNAVAILABLE', reason: 'TIMEOUT' } });
      await watch.retired;
      expect(work).toHaveBeenCalledOnce();
      expect(h.children).toHaveLength(0);
      expect(watch.state.notifications).toBe(1);
    } finally { clock?.mockRestore(); }
  });

  it('handles the late lifetime rejection after early failure without an unhandled rejection', async () => {
    const { asset } = h.add(archive());
    const service = h.service(), failures = [];
    const unhandled = error => failures.push(error);
    process.on('unhandledRejection', unhandled);
    let handle, close;
    const watch = observeCover(service, asset, input => {
      handle = observed.handles.at(-1); close = handle.close.bind(handle);
      handle.close = async () => { throw closeError(); };
      return input.acceptCurrent(() => {});
    });
    try {
      expect(await watch.result).toHaveProperty('error');
      await new Promise(resolve => setImmediate(resolve));
      expect(watch.state.notifications).toBe(0);
    } finally {
      handle.close = close;
      await recoverCover(service);
      await watch.retired;
      await new Promise(resolve => setImmediate(resolve));
      process.removeListener('unhandledRejection', unhandled);
    }
    expect(failures).toEqual([]);
    expect(watch.state.notifications).toBe(1);
  });

  it.each(['derivative-failed-exit', 'derivative-hang', 'derivative-delayed-exit'])('waits for the supervised child lifetime with %s', async mode => {
    const small = await sharp({ create: { width: 48, height: 64, channels: 3, background: 'red' } }).png().toBuffer();
    const { asset } = h.add(archive(small));
    const checkpoints = [];
    const supervisor = createComicRenditionSupervisor({
      childModule: fileURLToPath(new URL('./helpers/fake-rendition-child.js', import.meta.url)), childArgs: [mode],
      hooks: { spawned: ({ pid }) => h.children.push({ pid, exited: false }),
        exited: ({ pid }) => { h.children.find(child => child.pid === pid).exited = true; } },
    });
    const service = h.service({ renditions: supervisor, _hooks: { renditionPhase: () => {
      checkpoints.push(watch.state.permitHeld);
    } } });
    const watch = observeCover(service, asset, input => input.encode('preview', policy),
      mode === 'derivative-hang' ? { deadlineMs: 1500 } : {});
    try {
      const result = await watch.result;
      if (mode === 'derivative-delayed-exit') expect(result.value).toMatchObject({ format: 'png' });
      else expect(result.error).toMatchObject({ code: 'DECODER_UNAVAILABLE' });
      await watch.retired;
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(checkpoints.every(Boolean)).toBe(true);
      expect(watch.state.atRetirement.liveChildren).toBe(0);
      expect(watch.state.notifications).toBe(1);
      expect(supervisor.snapshot()).toMatchObject({ active: 0, terminating: 0 });
    } finally { await supervisor.close(); }
  });
});

// Intercept only the real fixture open, before the storage opener validates its handle.
function interceptSourceOpen(full, configure) {
  const open = fs.promises.open;
  let record;
  const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (file, ...args) => {
    const handle = await open.call(fs.promises, file, ...args);
    if (file === full && !record) {
      record = { handle, fd: handle.fd, stat: handle.stat.bind(handle), close: handle.close.bind(handle), attempts: 0 };
      configure(record);
    }
    return handle;
  });
  return { get record() { return record; }, restore() {
    spy.mockRestore();
    if (record) {
      delete record.handle.fd;
      record.handle.stat = record.stat;
      record.handle.close = record.close;
    }
  } };
}

describe('source-opening retirement ownership', () => {
  it('retires an actual open refusal without acquiring a descriptor', async () => {
    const { asset, full } = h.add(archive());
    const service = h.service(), work = vi.fn(), open = fs.promises.open;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation((file, ...args) => {
      if (file === full) throw Object.assign(new Error('Injected open refusal'), { code: 'EACCES' });
      return open.call(fs.promises, file, ...args);
    });
    try {
      const watch = observeCover(service, asset, work);
      expect(await watch.result).toMatchObject({ error: { code: 'SOURCE_MISSING' } });
      await watch.retired;
      expect(watch.state.notifications).toBe(1);
      expect(observed.handles).toHaveLength(0);
      expect(h.admission.snapshot().active).toBe(0);
      expect(service.isIdle()).toBe(true);
      expect(work).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it.each(['stat', 'non-file', 'validation-throw'].flatMap(validation =>
    ['closed', 'open', 'uncertain', 'closed-reject'].map(cleanup => ({ validation, cleanup }))))(
    'owns $validation validation failure with $cleanup cleanup', async ({ validation, cleanup }) => {
      const { asset, full } = h.add(archive());
      const service = h.service(), accepted = vi.fn(), work = vi.fn(input => input.acceptCurrent(accepted));
      const unhandled = [], onUnhandled = error => unhandled.push(error);
      process.on('unhandledRejection', onUnhandled);
      const fault = interceptSourceOpen(full, r => {
        r.handle.stat = async () => {
          if (validation === 'stat') throw closeError();
          const stat = await r.stat();
          stat.isFile = () => { if (validation === 'validation-throw') throw closeError(); return false; };
          return stat;
        };
        r.handle.close = async () => {
          r.attempts++;
          if (cleanup === 'closed' || cleanup === 'closed-reject') await r.close();
          if (cleanup === 'closed') return;
          if (cleanup === 'uncertain') Object.defineProperty(r.handle, 'fd', { configurable: true, get: () => -1 });
          throw closeError();
        };
      });
      const watch = observeCover(service, asset, work);
      let pause;
      try {
        const outcome = await watch.result;
        expect(outcome).toMatchObject({ error: { code: 'SOURCE_MISSING', message: 'Comic is not available.' } });
        expect(outcome.error.cause.name).toBe('StorageError');
        if (validation !== 'non-file') expect(outcome.error.cause.cause.code).toBe('EIO');
        if (cleanup !== 'closed') expect(outcome.error.cleanupError).toMatchObject({ code: 'INTERNAL', cause: { code: 'EIO' } });
        expect(work).not.toHaveBeenCalled();
        expect(accepted).not.toHaveBeenCalled();
        expect(observed.handles).toHaveLength(0);
        await new Promise(resolve => setImmediate(resolve));
        if (cleanup === 'open' || cleanup === 'uncertain') {
          expect(watch.state.notifications, 'opening retirement must remain pending while the descriptor is open').toBe(0);
          expect(fs.fstatSync(fault.record.fd).isFile()).toBe(true);
          expect(h.admission.snapshot().active, 'opening admission must remain reserved').toBe(1);
          expect(service.isIdle()).toBe(false);
          pause = service.pauseForMaintenance();
          await new Promise(resolve => setImmediate(resolve));
          service.stop();
          await new Promise(resolve => setImmediate(resolve));
          expect(fault.record.attempts).toBe(3);
          expect(watch.state.notifications).toBe(0);
          expect(fs.fstatSync(fault.record.fd).isFile()).toBe(true);
          expect(h.admission.snapshot().active).toBe(1);
          expect(service.isIdle()).toBe(false);
        } else {
          await watch.retired;
          expect(fault.record.handle.fd).toBe(-1);
          expect(watch.state.notifications).toBe(1);
          expect(fault.record.attempts).toBe(1);
        }
      } finally {
        fault.restore();
        pause?.release();
        await recoverCover(service);
        await watch.retired;
        await new Promise(resolve => setImmediate(resolve));
        process.removeListener('unhandledRejection', onUnhandled);
      }
      expect(fault.record.handle.fd).toBe(-1);
      expect(() => fs.fstatSync(fault.record.fd)).toThrow();
      expect(watch.state.notifications).toBe(1);
      expect(h.admission.snapshot()).toMatchObject({ active: 0, reservedBytes: 0 });
      await recoverCover(service);
      service.stop();
      expect(watch.state.notifications).toBe(1);
      expect(unhandled).toEqual([]);
    });

  it('holds the actual processing permit across an internal opener failure until confirmed retirement', async () => {
    const { asset, full } = h.add(archive());
    const service = h.service(), pool = createProcessingConcurrencyService({ concurrency: 1 });
    const ready = deferred(), accepted = vi.fn();
    const fault = interceptSourceOpen(full, r => {
      r.handle.stat = async () => { throw closeError(); };
      r.handle.close = () => { r.attempts++; throw closeError(); };
    });
    let watch, nextStarted = false, workerDone = false;
    const worker = pool.run(async () => {
      watch = observeCover(service, asset, input => input.acceptCurrent(accepted));
      watch.result.then(ready.resolve);
      await watch.operation.retired;
    }).then(() => { workerDone = true; });
    let next;
    try {
      expect(await ready.promise).toMatchObject({ error: { code: 'SOURCE_MISSING' } });
      next = pool.run(() => { nextStarted = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(fs.fstatSync(fault.record.fd).isFile()).toBe(true);
      expect(watch.state.notifications, 'opening retirement must remain pending while the descriptor is open').toBe(0);
      expect(workerDone, 'processing permit must remain held after opening result rejection').toBe(false);
      expect(nextStarted).toBe(false);
      expect(watch.state.notifications).toBe(0);
      expect(fs.fstatSync(fault.record.fd).isFile()).toBe(true);
      expect(h.admission.snapshot().active).toBe(1);
      expect(service.isIdle()).toBe(false);
      expect(accepted).not.toHaveBeenCalled();
    } finally {
      fault.restore();
      // Also closes the fixture under deliberately defective scratch ownership controls.
      if (watch.state.notifications && fault.record.handle.fd !== -1) await fault.record.close();
      await recoverCover(service);
      await worker;
      await next;
    }
    expect(workerDone).toBe(true);
    expect(nextStarted).toBe(true);
    expect(watch.state.notifications).toBe(1);
    expect(h.admission.snapshot().active).toBe(0);
    expect(accepted).not.toHaveBeenCalled();
  });

  it('holds admission capacity after opener failure until its tracked descriptor retires', async () => {
    const { asset, full } = h.add(archive());
    const admission = createComicAdmission({ maxActive: 1 }), service = h.service({ admission });
    const fault = interceptSourceOpen(full, r => {
      r.handle.stat = async () => { throw closeError(); };
      r.handle.close = async () => { throw closeError(); };
    });
    const watch = observeCover(service, asset, vi.fn());
    let next, nextStarted = false;
    try {
      expect(await watch.result).toHaveProperty('error');
      next = admission.run(() => { nextStarted = true; }, { weightBytes: 1 });
      await new Promise(resolve => setImmediate(resolve));
      expect(admission.snapshot().active, 'opening admission must remain reserved').toBe(1);
      expect(nextStarted, 'opening failure must not release admission capacity').toBe(false);
      expect(admission.snapshot().queued).toBe(1);
      expect(fs.fstatSync(fault.record.fd).isFile()).toBe(true);
      expect(watch.state.notifications).toBe(0);
    } finally {
      fault.restore();
      if (watch.state.notifications && fault.record.handle.fd !== -1) await fault.record.close();
      await recoverCover(service); await watch.retired; await next;
    }
    expect(nextStarted).toBe(true);
    expect(fault.record.handle.fd).toBe(-1);
    expect(watch.state.notifications).toBe(1);
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0, reservedBytes: 0 });
  });

  it.each(['cancel', 'deadline', 'pause', 'stop', 'withdraw', 'format', 'generation'])(
    'retains opening ownership through %s during validation', async mode => {
      const { asset, full } = h.add(archive());
      const service = h.service(), controller = new AbortController(), work = vi.fn();
      const entered = deferred(), release = deferred(), now = performance.now();
      let pause, clock;
      const fault = interceptSourceOpen(full, r => {
        r.handle.stat = async () => { entered.resolve(); await release.promise; throw closeError(); };
        r.handle.close = async () => { throw closeError(); };
      });
      const watch = observeCover(service, asset, work, { signal: controller.signal });
      try {
        await entered.promise;
        if (mode === 'cancel') controller.abort();
        if (mode === 'deadline') clock = vi.spyOn(performance, 'now').mockReturnValue(now + 60_000);
        if (mode === 'pause') pause = service.pauseForMaintenance();
        if (mode === 'stop') service.stop();
        if (mode === 'withdraw') h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
        if (mode === 'format') h.db.prepare("UPDATE assets SET extension = 'cbr' WHERE id = ?").run(asset.id);
        if (mode === 'generation') h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(asset.id);
        release.resolve();
        expect(await watch.result).toHaveProperty('error');
        await new Promise(resolve => setImmediate(resolve));
        expect(watch.state.notifications).toBe(0);
        expect(fs.fstatSync(fault.record.fd).isFile()).toBe(true);
        expect(h.admission.snapshot().active).toBe(1);
        expect(service.isIdle()).toBe(false);
        expect(work).not.toHaveBeenCalled();
      } finally {
        release.resolve(); clock?.mockRestore(); fault.restore(); pause?.release();
        await recoverCover(service); await watch.retired;
      }
      expect(fault.record.handle.fd).toBe(-1);
      expect(watch.state.notifications).toBe(1);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

  it('retires a second operation independently of a retained opening failure on the same asset', async () => {
    const { asset, full } = h.add(archive());
    const service = h.service(), work = vi.fn();
    const fault = interceptSourceOpen(full, r => {
      r.handle.stat = async () => { throw closeError(); };
      r.handle.close = async () => { throw closeError(); };
    });
    const a = observeCover(service, asset, work);
    try {
      expect(await a.result).toHaveProperty('error');
      const b = observeCover(service, asset, () => 'B');
      expect(a.operation.retired).not.toBe(b.operation.retired);
      expect(await b.result).toEqual({ value: 'B' });
      await Promise.resolve();
      expect(b.state.notifications, 'B must retire without a global idle transition').toBe(1);
      expect(a.state.notifications).toBe(0);
      expect(h.admission.snapshot().active).toBe(1);
      expect(fs.fstatSync(fault.record.fd).isFile()).toBe(true);
      expect(work).not.toHaveBeenCalled();
    } finally {
      fault.restore(); await recoverCover(service); await a.retired;
    }
    expect(a.state.notifications).toBe(1);
  });
});
