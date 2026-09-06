import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { build } from 'vite';
import { createAssetManifest } from '../../src/asset-manifest.js';

test('New and Edit Page contents alone have compact horizontal padding', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-padding-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const viteDistRoot = path.join(root, 'client');
    await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
    const assetManifest = createAssetManifest({ distRoot: viteDistRoot, manifestPath: path.join(viteDistRoot, '.vite/manifest.json') });
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot, assetManifest });
    const book = app.locals.bookService.createBook({ title: 'Padding Book' });
    const note = app.locals.noteService.createNote({ bookId: book.id, title: 'Padding Page', content: 'Editor content' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 640 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      for (const route of [`/notes/new?bookId=${book.id}`, `/notes/${note.id}/edit`]) {
        await page.goto(base + route);
        const dialog = page.locator('dialog[open]');
        await expect(dialog.locator('.toastui-editor-defaultUI')).toBeVisible();
        const result = await dialog.evaluate(n => {
          const body = n.querySelector('.notes-page-contents-body');
          const editor = n.querySelector('.toastui-editor-defaultUI');
          const properties = e => {
            const s = getComputedStyle(e);
            return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft];
          };
          const peers = [...n.querySelectorAll('.project-edit-dialog-section-body:not(.notes-page-contents-body)')];
          const measure = () => ({
            padding: properties(body), width: editor.getBoundingClientRect().width,
            height: editor.getBoundingClientRect().height,
            peers: peers.map(properties),
          });
          const after = measure();
          body.classList.remove('notes-page-contents-body');
          const before = measure();
          body.classList.add('notes-page-contents-body');
          return { after, before, overflow: n.scrollWidth > n.clientWidth || body.scrollWidth > body.clientWidth };
        });
        expect(result.after.padding).toEqual(['12px', '12px', '16px', '12px']);
        expect(result.before.padding).toEqual(['12px', '16px', '16px', '16px']);
        expect(result.after.width - result.before.width).toBeCloseTo(8, 0);
        expect(result.after.height).toBe(result.before.height);
        expect(result.after.peers).toEqual(result.before.peers);
        expect(result.after.peers.every(p => p[1] === '16px' && p[3] === '16px')).toBe(true);
        expect(result.overflow).toBe(false);
        const bold = dialog.locator('.toastui-editor-toolbar button.bold');
        await bold.scrollIntoViewIfNeeded();
        await bold.click();
        console.log(JSON.stringify({ viewport, route, ...result }));
      }
    }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
