import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

async function presentation(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      padding: style.padding,
      radius: style.borderRadius,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      base: style.getPropertyValue('--project-badge-bg').trim(),
      tint: style.getPropertyValue('--project-badge-tint').trim(),
    };
  });
}

test('Project badges retain tinted semantics across Settings, Projects, detail and Dashboard', async ({ page }) => {
  page.setDefaultTimeout(10_000);
  await page.setViewportSize({ width: 1280, height: 1600 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-badges-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper } },
    );
    const bright = app.locals.projectOptionCatalogueService.addOption('status', {
      name: 'Bright Custom', color: '#22D3EE',
    });
    const dark = app.locals.projectOptionCatalogueService.addOption('projectType', {
      name: 'Dark Custom', color: '#123456',
    });
    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, status, project_type)
      VALUES ('Project badge surfaces', 'project-badge-surfaces', ?, 'images')
    `).run(bright.value).lastInsertRowid);

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/settings/defaults`);

    const card = (kind, value) => page.locator(
      `[data-settings-project-option-editor="${kind}"] [data-project-option-value="${value}"]`,
    );
    const tbd = await presentation(card('status', 'tbd').locator('.project-status-badge'));
    const initialImages = await presentation(card('project-type', 'images').locator('.project-type-badge'));
    expect(tbd.background).toMatch(/(?:rgba|color\(srgb).*(?:0\.2|\/ 0\.2)/);
    expect(tbd.tint).toBe('20%');
    expect(initialImages.background).toMatch(/(?:rgba|color\(srgb).*(?:0\.18|\/ 0\.18)/);
    expect(initialImages.tint).toBe('18%');
    expect(tbd.color).not.toBe('rgb(0, 0, 0)');
    expect(initialImages.color).not.toBe('rgb(0, 0, 0)');
    for (const builtIn of [tbd, initialImages]) {
      expect(builtIn.padding).toBe('4px 8px');
      expect(builtIn.radius).toBe('6px');
      expect(builtIn.fontSize).toBe('12px');
      expect(builtIn.fontWeight).toBe('600');
    }

    const darkStyle = await presentation(card('project-type', dark.value).locator('.project-type-badge'));
    expect(darkStyle.base).toBe('#123456');
    expect(darkStyle.background).toMatch(/(?:rgba|color\(srgb).*(?:0\.18|\/ 0\.18)/);
    expect(darkStyle.color).toBe('rgb(132, 149, 167)');

    const typeResponse = page.waitForResponse(result => result.request().method() === 'POST'
      && result.url().endsWith('/project-options/project-type/images/color'));
    await card('project-type', 'images').locator('[data-project-option-color-trigger]').click();
    await card('project-type', 'images').locator('[data-color="#F97316"]').click();
    expect((await typeResponse).status()).toBe(302);
    await expect(card('project-type', 'images').locator('.project-option-color-code')).toHaveText('#F97316');
    const settingsType = await presentation(card('project-type', 'images').locator('.project-type-badge'));
    expect(settingsType.base).toBe('#F97316');
    expect(settingsType.tint).toBe('18%');
    expect(settingsType.background).toMatch(/(?:rgba|color\(srgb).*(?:0\.18|\/ 0\.18)/);
    expect(settingsType.background).not.toBe('rgba(34, 211, 238, 0.18)');
    expect(settingsType.color).toBe('rgb(250, 135, 55)');
    await expect(card('project-type', 'images').locator('.project-type-badge'))
      .not.toHaveClass(/project-type-badge--images/);

    const response = page.waitForResponse(result => result.request().method() === 'POST'
      && result.url().endsWith(`/project-options/status/${bright.value}/color`));
    await card('status', bright.value).locator('[data-project-option-color-trigger]').click();
    await card('status', bright.value).locator('[data-color="#0EA5E9"]').click();
    expect((await response).status()).toBe(302);
    const settingsStatus = await presentation(card('status', bright.value).locator('.project-status-badge'));
    expect(settingsStatus.base).toBe('#0EA5E9');
    expect(settingsStatus.background).not.toBe('rgb(14, 165, 233)');
    expect(settingsStatus.color).toBe('rgb(48, 178, 236)');

    const surfacePaths = ['/projects', `/projects/${projectId}`, '/'];
    for (const surfacePath of surfacePaths) {
      const surface = await page.context().newPage();
      try {
        await surface.goto(base + surfacePath);
        const host = surfacePath === `/projects/${projectId}`
          ? surface.locator('.project-detail-meta')
          : surface.locator('[data-project-card]').filter({ hasText: 'Project badge surfaces' }).first();
        const statusStyle = await presentation(host.locator('.project-status-badge').first());
        const typeStyle = await presentation(host.locator('.project-type-badge').first());
        expect(statusStyle).toEqual(settingsStatus);
        expect(typeStyle).toEqual(settingsType);
      } finally {
        await surface.close();
      }
    }

    const ordinary = await page.evaluate(() => {
      const badge = document.createElement('span');
      badge.className = 'status-badge status-badge--success';
      badge.textContent = 'Present';
      document.body.append(badge);
      const style = getComputedStyle(badge);
      const result = {
        background: style.backgroundColor,
        color: style.color,
        projectBase: style.getPropertyValue('--project-badge-bg').trim(),
      };
      badge.remove();
      return result;
    });
    expect(ordinary.background).toBe('rgba(52, 211, 153, 0.18)');
    expect(ordinary.color).toBe('rgb(52, 211, 153)');
    expect(ordinary.projectBase).toBe('');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
