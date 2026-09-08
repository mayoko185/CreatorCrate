import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

test('Book, Chapter, and Page detail contents preserve hierarchy while Pages use a text-only current state', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-navigation-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;

  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { appDataRoot, authState: { csrfPepper } },
    );
    const longChapterTitle = 'Chapter with an intentionally long title that must wrap without widening the Book contents sidebar';
    const longPageTitle = 'Nested Page with an intentionally long title that must wrap safely at narrow widths without horizontal overflow';
    const book = app.locals.bookService.createBook({ title: 'Navigation hierarchy Book' });
    const firstChapter = app.locals.chapterService.createChapter({ bookId: book.id, title: longChapterTitle });
    const currentNestedPage = app.locals.noteService.createNote({ chapterId: firstChapter.id, title: longPageTitle });
    app.locals.noteService.createNote({ chapterId: firstChapter.id, title: 'Nested Page Two' });
    const currentTopLevelPage = app.locals.noteService.createNote({ bookId: book.id, title: 'Top-level Page One' });
    app.locals.noteService.createNote({ bookId: book.id, title: 'Top-level Page Two' });
    app.locals.chapterService.createChapter({ bookId: book.id, title: 'Second Chapter' });
    app.locals.chapterService.createChapter({ bookId: book.id, title: 'Third Chapter' });
    app.locals.pageDefaultsService.saveDefault('bookDetail', 'navigation', 'expanded');

    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const routes = [
      { name: 'book', url: `${baseUrl}/notes/books/${book.id}`, currentPageKind: null, currentChapter: false, openChapters: 3 },
      { name: 'chapter', url: `${baseUrl}/notes/chapters/${firstChapter.id}`, currentPageKind: null, currentChapter: true, openChapters: 1 },
      { name: 'nested-page', url: `${baseUrl}/notes/${currentNestedPage.id}`, currentPageKind: 'nested', currentChapter: false, openChapters: 1 },
      { name: 'top-level-page', url: `${baseUrl}/notes/${currentTopLevelPage.id}`, currentPageKind: 'top-level', currentChapter: false, openChapters: 0 },
    ];

    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      for (const route of routes) {
        await page.setViewportSize(viewport);
        await page.goto(route.url);

        const sidebar = page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded)');
        const nav = sidebar.locator('.notes-book-nav');
        const chapters = nav.locator('.notes-book-nav-list > .notes-book-nav-chapter');
        const firstDetails = chapters.first().locator('.notes-book-nav-disclosure');
        const firstSummary = firstDetails.locator(':scope > .notes-book-nav-summary');
        const nestedGroup = firstDetails.locator(':scope > .notes-book-nav-pages');
        const nestedPages = nestedGroup.locator(':scope > .notes-book-nav-page--child');
        const topLevelPages = nav.locator('.notes-book-nav-list > .notes-book-nav-page');
        const topLevelPage = topLevelPages.first();

        await expect(sidebar).toHaveCount(1);
        await expect(sidebar.locator('.notes-book-cover')).toBeVisible();
        await expect(page.locator('.book-outline')).toHaveCount(0);
        await expect(nav.locator('.notes-book-nav-disclosure > p.notes-book-nav-page--child')).toHaveCount(0);
        await expect(chapters).toHaveCount(3);
        await expect(topLevelPages).toHaveCount(2);
        await expect(nestedPages).toHaveCount(2);
        await expect(nestedPages.locator('a')).toHaveText([longPageTitle, 'Nested Page Two']);
        expect(await nav.locator('.notes-book-nav-list > li').evaluateAll(items => items.map(item =>
          item.querySelector('.notes-book-nav-chapter-title, .notes-book-nav-page-link').textContent.trim())))
          .toEqual([longChapterTitle, 'Top-level Page One', 'Top-level Page Two', 'Second Chapter', 'Third Chapter']);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await expect(nav.locator('.notes-book-nav-disclosure[open]')).toHaveCount(route.openChapters);
        if (route.name === 'book') {
          await expect(nav.locator('.notes-book-nav-book-link')).toHaveCount(0);
          await expect(chapters.nth(1).locator('.notes-book-nav-disclosure')).toHaveAttribute('open');
          await expect(chapters.nth(2).locator('.notes-book-nav-disclosure')).toHaveAttribute('open');
          await expect(page.locator('.notes-page-detail-content > .notes-page-previews')).toBeVisible();
          await expect(page.locator('.asset-viewer-display-controls')).toBeVisible();
          await expect(page.getByRole('link', { name: 'Edit book', exact: true })).toBeVisible();
          await expect(page.getByRole('link', { name: 'Change order', exact: true })).toBeVisible();
          await expect(page.getByRole('link', { name: 'Book defaults', exact: true })).toBeVisible();
        } else {
          await expect(nav.locator('.notes-book-nav-book-link')).toHaveAttribute('href', `/notes/books/${book.id}`);
          await expect(chapters.nth(1).locator('.notes-book-nav-disclosure')).not.toHaveAttribute('open');
          await expect(chapters.nth(2).locator('.notes-book-nav-disclosure')).not.toHaveAttribute('open');
          await expect(page.locator('.notes-page-previews')).toHaveCount(0);
        }

        if (route.currentChapter) {
          const currentChapterSummary = nav.locator(
            '.notes-book-nav-chapter.notes-book-nav-item--current > .notes-book-nav-disclosure > .notes-book-nav-summary',
          );
          await page.mouse.move(viewport.width - 1, 1);
          const currentChapterStyle = await currentChapterSummary.evaluate(node => {
            const style = getComputedStyle(node);
            return { background: style.backgroundColor, shadow: style.boxShadow };
          });
          expect(currentChapterStyle.background).toBe('rgba(34, 211, 238, 0.12)');
          expect(currentChapterStyle.shadow).toContain('rgba(34, 211, 238, 0.35)');
          await currentChapterSummary.hover();
          await expect.poll(() => currentChapterSummary.evaluate(node => getComputedStyle(node).backgroundColor))
            .toBe('rgba(34, 211, 238, 0.17)');
          await page.mouse.move(viewport.width - 1, 1);
        }

        if (!(await firstDetails.evaluate(node => node.open))) {
          await firstSummary.click();
          await expect(firstDetails).toHaveAttribute('open');
        }

        const metrics = await nav.evaluate(node => {
        const style = selector => getComputedStyle(node.querySelector(selector));
        const rect = selector => node.querySelector(selector).getBoundingClientRect();
        const headingStyle = style('.notes-book-nav-heading');
        const summaryStyle = style('.notes-book-nav-summary');
        const titleStyle = style('.notes-book-nav-chapter-title');
        const groupStyle = style('.notes-book-nav-pages');
        const childStyle = style('.notes-book-nav-pages > .notes-book-nav-page--child');
        const nestedLinkStyle = style('.notes-book-nav-pages > .notes-book-nav-page--child:not(.notes-book-nav-item--current) > .notes-book-nav-page-link');
        const topLevelLinkStyle = style('.notes-book-nav-list > .notes-book-nav-page > .notes-book-nav-page-link');
        const topLevelGuideStyle = getComputedStyle(
          node.querySelector('.notes-book-nav-list > .notes-book-nav-page > .notes-book-nav-page-link'),
          '::before',
        );
        const firstDetails = rect('.notes-book-nav-chapter .notes-book-nav-disclosure');
        const chapterTitle = rect('.notes-book-nav-chapter-title');
        const topLevelLink = rect('.notes-book-nav-list > .notes-book-nav-page > .notes-book-nav-page-link');
        const longPage = rect('.notes-book-nav-pages .notes-book-nav-page-link');
        const topLevelItems = [...node.querySelector('.notes-book-nav-list').children];
        const itemMetrics = topLevelItems.map(item => {
          const itemStyle = getComputedStyle(item);
          return {
            type: item.classList.contains('notes-book-nav-chapter') ? 'chapter' : 'page',
            borderTopWidth: itemStyle.borderTopWidth,
            marginTop: itemStyle.marginTop,
            paddingTop: itemStyle.paddingTop,
          };
        });
        const firstTopLevelPageLink = topLevelItems[1].querySelector('.notes-book-nav-page-link').getBoundingClientRect();
        const secondTopLevelPageLink = topLevelItems[2].querySelector('.notes-book-nav-page-link').getBoundingClientRect();
        const secondChapterSummary = topLevelItems[3].querySelector('.notes-book-nav-summary').getBoundingClientRect();
        const thirdChapterSummary = topLevelItems[4].querySelector('.notes-book-nav-summary').getBoundingClientRect();
        const secondChapterDetails = topLevelItems[3].querySelector('.notes-book-nav-disclosure').getBoundingClientRect();
        const nestedGroupRect = node.querySelector('.notes-book-nav-pages').getBoundingClientRect();

        return {
          navOverflows: node.scrollWidth > node.clientWidth,
          navDescendantOverflows: [...node.querySelectorAll('*')].some(element => {
            const bounds = element.getBoundingClientRect();
            const navBounds = node.getBoundingClientRect();
            return bounds.left < navBounds.left - 1 || bounds.right > navBounds.right + 1;
          }),
          heading: {
            paddingBottom: headingStyle.paddingBottom,
            marginBottom: headingStyle.marginBottom,
            borderBottomWidth: headingStyle.borderBottomWidth,
          },
          summary: {
            height: rect('.notes-book-nav-summary').height,
            paddingTop: summaryStyle.paddingTop,
            paddingLeft: summaryStyle.paddingLeft,
          },
          title: { fontSize: titleStyle.fontSize, fontWeight: Number(titleStyle.fontWeight) },
          nested: {
            gap: groupStyle.rowGap,
            guideWidth: groupStyle.borderLeftWidth,
            childBorderWidth: childStyle.borderLeftWidth,
            childBorderTopWidth: childStyle.borderTopWidth,
            fontWeight: Number(nestedLinkStyle.fontWeight),
          },
          topLevelGuide: {
            content: topLevelGuideStyle.content,
            width: topLevelGuideStyle.width,
            borderRadius: topLevelGuideStyle.borderRadius,
            coordinateDelta: Math.abs(
              topLevelLink.left + parseFloat(topLevelGuideStyle.left) - nestedGroupRect.left
            ),
          },
          itemMetrics,
          topLevelAlignmentDelta: Math.abs(
            topLevelLink.left + parseFloat(topLevelLinkStyle.paddingLeft) - chapterTitle.left
          ),
          chapterToPageSeparation: firstTopLevelPageLink.top - firstDetails.bottom,
          pageToPageSeparation: secondTopLevelPageLink.top - firstTopLevelPageLink.bottom,
          pageToChapterSeparation: secondChapterSummary.top - secondTopLevelPageLink.bottom,
          chapterToChapterSeparation: thirdChapterSummary.top - secondChapterDetails.bottom,
          chapterWraps: chapterTitle.height > parseFloat(titleStyle.lineHeight),
          pageWraps: longPage.height > parseFloat(nestedLinkStyle.lineHeight)
            + parseFloat(nestedLinkStyle.paddingTop) + parseFloat(nestedLinkStyle.paddingBottom),
        };
      });

        expect(metrics.navOverflows).toBe(false);
        expect(metrics.navDescendantOverflows).toBe(false);
        expect(metrics.heading).toEqual({ paddingBottom: '8px', marginBottom: '12px', borderBottomWidth: '1px' });
        expect(metrics.summary.height).toBeGreaterThanOrEqual(40);
        expect(metrics.summary.paddingTop).toBe('8px');
        expect(metrics.summary.paddingLeft).toBe('12px');
        expect(metrics.title.fontSize).toBe('14px');
        expect(metrics.title.fontWeight).toBeGreaterThanOrEqual(700);
        expect(metrics.nested).toEqual(expect.objectContaining({
          gap: '4px',
          guideWidth: '1px',
          childBorderWidth: '0px',
          childBorderTopWidth: '0px',
        }));
        expect(metrics.nested.fontWeight).toBeLessThan(metrics.title.fontWeight);
        expect(metrics.topLevelGuide).toEqual(expect.objectContaining({
          content: '\"\"',
          width: '1px',
          borderRadius: '0px',
        }));
        expect(metrics.topLevelGuide.coordinateDelta).toBeLessThanOrEqual(1);
        expect(metrics.itemMetrics).toEqual([
          { type: 'chapter', borderTopWidth: '0px', marginTop: '0px', paddingTop: '0px' },
          { type: 'page', borderTopWidth: '1px', marginTop: '12px', paddingTop: '12px' },
          { type: 'page', borderTopWidth: '0px', marginTop: '0px', paddingTop: '0px' },
          { type: 'chapter', borderTopWidth: '1px', marginTop: '12px', paddingTop: '12px' },
          { type: 'chapter', borderTopWidth: '1px', marginTop: '12px', paddingTop: '12px' },
        ]);
        expect(metrics.topLevelAlignmentDelta).toBeLessThanOrEqual(1);
        expect(metrics.chapterToPageSeparation).toBeGreaterThanOrEqual(24);
        expect(metrics.pageToPageSeparation).toBe(0);
        expect(metrics.pageToChapterSeparation).toBeGreaterThanOrEqual(24);
        expect(metrics.chapterToChapterSeparation).toBeGreaterThanOrEqual(24);
        expect(metrics.chapterWraps).toBe(true);
        expect(metrics.pageWraps).toBe(true);

        const pageBackground = await topLevelPage.evaluate(node => getComputedStyle(node.firstElementChild).backgroundColor);
        await topLevelPage.hover();
        await expect.poll(() => topLevelPage.evaluate(node => getComputedStyle(node.firstElementChild).backgroundColor))
          .not.toBe(pageBackground);

        await firstSummary.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(firstSummary).toBeFocused();
        expect(await firstSummary.evaluate(node => {
          const style = getComputedStyle(node);
          return [style.outlineWidth, style.outlineOffset];
        })).toEqual(['2px', '2px']);
        await page.keyboard.press('Enter');
        await expect(firstDetails).not.toHaveAttribute('open');
        await firstSummary.click();
        await expect(firstDetails).toHaveAttribute('open');

        if (route.currentPageKind) {
          const currentPageLink = nav.locator(
            '.notes-book-nav-page.notes-book-nav-item--current > .notes-book-nav-page-link[aria-current="page"]',
          );
          await expect(currentPageLink).toHaveAttribute('aria-current', 'page');
          if (route.currentPageKind === 'nested') {
            await expect(currentPageLink.locator('xpath=..')).toHaveClass(/notes-book-nav-page--child/);
          } else {
            await expect(currentPageLink.locator('xpath=..')).not.toHaveClass(/notes-book-nav-page--child/);
          }
          await page.mouse.move(viewport.width - 1, 1);
          const current = await currentPageLink.evaluate(node => {
            const style = getComputedStyle(node);
            const itemStyle = getComputedStyle(node.parentElement);
            const isNested = node.parentElement.classList.contains('notes-book-nav-page--child');
            const guideStyle = isNested
              ? getComputedStyle(node.closest('.notes-book-nav-pages'))
              : getComputedStyle(node, '::before');
            return {
              color: style.color,
              fontWeight: Number(style.fontWeight),
              background: style.backgroundColor,
              shadow: style.boxShadow,
              borderLeft: style.borderLeftWidth,
              borderRight: style.borderRightWidth,
              itemBackground: itemStyle.backgroundColor,
              itemShadow: itemStyle.boxShadow,
              guideWidth: isNested ? guideStyle.borderLeftWidth : guideStyle.width,
              guideContent: isNested ? null : guideStyle.content,
            };
          });
          expect(current.color).toBe('rgb(34, 211, 238)');
          expect(current.fontWeight).toBe(700);
          expect(current.background).toBe('rgba(0, 0, 0, 0)');
          expect(current.shadow).toBe('none');
          expect(current.borderLeft).toBe('0px');
          expect(current.borderRight).toBe('0px');
          expect(current.itemBackground).toBe('rgba(0, 0, 0, 0)');
          expect(current.itemShadow).toBe('none');
          expect(current.guideWidth).toBe('1px');
          if (route.currentPageKind === 'top-level') {
            expect(current.guideContent).toBe('""');
          }
          await currentPageLink.hover();
          await expect.poll(() => currentPageLink.evaluate(node => getComputedStyle(node).backgroundColor))
            .not.toBe('rgba(0, 0, 0, 0)');
          await page.mouse.move(viewport.width - 1, 1);
          await expect.poll(() => currentPageLink.evaluate(node => getComputedStyle(node).backgroundColor))
            .toBe('rgba(0, 0, 0, 0)');
          await currentPageLink.focus();
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Tab');
          await expect(currentPageLink).toBeFocused();
          const focusedCurrent = await currentPageLink.evaluate(node => {
            const style = getComputedStyle(node);
            return [style.outlineWidth, style.outlineOffset, style.backgroundColor, style.textDecorationLine];
          });
          expect(focusedCurrent.slice(0, 2)).toEqual(['2px', '2px']);
          expect(focusedCurrent[2]).not.toBe('rgba(0, 0, 0, 0)');
          expect(focusedCurrent[3]).toBe('underline');
          await currentPageLink.evaluate(node => node.blur());
        }

        if (process.env.CREATORCRATE_BOOK_NAV_SCREENSHOT_DIR) {
          fs.mkdirSync(process.env.CREATORCRATE_BOOK_NAV_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({
            path: path.join(
              process.env.CREATORCRATE_BOOK_NAV_SCREENSHOT_DIR,
              `${route.name}-${viewport.width}px.png`,
            ),
            fullPage: true,
          });
        }
      }
    }

    app.locals.pageDefaultsService.saveDefault('bookDetail', 'navigation', 'collapsed');
    await page.goto(`${baseUrl}/notes/books/${book.id}`);
    await expect(page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav-disclosure[open]')).toHaveCount(0);
    await page.goto(`${baseUrl}/notes/chapters/${firstChapter.id}`);
    await expect(page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav-disclosure[open]')).toHaveCount(1);
    await page.goto(`${baseUrl}/notes/${currentNestedPage.id}`);
    await expect(page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav-disclosure[open]')).toHaveCount(1);
    await page.goto(`${baseUrl}/notes/${currentTopLevelPage.id}`);
    await expect(page.locator('.notes-book-detail-sidebar:not(.notes-book-detail-sidebar--embedded) .notes-book-nav-disclosure[open]')).toHaveCount(0);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
