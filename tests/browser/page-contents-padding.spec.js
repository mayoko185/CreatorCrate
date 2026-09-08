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

test('New and Edit Page primary sections have compact overall padding', async ({ page }) => {
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
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Padding Chapter' });
    const note = app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Padding Page', content: 'Editor content' });
    app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Nested Peer Page' });
    const directPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Top-level Peer Page' });
    const singleBook = app.locals.bookService.createBook({ title: 'Three-action Book' });
    app.locals.noteService.createNote({ bookId: singleBook.id, title: 'Only Page' });
    for (let index = 1; index <= 12; index += 1) {
      app.locals.noteService.createNote({ bookId: book.id, title: `Large Book Page ${index}` });
    }
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 800 }, { width: 390, height: 640 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      for (const route of [`/notes/new?bookId=${book.id}`, `/notes/new?chapterId=${chapter.id}`, `/notes/${note.id}/edit`, `/notes/${directPage.id}/edit`]) {
        await page.goto(base + route);
        const dialog = page.locator('dialog[open]');
        const documentWidths = async state => {
          const dimensions = await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]);
          expect(dimensions[1]).toBeLessThanOrEqual(dimensions[0]);
        };
        await expect(dialog.locator('.toastui-editor-defaultUI')).toBeVisible();
        const polishedNavigatorHost = dialog.locator('.notes-workspace-context.notes-book-detail-sidebar.notes-book-detail-sidebar--embedded');
        await expect(polishedNavigatorHost).toHaveCount(1);
        const bookContentsDisclosure = dialog.locator('.notes-book-contents-disclosure');
        await expect(dialog.locator('#notes-book-contents-heading')).toHaveText('Book contents');
        const bookContentsToggle = bookContentsDisclosure.locator(':scope > summary');
        const checkTabGeometry = async state => {
          const geometry = await bookContentsToggle.evaluate(node => {
            const heading = document.querySelector('#notes-book-contents-heading');
            const tab = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            const section = node.closest('section');
            const bounds = element => {
              const rect = element.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
            };
            return {
              section: bounds(section),
              heading: bounds(heading),
              details: bounds(node.parentElement),
              tab: bounds(node),
              body: bounds(node.nextElementSibling),
              following: bounds(section.nextElementSibling),
              centerOffset: (tab.left + tab.right - section.getBoundingClientRect().left - section.getBoundingClientRect().right) / 2,
              attachment: section.getBoundingClientRect().bottom - tab.top,
              display: style.display,
              topBorder: style.borderTopWidth,
              headingBorder: getComputedStyle(heading).borderBottomWidth,
              disclosureBorder: getComputedStyle(node.parentElement).borderTopWidth,
            };
          });
          expect(Math.abs(geometry.centerOffset)).toBeLessThanOrEqual(1);
          expect(Math.abs(geometry.attachment - 1)).toBeLessThanOrEqual(0.5);
          expect(geometry.following.top - geometry.tab.bottom).toBeGreaterThanOrEqual(8);
          expect(geometry.tab.top - geometry.heading.bottom).toBeGreaterThanOrEqual(23);
          if (state === 'expanded') {
            expect(Math.abs(geometry.body.bottom - geometry.tab.top)).toBeLessThanOrEqual(1);
          }
          expect(geometry).toMatchObject({ display: 'flex', topBorder: '0px', headingBorder: '1px', disclosureBorder: '0px' });
          return geometry;
        };
        const collapsedGeometry = await checkTabGeometry('collapsed');
        await expect(bookContentsDisclosure).not.toHaveAttribute('open', '');
        await expect(bookContentsToggle.getByText('Expand', { exact: true })).toBeVisible();
        await expect(bookContentsToggle).toHaveAccessibleName('Expand');
        await expect(bookContentsToggle.getByText('Collapse', { exact: true })).toBeHidden();
        await expect(polishedNavigatorHost).toBeHidden();
        await expect(dialog.locator('.toastui-editor-defaultUI')).toBeVisible();
        await expect(dialog.locator('.notes-connections')).toBeVisible();
        await expect(dialog.locator('.app-dialog-footer button')).toBeVisible();
        const collapsedScrollHeight = await dialog.locator('.app-dialog-body').evaluate(node => node.scrollHeight);
        await documentWidths('collapsed');

        await bookContentsToggle.click();
        await expect(bookContentsDisclosure).toHaveAttribute('open', '');
        await expect(bookContentsToggle.getByText('Expand', { exact: true })).toBeHidden();
        await expect(bookContentsToggle.getByText('Collapse', { exact: true })).toBeVisible();
        await expect(bookContentsToggle).toHaveAccessibleName('Collapse');
        await expect(polishedNavigatorHost).toBeVisible();
        await documentWidths('expanded');
        const expandedGeometry = await checkTabGeometry('expanded');
        const sectionGrowth = (expandedGeometry.section.bottom - expandedGeometry.section.top)
          - (collapsedGeometry.section.bottom - collapsedGeometry.section.top);
        const tabMovement = (expandedGeometry.tab.top - expandedGeometry.section.top)
          - (collapsedGeometry.tab.top - collapsedGeometry.section.top);
        expect(sectionGrowth).toBeGreaterThan(24);
        expect(Math.abs(tabMovement - sectionGrowth)).toBeLessThanOrEqual(1);
        await expect(polishedNavigatorHost.locator('.notes-book-nav-book-link')).toHaveAttribute('href', `/notes/books/${book.id}`);
        await expect(polishedNavigatorHost.getByText('View Chapter', { exact: true })).toHaveCount(0);
        await expect(polishedNavigatorHost.locator('img, .notes-book-cover, .asset-image')).toHaveCount(0);
        expect(await dialog.locator('.app-dialog-body').evaluate(node => node.scrollHeight)).toBeGreaterThan(collapsedScrollHeight);

        const result = await dialog.evaluate(n => {
          const padding = element => {
            const style = getComputedStyle(element);
            return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
          };
          const sections = [...n.querySelectorAll('[data-notes-dialog-compact-section]')];
          const bodies = sections.map(section => section.querySelector('.project-edit-dialog-section-body'));
          const actionBody = n.querySelector('.notes-workspace-secondary > .project-edit-dialog-section-body');
          const editor = n.querySelector('.toastui-editor-defaultUI');
          const connections = n.querySelector('.notes-connections');
          const navigator = n.querySelector('.notes-book-detail-sidebar--embedded .notes-book-nav');
          const topLevelPage = n.querySelector('.notes-book-nav-list > .notes-book-nav-page:not(.notes-book-nav-item--current) > .notes-book-nav-page-link');
          const nestedPage = n.querySelector('.notes-book-nav-pages > .notes-book-nav-page--child:not(.notes-book-nav-item--current) > .notes-book-nav-page-link');
          const typography = element => {
            const style = getComputedStyle(element);
            return { color: style.color, fontWeight: style.fontWeight };
          };

          return {
            sectionPadding: sections.map(padding),
            headingContained: sections.every(section => {
              const card = section.getBoundingClientRect();
              const heading = section.querySelector('h3').getBoundingClientRect();
              return heading.left >= card.left && heading.right <= card.right;
            }),
            bodyPadding: bodies.map(padding),
            actionPadding: actionBody ? padding(actionBody) : null,
            editorFits: editor.scrollWidth <= editor.clientWidth,
            connectionsUsable: connections.getBoundingClientRect().width > 0,
            overflow: n.scrollWidth > n.clientWidth || bodies.some(body => body.scrollWidth > body.clientWidth),
            navigatorMarginTop: getComputedStyle(navigator).marginTop,
            topLevelPageTypography: typography(topLevelPage),
            nestedPageTypography: typography(nestedPage),
          };
        });
        expect(result.sectionPadding).toHaveLength(3);
        expect(result.sectionPadding.every(value => value.every(side => side === '0px'))).toBe(true);
        expect(result.bodyPadding).toEqual([
          ['12px', '12px', '12px', '12px'],
          ['12px', '12px', '12px', '12px'],
          ['12px', '12px', '12px', '12px'],
        ]);
        expect(result.actionPadding).toEqual(route.endsWith('/edit') ? ['12px', '16px', '16px', '16px'] : null);
        expect(result.editorFits).toBe(true);
        expect(result.headingContained).toBe(true);
        expect(result.connectionsUsable).toBe(true);
        expect(result.overflow).toBe(false);
        expect(result.navigatorMarginTop).toBe('0px');
        expect(result.topLevelPageTypography).toEqual(result.nestedPageTypography);
        expect(result.topLevelPageTypography.fontWeight).toBe('400');
        await bookContentsToggle.click();
        await expect(bookContentsDisclosure).not.toHaveAttribute('open', '');
        await documentWidths('collapsed-again');
        await bookContentsToggle.focus();
        await bookContentsToggle.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await expect(bookContentsToggle).toBeFocused();
        const focusStyle = await bookContentsToggle.evaluate(node => {
          const style = getComputedStyle(node);
          return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
        });
        expect(focusStyle).toEqual({ outlineStyle: 'solid', outlineWidth: '2px' });
        const focusUnclipped = async () => bookContentsToggle.evaluate(node => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          const outset = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            const bounds = parent.getBoundingClientRect();
            const css = getComputedStyle(parent);
            if (/(auto|scroll|hidden|clip)/.test(css.overflowX)
              && (rect.left - outset < bounds.left || rect.right + outset > bounds.right)) return false;
            if (/(auto|scroll|hidden|clip)/.test(css.overflowY)
              && (rect.top - outset < bounds.top || rect.bottom + outset > bounds.bottom)) return false;
          }
          return true;
        });
        expect(await focusUnclipped()).toBe(true);
        await bookContentsToggle.press('Enter');
        await expect(bookContentsDisclosure).toHaveAttribute('open', '');
        await expect(bookContentsToggle).toHaveAccessibleName('Collapse');
        await bookContentsToggle.evaluate(node => node.scrollIntoView({ block: 'center' }));
        expect(await focusUnclipped()).toBe(true);
        expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth
          && [...node.querySelectorAll('.project-edit-dialog-section-body')]
            .every(body => body.scrollWidth <= body.clientWidth))).toBe(true);
        const innerNavigator = dialog.locator('.notes-book-nav-disclosure').first();
        const innerWasOpen = await innerNavigator.evaluate(node => node.open);
        await innerNavigator.locator(':scope > summary').click();
        expect(await innerNavigator.evaluate(node => node.open)).toBe(!innerWasOpen);
        await expect(bookContentsDisclosure).toHaveAttribute('open', '');
        await innerNavigator.locator(':scope > summary').click();
        expect(await innerNavigator.evaluate(node => node.open)).toBe(innerWasOpen);
        await bookContentsToggle.focus();
        await bookContentsToggle.press('Space');
        await expect(bookContentsDisclosure).not.toHaveAttribute('open', '');
        await expect(bookContentsToggle).toHaveAccessibleName('Expand');
        await bookContentsToggle.press('Tab');
        expect(await bookContentsDisclosure.evaluate(node => node.contains(document.activeElement))).toBe(false);
        await bookContentsToggle.click();
        await expect(bookContentsDisclosure).toHaveAttribute('open', '');
        const bold = dialog.locator('.toastui-editor-toolbar button.bold');
        await bold.scrollIntoViewIfNeeded();
        await bold.click();
        const navigator = dialog.locator('.notes-book-nav-disclosure').first();
        const wasOpen = await navigator.evaluate(node => node.open);
        await navigator.locator('summary').click();
        expect(await navigator.evaluate(node => node.open)).toBe(!wasOpen);
        await navigator.locator('summary').click();
        expect(await navigator.evaluate(node => node.open)).toBe(wasOpen);
        if (route.endsWith('/edit')) {
          const currentPage = polishedNavigatorHost.locator('.notes-book-nav-page.notes-book-nav-item--current > .notes-book-nav-page-link[aria-current="page"]');
          await expect(currentPage).toHaveCount(1);
          if (route === `/notes/${note.id}/edit`) {
            await expect(currentPage.locator('xpath=ancestor::details[contains(@class, "notes-book-nav-disclosure")]')).toHaveAttribute('open');
          }
          const currentPageStyle = await currentPage.evaluate(node => {
            const style = getComputedStyle(node);
            const probe = document.createElement('span');
            probe.style.color = 'var(--accent)';
            node.appendChild(probe);
            const accentColor = getComputedStyle(probe).color;
            probe.remove();
            return { color: style.color, accentColor, fontWeight: style.fontWeight };
          });
          expect(currentPageStyle.color).toBe(currentPageStyle.accentColor);
          expect(currentPageStyle.fontWeight).toBe('700');
        }
        if (route.includes('chapterId=')) {
          const currentChapter = polishedNavigatorHost.locator('.notes-book-nav-chapter.notes-book-nav-item--current > .notes-book-nav-disclosure');
          await expect(currentChapter).toHaveAttribute('open');
          expect(await currentChapter.locator('summary').evaluate(node => getComputedStyle(node).boxShadow))
            .toContain('rgba(34, 211, 238, 0.35)');
        }
        const projects = dialog.locator('#note-projects-form');
        await projects.locator('summary').click();
        await expect(projects).toHaveAttribute('open');
        await expect(projects.getByRole('searchbox')).toBeVisible();
        await projects.locator('summary').click();
        await dialog.locator('[name="title"]').fill('');
        const invalid = page.waitForResponse(response => response.request().method() === 'POST');
        await dialog.locator('.app-dialog-footer button').click();
        expect((await invalid).status()).toBe(422);
        await expect(dialog.locator('.field-error-message').filter({ hasText: 'Title is required.' })).toBeVisible();
        await expect(dialog.locator('.notes-book-contents-disclosure')).not.toHaveAttribute('open', '');
        await expect(dialog.locator('.notes-book-detail-sidebar--embedded')).toBeHidden();
        await dialog.locator('.app-dialog-footer button').scrollIntoViewIfNeeded();
        await expect(dialog.locator('.app-dialog-footer button')).toBeInViewport();
      }
    }
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${base}/notes/books/${singleBook.id}`);
    await expect(page.locator('.asset-viewer-display-controls .project-filter-control')).toHaveCount(3);
    await page.getByRole('link', { name: 'New Page', exact: true }).click();
    const singleDisclosure = page.locator('dialog[open] .notes-book-contents-disclosure');
    for (const state of ['collapsed', 'expanded', 'collapsed-again']) {
      if (state !== 'collapsed') await singleDisclosure.locator(':scope > summary').click();
      const dimensions = await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]);
      expect(dimensions).toEqual([375, 375]);
    }
    for (const route of [`/notes/books/${book.id}/chapters/new`, `/notes/chapters/${chapter.id}/edit`]) {
      await page.goto(base + route);
      const chapterDialog = page.locator('dialog[open]');
      await expect(chapterDialog.locator('[data-notes-dialog-compact-section], [data-notes-book-actions-section]')).toHaveCount(0);
      expect(await chapterDialog.locator('.project-edit-dialog-section-body').first().evaluate(node => getComputedStyle(node).padding))
        .toBe('12px 16px 16px');
    }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
