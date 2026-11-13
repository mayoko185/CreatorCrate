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
import { createReleaseService } from '../../src/services/release-service.js';
import { createComicRuntime } from '../../src/services/comic-runtime.js';
import { makeZip } from '../helpers/zip-fixture.js';

const DIALOG = '#unified-viewer-dialog';
const evidence = process.env.CC_B_EVIDENCE;
const result = { geometry: [], behavior: {} };
if (evidence) fs.mkdirSync(path.join(evidence, 'screenshots'), { recursive: true });
test.setTimeout(45000);
let fixture;
let serial = 0;

test.beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-native-'));
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
  fs.writeFileSync(bridge, `export * from '${source}release-detail-refresh.js';\nexport * from '${source}preview.js';`);
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
      app.locals.appMetaRepository.setValue('images.preview.format', 'webp');
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
      const extra = write('z-later.cbz', makeZip([{name:'001.png',data:other}]));
      const release = createReleaseService({db}).createReleaseWithSelectedAssets(project.id,{title:'Native Cover Release'},[comic,picture]);
      return { project, dir, write, comic, picture, extra, release,
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

const card = (page,id) => page.locator(`article[data-asset-id="${id}"]`);
const frame = (page,f) => card(page,f.comic).locator('.asset-card-media[data-preview-enhancement], .asset-list-card-media[data-preview-enhancement]');
const image = (page,f) => frame(page,f).locator('[data-preview-image]');
const reader = (page,f) => card(page,f.comic).locator('[data-comic-asset]:visible');
const route = (host,f,view='grid') => `/releases/${f.release.id}${host==='manage'?'/assets':''}?view=${view}&sort=filename&order=asc&pageSize=all${host==='manage'?'&selection=all':''}`;
async function refresh(page,host,f,nextURL) {
  if(host==='release') return page.evaluate(async ({bridge,id})=>(await import(bridge)).refreshReleaseDetail(document,String(id)),{bridge:fixture.bridgeURL,id:f.release.id});
  await page.locator('[data-release-assets-live-region]').evaluate(el=>{el.dataset.bMarker='true';});
  await page.evaluate(next=>{if(next)history.replaceState({releaseAssets:true},'',next);dispatchEvent(new PopStateEvent('popstate',{state:{releaseAssets:true}}));},nextURL);
  await expect(page.locator('[data-release-assets-live-region][data-b-marker]')).toHaveCount(0);
  await expect(page.locator('[data-release-assets-live-region]')).not.toHaveAttribute('aria-busy','true');
}
async function open(page,host,f,view='grid') {
  await page.goto(fixture.baseURL+route(host,f,view));
  await page.waitForFunction(()=>!!document.querySelector('#unified-viewer-dialog')?.__creatorCrateUnifiedViewer);
  await card(page,f.comic).scrollIntoViewIfNeeded();
  await expect(frame(page,f)).toHaveAttribute('data-preview-state','loaded');
  await image(page,f).evaluate(async img=>{await img.decode();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
}
async function pixels(page,f) {
  return image(page,f).evaluate(img=>{const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);return c.toDataURL();});
}
async function geometry(page,id) {
 return card(page,id).locator('.asset-card-media [data-preview-image], .asset-list-card-media [data-preview-image]').evaluate(img=>{const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};const root=img.closest('[data-preview-enhancement]'),css=getComputedStyle(img);return {image:box(img),frame:box(root),className:img.className,objectFit:css.objectFit,natural:[img.naturalWidth,img.naturalHeight],loading:img.loading,src:img.currentSrc,legacy:!!root.querySelector('[data-comic-thumbnail],.asset-comic-thumbnail-badge')};});
}
const membership=page=>page.locator('input[name="selectedAssetIds"]').evaluateAll(inputs=>[...new Set(inputs.filter(el=>el.type==='hidden'||el.checked).map(el=>el.value))].sort());
const saved=f=>fixture.db.prepare('SELECT asset_id,role,sort_order FROM release_assets WHERE release_id=? ORDER BY sort_order').all(f.release.id);

for(const host of ['manage','release']) {
 test(`${host}: shared native Grid cropped/uncropped and List geometry parity`,async({page})=>{
  const f=fixture.create();const requests=[];page.on('request',r=>{if(/\/(preview|thumbnail)(\?|$)/.test(r.url()))requests.push({url:r.url(),type:r.resourceType()});});
  for(const width of [390,1440])for(const [view,style] of [['grid','uncropped'],['grid','cropped'],['list','uncropped']]) {
   await page.setViewportSize({width,height:1100});await open(page,host,f,view);
   if(view==='grid') {await page.locator('[data-asset-grid-style-control]').selectOption(style,{force:true});await expect(page.locator('.asset-grid')).toHaveAttribute('data-grid-style',style);}
   const pair=[];
   for(const [kind,id] of [['ordinary',f.picture],['comic',f.comic]]) {
    await card(page,id).scrollIntoViewIfNeeded();await expect(card(page,id).locator('.asset-card-media[data-preview-enhancement], .asset-list-card-media[data-preview-enhancement]')).toHaveAttribute('data-preview-state','loaded');
    const data=await geometry(page,id);data.kind=kind;data.host=host;data.viewport=width;data.view=view;data.style=style;
    data.pixelHash=await card(page,id).locator('.asset-card-media [data-preview-image], .asset-list-card-media [data-preview-image]').evaluate(async img=>{await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);const d=await crypto.subtle.digest('SHA-256',c.getContext('2d').getImageData(0,0,c.width,c.height).data);return [...new Uint8Array(d)].map(n=>n.toString(16).padStart(2,'0')).join('');});
    expect(data.loading).toBe('lazy');expect(data.legacy).toBe(false);expect(data.image.right).toBeLessThanOrEqual(data.frame.right+.1);expect(data.image.x).toBeGreaterThanOrEqual(data.frame.x-.1);pair.push(data);
   }
   expect(pair[0].image.width).toBeCloseTo(pair[1].image.width,2);expect(pair[0].image.height).toBeCloseTo(pair[1].image.height,2);expect(pair[0].objectFit).toBe(pair[1].objectFit);expect(pair[0].className).toBe(pair[1].className);expect(pair[0].pixelHash).toBe(pair[1].pixelHash);
   if(view==='grid'&&style==='uncropped')expect(pair[1].image.height/pair[1].image.width).toBeCloseTo(1.5,2);
   if(evidence)await page.screenshot({path:path.join(evidence,'screenshots',`${host}-${width}-${view}-${style}.png`),fullPage:true});result.geometry.push(...pair);
  }
  expect(requests.every(r=>r.type==='image'&&r.url.includes('/preview?'))).toBe(true);
  result.behavior[host+'GeometryRequests']=requests;
 });

 test(`${host}: normal-cache source/policy/canonical freshness and original Reader bytes`,async({page,request})=>{
  const f=fixture.create();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{window.bBlob=0;const orig=URL.createObjectURL;URL.createObjectURL=(...a)=>{window.bBlob++;return orig.apply(URL,a);};});await open(page,host,f);
  const before=await pixels(page,f);const originalSrc=await image(page,f).getAttribute('src');const originalSaved=saved(f);const countStart=fixture.previewRequests.length;
  await image(page,f).evaluate(img=>{window.bImage=img;window.bCard=img.closest('article');img.closest('a').focus();});
  await refresh(page,host,f);await page.evaluate(async bridge=>{const m=await import(bridge);for(let i=0;i<3;i++)m.enhancePreviewMedia(document);},fixture.bridgeURL);await expect(frame(page,f)).toHaveAttribute('data-preview-state','loaded');
  if(host==='release') {expect(fixture.previewRequests.length).toBe(countStart);expect(await image(page,f).evaluate(img=>img===window.bImage&&img.closest('article')===window.bCard&&document.activeElement===img.closest('a'))).toBe(true);}
  f.rewrite();const start=fixture.previewRequests.length;await refresh(page,host,f);await expect(frame(page,f)).toHaveAttribute('data-preview-state','loaded');expect(await pixels(page,f)).not.toBe(before);expect(await image(page,f).getAttribute('src')).not.toBe(originalSrc);expect(fixture.previewRequests.slice(start).filter(r=>r.url.includes(`/assets/${f.comic}/preview`))).toHaveLength(1);
  if(host==='release')expect(await image(page,f).evaluate(img=>img===window.bImage)).toBe(true);
  const sourceURL=await image(page,f).getAttribute('src');fixture.app.locals.appMetaRepository.setValue('images.preview.format','png');await refresh(page,host,f);await expect(frame(page,f)).toHaveAttribute('data-preview-state','loaded');expect(await image(page,f).getAttribute('src')).not.toBe(sourceURL);
  expect(await image(page,f).evaluate(img=>{const c=document.createElement('canvas');c.width=1;c.height=1;c.getContext('2d').drawImage(img,0,0);return [...c.getContext('2d').getImageData(0,0,1,1).data];})).toEqual([27,163,57,255]);
  const hint=await reader(page,f).getAttribute('data-comic-source-revision');const policyURL=await image(page,f).getAttribute('src');fixture.db.prepare("UPDATE assets SET extension='cbr',mime_type='application/vnd.comicbook-rar' WHERE id=?").run(f.comic);fixture.refusePreview(f.project.id,f.comic,409);
  const serverStart=fixture.previewRequests.length;await refresh(page,host,f);await expect(frame(page,f)).toHaveAttribute('data-preview-state','failed');const formatURL=await image(page,f).getAttribute('src');expect(formatURL).not.toBe(policyURL);expect(await reader(page,f).getAttribute('data-comic-source-revision')).toBe(hint);expect(fixture.previewRequests.slice(serverStart).filter(r=>r.url.includes(`/assets/${f.comic}/preview`))).toEqual([{url:formatURL,status:409}]);await expect(image(page,f)).toBeHidden();await expect(reader(page,f)).toHaveAttribute('data-preview-fallback','');
  fixture.db.prepare("UPDATE assets SET extension='cbz',mime_type='application/vnd.comicbook+zip',source_generation=source_generation+1 WHERE id=?").run(f.comic);fixture.refusePreview(f.project.id,f.comic,0);await refresh(page,host,f);await expect(frame(page,f)).toHaveAttribute('data-preview-state','loaded');
  const manifest=await (await request.get(fixture.baseURL+`/projects/${f.project.id}/assets/${f.comic}/comic`)).json();expect(manifest.pages.length).toBe(1);const pageURL=manifest.pages[0].url;const original=await request.get(fixture.baseURL+pageURL);expect(original.status()).toBe(200);expect(createHash('sha256').update(await original.body()).digest('hex')).toBe(createHash('sha256').update(fixture.other).digest('hex'));
  expect(saved(f)).toEqual(originalSaved);expect(errors).toEqual([]);expect(await page.evaluate(()=>window.bBlob)).toBe(0);result.behavior[host+'Freshness']={unchangedNoRequest:host==='release',sameImage:host==='release',sourcePixelsChanged:true,sourceURLChanged:true,policyPixel:[27,163,57,255],formatURLChanged:true,formatHintUnchanged:true,formatServerRequests:fixture.previewRequests.slice(serverStart).filter(r=>r.url===formatURL),readerOriginalSHA256:createHash('sha256').update(await original.body()).digest('hex'),saved:originalSaved,errors};
 });

 for(const status of [404,503])test(`${host}: Preview ${status} fallback pointer/Enter/focus, recovery and withdrawal`,async({page})=>{
  const f=fixture.create();fixture.refusePreview(f.project.id,f.comic,status);await page.goto(fixture.baseURL+route(host,f));await page.waitForFunction(()=>!!document.querySelector('#unified-viewer-dialog')?.__creatorCrateUnifiedViewer);await card(page,f.comic).scrollIntoViewIfNeeded();await expect(frame(page,f)).toHaveAttribute('data-preview-state','failed');
  const fallback=reader(page,f);await expect(fallback).toHaveAttribute('data-preview-fallback','');await fallback.click();await expect(page.locator(DIALOG)).toBeVisible();await page.keyboard.press('Escape');await expect(fallback).toBeFocused();await fallback.press('Enter');await expect(page.locator(DIALOG)).toBeVisible();await page.keyboard.press('Escape');await expect(fallback).toBeFocused();
  fixture.refusePreview(f.project.id,f.comic,0);f.rewrite();await refresh(page,host,f);await expect(frame(page,f)).toHaveAttribute('data-preview-state','loaded');if(host==='release')await expect(reader(page,f)).toBeFocused();
  await reader(page,f).press('Enter');await expect(page.locator(DIALOG)).toBeVisible();fixture.db.prepare('UPDATE assets SET is_present=0 WHERE id=?').run(f.comic);await refresh(page,host,f);await expect(page.locator(DIALOG)).toBeHidden();await expect(card(page,f.comic).locator('[data-comic-asset]')).toHaveCount(0);
  if(host==='release'){await expect(image(page,f)).not.toHaveAttribute('src');await expect(image(page,f)).toBeHidden();}
  result.behavior[host+'Fallback'+status]={pointer:true,enter:true,closeFocus:true,recovery:true,withdrawnBothTriggers:true,withdrawnImage:true};
 });
}

test('Manage Assets hidden draft, membership/order and card actions survive native cover refresh',async({page})=>{
 const f=fixture.create();const initial=saved(f);const nonGet=[];page.on('request',r=>{if(r.method()!=='GET')nonGet.push(r.method());});await open(page,'manage',f);
 await page.locator(`#release-asset-select-${f.extra}`).check();await page.locator(`#release-asset-select-${f.comic}`).uncheck();const draft=await membership(page);await reader(page,f).click();await expect(page.locator(DIALOG)).toBeVisible();await page.keyboard.press('Escape');expect(await membership(page)).toEqual(draft);
 await refresh(page,'manage',f,route('manage',f,'list')+'&search=picture');expect(await membership(page)).toEqual(draft);expect(await page.locator('input[type="hidden"][name="selectedAssetIds"]').count()).toBeGreaterThan(0);
 await refresh(page,'manage',f,route('manage',f));await expect(page.locator(`#release-asset-select-${f.extra}`)).toBeChecked();await expect(page.locator(`#release-asset-select-${f.comic}`)).not.toBeChecked();expect(await membership(page)).toEqual(draft);expect(saved(f)).toEqual(initial);expect(nonGet).toEqual([]);await expect(card(page,f.comic).locator('.asset-details-link')).toHaveAttribute('href',`/projects/${f.project.id}/assets/${f.comic}`);result.behavior.hiddenDraft={draft,saved:initial,nonGet};
});
