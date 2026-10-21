import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// Real scrollbars: headless Chromium hides them by default, which hides the
// layout shift a transient body overflow causes while a dropdown opens.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const TAG_NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta'];
const DROPDOWN_IDS = ['project-status-form', 'project-type-form', 'project-tags-form'];
const SUBMIT = 'button[form="project-create-form"][data-dialog-submit]';

async function withProjectApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-dialog-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    for (const name of TAG_NAMES) app.locals.tagService.createTag({ name });
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

// Opened-panel geometry problems: the fixed panel must share the trigger's
// left edge and width, sit 4px below (or above) it, and stay in the viewport.
const panelGeometry = (dialog, dropdownId) => dialog.locator(`#${dropdownId}`).evaluate((dropdown) => {
  const trigger = dropdown.querySelector('summary').getBoundingClientRect();
  const panelElement = dropdown.querySelector('.asset-filter-multiselect-panel');
  const panel = panelElement.getBoundingClientRect();
  const problems = [];
  if (!dropdown.open) problems.push('closed');
  if (getComputedStyle(panelElement).position !== 'fixed') problems.push('not fixed');
  if (Math.abs(panel.left - trigger.left) > 1) problems.push(`left ${panel.left} vs ${trigger.left}`);
  if (Math.abs(panel.width - trigger.width) > 1) problems.push(`width ${panel.width} vs ${trigger.width}`);
  const below = panel.top >= trigger.bottom;
  const gap = below ? panel.top - trigger.bottom : trigger.top - panel.bottom;
  if (Math.abs(gap - 4) > 1 && !(!below && panel.top <= 8.5)) problems.push(`gap ${gap}`);
  if (panel.left < 7.5 || panel.right > innerWidth - 7.5 || panel.top < 7.5 || panel.bottom > innerHeight - 7.5) {
    problems.push('outside viewport');
  }
  return { problems, placement: below ? 'below' : 'above' };
});

async function expectPanelAligned(dialog, dropdownId, placement) {
  await expect.poll(async () => (await panelGeometry(dialog, dropdownId)).problems).toEqual([]);
  if (placement) expect((await panelGeometry(dialog, dropdownId)).placement).toBe(placement);
}

const bodyScrolls = (dialog) => dialog.locator('.app-dialog-body').evaluate((body) => body.scrollHeight > body.clientHeight + 1);

async function openProjectDialog(page, origin, app, kind) {
  if (kind === 'new') {
    await page.goto(origin + '/');
    await page.getByRole('link', { name: 'New Project', exact: true }).click();
    const dialog = page.locator('#project-create-dialog');
    await expect(dialog).toBeVisible();
    return dialog;
  }
  const project = app.locals.projectService.create({ title: 'Edit Target', status: 'ready' });
  await page.goto(`${origin}/projects/${project.id}`);
  await page.getByRole('link', { name: 'Edit project' }).click();
  const dialog = page.locator('#project-edit-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

const optionText = (dialog, dropdownId) => dialog.locator(`#${dropdownId} .asset-filter-multiselect-option`).evaluateAll(options => (
  options.map((option) => {
    const style = getComputedStyle(option.querySelector('label > span'));
    const indicator = getComputedStyle(option.querySelector('input'));
    return {
      checked: option.querySelector('input').checked,
      text: [style.color, style.fontSize, style.fontWeight, style.lineHeight].join(' '),
      indicator: [indicator.width, indicator.order, indicator.borderRadius, indicator.backgroundImage !== 'none'].join(' '),
    };
  })
));

test('New Project dialog sizes notes fields, matches option styling, and keeps Tags open', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });

  await withProjectApp(async (origin) => {
    await page.goto(origin + '/');
    await page.getByRole('link', { name: 'New Project', exact: true }).click();
    const dialog = page.locator('#project-create-dialog');
    await expect(dialog).toBeVisible();

    // Description and Notes are three times their three-row height, side by side.
    for (const id of ['description', 'notes']) {
      const sizing = await dialog.locator(`#${id}`).evaluate((textarea) => {
        const style = getComputedStyle(textarea);
        const px = (value) => parseFloat(value);
        const threeRows = 3 * px(style.lineHeight) + px(style.paddingTop) + px(style.paddingBottom)
          + px(style.borderTopWidth) + px(style.borderBottomWidth);
        return { rows: textarea.rows, height: textarea.getBoundingClientRect().height, threeRows, resize: style.resize };
      });
      expect(sizing.rows).toBe(3);
      expect(sizing.height).toBeCloseTo(sizing.threeRows * 3, 0);
      expect(sizing.resize).toBe('vertical');
    }
    const [description, notes, tagsTrigger, title] = await Promise.all(
      ['#description', '#notes', '#project-tags-form summary', '#title'].map((selector) => dialog.locator(selector).boundingBox()),
    );
    expect(Math.abs(description.y - notes.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(tagsTrigger.x + tagsTrigger.width - (title.x + title.width))).toBeLessThanOrEqual(1);

    // Selected and unselected options share text styling and indicator geometry.
    await dialog.locator('#project-status-form summary').click();
    const statusOptions = await optionText(dialog, 'project-status-form');
    await dialog.locator('#project-status-form summary').click();
    await dialog.locator('#project-tags-form summary').click();
    await dialog.locator('#project-tags-form label', { hasText: 'Beta' }).click();
    await expect(dialog.locator('#project-tags-form')).toHaveAttribute('open', '');
    await dialog.locator('#project-tags-form label', { hasText: 'Alpha' }).click();
    await dialog.locator('#project-tags-form label', { hasText: 'Beta' }).click();
    await expect(dialog.locator('#project-tags-form')).toHaveAttribute('open', '');
    await expect(dialog.locator('#project-tags-form [data-cc-dropdown-summary-current]')).toHaveText('Alpha');
    const tagOptions = await optionText(dialog, 'project-tags-form');

    const all = [...statusOptions, ...tagOptions];
    expect(all.some((option) => option.checked)).toBe(true);
    expect(all.some((option) => !option.checked)).toBe(true);
    expect(new Set(all.map((option) => option.text)).size).toBe(1);
    expect(new Set(all.map((option) => option.indicator.split(' ').slice(0, 3).join(' '))).size).toBe(1);
    expect(all.every((option) => option.indicator.endsWith(String(option.checked)))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog.locator('#project-tags-form')).not.toHaveAttribute('open', '');
    await expect(dialog).toBeVisible();
  });
  expect(pageErrors).toEqual([]);
});

test('New Project Tags panel matches its trigger when its height briefly overflows the body', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withProjectApp(async (origin, app) => {
    const dialog = await openProjectDialog(page, origin, app, 'new');
    expect(await bodyScrolls(dialog)).toBe(false);
    const tags = dialog.locator('#project-tags-form');

    for (const id of DROPDOWN_IDS) {
      await dialog.locator(`#${id} summary`).click();
      await expectPanelAligned(dialog, id, 'below');
      await dialog.locator(`#${id} summary`).click();
    }

    // Pointer selection and deselection keep Tags open and aligned.
    await tags.locator('summary').click();
    await expect(tags.locator('.asset-filter-multiselect-option')).toHaveCount(TAG_NAMES.length);
    await tags.locator('label', { hasText: 'Theta' }).click();
    await expect(tags).toHaveAttribute('open', '');
    await expectPanelAligned(dialog, 'project-tags-form', 'below');
    await tags.locator('label', { hasText: 'Theta' }).click();
    await expect(tags).toHaveAttribute('open', '');
    await expectPanelAligned(dialog, 'project-tags-form', 'below');

    // Reopening and resizing keep the panel on its trigger.
    await tags.locator('summary').click();
    await expect(tags).not.toHaveAttribute('open', '');
    await tags.locator('summary').click();
    await expectPanelAligned(dialog, 'project-tags-form', 'below');
    await page.setViewportSize({ width: 1100, height: 900 });
    await expectPanelAligned(dialog, 'project-tags-form');
  });
});

for (const kind of ['new', 'edit']) {
  for (const viewport of [
    { width: 1280, height: 1400, scrolls: false },
    { width: 1280, height: 640, scrolls: true },
    { width: 390, height: 2400, scrolls: false },
    { width: 390, height: 760, scrolls: true },
  ]) {
    test(`${kind} project dropdown panels align at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await withProjectApp(async (origin, app) => {
        const dialog = await openProjectDialog(page, origin, app, kind);
        expect(await bodyScrolls(dialog)).toBe(viewport.scrolls);

        for (const id of DROPDOWN_IDS) {
          await dialog.locator(`#${id} summary`).evaluate((summary) => summary.scrollIntoView({ block: 'center' }));
          await dialog.locator(`#${id} summary`).click();
          await expectPanelAligned(dialog, id);
          await dialog.locator(`#${id} summary`).click();
        }

        const tags = dialog.locator('#project-tags-form');
        await tags.locator('summary').click();
        await tags.locator('label', { hasText: 'Delta' }).click();
        await expect(tags).toHaveAttribute('open', '');
        await expectPanelAligned(dialog, 'project-tags-form');
        if (viewport.scrolls) {
          // Scrolling the body moves the trigger; the panel follows it.
          await dialog.locator('.app-dialog-body').evaluate((body) => body.scrollBy(0, 24));
          await expectPanelAligned(dialog, 'project-tags-form');
        }
        await tags.locator('label', { hasText: 'Delta' }).click();
        await expect(tags).toHaveAttribute('open', '');
        await expectPanelAligned(dialog, 'project-tags-form');
      });
    });
  }
}

for (const kind of ['new', 'edit']) {
  test(`${kind} project open Tags panel follows its trigger across the 640px breakpoint`, async ({ page }) => {
    await page.setViewportSize({ width: 641, height: 1000 });
    await withProjectApp(async (origin, app) => {
      const dialog = await openProjectDialog(page, origin, app, kind);
      const tags = dialog.locator('#project-tags-form');
      const checkedTags = () => tags.locator('input:checked').evaluateAll((inputs) => inputs.map((input) => input.value));
      const triggerWidth = async () => (await tags.locator('summary').boundingBox()).width;

      await tags.locator('summary').evaluate((summary) => summary.scrollIntoView({ block: 'center' }));
      await tags.locator('summary').click();
      for (const name of ['Beta', 'Theta']) await tags.locator('label', { hasText: name }).click();
      await expectPanelAligned(dialog, 'project-tags-form');
      const selected = await checkedTags();
      expect(selected).toHaveLength(2);
      const wideWidth = await triggerWidth();

      // Crossing into one column widens the trigger; the open panel widens with it.
      await page.setViewportSize({ width: 640, height: 1000 });
      await expect.poll(triggerWidth).toBeGreaterThan(wideWidth * 2);
      await expectPanelAligned(dialog, 'project-tags-form');
      await expect(tags).toHaveAttribute('open', '');
      expect(await checkedTags()).toEqual(selected);

      // And narrows with it on the way back.
      await page.setViewportSize({ width: 641, height: 1000 });
      await expect.poll(triggerWidth).toBeCloseTo(wideWidth, 0);
      await expectPanelAligned(dialog, 'project-tags-form');
      await expect(tags).toHaveAttribute('open', '');
      expect(await checkedTags()).toEqual(selected);
    });
  });
}

const buttonLook = (button) =>button.evaluate((element) => {
  const style = getComputedStyle(element);
  const text = document.createRange();
  text.selectNodeContents(element);
  return {
    background: style.backgroundColor,
    backgroundImage: style.backgroundImage,
    border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
    color: style.color,
    font: `${style.fontSize} ${style.fontWeight}`,
    inheritsFont: style.fontFamily === getComputedStyle(element.closest('dialog')).fontFamily,
    minHeight: style.minHeight,
    height: element.getBoundingClientRect().height,
    radius: style.borderTopLeftRadius,
    padding: `${style.paddingLeft} ${style.paddingRight}`,
    shadow: style.boxShadow,
    filter: style.filter,
    transform: style.transform,
    outline: `${style.outlineWidth} ${style.outlineStyle}`,
    width: element.getBoundingClientRect().width,
    contentWidth: text.getBoundingClientRect().width,
  };
});

const luminance = (rgb) => rgb.match(/\d+/g).slice(0, 3).map(Number).map((channel) => {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);

test('Create project button is an outlined button with a cyan plus square, scoped to New Project', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });

  await withProjectApp(async (origin, app) => {
    const dialog = await openProjectDialog(page, origin, app, 'new');
    const button = dialog.locator(SUBMIT);
    const accent = 'rgb(34, 211, 238)';
    const bg = 'rgb(13, 15, 19)';
    const text = 'rgb(232, 236, 241)';
    const borderStrong = 'rgb(58, 67, 83)';

    // One submit control named by its label; the plus square is decorative.
    await expect(dialog.getByRole('button', { name: 'Create project', exact: true })).toHaveCount(1);
    const icon = await button.evaluate((element) => {
      const square = element.querySelector('.project-create-submit-icon');
      const style = getComputedStyle(square);
      const box = square.getBoundingClientRect();
      const host = element.getBoundingClientRect();
      return {
        hidden: square.getAttribute('aria-hidden'),
        focusables: element.querySelectorAll('a, button, input, [tabindex]').length,
        background: style.backgroundColor,
        color: style.color,
        size: `${box.width}x${box.height}`,
        leading: box.left - host.left < 12 && square === element.firstElementChild,
      };
    });
    expect(icon).toEqual({ hidden: 'true', focusables: 0, background: accent, color: bg, size: '20x20', leading: true });

    const idle = await buttonLook(button);
    expect(idle).toMatchObject({
      background: bg,
      backgroundImage: 'none',
      border: `1px solid ${borderStrong}`,
      color: text,
      font: '14px 600',
      inheritsFont: true,
      minHeight: '36px',
      height: 36,
      radius: '6px',
      padding: '8px 12px',
      shadow: 'none',
    });
    expect(idle.width).toBeCloseTo(idle.contentWidth + 8 + 12 + 2, 0);
    // --text on --bg clears WCAG AAA contrast.
    expect((luminance(text) + 0.05) / (luminance(bg) + 0.05)).toBeGreaterThan(7);

    await button.hover();
    await expect.poll(async () => (await buttonLook(button)).border).toBe(`1px solid ${accent}`);
    expect((await buttonLook(button)).filter).toBe('brightness(1.08)');
    expect((await buttonLook(button)).backgroundImage).toBe('none');
    await page.mouse.move(0, 0);

    await dialog.locator('#title').focus();
    for (let i = 0; i < 60 && !(await button.evaluate((element) => element === document.activeElement)); i += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(button).toBeFocused();
    expect(await button.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
    expect((await buttonLook(button)).outline).toBe('2px solid');

    // Pressed movement, then an empty submission rerenders with a validation error.
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(async () => (await buttonLook(button)).transform).toBe('matrix(1, 0, 0, 1, 0, 1)');
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.field-error-message')).toContainText('Title is required.');
    expect(await buttonLook(button)).toMatchObject({ background: bg, color: text, radius: '6px' });

    // Edit Project's Save changes shares the outlined treatment, without the plus.
    const project = app.locals.projectService.create({ title: 'Untouched', status: 'ready' });
    await page.goto(`${origin}/projects/${project.id}`);
    await page.locator('[data-dialog-open="project-edit-dialog"]').first().click();
    const editDialog = page.locator('#project-edit-dialog');
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(1);
    const editSubmit = editDialog.locator('button[form="project-edit-form"][data-dialog-submit]');
    await expect(editSubmit.locator('.project-create-submit-icon')).toHaveCount(0);
    expect(await buttonLook(editSubmit)).toMatchObject({
      background: bg,
      backgroundImage: 'none',
      border: `1px solid ${borderStrong}`,
      color: text,
      font: '14px 600',
      height: 36,
      radius: '6px',
      padding: '12px 12px',
      shadow: 'none',
    });
    await editSubmit.hover();
    await expect.poll(async () => (await buttonLook(editSubmit)).border).toBe(`1px solid ${accent}`);
    await page.mouse.move(0, 0);

    // A successful creation keeps its selected tag.
    await page.goto(origin + '/');
    await page.getByRole('link', { name: 'New Project', exact: true }).click();
    await dialog.locator('#title').fill('Trial Button Project');
    await dialog.locator('#project-tags-form summary').click();
    await dialog.locator('#project-tags-form label', { hasText: 'Gamma' }).click();
    await dialog.locator('#project-tags-form summary').click();
    await button.click();
    await expect(page).toHaveURL(/\/projects\/\d+$/);
    await expect(page.getByRole('heading', { name: 'Trial Button Project' })).toBeVisible();
    await expect(page.locator('main')).toContainText('Gamma');
  });
  expect(pageErrors).toEqual([]);
});

test('Create project button fits the narrow New Project footer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await withProjectApp(async (origin, app) => {
    const dialog = await openProjectDialog(page, origin, app, 'new');
    const fit = await dialog.locator(SUBMIT).evaluate((element) => {
      const footer = element.closest('.app-dialog-footer');
      const button = element.getBoundingClientRect();
      const footerBox = footer.getBoundingClientRect();
      return {
        inside: button.left >= footerBox.left && button.right <= footerBox.right,
        overflow: footer.scrollWidth > footer.clientWidth,
        height: button.height,
        stretched: button.width > footerBox.width * 0.8,
      };
    });
    expect(fit).toEqual({ inside: true, overflow: false, height: 36, stretched: false });
  });
});
