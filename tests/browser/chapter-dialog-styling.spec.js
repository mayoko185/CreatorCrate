import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

test('Chapter dialogs reuse Book section styling and preserve hosted lifecycle', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-order-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const book = app.locals.bookService.createBook({ title: 'Book Alpha' });
    app.locals.bookService.createBook({ title: 'Book Beta' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Chapter Alpha' });
    app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Page' });
    app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Page Alpha' });
    app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Page Beta' });

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const styles = async section => section.evaluate(n => {
      const pick = e => { const s = getComputedStyle(e); return Object.fromEntries(['backgroundColor', 'color', 'fontSize', 'fontWeight', 'border', 'borderRadius', 'padding'].map(k => [k, s[k]])); };
      return [pick(n), pick(n.querySelector(':scope > h3')), pick(n.querySelector('.project-edit-dialog-section-body'))];
    });
    await page.goto(`${base}/notes/books/${book.id}`);
    await page.getByRole('link', { name: 'Edit Book', exact: true }).click();
    const reference = await styles(page.locator('#book-edit-dialog .project-edit-dialog-section').first());
    await page.keyboard.press('Escape');
    for (const config of [
      { host: `/notes/books/${book.id}`, direct: `/notes/books/${book.id}/chapters/new`, id: 'chapter-create-dialog', title: 'New Chapter', submit: 'Create', peer: 'Edit Book' },
      { host: `/notes/chapters/${chapter.id}`, direct: `/notes/chapters/${chapter.id}/edit`, id: 'chapter-edit-dialog', title: 'Edit Chapter', submit: 'Save', peer: 'New Page' },
    ]) {
      await page.goto(base + config.host);
      const opener = page.getByRole('link', { name: config.title, exact: true });
      const dialog = page.locator('#' + config.id);
      await expect(opener).toHaveAttribute('href', config.direct);
      for (const close of ['Escape', 'X']) {
        await opener.click();
        await expect(dialog).toBeVisible();
        expect(await dialog.evaluate(n => n.matches(':modal'))).toBe(true);
        await expect(page.locator('body')).toHaveClass(/app-dialog-open/);
        const sections = dialog.locator('.project-edit-dialog-section');
        await expect(sections).toHaveCount(config.submit === 'Save' ? 2 : 1);
        const section = sections.first();
        await expect(section.locator(':scope > h3')).toHaveText('Basic information');
        expect(await styles(section)).toEqual(reference);
        await expect(dialog.getByText('Secondary actions', { exact: true })).toHaveCount(0);
        if (config.submit === 'Save') {
          const actions = sections.nth(1);
          await expect(actions.locator(':scope > h3')).toHaveText('Chapter Actions');
          await expect(dialog.getByRole('heading', { name: 'Chapter Actions', exact: true })).toHaveCount(1);
          expect(await styles(actions)).toEqual(reference);
          await expect(actions.locator('details')).not.toHaveAttribute('open');
          await actions.locator('summary').click();
          await expect(actions.locator('#chapter-delete-form button')).toBeVisible();
          expect(await actions.locator('#chapter-delete-form').evaluate(n => n.parentElement.closest('form'))).toBeNull();
          await actions.locator('summary').click();
        } else {
          await expect(dialog.getByRole('heading', { name: 'Chapter Actions', exact: true })).toHaveCount(0);
        }
        await expect(dialog.locator('[name="title"]')).toHaveCount(1);
        if (close === 'Escape') await page.keyboard.press('Escape');
        else await dialog.getByRole('button', { name: `Close ${config.title}`, exact: true }).click();
        await expect(dialog).not.toBeVisible();
        await expect(opener).toBeFocused();
        await expect(page.locator('body')).not.toHaveClass(/app-dialog-open/);
      }
      await page.getByRole('link', { name: config.peer, exact: true }).click();
      await expect(page.locator('dialog[open]')).toHaveCount(1);
      await page.keyboard.press('Escape');
      expect(await page.locator('[id]').evaluateAll(nodes => new Set(nodes.map(n => n.id)).size === nodes.length)).toBe(true);
      expect(await page.locator('label[for]').evaluateAll(nodes => nodes.every(n => document.getElementById(n.htmlFor)))).toBe(true);
      await expect(page.locator('form form')).toHaveCount(0);
      await page.goto(base + config.direct);
      await expect(dialog).toBeVisible();
      await dialog.locator('[name="title"]').fill('');
      const invalid = page.waitForResponse(r => r.request().method() === 'POST');
      await dialog.getByRole('button', { name: config.submit, exact: true }).click();
      expect((await invalid).status()).toBe(422);
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('[name="title"]')).toHaveAttribute('aria-invalid', 'true');
      if (config.submit === 'Save') {
        await expect(dialog.locator('#chapter-delete-form')).toHaveCount(1);
        await expect(dialog.locator('#chapter-form #chapter-delete-form')).toHaveCount(0);
      }
      await page.keyboard.press('Escape');
    }
    const empty = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Delete test Chapter' });
    await page.goto(`${base}/notes/chapters/${empty.id}/edit`);
    const edit = page.locator('#chapter-edit-dialog');
    await page.mouse.click(5, 5);
    await expect(edit).not.toBeVisible();
    await page.getByRole('link', { name: 'Edit Chapter', exact: true }).click();
    await edit.locator('summary').click();
    await edit.locator('#chapter-delete-form button').click();
    const confirmation = page.locator('#app-confirmation-dialog');
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText('Delete this Chapter permanently? This cannot be undone.');
    await confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
    await expect(page).toHaveURL(`${base}/notes/books/${book.id}`);
    expect(app.locals.chapterService.listChapters(book.id).some(c => c.id === empty.id)).toBe(false);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
