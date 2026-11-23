import { expect, test } from '@playwright/test';
import { createCalendarFixture, enhanced, MONTH, watch } from './calendar-filters-defaults-fixture.js';

const fixture = createCalendarFixture('calendar-terminal-dialog-focus');
test.beforeAll(fixture.start);
test.afterAll(fixture.stop);
test.beforeEach(fixture.isolate);

async function openReleaseEditor(page, release) {
  const action = page.locator(`[data-release-edit-id="${release.id}"]`);
  const cards = page.locator('[data-calendar-info-card]').filter({ has: action });
  const cardIds = await cards.evaluateAll((elements) => elements.map((element) => element.id));
  const opener = page.locator('[data-calendar-info-trigger]:visible')
    .and(page.locator(cardIds.map((id) => `[aria-controls="${id}"]`).join(', ')));
  await opener.click();
  await action.filter({ visible: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit Release' });
  await expect(editor.locator('[data-dialog-submit]')).toBeEnabled();
  return { editor, opener };
}

for (const { kind, status, view, dismissal, width } of [
  { kind: 'archive', status: 409, view: 'grid', dismissal: 'Escape', width: 1280 },
  { kind: 'delete', status: 404, view: 'list', dismissal: 'Escape', width: 1280 },
  { kind: 'archive', status: 409, view: 'grid', dismissal: 'Close', width: 390 },
]) {
  test(`terminal ${kind} ${status} restores Calendar focus on ${dismissal} (${view}, ${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const project = fixture.project('Dialog focus');
    const target = fixture.release(project, 'First release', { planned: `${MONTH}-10` });
    const another = fixture.release(project, 'Second release', { planned: `${MONTH}-12` });
    const control = watch(page);
    await page.goto(`${fixture.baseURL}/calendar?month=${MONTH}&view=${view}&status=planned&weekStart=sunday&project=${project.id}&type=${project.projectType}`);
    await enhanced(page);
    const before = await page.evaluate(() => ({ href: location.href, length: history.length, state: history.state }));
    const { editor, opener } = await openReleaseEditor(page, target);
    const oldOpener = await opener.elementHandle();
    const action = editor.locator(`[data-release-edit-action="${kind}"]`);
    await action.locator('summary').click();
    await action.locator('button[data-confirm]').click();
    const confirmation = page.locator('#app-confirmation-dialog');
    await expect(confirmation).toBeVisible();
    if (kind === 'archive') {
      fixture.state.db.prepare('UPDATE releases SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(target.id);
    } else {
      fixture.state.db.prepare('DELETE FROM releases WHERE id = ?').run(target.id);
    }

    const postPath = `/releases/${target.id}/${kind}`;
    const response = page.waitForResponse((answer) => new URL(answer.url()).pathname === postPath
      && answer.request().method() === 'POST');
    await confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
    const refusal = await response;
    expect(refusal.status()).toBe(status);
    expect((await refusal.json()).code).toBe(kind === 'archive' ? 'RELEASE_ALREADY_ARCHIVED' : 'RELEASE_NOT_FOUND');
    await expect(page.locator(`[data-release-edit-id="${target.id}"]`)).toHaveCount(0);
    expect(await oldOpener.evaluate((element) => element.isConnected)).toBe(false);
    await expect(editor).toBeVisible();
    const feedback = page.locator('[data-dialog-feedback]');
    await expect(feedback).toBeVisible();
    const notice = await feedback.textContent();
    const gets = control.gets.length;
    expect(gets).toBe(1);

    if (dismissal === 'Escape') await page.keyboard.press('Escape');
    else await editor.getByRole('button', { name: 'Close Edit Release' }).click();
    await expect(editor).toBeHidden();
    const month = page.getByRole('button', { name: /^Choose month:/ });
    await expect.poll(() => page.evaluate(() => ({
      tag: document.activeElement.tagName,
      month: document.activeElement.matches('[data-dialog-open="calendar-month-dialog"]'),
    }))).toEqual({ tag: 'BUTTON', month: true });
    await expect(month).toBeVisible();
    await expect(month).toBeEnabled();
    expect(await month.evaluate((element) => element.isConnected && element.tabIndex === 0)).toBe(true);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Previous month' })).toBeFocused();

    const second = await openReleaseEditor(page, another);
    await page.keyboard.press('Escape');
    await expect(second.editor).toBeHidden();
    await expect(second.opener).toBeFocused();
    await expect(feedback).toHaveText(notice.trim());
    expect(control.posts.map(({ path }) => path)).toEqual([postPath]);
    expect(control.gets).toHaveLength(gets);
    expect(control.documents).toHaveLength(1);
    expect(control.errors).toEqual([]);
    expect(await page.evaluate(() => ({ href: location.href, length: history.length, state: history.state }))).toEqual(before);
  });
}

async function openCalendarWithRelease(page) {
  const project = fixture.project('Focus edge cases');
  const release = fixture.release(project, 'Focus edge case release', { planned: `${MONTH}-10` });
  await page.goto(`${fixture.baseURL}/calendar?month=${MONTH}&view=grid&project=${project.id}`);
  await enhanced(page);
  return release;
}

for (const { caption, dismissal, change } of [
  {
    caption: 'non-tabbable opener',
    dismissal: 'Escape',
    change: (element) => { element.tabIndex = -1; },
  },
  {
    caption: 'throwing opener',
    dismissal: 'Close',
    change: (element) => { element.focus = () => { throw new Error('opener focus failed'); }; },
  },
]) {
  test(`Calendar dismisses Edit Release with a ${caption}`, async ({ page }) => {
    const control = watch(page);
    const release = await openCalendarWithRelease(page);
    const { editor, opener } = await openReleaseEditor(page, release);
    await opener.evaluate(change);

    if (dismissal === 'Escape') await page.keyboard.press('Escape');
    else await editor.getByRole('button', { name: 'Close Edit Release' }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByRole('button', { name: /^Choose month:/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Previous month' })).toBeFocused();
    expect(control.errors).toEqual([]);
    expect(control.posts).toEqual([]);
    expect(control.gets).toEqual([]);
    expect(control.documents).toHaveLength(1);
  });
}

for (const { caption, dismissal, change } of [
  { caption: 'non-tabbable', dismissal: 'Close', change: (button) => { button.tabIndex = -1; } },
  { caption: 'non-tabbable', dismissal: 'Escape', change: (button) => { button.tabIndex = -1; } },
  { caption: 'disabled', dismissal: 'Escape', change: (button) => { button.disabled = true; } },
  { caption: 'hidden', dismissal: 'Escape', change: (button) => { button.hidden = true; } },
  { caption: 'inert', dismissal: 'Escape', change: (button) => { button.parentElement.inert = true; } },
  { caption: 'detached', dismissal: 'Escape', change: (button) => { button.remove(); } },
  { caption: 'throwing', dismissal: 'Escape', change: (button) => {
    button.focus = () => { throw new Error('month focus failed'); };
  } },
  { caption: 'no-op', dismissal: 'Escape', change: (button) => { button.focus = () => {}; } },
]) {
  test(`Calendar skips the ${caption} Choose month fallback on ${dismissal}`, async ({ page }) => {
    const control = watch(page);
    const release = await openCalendarWithRelease(page);
    const before = await page.evaluate(() => ({ href: location.href, length: history.length, state: history.state }));
    const { editor, opener } = await openReleaseEditor(page, release);
    const month = page.getByRole('button', { name: /^Choose month:/ });
    const main = page.locator('main#main-content');
    await opener.evaluate((element) => { element.tabIndex = -1; });
    await month.evaluate(change);
    const requests = [];
    page.on('request', (request) => {
      if (['document', 'fetch', 'xhr'].includes(request.resourceType()) || request.method() === 'POST') {
        requests.push(`${request.method()} ${request.url()}`);
      }
    });

    if (dismissal === 'Escape') await page.keyboard.press('Escape');
    else await editor.getByRole('button', { name: 'Close Edit Release' }).click();

    await expect(editor).toBeHidden();
    await expect.poll(() => page.evaluate(() => {
      const active = document.activeElement;
      return {
        tag: active.tagName,
        id: active.id,
        tabIndex: active.tabIndex,
        isChooseMonth: active.matches('[data-dialog-open="calendar-month-dialog"]'),
      };
    })).toEqual({ tag: 'MAIN', id: 'main-content', tabIndex: -1, isChooseMonth: false });
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Calendar view' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(main).not.toBeFocused();
    if (caption === 'non-tabbable') await expect(month).toHaveAttribute('tabindex', '-1');
    expect(await page.evaluate(() => ({ href: location.href, length: history.length, state: history.state }))).toEqual(before);
    expect(control.errors).toEqual([]);
    expect(requests).toEqual([]);
  });
}

test('repeated ordinary Calendar dismissal restores the opener and preserves Tab order', async ({ page }) => {
  const control = watch(page);
  const release = await openCalendarWithRelease(page);
  for (const dismissal of ['Escape', 'Close']) {
    const { editor, opener } = await openReleaseEditor(page, release);
    if (dismissal === 'Escape') await page.keyboard.press('Escape');
    else await editor.getByRole('button', { name: 'Close Edit Release' }).click();
    await expect(editor).toBeHidden();
    await expect(opener).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(opener).toBeFocused();
  }
  expect(control.posts).toEqual([]);
  expect(control.gets).toEqual([]);
  expect(control.errors).toEqual([]);
  expect(control.documents).toHaveLength(1);
});

for (const detach of [false, true]) {
  test(`shared native close with malformed selector and ${detach ? 'detached' : 'valid'} opener`, async ({ page }) => {
    const control = watch(page);
    await openCalendarWithRelease(page);
    await page.evaluate(async (detach) => {
      const { openAppDialogById } = await import('/client/app-dialogs.js');
      document.activeElement.blur();
      const opener = document.createElement('button');
      opener.id = 'shared-focus-opener';
      const preferred = document.createElement('button');
      preferred.id = 'shared-focus-preferred';
      preferred.tabIndex = -1;
      document.body.append(opener, preferred);
      openAppDialogById(document, 'app-confirmation-dialog', opener, {
        focusFallbacks: ['[', '#shared-focus-preferred', '#main-content'],
      });
      if (detach) opener.remove();
    }, detach);

    const dialog = page.locator('#app-confirmation-dialog');
    await dialog.getByRole('button', { name: 'Close Confirm action' }).click();
    await expect(dialog).toBeHidden();
    const destination = page.locator(detach ? '#main-content' : '#shared-focus-opener');
    await expect(destination).toBeFocused();
    if (detach) await expect(destination).toHaveAttribute('tabindex', '-1');
    expect(control.errors).toEqual([]);
    expect(control.posts).toEqual([]);
    expect(control.gets).toEqual([]);
  });
}

test('a real queued close cannot take focus from a newer dialog', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const release = await openCalendarWithRelease(page);
  const { editor, opener } = await openReleaseEditor(page, release);
  const requests = [];
  page.on('request', (request) => {
    if (['document', 'fetch', 'xhr'].includes(request.resourceType())) requests.push(request.url());
  });
  const openerHandle = await opener.elementHandle();
  const events = await openerHandle.evaluate(async (opener) => {
    const { openAppDialogById, closeAppDialogById } = await import('/client/app-dialogs.js');
    const older = document.querySelector('#release-edit-dialog');
    const newer = document.querySelector('#calendar-month-dialog');
    const attempts = [];
    const month = document.querySelector('[data-dialog-open="calendar-month-dialog"]');
    for (const target of [opener, month, document.querySelector('#main-content')]) {
      const focus = target.focus.bind(target);
      target.focus = (options) => { attempts.push(target.tagName); focus(options); };
    }
    let newerCloses = 0;
    newer.addEventListener('close', () => { newerCloses += 1; });
    const olderClosed = new Promise((resolve) => older.addEventListener('close', resolve, { once: true }));
    closeAppDialogById(document, older.id);
    openAppDialogById(document, newer.id);
    const focusedByNewer = document.activeElement;
    await olderClosed;
    return { attempts, newerCloses, sameFocus: newer.contains(focusedByNewer) && document.activeElement === focusedByNewer };
  });

  expect(events).toEqual({ attempts: [], newerCloses: 0, sameFocus: true });
  await expect(editor).toBeHidden();
  const picker = page.locator('#calendar-month-dialog');
  await expect(picker).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await picker.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
});
