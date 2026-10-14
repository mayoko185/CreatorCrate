import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

function localDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function insertRelease(db, projectId, title, { plannedDate = null, publishedDate = null } = {}) {
  db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at)
    VALUES (?, ?, '', '', ?, NULL, NULL, ?, NULL)
  `).run(projectId, title, plannedDate, publishedDate);
}

const LONG_TITLE = 'An Exceptionally Long Release Title That Must Truncate Or Wrap Without Widening The Page';

async function withDashboardApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-visual-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const project = app.locals.projectService.create({ title: `${LONG_TITLE} Project` });
    insertRelease(db, project.id, `${LONG_TITLE} Undated`);
    insertRelease(db, project.id, `${LONG_TITLE} Scheduled`, { plannedDate: localDate(2) });
    insertRelease(db, project.id, `${LONG_TITLE} Published`, { publishedDate: localDate(-1) });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}` });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Each region's thumbnail edge in CSS pixels at the default 16px root size.
const THUMB_SIZES = {
  needsDate: { selector: '.dashboard-needs-date-item .dashboard-thumb', size: 72 },
  scheduled: { selector: '.dashboard-release-row > .dashboard-thumb', size: 60 },
  recent: { selector: '.dashboard-recent-item .dashboard-thumb', size: 54 },
  projects: { selector: '.dashboard-project-cell .dashboard-thumb', size: 48 },
};
// Scheduled-row thumbnails are decorative and hidden at the narrowest breakpoint.
const SCHEDULED_THUMB_HIDDEN_MAX_WIDTH = 540;

for (const width of [1440, 1024, 768, 375, 320]) {
  test(`dashboard visual polish holds at ${width}px`, async ({ page }) => {
    await withDashboardApp(async ({ origin }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/`);
      await page.locator('.dashboard').waitFor();

      const metrics = await page.evaluate((thumbSizes) => {
        const rect = (element) => element.getBoundingClientRect();
        const thumbs = {};
        for (const [region, { selector }] of Object.entries(thumbSizes)) {
          thumbs[region] = [...document.querySelectorAll(selector)].map((thumb) => {
            const box = rect(thumb);
            const initials = rect(thumb.querySelector('.dashboard-thumb-initials'));
            return {
              display: getComputedStyle(thumb).display,
              width: box.width,
              height: box.height,
              initialsOffsetX: Math.abs((initials.left + initials.width / 2) - (box.left + box.width / 2)),
              initialsOffsetY: Math.abs((initials.top + initials.height / 2) - (box.top + box.height / 2)),
            };
          });
        }
        const tile = getComputedStyle(document.querySelector('.dashboard-tile--emphasis'));
        const recentItem = document.querySelector('.dashboard-recent-item');
        const tableScroll = rect(document.querySelector('.dashboard-table-scroll'));
        const needsDateItems = [...document.querySelectorAll('.dashboard-needs-date-item')];
        const clippedControls = needsDateItems.flatMap((item) => {
          const itemBox = rect(item);
          return [...item.querySelectorAll('button, input, select, a')]
            .filter((control) => control.getClientRects().length)
            .filter((control) => rect(control).right > itemBox.right + 0.5)
            .map((control) => control.outerHTML.slice(0, 80));
        });
        const needsDate = rect(document.querySelector('.dashboard-needs-date'));
        const scheduled = rect(document.querySelector('.dashboard-scheduled'));
        return {
          viewport: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          thumbs,
          tile: {
            borderLeftWidth: tile.borderLeftWidth,
            borderTopWidth: tile.borderTopWidth,
            borderLeftColor: tile.borderLeftColor,
            borderTopColor: tile.borderTopColor,
            background: tile.backgroundColor,
          },
          recentBackground: getComputedStyle(recentItem).backgroundColor,
          recentPanelBackground: getComputedStyle(recentItem.closest('.dashboard-panel')).backgroundColor,
          tableScrollRight: tableScroll.right,
          clippedControls,
          needsDateFirst: needsDate.top < scheduled.top,
          needsDateRightOfScheduled: needsDate.left > scheduled.left,
        };
      }, THUMB_SIZES);

      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewport);
      expect(metrics.tableScrollRight).toBeLessThanOrEqual(metrics.viewport);
      expect(metrics.clippedControls).toEqual([]);

      expect(metrics.tile.borderLeftWidth).toBe(metrics.tile.borderTopWidth);
      expect(metrics.tile.borderLeftColor).toBe(metrics.tile.borderTopColor);
      expect(metrics.tile.borderTopColor).toBe('rgba(167, 139, 250, 0.45)');
      expect(metrics.tile.background).toBe('rgba(167, 139, 250, 0.08)');

      expect(metrics.recentBackground).toBe('rgb(29, 34, 43)');
      expect(metrics.recentBackground).not.toBe(metrics.recentPanelBackground);

      for (const [region, { size }] of Object.entries(THUMB_SIZES)) {
        const thumbs = metrics.thumbs[region];
        expect(thumbs.length, region).toBeGreaterThan(0);
        for (const thumb of thumbs) {
          if (region === 'scheduled' && width <= SCHEDULED_THUMB_HIDDEN_MAX_WIDTH) {
            expect(thumb.display, region).toBe('none');
            continue;
          }
          expect(thumb.width, region).toBeCloseTo(size, 1);
          expect(thumb.height, region).toBeCloseTo(size, 1);
          expect(thumb.initialsOffsetX, region).toBeLessThanOrEqual(1);
          expect(thumb.initialsOffsetY, region).toBeLessThanOrEqual(1);
        }
      }

      if (width >= 1024) expect(metrics.needsDateRightOfScheduled).toBe(true);
      else expect(metrics.needsDateFirst).toBe(true);

      const tile = page.locator('.dashboard-tile--emphasis');
      await tile.focus();
      await expect(tile).toHaveCSS('outline-style', 'solid');
      await expect(tile).toHaveCSS('outline-width', '2px');
    });
  });
}
