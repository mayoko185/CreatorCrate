import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// WP3B: Project Detail Related Notes disclosure and browser-local Pin on the
// real page (isolated SQLite and filesystem in a temporary root). Native
// buttons drive the disclosures from the keyboard, a pin persists per note
// in localStorage across reloads and Projects, collapsing a pinned note keeps
// the pin, and a blocked write leaves the pin off with an error notice.
// WP6.1: the disclosure reads Show note / Hide note with its state, Edit and
// Pin are icon buttons revealed by hover or focus (always shown without a
// hovering pointer) without moving anything, and the card shows the whole Page.

let server;
let db;
let app;
let root;
let baseURL;
let fixture;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-related-notes-pin-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;

  const project = app.locals.projectService.create({ title: 'Pin Project', status: 'tbd' });
  const other = app.locals.projectService.create({ title: 'Second Project', status: 'tbd' });
  const book = app.locals.bookService.createBook({ title: 'Lore' });
  const create = (input) => app.locals.noteService.createNote({ bookId: book.id, ...input });
  const alpha = create({ title: 'Alpha Page', content: 'Alpha body text.', projectIds: [project.id] });
  const beta = create({ title: 'Beta Page', content: 'Beta body text.', projectIds: [project.id, other.id] });
  const longProject = app.locals.projectService.create({ title: 'Long Project', status: 'tbd' });
  const longContent = [
    ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`),
    '| Column A | Column B |\n| --- | --- |\n| one | two |',
    '```js\nconst copyMe = 1;\n```',
    'Final paragraph marker.',
  ].join('\n\n');
  const long = create({
    title: 'A very long related note title that keeps going well past one line of the card header so it must wrap',
    content: longContent,
    projectIds: [longProject.id],
  });
  // M2 F1: a 2,000-character code line and a wide table in one note.
  const wideProject = app.locals.projectService.create({ title: 'Wide Project', status: 'tbd' });
  const wideColumns = Array.from({ length: 24 }, (_, i) => `Column${i}`);
  const wide = create({
    title: 'Wide Page',
    content: [
      `\`\`\`\n${'x'.repeat(1999)}Z\n\`\`\``,
      `| ${wideColumns.join(' | ')} |\n|${' --- |'.repeat(24)}\n| ${wideColumns.map((c) => `${c}Value`).join(' | ')} |`,
      'Wide final marker.',
    ].join('\n\n'),
    projectIds: [wideProject.id],
  });
  fixture = {
    project, other, alpha: String(alpha.id), beta: String(beta.id), longProject, long: String(long.id),
    wideProject, wide: String(wide.id),
  };
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const key = (id) => `creatorcrate:related-notes:v1:note:${id}`;
const disclosure = (page, id) => page.locator(`[data-project-related-note-disclosure="${id}"]`);
const preview = (page, id) => page.locator(`[data-project-related-note-preview="${id}"]`);
const pin = (page, id) => page.locator(`[data-project-related-note-pin="${id}"]`);
const edit = (page, id) => page.locator(`[data-project-related-note-edit="${id}"]`);
// A neutral pointer spot outside every card (the page's left edge opens the
// navigation flyout, so it is not used).
const away = (page) => page.locator('#project-related-notes-heading').hover();
const card = (page, id) => page.locator(`[data-project-related-note="${id}"]`);
const opacity = (locator) => locator.evaluate((node) => Number(getComputedStyle(node.parentElement).opacity));
const box = (locator) => locator.evaluate((node) => {
  const { x, y, width, height } = node.getBoundingClientRect();
  return { x, y, width, height };
});

async function open(page, projectId) {
  await page.goto(`${baseURL}/projects/${projectId}`);
  await expect(page.locator('[data-project-related-note]:not([data-project-related-note-bound="true"])')).toHaveCount(0);
  await expect(page.locator('[data-project-related-note-bound="true"]').first()).toBeAttached();
}

async function expectExpanded(page, id, expanded) {
  await expect(disclosure(page, id)).toHaveAttribute('aria-expanded', String(expanded));
  await expect(disclosure(page, id).locator('[data-project-related-note-disclosure-label]'))
    .toHaveText(expanded ? 'Hide note' : 'Show note');
  if (expanded) await expect(preview(page, id)).toBeVisible();
  else await expect(preview(page, id)).toBeHidden();
}

async function expectPinned(page, id, title, pinned) {
  const verb = pinned ? 'Unpin' : 'Pin';
  await expect(pin(page, id)).toHaveAttribute('aria-pressed', String(pinned));
  await expect(pin(page, id)).toHaveAccessibleName(`${verb} ${title}`);
  // Icon-only: the established tooltip carries the action.
  await expect(pin(page, id)).toHaveText('');
  await expect(pin(page, id)).toHaveAttribute('data-tooltip', `${verb} note`);
}

test('disclosures toggle independently from the keyboard and pins persist per note', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { alpha, beta } = fixture;
  await open(page, fixture.project.id);

  // Default: collapsed and unpinned; aria-controls names the card's preview.
  for (const id of [alpha, beta]) {
    await expectExpanded(page, id, false);
    const controls = await disclosure(page, id).getAttribute('aria-controls');
    await expect(page.locator(`#${controls}`)).toHaveAttribute('data-project-related-note-preview', id);
  }
  await expectPinned(page, alpha, 'Alpha Page', false);

  // Native Enter and Space toggle only that note; focus stays on the button.
  await disclosure(page, alpha).focus();
  await page.keyboard.press('Enter');
  await expectExpanded(page, alpha, true);
  await expectExpanded(page, beta, false);
  await expect(disclosure(page, alpha)).toBeFocused();
  const outline = await disclosure(page, alpha).evaluate((node) => getComputedStyle(node).outlineStyle);
  expect(outline).not.toBe('none');
  await page.keyboard.press('Space');
  await expectExpanded(page, alpha, false);
  await disclosure(page, beta).click();
  await expectExpanded(page, beta, true);
  await expectExpanded(page, alpha, false);
  await disclosure(page, beta).click();
  // Expanding never pins.
  expect(await page.evaluate((k) => localStorage.getItem(k), key(beta))).toBeNull();

  // Pin from the keyboard: persisted, pressed, expanded; focus stays.
  await pin(page, beta).focus();
  await page.keyboard.press('Space');
  await expectPinned(page, beta, 'Beta Page', true);
  await expectExpanded(page, beta, true);
  await expect(pin(page, beta)).toBeFocused();
  expect(await page.evaluate((k) => localStorage.getItem(k), key(beta))).toBe('1');
  const background = (id) => pin(page, id).evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(await background(beta)).not.toBe(await background(alpha));
  await expect(page.locator('[data-dialog-feedback]')).toBeHidden();

  // Manual collapse keeps the pin; reload restores it expanded.
  await disclosure(page, beta).click();
  await expectExpanded(page, beta, false);
  await expectPinned(page, beta, 'Beta Page', true);
  await page.reload();
  await open(page, fixture.project.id);
  await expectExpanded(page, beta, true);
  await expectPinned(page, beta, 'Beta Page', true);
  await expectExpanded(page, alpha, false);

  // The same note on another Project shares the note-level pin.
  await open(page, fixture.other.id);
  await expectExpanded(page, beta, true);
  await expectPinned(page, beta, 'Beta Page', true);

  // Unpin: removed, unpressed, expansion unchanged; next load is collapsed.
  await open(page, fixture.project.id);
  await pin(page, beta).click();
  await expectPinned(page, beta, 'Beta Page', false);
  await expectExpanded(page, beta, true);
  expect(await page.evaluate((k) => localStorage.getItem(k), key(beta))).toBeNull();
  await page.reload();
  await open(page, fixture.project.id);
  await expectExpanded(page, beta, false);
  expect(errors).toEqual([]);
});

test('a blocked storage write keeps the pin off and reports it', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'QuotaExceededError'); };
  });
  const { alpha } = fixture;
  await open(page, fixture.project.id);
  await pin(page, alpha).click();
  await expectPinned(page, alpha, 'Alpha Page', false);
  await expectExpanded(page, alpha, false);
  const notice = page.locator('[data-dialog-feedback]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('role', 'status');
  await expect(notice).toHaveClass(/notice--error/);
  await expect(notice).toContainText("Couldn't pin Alpha Page.");
  // Disclosure stays usable.
  await disclosure(page, alpha).click();
  await expectExpanded(page, alpha, true);
  expect(errors).toEqual([]);
});

test('Edit and Pin are icon buttons revealed by hover or focus without moving the card', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { alpha, beta } = fixture;
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, fixture.project.id);
  expect(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(true);

  // The Notes Book Detail card: same background, border, radius and padding.
  const styles = await card(page, alpha).evaluate((node) => {
    const style = getComputedStyle(node);
    const probe = document.createElement('div');
    probe.style.cssText = 'background: var(--surface-card); border-radius: var(--radius-md); padding: var(--space-md); border: 1px solid var(--border)';
    document.body.append(probe);
    const expected = getComputedStyle(probe);
    const result = {
      actual: [style.backgroundColor, style.borderTopColor, style.borderTopWidth, style.borderTopLeftRadius, style.paddingTop],
      expected: [expected.backgroundColor, expected.borderTopColor, expected.borderTopWidth, expected.borderTopLeftRadius, expected.paddingTop],
    };
    probe.remove();
    return result;
  });
  expect(styles.actual).toEqual(styles.expected);
  // Title and both icons share one header row; no association badges.
  await expect(card(page, alpha).locator('[data-project-related-note-association]')).toHaveCount(0);
  await card(page, beta).scrollIntoViewIfNeeded();
  const titleBox = await box(card(page, alpha).locator('.project-related-note-title'));
  for (const control of [edit(page, alpha), pin(page, alpha)]) {
    const controlBox = await box(control);
    expect(controlBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
    expect(Math.abs((controlBox.y + controlBox.height / 2) - (titleBox.y + titleBox.height / 2))).toBeLessThan(2);
  }
  await expect(edit(page, alpha)).toHaveAccessibleName('Edit Alpha Page');
  await expect(edit(page, alpha)).toHaveAttribute('data-tooltip', 'Edit note');

  // Hidden at rest; hovering anywhere on the card reveals both, leaving hides them.
  await card(page, beta).scrollIntoViewIfNeeded();
  await away(page);
  expect(await opacity(edit(page, alpha))).toBe(0);
  const before = { card: await box(card(page, alpha)), title: titleBox, edit: await box(edit(page, alpha)) };
  const cardBox = before.card;
  await page.mouse.move(cardBox.x + cardBox.width - 12, cardBox.y + cardBox.height - 6);
  await expect.poll(() => opacity(edit(page, alpha))).toBe(1);
  expect(await opacity(edit(page, beta))).toBe(0);
  expect({
    card: await box(card(page, alpha)),
    title: await box(card(page, alpha).locator('.project-related-note-title')),
    edit: await box(edit(page, alpha)),
  }).toEqual(before);
  await away(page);
  await expect.poll(() => opacity(edit(page, alpha))).toBe(0);

  // The icon Edit opens the existing Notes Edit Page dialog in place.
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height - 6);
  await edit(page, alpha).click();
  const dialog = page.locator('#note-edit-dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(edit(page, alpha)).toBeFocused();

  // Keyboard focus inside the card reveals them, with the focus ring visible,
  // and keeps them shown while the pointer is elsewhere.
  await away(page);
  await disclosure(page, beta).focus();
  await expect.poll(() => opacity(edit(page, beta))).toBe(1);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(edit(page, beta)).toBeFocused();
  expect(await opacity(edit(page, beta))).toBe(1);
  expect(await edit(page, beta).evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Tab');
  await expect(pin(page, beta)).toBeFocused();
  await expect(pin(page, beta)).toHaveAccessibleName('Pin Beta Page');
  expect(errors).toEqual([]);
});

test('without a hovering pointer Edit and Pin stay visible', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  try {
    await open(page, fixture.longProject.id);
    expect(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(false);
    const id = fixture.long;
    expect(await opacity(edit(page, id))).toBe(1);
    await expect(edit(page, id)).toBeVisible();
    await expect(pin(page, id)).toBeVisible();
    // The long title wraps beside the controls without overlapping them.
    const titleBox = await box(card(page, id).locator('.project-related-note-title'));
    const editBox = await box(edit(page, id));
    expect(titleBox.height).toBeGreaterThan(editBox.height);
    expect(editBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await pin(page, id).tap();
    await expectPinned(page, id, await card(page, id).locator('.project-related-note-title').innerText(), true);
    await expectExpanded(page, id, true);
    await pin(page, id).tap();
    await expectPinned(page, id, await card(page, id).locator('.project-related-note-title').innerText(), false);
  } finally {
    await context.close();
  }
});

test('expanding a long note shows the complete Page, unclipped, with code and tables usable', async ({ page }) => {
  const id = fixture.long;
  await open(page, fixture.longProject.id);
  await expectExpanded(page, id, false);
  await disclosure(page, id).click();
  await expectExpanded(page, id, true);
  const content = preview(page, id).locator('.notes-content');
  await expect(content.locator('p').last()).toHaveText('Final paragraph marker.');
  await expect(content).toContainText('Paragraph 29');
  await expect(preview(page, id).locator('.notes-page-preview-truncated')).toHaveCount(0);
  const clipped = await preview(page, id).evaluate((node) => [node, node.querySelector('.notes-content')]
    .some((element) => element.scrollHeight > element.clientHeight + 1 || getComputedStyle(element).maxHeight !== 'none'));
  expect(clipped).toBe(false);
  await content.locator('p').last().scrollIntoViewIfNeeded();
  await expect(content.locator('p').last()).toBeInViewport();
  // The shared Notes code block Copy control and table styling apply.
  await expect(content.locator('pre.notes-code-block-enhanced .notes-code-copy')).toHaveCount(1);
  await expect(content.locator('table td').first()).toHaveText('one');
  // Collapsing restores Show note.
  await disclosure(page, id).click();
  await expectExpanded(page, id, false);
});

test('an expanded note with a long code line and a wide table stays inside a narrow page', async ({ page }) => {
  const id = fixture.wide;
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, fixture.wideProject.id);
  await disclosure(page, id).click();
  await expectExpanded(page, id, true);
  const content = preview(page, id).locator('.notes-content');
  await expect(content.locator('p').last()).toHaveText('Wide final marker.');
  const layout = await page.evaluate((noteId) => {
    const root = document.documentElement;
    const note = document.querySelector(`[data-project-related-note="${noteId}"]`);
    const scroller = (node) => (node.scrollWidth > node.clientWidth ? node : [...node.querySelectorAll('*')]
      .find((child) => child.scrollWidth > child.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(child).overflowX)));
    const pre = note.querySelector('.notes-content pre');
    const table = note.querySelector('.notes-content table');
    return {
      documentOverflow: root.scrollWidth - root.clientWidth,
      cardRight: note.getBoundingClientRect().right,
      contentRight: note.querySelector('.project-related-note-content').getBoundingClientRect().right,
      viewport: root.clientWidth,
      code: pre.textContent.includes(`${'x'.repeat(1999)}Z`),
      codeScrolls: Boolean(scroller(pre)),
      lastColumn: table.querySelector('tr:last-child td:last-child')?.textContent,
      tableScrolls: table.scrollWidth > table.clientWidth,
    };
  }, id);
  expect(layout.documentOverflow).toBeLessThanOrEqual(0);
  expect(layout.cardRight).toBeLessThanOrEqual(layout.viewport);
  expect(layout.contentRight).toBeLessThanOrEqual(layout.cardRight);
  // The whole note is rendered; wide code and the table scroll in place.
  expect(layout.code).toBe(true);
  expect(layout.codeScrolls).toBe(true);
  expect(layout.lastColumn).toBe('Column23Value');
  expect(layout.tableScrolls).toBe(true);
  await expect(content.locator('pre .notes-code-copy')).toHaveCount(1);
});
