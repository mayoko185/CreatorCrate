import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { createAssetRepository } from '../../src/data/asset-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createComicRuntime } from '../../src/services/comic-runtime.js';
import { makeZip } from '../helpers/zip-fixture.js';

const DIALOG = '#unified-viewer-dialog';
const evidence = process.env.CC_A2_EVIDENCE;
const result = { geometry: [], behavior: {} };
if (evidence) fs.mkdirSync(path.join(evidence, 'screenshots'), { recursive: true });
test.setTimeout(45000);
let fixture;
let serial = 0;

test.beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-thumbnail-hosts-'));
  let db; let runtime; let server; let app;
  const documentGates = new Map();
  const previewRefusals = new Map();
  const previewRequests = [];
  const close = async () => {
    try {
      for (const gate of documentGates.values()) gate.release();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    } finally {
      try {
        app?.locals.comicMediaService?.stop();
        await app?.locals.comicMediaService?.pauseForMaintenance().waitForIdle();
        for (const owner of [app?.locals.generatedImageRebuildService, app?.locals.generatedImagePublicationLifecycle]) { owner?.stop(); await owner?.waitForIdle(); }
        await runtime?.close();
      } finally {
        if (db) closeDatabase(db);
        if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Unsafe fixture cleanup');
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
      }
    }
  };
  fixture = { close };
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const previewRoot = path.join(appDataRoot, 'previews');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(previewRoot, { recursive: true });
  // A second compiled entry exposes the same module instances as the real bundle.
  const bridge = path.join(root, 'bridge.js');
  const source = fileURLToPath(new URL('../../src/static/client/', import.meta.url)).replaceAll('\\', '/');
  fs.writeFileSync(bridge, `export * from '${source}asset-viewer-refresh.js';\nexport * from '${source}preview.js';`);
  await build({ build: { outDir: viteDistRoot, rolldownOptions: { preserveEntrySignatures: 'strict', input: {
    main: fileURLToPath(new URL('../../client/main.js', import.meta.url)), bridge,
  } } }, logLevel: 'silent' });
  const built = JSON.parse(fs.readFileSync(path.join(viteDistRoot, '.vite/manifest.json')));
  const bridgeKey = Object.keys(built).find(key => built[key].name === 'bridge');
  built['test-bridge.js'] = { ...built[bridgeKey], src: 'test-bridge.js' };
  delete built[bridgeKey];
  const keys = Object.fromEntries(Object.keys(built).map(key => [key, /^[A-Za-z]:/.test(key) ? 'test-dependency/' + createHash('sha256').update(key).digest('hex').slice(0,16) + '.js' : key]));
  const normalized = {};
  for (const [key, value] of Object.entries(built)) {
    const entry = { ...value };
    if (entry.src && keys[entry.src]) entry.src = keys[entry.src];
    for (const field of ['imports', 'dynamicImports']) if (entry[field]) entry[field] = entry[field].map(k => keys[k] || k);
    normalized[keys[key]] = entry;
  }
  fs.writeFileSync(path.join(viteDistRoot, '.vite/manifest.json'), JSON.stringify(normalized));
  const bridgeURL = '/vite/' + Object.values(built).find(entry => entry.isEntry && entry.name === 'bridge').file;
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  runtime = createComicRuntime({ appDataRoot, projectsRoot, cacheOptions: { settleMs: 0 } });
  await runtime.start();
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
    appDataRoot, authState: { csrfPepper }, comicRuntime: runtime,
    startGeneratedImageRebuild: false, useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot, manifestPath: path.join(viteDistRoot, '.vite/manifest.json') }),
  });
  app.locals.appMetaRepository.setValue('images.preview.max_dimension', '960');
  app.locals.appMetaRepository.setValue('images.preview.webp_quality', '73');
  app.locals.generatedImagePublicationLifecycle.prepare();
  app.locals.generatedImagePublicationLifecycle.signal();
  await app.locals.generatedImagePublicationLifecycle.waitForIdle();
  const repo = createAssetRepository(db);
  const cover = await sharp({ create: { width: 1200, height: 1800, channels: 3, background: '#cf1973' } }).png().toBuffer();
  const other = await sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#1ba339' } }).png().toBuffer();
  // Delay only the selected document on the server; browser Fetch routing can strand startup scripts.
  server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (/\/assets\/\d+\/preview$/.test(pathname)) {
      const request = { url: req.url, status: null };
      previewRequests.push(request);
      res.once('finish', () => { request.status = res.statusCode; });
      const refusal = previewRefusals.get(pathname);
      if (refusal) {
        res.writeHead(refusal, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' });
        res.end('Current source unavailable');
        return;
      }
    }
    const gate = documentGates.get(req.url);
    if (!gate) return app(req, res);
    gate.entered = true;
    gate.promise.then(() => { if (!res.destroyed) app(req, res); });
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(baseURL + '/health', { signal: AbortSignal.timeout(15000) });
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok', database: 'ok' });
  fixture = { root, db, app, repo, cover, other, bridgeURL,
    baseURL,
    previewRequests,
    refusePreview(projectId, assetId, status) {
      previewRefusals.set(`/projects/${projectId}/assets/${assetId}/preview`, status);
    },
    pendingDocuments: () => documentGates.size,
    holdDocument(destination) {
      const { pathname, search } = new URL(destination);
      const key = pathname + search;
      expect(documentGates.has(key)).toBe(false);
      let release;
      const gate = { entered: false, promise: new Promise(resolve => { release = resolve; }),
        release() { documentGates.delete(key); release(); } };
      documentGates.set(key, gate);
      return gate;
    },
    create() {
      const project = app.locals.projectService.create({ title: `Thumbnail Host ${++serial}`, status: 'tbd', projectType: 'images' });
      const dir = path.join(projectsRoot, project.project_dir);
      function write(filename, bytes) {
        fs.writeFileSync(path.join(dir, filename), bytes);
        const stat = fs.statSync(path.join(dir, filename));
        return repo.upsert(project.id, filename, { filename, extension: filename.split('.').pop(),
          mimeType: { png: 'image/png', mp4: 'video/mp4', cbz: 'application/vnd.comicbook+zip',
            cbr: 'application/vnd.comicbook-rar', cb7: 'application/x-cb7' }[filename.split('.').pop()],
          sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() }).id;
      }
      const comic = write('a-book.cbz', makeZip([{ name: '001.png', data: cover }, { name: '002.png', data: other }]));
      const picture = write('picture.png', cover);
      return { project, dir, write, comic, picture,
        rewrite() {
          const filename = 'a-book.cbz';
          const bytes = makeZip([{ name: 'replacement.png', data: other }]);
          fs.writeFileSync(path.join(dir, filename), bytes);
          const later = new Date(Date.now() + 60000);
          fs.utimesSync(path.join(dir, filename), later, later);
          const stat = fs.statSync(path.join(dir, filename));
          db.prepare('UPDATE assets SET filename = ?, relative_path = ?, extension = ?, mime_type = ?, size_bytes = ?, modified_at = ?, source_generation = source_generation + 1 WHERE id = ?')
            .run(filename, filename, 'cbz', 'application/vnd.comicbook+zip', stat.size, stat.mtime.toISOString(), comic);
        },
      };
    },
    close,
  };
});
test.afterEach(() => { expect(fixture?.pendingDocuments()).toBe(0); });
test.afterAll(async ({ browser }) => {
  try { expect(browser.contexts()).toHaveLength(0); }
  finally { await fixture?.close(); if (evidence) fs.writeFileSync(path.join(evidence, 'browser-results.json'), JSON.stringify(result, null, 2)); }
});

const frame = page => page.locator('figure[data-preview-enhancement]');
const image = page => frame(page).locator('[data-preview-image]');
const reader = page => page.locator('[data-asset-details-comic-trigger]:visible');
const route = (f, id = f.comic) => `/projects/${f.project.id}/assets/${id}`;
const refresh = page => page.evaluate(async bridge => (await import(bridge)).refreshAssetViewer(document, { regions: ['file'] }), fixture.bridgeURL);
async function open(page, f, id = f.comic) {
  await page.goto(fixture.baseURL + route(f,id));
  await page.waitForFunction(() => !!document.querySelector('#unified-viewer-dialog')?.__creatorCrateUnifiedViewer);
  await expect(frame(page)).toHaveAttribute('data-preview-state','loaded');
  await image(page).evaluate(async img => { await img.decode(); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); });
}
async function pixels(page) {
  return image(page).evaluate(img => { const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);return c.toDataURL(); });
}
async function metadata(page) {
  return image(page).evaluate(img => {
    const box = e => { const r=e.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; };
    const f=img.closest('figure'), link=img.closest('a'),css=getComputedStyle(img);
    return { image:box(img),frame:box(f),link:box(link),natural:[img.naturalWidth,img.naturalHeight],objectFit:css.objectFit,maxHeight:css.maxHeight,loading:img.loading,src:img.currentSrc,legacy:!!f.querySelector('[data-comic-thumbnail],.asset-comic-thumbnail-badge'),className:img.className };
  });
}
test('Detail ordinary/comic native image parity at narrow and wide viewports', async ({ page }) => {
  const f=fixture.create();
  for(const width of [390,1440]) {
    await page.setViewportSize({width,height:1100});
    const pair=[];
    for(const [kind,id] of [['ordinary',f.picture],['comic',f.comic]]) {
      const requests=[];const watch=req=>{if(/\/(preview|thumbnail)(\?|$)/.test(req.url())) requests.push({url:req.url(),type:req.resourceType()});};
      page.on('request',watch); await open(page,f,id);page.off('request',watch);
      const data=await metadata(page);data.kind=kind;data.width=width;data.requests=requests;data.pixelHash=createHash('sha256').update(await pixels(page)).digest('hex');
      expect(data.image.height).toBeLessThanOrEqual(770.1);
      expect(data.image.height/data.image.width).toBeCloseTo(1.5,2);
      expect(data.image.right).toBeLessThanOrEqual(data.frame.right+.1);
      expect(data.image.x).toBeGreaterThanOrEqual(data.frame.x-.1);
      expect(data.objectFit).toBe('contain');expect(data.loading).toBe('auto');expect(data.legacy).toBe(false);
      expect(requests).toHaveLength(1);expect(requests[0].type).toBe('image');
      if(evidence) await page.screenshot({path:path.join(evidence,'screenshots',`${kind}-${width}.png`),fullPage:true});
      pair.push(data);
    }
    expect(pair[1].image.width).toBeCloseTo(pair[0].image.width,2);expect(pair[1].image.height).toBeCloseTo(pair[0].image.height,2);
    expect(pair[1].className).toBe(pair[0].className);expect(pair[1].pixelHash).toBe(pair[0].pixelHash);
    result.geometry.push(...pair);
  }
});
test('Detail normal-cache retained source/policy and canonical format refresh reaches current authority', async ({page})=>{
  const f=fixture.create();await page.addInitScript(()=>{window.a2Blobs=0;const original=URL.createObjectURL;URL.createObjectURL=(...args)=>{window.a2Blobs++;return original.apply(URL,args);};});
  const initialResponse=page.waitForResponse(r=>r.url().includes(`/assets/${f.comic}/preview`) && r.request().resourceType()==='image');
  await open(page,f);const cacheControl=(await initialResponse).headers()['cache-control'];expect(cacheControl).toBe('private, max-age=0, must-revalidate');
  const firstPixels=await pixels(page);let requests=0;
  page.on('request',req=>{if(req.url().includes(`/assets/${f.comic}/preview`))requests++;});
  await page.evaluate(()=>{window.a2Image=document.querySelector('[data-preview-image]');window.a2Frame=document.querySelector('figure[data-preview-enhancement]');document.querySelector('[data-asset-details-comic-trigger]').focus();});
  const oldSrc=await image(page).getAttribute('src');
  expect((await refresh(page)).mediaReplaced).toBe(false);await page.evaluate(async bridge=>{const m=await import(bridge);for(let i=0;i<3;i++)m.enhancePreviewMedia(document);},fixture.bridgeURL);await page.waitForTimeout(100);
  expect(requests).toBe(0);expect(await page.evaluate(()=>window.a2Image===document.querySelector('[data-preview-image]') && window.a2Frame===document.querySelector('figure[data-preview-enhancement]') && document.activeElement.matches('[data-asset-details-comic-trigger]'))).toBe(true);
  f.rewrite();expect((await refresh(page)).mediaChanges).toContain('preview');await expect(frame(page)).toHaveAttribute('data-preview-state','loaded');
  expect(requests).toBe(1);expect(await pixels(page)).not.toBe(firstPixels);expect(await image(page).getAttribute('src')).not.toBe(oldSrc);
  expect(await page.evaluate(()=>window.a2Image===document.querySelector('[data-preview-image]'))).toBe(true);
  const sourceSrc=await image(page).getAttribute('src');const sourcePixels=await pixels(page);
  fixture.app.locals.appMetaRepository.setValue('images.preview.format','png');
  const pngResponse=page.waitForResponse(r=>r.url().includes(`/assets/${f.comic}/preview`) && r.request().resourceType()==='image');
  expect((await refresh(page)).mediaChanges).toContain('preview');await expect(frame(page)).toHaveAttribute('data-preview-state','loaded');
  expect((await pngResponse).headers()['content-type']).toContain('image/png');expect(requests).toBe(2);
  expect(await image(page).getAttribute('src')).not.toBe(sourceSrc);expect(await pixels(page)).not.toBe('');
  expect(await image(page).evaluate(img=>{const c=document.createElement('canvas');c.width=1;c.height=1;c.getContext('2d').drawImage(img,0,0);return [...c.getContext('2d').getImageData(0,0,1,1).data];})).toEqual([27,163,57,255]);
  const beforeFormat=await image(page).getAttribute('src');const hint=await reader(page).getAttribute('data-comic-source-revision');
  fixture.db.prepare("UPDATE assets SET extension='cbr', mime_type='application/vnd.comicbook-rar' WHERE id=?").run(f.comic);
  // Server-side refusal preserves normal browser caching, including decoded-image reuse.
  fixture.refusePreview(f.project.id,f.comic,409);
  const serverStart=fixture.previewRequests.length;
  const refusal=page.waitForResponse(r=>r.url().includes(`/assets/${f.comic}/preview`) && r.request().resourceType()==='image');
  expect((await refresh(page)).mediaChanges).toContain('preview');await expect(frame(page)).toHaveAttribute('data-preview-state','failed');
  expect((await refusal).status()).toBe(409);
  const currentSrc=await image(page).getAttribute('src');
  expect(currentSrc).not.toBe(beforeFormat);expect(await reader(page).getAttribute('data-comic-source-revision')).toBe(hint);
  expect(fixture.previewRequests.slice(serverStart)).toEqual([{url:currentSrc,status:409}]);
  await expect(frame(page)).toHaveAttribute('data-comic-format','cbr');await expect(image(page)).toBeHidden();await expect(reader(page)).toHaveAttribute('data-preview-fallback','');
  expect(await image(page).evaluate(img=>img.naturalWidth)).toBe(0);
  expect(await page.evaluate(()=>window.a2Image===document.querySelector('[data-preview-image]'))).toBe(true);
  expect(requests).toBe(3);expect(await page.evaluate(()=>window.a2Blobs)).toBe(0);
  if(evidence) await page.screenshot({path:path.join(evidence,'screenshots','normal-cache-format-fallback.png'),fullPage:true});
  result.behavior.refresh={nativeImageRequests:requests,blobCalls:0,pngCurrentPixel:[27,163,57,255],requests,unchangedRequests:0,sameImage:true,oldSrc,sourceSrc,policySrc:beforeFormat,formatSrc:currentSrc,readerHintUnchanged:true,cacheControl,formatServerRequests:fixture.previewRequests.slice(serverStart),formatFailed:true,staleImageHidden:true,staleNaturalWidth:0,sourcePixelsChanged:sourcePixels!==firstPixels};
});
test('Detail failed cover Reader activation, recovery, gone and stale-order focus', async ({page})=>{
  const f=fixture.create();await page.route(`**/assets/${f.comic}/preview*`,r=>r.fulfill({status:503,body:'Unavailable'}));
  await page.goto(fixture.baseURL+route(f));await page.waitForFunction(()=>!!document.querySelector('#unified-viewer-dialog')?.__creatorCrateUnifiedViewer);
  await expect(frame(page)).toHaveAttribute('data-preview-state','failed');
  const fallback=reader(page);await expect(fallback).toHaveAttribute('data-preview-fallback','');await fallback.click();await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');await expect(fallback).toBeFocused();await fallback.press('Enter');await expect(page.locator(DIALOG)).toBeVisible();await page.keyboard.press('Escape');await expect(fallback).toBeFocused();
  await page.unroute(`**/assets/${f.comic}/preview*`);f.rewrite();await refresh(page);await expect(frame(page)).toHaveAttribute('data-preview-state','loaded');await expect(reader(page)).toBeFocused();
  await reader(page).press('Enter');await expect(page.locator(DIALOG)).toBeVisible();
  // Hold an earlier server render, then install a newer missing response.
  let releaseOld;let entered;const start=new Promise(r=>entered=r),gate=new Promise(r=>releaseOld=r);let call=0;
  await page.route(fixture.baseURL+route(f),async r=>{call++;if(call===1){const old=await r.fetch();entered();await gate;await r.fulfill({response:old});}else await r.fulfill({status:404,body:'Gone'});});
  const old=refresh(page);await start;expect((await refresh(page)).status).toBe('missing');releaseOld();expect((await old).status).toBe('superseded');
  await expect(page.locator(DIALOG)).toBeHidden();await expect(page.locator('#asset-preview-heading')).toBeFocused();await expect(page.locator('[data-asset-details-comic-trigger]')).toHaveCount(0);await expect(image(page)).not.toHaveAttribute('src');await expect(image(page)).toBeHidden();
  result.behavior.fallback={pointer:true,enter:true,closeFocus:true,recoveryFocus:true,goneHeadingFocus:true,goneSourceWithdrawn:true,staleSuperseded:true};
});
