import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

test('shared Projects toolbar tooltips stay inside the document on Book detail and Projects', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-tooltip-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const project = app.locals.projectService.create({ title: 'Toolbar project', status: 'tbd' });
    const book = app.locals.bookService.createBook({ title: 'Toolbar regression' });
    app.locals.noteService.createNote({ bookId: book.id, title: 'First', content: 'First Page' });
    app.locals.noteService.createNote({ bookId: book.id, title: 'Second', content: 'Second Page' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const selector = '.asset-viewer-display-controls .project-filter-actions--projects .asset-tooltip[data-tooltip]';
    for (const width of [1280, 1440, 390, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of [`/notes/books/${book.id}`, '/projects', '/', '/asset-viewer', `/projects/${project.id}/assets`, '/releases', '/settings/logs']) {
        await page.goto(`${base}${route}`);
        const controls = page.locator(selector);
        await expect(controls.first()).toBeVisible();
        // Compare the entire control row with the original placement: positioning a tooltip must not move controls.
        const geometry = () => page.locator('.asset-viewer-display-controls').evaluate(node =>
          [node, ...node.querySelectorAll('*')].map(element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return [element.className.baseVal ?? element.className, rect.x, rect.y, rect.width, rect.height, style.gap, style.justifyContent];
          }));
        const currentGeometry = await geometry();
        await page.evaluate(rule => document.styleSheets[0].insertRule(rule, 0), `${selector}::after { left: 0 !important; right: auto !important; }`);
        expect(await geometry()).toEqual(currentGeometry);
        await page.evaluate(() => document.styleSheets[0].deleteRule(0));
        if (route.startsWith('/notes/books/')) {
          await expect(page.locator('.page-heading .asset-viewer-display-controls')).toHaveCount(0);
          await expect(page.locator('.asset-viewer-display-controls > .project-filter-actions.project-filter-actions--projects')).toHaveCount(1);
          const toolbar = page.locator('[data-book-detail-toolbar]');
          const back = toolbar.getByRole('link', { name: 'Back to book list', exact: true });
          await expect(back).toBeVisible();
          await expect(back).toHaveAttribute('href', '/notes');
          await expect(back).toHaveClass('button button-secondary');
          expect(await toolbar.locator('a').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') || node.textContent.trim())))
            .toEqual(['Back to book list', 'Edit book', 'Change order', 'Book defaults', 'Reset to default']);
          const row = await toolbar.boundingBox();
          const backBox = await back.boundingBox();
          const actions = await toolbar.locator('.project-filter-actions').boundingBox();
          expect(backBox.x).toBe(row.x);
          const reset = await controls.last().boundingBox();
          expect(reset.x + reset.width).toBeCloseTo(row.x + row.width, 1);
          if (width <= 540) expect(actions.y).toBeGreaterThanOrEqual(backBox.y + backBox.height);
          else expect(actions.y).toBeLessThan(backBox.y + backBox.height);
          expect(await controls.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))))
            .toEqual(['Edit book', 'Change order', 'Book defaults', 'Reset to default']);
        }
        const dimensions = () => page.evaluate(() => {
          window.scrollTo(10000, 0);
          const result = [document.documentElement.clientWidth, document.documentElement.scrollWidth, window.scrollX];
          window.scrollTo(0, 0);
          return result;
        });
        expect(await dimensions()).toEqual([width, width, 0]);
        for (const control of await controls.all()) {
          const label = await control.getAttribute('data-tooltip');
          await expect(control).toHaveAccessibleName(label);
          await control.hover();
          await expect.poll(() => control.evaluate(node => getComputedStyle(node, '::after').opacity)).toBe('1');
          // Empty asset fixtures intentionally disable slideshow: hover still works, keyboard focus must not.
          if (await control.isDisabled()) {
            expect(await dimensions()).toEqual([width, width, 0]);
            await page.mouse.move(width / 2, 0);
            continue;
          }
          await page.mouse.move(width / 2, 0);
          await control.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          await expect(control).toBeFocused();
          await expect.poll(() => control.evaluate(node => getComputedStyle(node, '::after').opacity)).toBe('1');
          const metrics = await control.evaluate((node, width) => {
            const p = getComputedStyle(node, '::after');
            const s = getComputedStyle(node);
            const r = node.getBoundingClientRect();
            const icon = node.querySelector('svg').getBoundingClientRect();
            const ancestors = [];
            for (let parent = node.parentElement; parent; parent = parent.parentElement) ancestors.push(getComputedStyle(parent).overflowX);
            const tooltipWidth = parseFloat(p.width) + parseFloat(p.paddingLeft) + parseFloat(p.paddingRight)
              + parseFloat(p.borderLeftWidth) + parseFloat(p.borderRightWidth);
            const leftEdge = p.right === '0px' ? r.right - parseFloat(s.borderRightWidth) - tooltipWidth : r.left + parseFloat(s.borderLeftWidth);
            return { content: p.content, right: p.right, leftEdge, rightEdge: leftEdge + tooltipWidth,
              outline: s.outlineWidth, icon: [icon.width, icon.height], size: [r.width, r.height], ancestors };
          }, width);
          expect(metrics.content).toBe(JSON.stringify(label));
          if (width > 540) expect(metrics.right).toBe('0px');
          expect(metrics.leftEdge).toBeGreaterThanOrEqual(0);
          expect(metrics.rightEdge).toBeLessThanOrEqual(width);
          expect(metrics.outline).not.toBe('0px');
          expect(metrics.icon).toEqual([20, 20]);
          if (width > 540 || route.startsWith('/notes/books/')) expect(metrics.size).toEqual([38, 38]);
          expect(metrics.ancestors).not.toContain('hidden');
          expect(metrics.ancestors).not.toContain('clip');
          expect(await dimensions()).toEqual([width, width, 0]);
          if (process.env.CREATORCRATE_TOOLTIP_SCREENSHOTS
            && (route.startsWith('/notes/books/') || route === '/projects') && label.startsWith('Reset')) {
            fs.mkdirSync(process.env.CREATORCRATE_TOOLTIP_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.CREATORCRATE_TOOLTIP_SCREENSHOTS,
              `${route === '/projects' ? 'projects' : 'book'}-${width}.png`), fullPage: true });
          }
          await control.evaluate(node => node.blur());
          await expect.poll(() => control.evaluate(node => getComputedStyle(node, '::after').opacity)).toBe('0');
        }
      }
    }
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Book detail hosts Random and Selected Page previews without restoring the retired outline', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-previews-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;

  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const viteDistRoot = path.join(root, 'client');
    await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
    const assetManifest = createAssetManifest({
      distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite/manifest.json'),
    });
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot, assetManifest },
    );
    const emptyBook = app.locals.bookService.createBook({ title: 'Empty Preview Book' });
    const singleBook = app.locals.bookService.createBook({ title: 'Single Preview Book' });
    const singlePage = app.locals.noteService.createNote({
      bookId: singleBook.id,
      title: 'Only Page',
      content: 'The only Page remains eligible on Book detail.',
    });
    const book = app.locals.bookService.createBook({ title: 'Preview Layout Book' });
    const chapter = app.locals.chapterService.createChapter({
      bookId: book.id,
      title: 'Chapter with a long contextual title that must wrap safely',
    });
    const first = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'First Book Page',
      content: [
        '# First Book Page',
        '',
        'A formatted *preview paragraph* with a [safe link](https://example.com/preview).',
        '![hidden image](https://example.com/preview.png)',
      ].join('\n'),
    });
    const longDirect = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'A very long direct Page preview title that wraps instead of widening the flexible Book-detail content column',
      content: [
        '# Retained preview heading',
        '',
        'A very long preview paragraph. '.repeat(90),
        '',
        'OMITTED-LONG-DOCUMENT-TAIL',
      ].join('\n'),
    });
    const nested = app.locals.noteService.createNote({
      chapterId: chapter.id,
      title: 'Nested Preview Destination',
      content: 'Nested **preview content**.\n\n> A nested quote.',
    });
    const codeFirst = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Code-first Preview',
      content: ['```text', 'one', 'two', 'three', 'four', 'five', 'six', '```'].join('\n'),
    });
    const tableFirst = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Table-first Preview',
      content: ['| Name | Value |', '| --- | --- |', '| one | 1 |', '| two | 2 |'].join('\n'),
    });
    db.prepare("UPDATE notes SET updated_at = '2026-09-07 10:11:12' WHERE id = ?").run(nested.id);
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'page', id: first.id },
      { type: 'chapter', id: chapter.id },
      { type: 'page', id: longDirect.id },
      { type: 'page', id: codeFirst.id },
      { type: 'page', id: tableFirst.id },
    ]);

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const checkEmptyPreview = async (bookId, message) => {
      for (const width of [1280, 390, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${base}/notes/books/${bookId}`);
        const section = page.getByRole('region', { name: 'Page previews', exact: true });
        await expect(section).toBeVisible();
        await expect(section.locator('.notes-page-previews-empty')).toHaveText(message);
        await expect(section.locator('h2')).toHaveCount(0);
        await expect(section).not.toHaveAttribute('aria-labelledby');
        expect(await section.locator('.notes-page-previews-empty').evaluate(node => getComputedStyle(node).marginTop)).toBe('0px');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      }
    };
    await checkEmptyPreview(emptyBook.id, 'No Pages to preview.');
    await expect(page.locator('.book-outline')).toHaveCount(0);

    await page.goto(`${base}/notes/books/${singleBook.id}`);
    await expect(page.locator('.notes-page-preview-item')).toHaveCount(1);
    await expect(page.locator(`a.notes-page-preview-title[href="/notes/${singlePage.id}"]`)).toHaveText(singlePage.title);

    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
      mode: 'random', randomCount: 1, selectedPageIds: [],
    });
    const originalRandom = Math.random;
    let firstRandomTitle;
    let secondRandomTitle;
    try {
      Math.random = () => 0;
      await page.goto(`${base}/notes/books/${book.id}`);
      firstRandomTitle = await page.locator('.notes-page-preview-title').textContent();
      Math.random = () => 0.99;
      await page.goto(`${base}/notes/books/${book.id}`);
      secondRandomTitle = await page.locator('.notes-page-preview-title').textContent();
    } finally {
      Math.random = originalRandom;
    }
    expect(firstRandomTitle).toBe(first.title);
    expect(secondRandomTitle).toBe(tableFirst.title);

    const emptyStructure = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Empty-structure Preview',
      content: '-\n'.repeat(100),
    });
    const oversizedTable = app.locals.noteService.createNote({
      bookId: book.id,
      title: 'Oversized-table Preview',
      content: [`| ${'h'.repeat(481)} |`, '| --- |', '| body |'].join('\n'),
    });
    app.locals.bookService.reorderBookContents(book.id, [
      { type: 'page', id: first.id },
      { type: 'chapter', id: chapter.id },
      { type: 'page', id: longDirect.id },
      { type: 'page', id: codeFirst.id },
      { type: 'page', id: tableFirst.id },
      { type: 'page', id: emptyStructure.id },
      { type: 'page', id: oversizedTable.id },
    ]);

    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
      mode: 'selected', randomCount: 5,
      selectedPageIds: [longDirect.id, nested.id, first.id, codeFirst.id, tableFirst.id],
    });

    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 375, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`${base}/notes/books/${book.id}`);

      const sidebar = page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded)');
      const previews = page.locator('.notes-page-detail-content > .notes-page-previews');
      await expect(page.locator('.book-outline')).toHaveCount(0);
      await expect(sidebar).toBeVisible();
      await expect(sidebar.locator('.notes-book-cover')).toBeVisible();
      await expect(sidebar.locator('.notes-book-nav')).toBeVisible();
      await expect(previews).toBeVisible();
      await expect(previews).toHaveAccessibleName('Page previews');
      await expect(previews.locator(':scope > h2')).toHaveCount(0);
      await expect(previews).not.toHaveAttribute('aria-labelledby');
      await expect(page.locator('#notes-page-previews-heading')).toHaveCount(0);
      expect(await previews.locator('.notes-page-preview-list').evaluate(node => getComputedStyle(node).marginTop)).toBe('0px');
      await expect(previews.locator('.notes-page-preview-item')).toHaveCount(5);
      await expect(previews.locator('.notes-page-preview-title')).toHaveText([
        first.title,
        nested.title,
        longDirect.title,
        codeFirst.title,
        tableFirst.title,
      ]);
      await expect(previews.locator('.notes-page-preview-context')).toHaveText(`Chapter: ${chapter.title}`);
      await expect(previews).not.toContainText(`Book: ${book.title}`);
      const previewBodies = previews.locator('.book-page-preview-content.notes-content');
      await expect(previewBodies).toHaveCount(5);
      await expect(previewBodies.nth(0).locator('h1')).toHaveCount(0);
      await expect(previewBodies.nth(0).locator('em')).toHaveText('preview paragraph');
      const safeLink = previewBodies.nth(0).getByRole('link', { name: 'safe link', exact: true });
      await expect(safeLink).toHaveAttribute('href', 'https://example.com/preview');
      await safeLink.focus();
      await expect(safeLink).toBeFocused();
      await expect(previews.locator('img')).toHaveCount(0);
      await expect(previewBodies.nth(0)).not.toContainText('# First Book Page');
      await expect(previewBodies.nth(1).locator('strong')).toHaveText('preview content');
      await expect(previewBodies.nth(1).locator('blockquote')).toContainText('A nested quote.');
      await expect(previewBodies.nth(2).locator('h1')).toHaveText('Retained preview heading');
      await expect(previewBodies.nth(2)).not.toContainText('OMITTED-LONG-DOCUMENT-TAIL');
      await expect(previewBodies.nth(2).locator('pre, table')).toHaveCount(0);
      await expect(previewBodies.nth(3).locator('pre code')).toContainText('six');
      await expect(previewBodies.nth(4).locator('table')).toBeVisible();
      await expect(previews.locator('.notes-page-preview-truncated')).toHaveCount(1);
      await expect(previews.locator('.notes-page-preview-truncated')).toHaveAccessibleName('Preview truncated');
      await expect(previews.locator('.notes-page-preview-item').nth(0).locator('.notes-page-preview-truncated')).toHaveCount(0);
      await expect(previews.locator('.notes-page-preview-updated')).toHaveCount(5);
      await expect(previews.locator('.notes-page-preview-updated').nth(1)).toHaveText('Updated 2026-09-07 10:11:12');

      const layout = await page.evaluate(() => {
        const bounds = selector => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        };
        const titles = [...document.querySelectorAll('.notes-page-preview-title')];
        const bodies = [...document.querySelectorAll('.book-page-preview-content')];
        const longBody = bodies[2];
        const longItem = longBody.closest('.notes-page-preview-item');
        return {
          sidebar: bounds('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded)'),
          previews: bounds('.notes-page-previews'),
          titlesContained: titles.every(element => element.scrollWidth <= element.clientWidth),
          bodiesContained: bodies.every(element => element.getBoundingClientRect().right <= element.closest('.notes-page-preview-item').getBoundingClientRect().right),
          noVerticalScrollbars: bodies.every(element => element.scrollHeight === element.clientHeight),
          longBody: {
            clientHeight: longBody.clientHeight,
            scrollHeight: longBody.scrollHeight,
            maxBlockSize: getComputedStyle(longBody).maxBlockSize,
            overflowY: getComputedStyle(longBody).overflowY,
            titleOutside: !longBody.contains(longItem.querySelector('.notes-page-preview-title')),
            contextOutside: !longBody.contains(longItem.querySelector('.notes-page-preview-context')),
            updatedOutside: !longBody.contains(longItem.querySelector('.notes-page-preview-updated')),
          },
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      if (viewport.width > 767) expect(layout.previews.left).toBeGreaterThan(layout.sidebar.left);
      else expect(layout.previews.top).toBeGreaterThanOrEqual(layout.sidebar.bottom);
      expect(layout.titlesContained).toBe(true);
      expect(layout.bodiesContained).toBe(true);
      expect(layout.noVerticalScrollbars).toBe(true);
      expect(layout.longBody.scrollHeight).toBe(layout.longBody.clientHeight);
      expect(layout.longBody.maxBlockSize).toBe('none');
      expect(layout.longBody.overflowY).not.toBe('auto');
      expect(layout.longBody.clientHeight).toBeLessThan(600);
      expect(layout.longBody.titleOutside).toBe(true);
      expect(layout.longBody.contextOutside).toBe(true);
      expect(layout.longBody.updatedOutside).toBe(true);
      expect(layout.horizontalOverflow).toBe(false);

      await page.locator(`a.notes-page-preview-title[href="/notes/${longDirect.id}"]`).click();
      await expect(page).toHaveURL(`${base}/notes/${longDirect.id}`);
      await expect(page.locator('.notes-page-previews')).toHaveCount(0);
      await expect(page.locator('.notes-detail-content')).toBeVisible();
      await expect(page.locator('.notes-detail-content')).toContainText('OMITTED-LONG-DOCUMENT-TAIL');
      await expect(page.locator('.notes-page-preview-truncated')).toHaveCount(0);
      // This destination has no associations; preview relocation must not invent empty sections.
      expect(app.locals.noteService.getNote(longDirect.id).projectIds).toEqual([]);
      expect(app.locals.noteService.getNote(longDirect.id).assetIds).toEqual([]);
      await expect(page.locator('.notes-detail-projects')).toHaveCount(0);
      await expect(page.locator('.notes-detail-assets')).toHaveCount(0);
      await page.locator('[data-dialog-open="note-edit-dialog"]').click();
      await expect(page.locator('#note-edit-dialog[open] #content')).toHaveValue(longDirect.content);
    }

    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
      mode: 'selected', randomCount: 5, selectedPageIds: [emptyStructure.id, oversizedTable.id],
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/notes/books/${book.id}`);
    const emptyStructureItem = page.locator('.notes-page-preview-item').filter({ hasText: emptyStructure.title });
    const oversizedTableItem = page.locator('.notes-page-preview-item').filter({ hasText: oversizedTable.title });
    await expect(emptyStructureItem.locator('ul, ol, li li, blockquote')).toHaveCount(0);
    await expect(emptyStructureItem.locator('.book-page-preview-content')).toHaveCount(0);
    expect(await emptyStructureItem.evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(250);
    await expect(oversizedTableItem).not.toContainText('No content yet');
    await expect(oversizedTableItem.locator('.notes-page-preview-truncated')).toHaveAccessibleName('Preview truncated');
    await expect(oversizedTableItem.locator('.book-page-preview-content')).toHaveCount(0);

    app.locals.bookPagePreviewSettingsService.replaceBookPagePreviewSettings(book.id, {
      mode: 'selected', randomCount: 5, selectedPageIds: [],
    });
    await checkEmptyPreview(book.id, 'No selected Pages are available.');

    // Separate associated-data regression; leave the original preview fixture association-free.
    const project = app.locals.projectService.create({ title: 'Associated Page project', status: 'tbd' });
    const asset = db.prepare(`INSERT INTO assets
      (project_id, relative_path, filename, extension, mime_type, size_bytes, is_present, last_seen_at)
      VALUES (?, 'associated.png', 'associated.png', 'png', 'image/png', 1, 0, datetime('now'))
      RETURNING id`).get(project.id);
    const associated = app.locals.noteService.createNote({
      bookId: singleBook.id, title: 'Associated Page', content: 'Associated Page contents.',
      projectIds: [project.id], assetIds: [asset.id],
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${base}/notes/${associated.id}`);
      await expect(page.locator('.notes-page-previews')).toHaveCount(0);
      await expect(page.locator('.notes-detail-content')).toContainText(associated.content);
      await expect(page.locator('.notes-detail-projects')).toBeVisible();
      await expect(page.locator('.notes-detail-projects a')).toHaveAttribute('href', `/projects/${project.id}`);
      await expect(page.locator('.notes-detail-assets')).toBeVisible();
      await expect(page.locator('.notes-detail-assets')).toContainText('associated.png');
      expect(await page.locator('.notes-page-detail-content > section').evaluateAll(nodes =>
        nodes.map(node => node.classList.contains('notes-detail-content') ? 'contents'
          : node.classList.contains('notes-detail-projects') ? 'projects' : 'assets')))
        .toEqual(['contents', 'projects', 'assets']);
      await page.locator('[data-dialog-open="note-edit-dialog"]').click();
      await expect(page.locator('#note-edit-dialog[open] #content')).toHaveValue(associated.content);
    }
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
