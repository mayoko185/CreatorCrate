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

test('Page detail keeps its small content heading and omits a matching Markdown H1 at desktop and mobile', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-detail-refinement-'));
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
    const book = app.locals.bookService.createBook({ title: 'Refinement Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Refinement Chapter' });
    const storedMarkdown = '# Page Detail Refinement\n\nReadable Page content without a repeated title.\n\n## Legitimate section';
    const note = app.locals.noteService.createNote({
      chapterId: chapter.id,
      title: 'Page Detail Refinement',
      content: storedMarkdown,
    });
    const nonmatchingHeadingNote = app.locals.noteService.createNote({
      chapterId: chapter.id,
      title: 'Different Page Title',
      content: '# Legitimate Markdown Heading\n\nThis heading must remain visible.',
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 375, height: 800 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`${base}/notes/${note.id}`);

      await expect(page.locator('body')).toHaveClass('refined-page notes-page-detail-page');
      await expect(page.locator('h1.app-section-title')).toHaveCount(1);
      await expect(page.locator('h1.app-section-title')).toContainText(note.title);
      await expect(page.locator('.notes-detail-kicker')).toHaveText(note.title);
      await expect(page.locator('#notes-detail-content-heading')).toHaveCount(1);
      await expect(page.locator('.notes-detail-content')).toHaveAttribute('aria-labelledby', 'notes-detail-content-heading');
      await expect(page.locator('.notes-content > h1')).toHaveCount(0);
      await expect(page.locator('.notes-content > h2')).toHaveText('Legitimate section');

      const details = page.locator('.notes-detail-details');
      await expect(details).toHaveClass(/project-detail-section/);
      await expect(details.locator(':scope > h2')).toHaveText('Details');
      await expect(details.locator(':scope > .project-detail-section-body .detail-list dt')).toHaveText(['Created', 'Updated']);
      await expect(details.locator(':scope > .project-detail-section-body .detail-list dd')).toHaveCount(2);

      const layout = await page.evaluate(() => {
        const heading = document.querySelector('h1.app-section-title');
        const contentHeading = document.querySelector('#notes-detail-content-heading');
        const actionRow = document.querySelector('.page-heading');
        const edit = document.querySelector('.page-heading-actions a');
        const contentSection = document.querySelector('.notes-detail-content');
        const content = contentSection.querySelector('.notes-content');
        const detailsSection = document.querySelector('.notes-detail-details');
        const detailsHeading = detailsSection.querySelector(':scope > h2');
        const detailsBody = detailsSection.querySelector(':scope > .project-detail-section-body');
        const text = content.querySelector('p');
        const style = element => getComputedStyle(element);
        const bounds = element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
        };

        return {
          shellHeadingFontSize: style(heading).fontSize,
          contentHeadingFontSize: style(contentHeading).fontSize,
          textFontSize: style(text).fontSize,
          detailsHeading: {
            padding: style(detailsHeading).padding,
            fontSize: style(detailsHeading).fontSize,
            textTransform: style(detailsHeading).textTransform,
            color: style(detailsHeading).color,
            borderBottomWidth: style(detailsHeading).borderBottomWidth,
          },
          detailsBodyPadding: [
            style(detailsBody).paddingTop,
            style(detailsBody).paddingRight,
            style(detailsBody).paddingBottom,
            style(detailsBody).paddingLeft,
          ],
          listMargin: style(detailsBody.querySelector('dl')).margin,
          listGap: style(detailsBody.querySelector('dl')).rowGap,
          fields: [...detailsBody.querySelectorAll('dt, dd')].map(bounds),
          contentStartsWithHeading: contentSection.firstElementChild.contains(contentHeading),
          actionRow: bounds(actionRow),
          edit: bounds(edit),
          details: bounds(detailsSection),
          content: bounds(contentSection),
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });

      expect(layout.shellHeadingFontSize).toBe('13px');
      expect(layout.contentHeadingFontSize).toBe('16px');
      expect(parseFloat(layout.contentHeadingFontSize)).toBeGreaterThanOrEqual(parseFloat(layout.textFontSize));
      // Details takes the refined section card's accent heading, and the
      // card's padding is the inset.
      expect(layout.detailsHeading).toMatchObject({
        padding: '0px',
        fontSize: '14px',
        textTransform: 'none',
        borderBottomWidth: '0px',
      });
      expect(layout.detailsBodyPadding).toEqual(['0px', '0px', '0px', '0px']);
      expect(layout.listMargin).toBe('0px');
      expect(layout.listGap).toBe('10px');
      for (let index = 0; index < layout.fields.length; index += 1) {
        const field = layout.fields[index];
        expect(field.left).toBeGreaterThanOrEqual(layout.details.left);
        expect(field.right).toBeLessThanOrEqual(layout.details.right);
        if (viewport.width <= 540 && index > 0) {
          expect(field.top).toBeGreaterThanOrEqual(layout.fields[index - 1].bottom);
        } else if (viewport.width > 540 && index % 2 === 1) {
          expect(field.left).toBeGreaterThanOrEqual(layout.fields[index - 1].right);
          expect(field.top).toBe(layout.fields[index - 1].top);
        }
      }
      expect(layout.contentStartsWithHeading).toBe(true);
      expect(layout.actionRow.width).toBeGreaterThan(0);
      expect(layout.edit.width).toBeGreaterThan(0);
      expect(layout.edit.left).toBeGreaterThanOrEqual(layout.actionRow.left);
      expect(layout.edit.right).toBeLessThanOrEqual(layout.actionRow.right);
      expect(layout.details.width).toBeGreaterThan(0);
      expect(layout.content.width).toBeGreaterThan(0);
      expect(layout.horizontalOverflow).toBe(false);

      const editPage = page.locator(`a[href="/notes/${note.id}/edit"][data-dialog-open="note-edit-dialog"]`);
      await expect(editPage).toBeVisible();
      await editPage.click();
      const editDialog = page.locator('#note-edit-dialog[open]');
      await expect(editDialog).toBeVisible();
      await expect(editDialog.locator('#content')).toHaveValue(storedMarkdown);

      await page.goto(`${base}/notes/${nonmatchingHeadingNote.id}`);
      await expect(page.locator('.notes-detail-kicker')).toHaveText(nonmatchingHeadingNote.title);
      await expect(page.locator('.notes-content > h1')).toHaveText('Legitimate Markdown Heading');
      await expect(page.locator('.notes-content > h1')).toBeVisible();
      await expect(page.locator('.notes-content > h1')).not.toHaveText(nonmatchingHeadingNote.title);
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${base}/notes/books/${book.id}`);
    await expect(page.locator('body')).not.toHaveClass(/notes-page-detail-page/);
    await expect(page.locator('h1.app-section-title')).toHaveCSS('font-size', '13px');
    await expect(page.locator('.notes-detail-details')).toHaveClass('notes-detail-panel notes-detail-details');
    await expect(page.locator('.notes-detail-details > .project-detail-section-body')).toHaveCount(0);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Page and Revision Assets metadata wraps long relative paths inside its card', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-detail-asset-wrap-'));
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
    const book = app.locals.bookService.createBook({ title: 'Asset Wrap Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Asset Wrap Chapter' });
    const project = app.locals.projectService.create({ title: 'Asset Wrap project', status: 'tbd' });
    const relativePath = `${'a'.repeat(95)}/file.txt`;
    const asset = db.prepare(`INSERT INTO assets
      (project_id, relative_path, filename, extension, mime_type, size_bytes, is_present, last_seen_at)
      VALUES (?, ?, 'file.txt', 'txt', 'text/plain', 1, 1, datetime('now'))
      RETURNING id`).get(project.id, relativePath);
    const content = [
      '## Authored heading',
      '',
      `Long authored paragraph ${'word '.repeat(60)}`,
      '',
      '```',
      `const wideAuthoredCode = '${'x'.repeat(240)}';`,
      '```',
      '',
      '| Column A | Column B |',
      '| --- | --- |',
      '| Cell one | Cell two |',
    ].join('\n');
    const note = app.locals.noteService.createNote({
      chapterId: chapter.id,
      title: 'Asset Wrap Page',
      content,
      projectIds: [project.id],
      assetIds: [asset.id],
    });
    app.locals.noteService.updateNote(note.id, {
      title: 'Asset Wrap Page',
      content: `${content}\n\nUpdated.`,
      projectIds: [project.id],
      assetIds: [asset.id],
    });
    const [revision] = app.locals.noteService.listNoteRevisions(note.id);
    expect(revision).toBeTruthy();
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    for (const url of [`${base}/notes/${note.id}`, `${base}/notes/${note.id}/revisions/${revision.id}`]) {
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(url);
        const pathText = page.locator('.notes-detail-asset span', { hasText: relativePath });
        await expect(pathText).toHaveText(relativePath);
        await expect(page.locator('.notes-detail-asset-link')).toHaveAttribute('href', /.+/);

        const metrics = await page.evaluate(() => {
          const card = document.querySelector('.notes-detail-asset');
          const panel = document.querySelector('.notes-detail-assets');
          const span = [...card.querySelectorAll('span')].find(node => node.textContent.includes('/file.txt'));
          const pre = document.querySelector('.notes-content pre');
          const paragraph = document.querySelector('.notes-content p');
          const cardBox = card.getBoundingClientRect();
          const panelBox = panel.getBoundingClientRect();
          const spanBox = span.getBoundingClientRect();
          return {
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            cardWidth: Math.round(cardBox.width),
            cardRight: cardBox.right,
            panelRight: panelBox.right,
            spanRight: spanBox.right,
            spanOverflow: span.scrollWidth - span.clientWidth,
            authored: {
              pre: [pre.scrollWidth, pre.clientWidth, pre.offsetHeight, getComputedStyle(pre).overflowX],
              paragraph: [paragraph.offsetWidth, paragraph.offsetHeight],
              table: document.querySelector('.notes-content table')?.offsetWidth,
            },
          };
        });
        console.log(`[asset-wrap] ${url.includes('/revisions/') ? 'revision' : 'page'} @${width}: ${JSON.stringify(metrics)}`);

        expect.soft(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
        expect.soft(metrics.cardRight).toBeLessThanOrEqual(metrics.panelRight);
        expect.soft(metrics.spanRight).toBeLessThanOrEqual(metrics.cardRight);
        expect.soft(metrics.spanOverflow).toBeLessThanOrEqual(0);
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
