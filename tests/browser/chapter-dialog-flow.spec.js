import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// New Chapter and Edit Chapter save in place: the Book or Chapter page they were
// opened on is never navigated or replaced, and only what names the Chapter changes.

async function withNotesApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-chapter-flow-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run(`http://127.0.0.1:${server.address().port}`, app);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const markDocument = (page) => page.evaluate(() => { window.__chapterFlowDocument = true; });
const documentKept = (page) => page.evaluate(() => window.__chapterFlowDocument === true);

function track(page, postPath, hostPath) {
  const log = { navigations: [], posts: [], gets: [] };
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) log.navigations.push(frame.url()); });
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === 'POST' && pathname === postPath) log.posts.push(request);
    if (request.method() === 'GET' && pathname === hostPath) log.gets.push(request);
  });
  return log;
}

const newChapterTrigger = (page) => page.locator('.page-heading [data-dialog-open="chapter-create-dialog"]');
const editChapterTrigger = (page) => page.locator('.page-heading [data-dialog-open="chapter-edit-dialog"]');
const sidebarChapterTitles = (page) => page.locator('.notes-page-detail-sidebar .notes-book-nav-chapter-title').allTextContents();

// Fails the next `count` GETs of the host while letting every other request through.
async function failHostRefresh(page, hostPath, count = 1) {
  let remaining = count;
  await page.route((url) => url.pathname === hostPath, async (route) => {
    if (route.request().method() === 'GET' && remaining > 0) {
      remaining -= 1;
      await route.abort();
      return;
    }
    await route.fallback();
  });
}

test('New Chapter creates in place on Book Detail and keeps the rest of the page', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await withNotesApp(async (origin, app) => {
    const book = app.locals.bookService.createBook({ title: 'Host Book' });
    const opened = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Open Chapter' });
    app.locals.noteService.createNote({ chapterId: opened.id, title: 'Nested Page' });
    app.locals.noteService.createNote({ bookId: book.id, title: 'Direct Page', content: 'Preview body' });
    await page.goto(`${origin}/notes/books/${book.id}`);
    const log = track(page, `/notes/books/${book.id}/chapters`, `/notes/books/${book.id}`);
    await markDocument(page);

    // An open Chapter disclosure, the Page previews and a New Page draft all survive.
    await page.locator(`.notes-page-detail-sidebar [data-book-nav-chapter="${opened.id}"]`).click();
    const previews = page.locator('[data-book-detail-live-region] .notes-page-detail-content');
    await previews.evaluate((node) => { node.dataset.sameNode = 'yes'; });
    const pageDraft = page.locator('#note-create-dialog [name="title"]');
    await pageDraft.evaluate((node) => { node.value = 'Draft Page'; });

    await newChapterTrigger(page).click();
    const dialog = page.locator('#chapter-create-dialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((node) => node.matches(':modal'))).toBe(true);
    await dialog.locator('[name="title"]').fill('Fresh Chapter');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();

    const feedback = page.locator('[data-dialog-feedback]');
    await expect(feedback).toContainText('Chapter “Fresh Chapter” created.');
    await expect(dialog).toBeHidden();
    await expect.poll(() => sidebarChapterTitles(page)).toEqual(['Open Chapter', 'Fresh Chapter']);
    const created = app.locals.chapterService.listChapters(book.id).find(({ title }) => title === 'Fresh Chapter');
    expect(app.locals.chapterService.listChapters(book.id)).toHaveLength(2);
    expect(log.posts).toHaveLength(1);
    await expect(feedback.locator('[data-chapter-view]')).toHaveAttribute('href', `/notes/chapters/${created.id}`);
    await expect(newChapterTrigger(page)).toBeFocused();
    expect(log.navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);

    await expect(page.locator(`.notes-page-detail-sidebar [data-book-nav-chapter="${opened.id}"]`)
      .locator('xpath=ancestor::details')).toHaveAttribute('open', '');
    await expect(previews).toHaveAttribute('data-same-node', 'yes');
    await expect(page.locator('#note-create-dialog .notes-book-nav-chapter-title')).toHaveText(['Open Chapter', 'Fresh Chapter']);
    await expect(pageDraft).toHaveValue('Draft Page');
    await expect(page.locator(`#book-order-dialog [data-content-key="chapter:${created.id}"]`)).toHaveCount(1);

    await newChapterTrigger(page).click();
    await expect(dialog.locator('[name="title"]')).toHaveValue('');
    await page.keyboard.press('Escape');
    await feedback.locator('[data-chapter-view]').click();
    await expect(page).toHaveURL(`${origin}/notes/chapters/${created.id}`);
    expect(pageErrors).toEqual([]);
  });
});

test('the Book order trigger appears once a new Chapter makes order changeable, and it works', async ({ page }) => {
  await withNotesApp(async (origin, app) => {
    const book = app.locals.bookService.createBook({ title: 'Trigger Book' });
    await page.goto(`${origin}/notes/books/${book.id}`);
    const order = page.locator('[data-book-detail-toolbar] [data-dialog-open="book-order-dialog"]');
    await expect(order).toHaveCount(0);
    const dialog = page.locator('#chapter-create-dialog');
    for (const title of ['One', 'Two']) {
      await newChapterTrigger(page).click();
      await dialog.locator('[name="title"]').fill(title);
      await page.keyboard.press('Enter');
      await expect(page.locator('.notes-page-detail-sidebar .notes-book-nav-chapter-title').last()).toHaveText(title);
    }
    await expect(order).toHaveCount(1);
    await order.click();
    const orderDialog = page.locator('#book-order-dialog');
    await expect(orderDialog).toBeVisible();
    const handles = orderDialog.locator('[data-book-hierarchy-handle]');
    await expect(handles).toHaveCount(2);
    const saved = page.waitForResponse((response) => response.url().endsWith('/hierarchy/reorder'));
    await handles.first().focus();
    await page.keyboard.press('ArrowDown');
    expect((await saved).status()).toBe(200);
    await expect.poll(() => app.locals.bookService.listBookContents(book.id).map(({ chapter }) => chapter.title))
      .toEqual(['Two', 'One']);
  });
});

test('Edit Chapter saves in place and updates everything that names the Chapter', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await withNotesApp(async (origin, app) => {
    const book = app.locals.bookService.createBook({ title: 'Edit Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Before' });
    const other = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Other' });
    app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Page A' });
    app.locals.noteService.createNote({ chapterId: chapter.id, title: 'Page B' });
    const hostPath = `/notes/chapters/${chapter.id}`;
    await page.goto(origin + hostPath);
    const log = track(page, hostPath, hostPath);
    await markDocument(page);

    // Saving the Chapter leaves the saved Page order and its dialog alone.
    const orderDialog = page.locator('#chapter-order-dialog');
    const savedOrder = await orderDialog.locator('[data-chapter-page-order-input]').inputValue();

    await editChapterTrigger(page).click();
    const dialog = page.locator('#chapter-edit-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[name="title"]')).toHaveValue('Before');
    await dialog.locator('[name="title"]').fill('  After  ');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.locator('[data-dialog-feedback]')).toContainText('Chapter “After” saved.');
    await expect(dialog).toBeHidden();
    await expect(page.locator('h1.app-section-title')).toHaveText('Notes — After');
    await expect(page).toHaveTitle('CreatorCrate — Notes — After');
    await expect.poll(() => log.gets.length).toBe(1);
    await expect(page.locator('.notes-chapter-detail-sidebar .notes-book-nav-chapter-title')).toHaveText(['After', 'Other']);
    await expect(page.locator('.notes-chapter-pages [aria-label="Pages in After"]')).toHaveCount(1);
    await expect(page.locator('#chapter-order-dialog [aria-label="Pages in After"]')).toHaveCount(1);
    await expect(orderDialog.locator('[data-chapter-page-order-input]')).toHaveValue(savedOrder);
    await expect(editChapterTrigger(page)).toBeFocused();
    expect(log.posts).toHaveLength(1);
    expect(log.navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
    expect(app.locals.chapterService.getChapter(chapter.id)).toMatchObject({ title: 'After', book_id: book.id });
    expect(app.locals.chapterService.listChapters(book.id).map(({ id }) => id)).toEqual([chapter.id, other.id]);

    // Reopening shows the saved title; an abandoned draft does not stick.
    await editChapterTrigger(page).click();
    await expect(dialog.locator('[name="title"]')).toHaveValue('After');
    await dialog.locator('[name="title"]').fill('Abandoned');
    await dialog.getByRole('button', { name: 'Close Edit Chapter', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(editChapterTrigger(page)).toBeFocused();
    await editChapterTrigger(page).click();
    await expect(dialog.locator('[name="title"]')).toHaveValue('After');
    await page.keyboard.press('Escape');
    expect(pageErrors).toEqual([]);
  });
});

for (const config of [
  { name: 'New Chapter', dialogId: 'chapter-create-dialog', submit: 'Create', trigger: newChapterTrigger,
    start: (app) => ({ host: `/notes/books/${app.locals.bookService.createBook({ title: 'V Book' }).id}` }) },
  { name: 'Edit Chapter', dialogId: 'chapter-edit-dialog', submit: 'Save', trigger: editChapterTrigger,
    start: (app) => {
      const book = app.locals.bookService.createBook({ title: 'V Book' });
      return { host: `/notes/chapters/${app.locals.chapterService.createChapter({ bookId: book.id, title: 'V Chapter' }).id}` };
    } },
]) {
  test(`${config.name} keeps validation and every dismissal local`, async ({ page }) => {
    await withNotesApp(async (origin, app) => {
      const { host } = config.start(app);
      await page.goto(origin + host);
      const log = { navigations: [] };
      page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) log.navigations.push(frame.url()); });
      await markDocument(page);
      const dialog = page.locator(`#${config.dialogId}`);
      const title = dialog.locator('[name="title"]');
      const initial = config.submit === 'Save' ? 'V Chapter' : '';

      await config.trigger(page).click();
      const tooLong = 'x'.repeat(201);
      await title.evaluate((node) => node.removeAttribute('maxlength'));
      await title.fill(tooLong);
      await dialog.getByRole('button', { name: config.submit, exact: true }).click();
      await expect(dialog.locator('[data-dialog-error]')).toBeVisible();
      await expect(dialog.locator('.field-error-message')).toContainText('200 characters');
      await expect(title).toHaveAttribute('aria-invalid', 'true');
      await expect(title).toBeFocused();
      await expect(title).toHaveValue(tooLong);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: config.submit, exact: true })).toBeEnabled();

      for (const dismiss of [
        () => page.keyboard.press('Escape'),
        () => dialog.getByRole('button', { name: `Close ${config.name}`, exact: true }).click(),
        () => page.mouse.click(5, 5),
      ]) {
        await dismiss();
        await expect(dialog).toBeHidden();
        await expect(config.trigger(page)).toBeFocused();
        await config.trigger(page).click();
        await expect(title).toHaveValue(initial);
        await expect(title).not.toHaveAttribute('aria-invalid');
        await expect(dialog.locator('[data-dialog-error]')).toBeHidden();
      }
      await page.keyboard.press('Escape');
      expect(log.navigations).toEqual([]);
      expect(await documentKept(page)).toBe(true);
    });
  });

  test(`${config.name} blocks duplicate submits and dismissal while saving`, async ({ page }) => {
    await withNotesApp(async (origin, app) => {
      const { host } = config.start(app);
      await page.goto(origin + host);
      let posts = 0;
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      await page.route((url) => url.pathname.includes('/notes/'), async (route) => {
        if (route.request().method() === 'POST') {
          posts += 1;
          await held;
        }
        await route.fallback();
      });
      const dialog = page.locator(`#${config.dialogId}`);
      await config.trigger(page).click();
      await dialog.locator('[name="title"]').fill('Once');
      await dialog.getByRole('button', { name: config.submit, exact: true }).click();
      await expect(dialog.getByRole('button', { name: config.submit, exact: true })).toBeDisabled();
      await dialog.locator('[name="title"]').press('Enter');
      await page.keyboard.press('Escape');
      await dialog.getByRole('button', { name: `Close ${config.name}`, exact: true }).click();
      await expect(dialog).toBeVisible();
      expect(posts).toBe(1);
      release();
      await expect(dialog).toBeHidden();
      await expect(page.locator('[data-dialog-feedback]')).toContainText('Once');
      expect(posts).toBe(1);
    });
  });
}

test('a failed refresh after a confirmed create keeps the result and retries with GET only', async ({ page }) => {
  await withNotesApp(async (origin, app) => {
    const book = app.locals.bookService.createBook({ title: 'Retry Book' });
    const hostPath = `/notes/books/${book.id}`;
    await page.goto(origin + hostPath);
    const log = track(page, `${hostPath}/chapters`, hostPath);
    await markDocument(page);
    await failHostRefresh(page, hostPath);

    const dialog = page.locator('#chapter-create-dialog');
    await newChapterTrigger(page).click();
    await dialog.locator('[name="title"]').fill('Retry Chapter');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();

    const feedback = page.locator('[data-dialog-feedback]');
    const retry = feedback.locator('[data-chapter-refresh-retry]');
    await expect(retry).toBeVisible();
    await expect(feedback).toContainText('Chapter “Retry Chapter” created.');
    await expect(feedback).toContainText('could not refresh');
    const [created] = app.locals.chapterService.listChapters(book.id);
    await expect(feedback.locator('[data-chapter-view]')).toHaveAttribute('href', `/notes/chapters/${created.id}`);
    await expect(page.locator('.notes-page-detail-sidebar .notes-book-nav-chapter-title')).toHaveCount(0);

    await retry.focus();
    await retry.click();
    await expect(page.locator('.notes-page-detail-sidebar .notes-book-nav-chapter-title')).toHaveText(['Retry Chapter']);
    await expect(feedback.locator('[data-chapter-refresh-note]')).toHaveCount(0);
    await expect(feedback.locator('[data-chapter-view]')).toBeVisible();
    await expect(newChapterTrigger(page)).toBeFocused();
    expect(log.posts).toHaveLength(1);
    expect(log.gets).toHaveLength(2);
    expect(app.locals.chapterService.listChapters(book.id)).toHaveLength(1);
    expect(log.navigations).toEqual([]);
  });
});

test('a failed refresh after a confirmed edit still shows the saved title', async ({ page }) => {
  await withNotesApp(async (origin, app) => {
    const book = app.locals.bookService.createBook({ title: 'Retry Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Old' });
    const hostPath = `/notes/chapters/${chapter.id}`;
    await page.goto(origin + hostPath);
    const log = track(page, hostPath, hostPath);
    await failHostRefresh(page, hostPath);

    const dialog = page.locator('#chapter-edit-dialog');
    await editChapterTrigger(page).click();
    await dialog.locator('[name="title"]').fill('New');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    const retry = page.locator('[data-chapter-refresh-retry]');
    await expect(retry).toBeVisible();
    await expect(page.locator('h1.app-section-title')).toHaveText('Notes — New');
    await expect(page.locator('.notes-chapter-detail-sidebar .notes-book-nav-chapter-title')).toHaveText(['New']);
    await editChapterTrigger(page).click();
    await expect(dialog.locator('[name="title"]')).toHaveValue('New');
    await page.keyboard.press('Escape');

    await retry.click();
    await expect(retry).toHaveCount(0);
    expect(log.posts).toHaveLength(1);
    expect(log.gets).toHaveLength(2);
    expect(log.navigations).toEqual([]);
  });
});

test('refusals and uncertain outcomes stay in the dialog and report only what is known', async ({ page }) => {
  await withNotesApp(async (origin, app) => {
    const book = app.locals.bookService.createBook({ title: 'Failure Book' });
    const hostPath = `/notes/books/${book.id}`;
    const postPath = `${hostPath}/chapters`;
    await page.goto(origin + hostPath);
    const log = track(page, postPath, hostPath);
    await markDocument(page);
    const dialog = page.locator('#chapter-create-dialog');
    const title = dialog.locator('[name="title"]');
    const summary = dialog.locator('[data-dialog-error]');
    const submit = () => dialog.getByRole('button', { name: 'Create', exact: true }).click();

    await newChapterTrigger(page).click();
    await title.fill('Keep Me');

    // An unknown outcome is said to be unknown, and the host is only read.
    for (const handler of [
      (route) => route.abort(),
      (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>login</html>' }),
      (route) => route.fulfill({ status: 500, contentType: 'text/html', body: '<html>SQLITE secret</html>' }),
      (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":' }),
    ]) {
      await page.unrouteAll();
      await page.route((url) => url.pathname === postPath, handler);
      const getsBefore = log.gets.length;
      await submit();
      await expect(summary).toContainText('Could not confirm whether the Chapter was created');
      await expect(summary).not.toContainText('secret');
      await expect(title).toHaveValue('Keep Me');
      await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
      await expect.poll(() => log.gets.length).toBe(getsBefore + 1);
    }

    // What the server refused is reported as such, and the dialog stays usable.
    await page.unrouteAll();
    app.locals.bookService.deleteBook(book.id);
    await submit();
    await expect(summary).toContainText('This Book is no longer available.');
    await expect(summary).not.toContainText('Could not confirm');
    await expect(title).toHaveValue('Keep Me');
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(newChapterTrigger(page)).toBeFocused();
    expect(log.navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
});

test('a deleted Chapter is reported in place and a stale refresh cannot overwrite a newer save', async ({ page }) => {
  await withNotesApp(async (origin, app) => {
    const book = app.locals.bookService.createBook({ title: 'Stale Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'First' });
    const hostPath = `/notes/chapters/${chapter.id}`;
    await page.goto(origin + hostPath);
    const dialog = page.locator('#chapter-edit-dialog');
    const heading = page.locator('h1.app-section-title');

    // The refresh for the first save answers only after the second has finished.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let gets = 0;
    await page.route((url) => url.pathname === hostPath, async (route) => {
      if (route.request().method() === 'GET' && (gets += 1) === 1) {
        const stale = await route.fetch();
        await held;
        await route.fulfill({ response: stale });
        return;
      }
      await route.fallback();
    });
    for (const title of ['Second', 'Third']) {
      await editChapterTrigger(page).click();
      await dialog.locator('[name="title"]').fill(title);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(heading).toHaveText(`Notes — ${title}`);
    }
    await expect.poll(() => gets).toBe(2);
    release();
    await page.waitForTimeout(200);
    await expect(heading).toHaveText('Notes — Third');
    await expect(page.locator('.notes-chapter-detail-sidebar .notes-book-nav-chapter-title')).toHaveText(['Third']);
    await page.unrouteAll();

    app.locals.chapterService.deleteChapter(chapter.id);
    await editChapterTrigger(page).click();
    await expect(dialog.locator('[name="title"]')).toHaveValue('Third');
    await dialog.locator('[name="title"]').fill('Gone');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.locator('[data-dialog-error]')).toContainText('This Chapter is no longer available.');
    await expect(dialog.locator('[name="title"]')).toHaveValue('Gone');
    await expect(page).toHaveURL(origin + hostPath);
  });
});

test('direct URLs stay native and redirect as before', async ({ page }) => {
  await withNotesApp(async (origin, app) => {
    const book = app.locals.bookService.createBook({ title: 'Direct Book' });
    const chapter = app.locals.chapterService.createChapter({ bookId: book.id, title: 'Direct Chapter' });

    await page.goto(`${origin}/notes/books/${book.id}/chapters/new`);
    const create = page.locator('#chapter-create-dialog');
    await expect(create).toBeVisible();
    await create.locator('[name="title"]').fill('Direct Created');
    await create.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(/\/notes\/chapters\/\d+$/);
    await expect(page.locator('h1.app-section-title')).toHaveText('Notes — Direct Created');

    await page.goto(`${origin}/notes/chapters/${chapter.id}/edit`);
    const edit = page.locator('#chapter-edit-dialog');
    await edit.locator('[name="title"]').fill('Direct Edited');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/notes/chapters/${chapter.id}`);
    await expect(page.locator('h1.app-section-title')).toHaveText('Notes — Direct Edited');
  });
});
