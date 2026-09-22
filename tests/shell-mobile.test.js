/**
 * Mobile application-shell integration tests.
 *
 * Destination inventories and route matching belong to navigation-model tests.
 * Shared keyboard, skip-link, and reduced-motion behavior belongs to
 * shell-keyboard tests. Browser shell tests own native disclosure interaction
 * and navigation continuity. This suite keeps the rendered mobile-shell wiring,
 * breakpoint switch, accessibility, touch, and mobile drawer layout contracts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function navLinks(html, className) {
  return [...html.matchAll(
    new RegExp(`<a href="([^"]+)" class="${className}" data-nav-key="([^"]+)"`, 'g'),
  )].map((match) => ({ href: match[1], key: match[2] }));
}

function cssBlock(source, preludePattern) {
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const prelude = uncommented.match(preludePattern);
  if (!prelude) return null;

  const openBrace = uncommented.indexOf('{', prelude.index + prelude[0].length);
  if (openBrace === -1) return null;

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openBrace; index < uncommented.length; index += 1) {
    const character = uncommented[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return uncommented.slice(openBrace + 1, index);
    }
  }

  return null;
}

describe('mobile application shell', () => {
  let agent;
  let db;
  let tmpDir;
  let homeHtml;
  let css;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-shell-mobile-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { authConfig: AUTH_CONFIG },
    );
    ({ agent } = await authenticate(app));

    homeHtml = (await agent.get('/').expect(200)).text;
    expect(homeHtml).toContain('<link rel="stylesheet" href="/creatorcrate.css">');
    const stylesheet = await agent.get('/creatorcrate.css').expect(200);
    expect(stylesheet.headers['content-type']).toMatch(/text\/css/);
    css = stylesheet.text;
  });

  afterAll(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders a native, labelled mobile disclosure with a Primary navigation landmark', () => {
    const disclosure = homeHtml.match(/<details class="mobile-nav">[\s\S]*?<\/details>/)?.[0];
    const summary = disclosure?.match(/<summary class="mobile-nav-summary">([\s\S]*?)<\/summary>/)?.[1];

    expect(disclosure).toBeTruthy();
    expect(summary).toContain('<span class="mobile-nav-section">Dashboard</span>');
    expect(summary).toContain('<span class="mobile-nav-toggle">Menu</span>');
    expect(disclosure).toContain('<nav class="mobile-nav-primary" aria-label="Primary">');
    expect(disclosure).not.toMatch(/role="menu"|role="menuitem"|\son\w+=/);
  });

  it('renders mobile and desktop top-level links from the same navigation model', () => {
    const mobileLinks = navLinks(homeHtml, 'mobile-nav-link');
    const desktopLinks = navLinks(homeHtml, 'app-nav-link');

    expect(mobileLinks.length).toBeGreaterThan(0);
    expect(mobileLinks).toEqual(desktopLinks);
    expect(mobileLinks).toEqual(expect.arrayContaining([
      { href: '/projects', key: 'projects' },
      { href: '/settings', key: 'settings' },
    ]));
  });

  it('renders the Settings hierarchy with one current mobile child', async () => {
    const page = await agent.get('/settings/logs').expect(200);
    const children = page.text.match(/<ul class="mobile-nav-children">([\s\S]*?)<\/ul>/)?.[1];

    expect(children).toBeTruthy();
    expect(page.text).toMatch(
      /<li class="mobile-nav-item mobile-nav-item--active mobile-nav-item--has-children">/,
    );
    expect(children.match(/aria-current="page"/g) || []).toHaveLength(1);
    expect(children).toMatch(
      /<a\b(?=[^>]*\bclass="mobile-nav-child-link")(?=[^>]*\bdata-nav-key="settings-logs")(?=[^>]*\baria-current="page")[^>]*>/,
    );
    expect(children).not.toMatch(/role="menu"|role="menuitem"|aria-expanded|\son\w+=/);
  });

  it('switches from the desktop shell to the mobile shell at 1023px', () => {
    const mobileBreakpoint = cssBlock(
      css,
      /@media\s*\(max-width:\s*1023px\)\s*(?=\{)/,
    );

    expect(css).toMatch(/\.mobile-nav\s*\{\s*display:\s*none/);
    expect(mobileBreakpoint).not.toBeNull();
    expect(cssBlock(mobileBreakpoint, /\.app-sidebar\s*(?=\{)/))
      .toMatch(/display:\s*none\s*!important/);
    expect(cssBlock(mobileBreakpoint, /\.app-main\s*(?=\{)/))
      .toMatch(/margin-left:\s*0/);
    expect(cssBlock(mobileBreakpoint, /\.app-header\s*(?=\{)/))
      .toMatch(/display:\s*none/);
    expect(cssBlock(mobileBreakpoint, /\.mobile-nav\s*(?=\{)/))
      .toMatch(/display:\s*block/);
  });

  it('marks the rendered mobile destination current and distinguishes it structurally', async () => {
    const page = await agent.get('/projects').expect(200);
    const activeRule = css.match(
      /\.mobile-nav-link\[aria-current="page"\]::before,\s*\.mobile-nav-item--active\s*>\s*\.mobile-nav-link::before\s*\{[^}]*\}/,
    );

    expect(page.text).toContain(
      '<a href="/projects" class="mobile-nav-link" data-nav-key="projects" aria-current="page">',
    );
    expect(activeRule).not.toBeNull();
    expect(activeRule[0]).toMatch(/content:\s*""/);
    expect(activeRule[0]).toMatch(/width:\s*[1-9][0-9]*px/);
  });

  it('keeps top-level and nested mobile links touch-sized', () => {
    const navItemHeight = Number(css.match(/--shell-nav-item-height:\s*(\d+)px/)?.[1]);
    const linkRule = css.match(/\.mobile-nav-link\s*\{[^}]*\}/)?.[0];
    const childRule = css.match(/\.mobile-nav-child-link\s*\{[^}]*\}/)?.[0];

    expect(navItemHeight).toBeGreaterThanOrEqual(44);
    expect(linkRule).toMatch(/min-height:\s*var\(--shell-nav-item-height\)/);
    expect(childRule).toMatch(/min-height:\s*var\(--shell-nav-item-height\)/);
  });

  it('keeps the open drawer viewport-bounded above page content', () => {
    const navRule = cssBlock(css, /\.mobile-nav\s*(?=\{)/);
    const summaryRule = cssBlock(css, /\.mobile-nav-summary\s*(?=\{)/);
    const panelRule = cssBlock(css, /\.mobile-nav-primary\s*(?=\{)/);
    const backdropRule = cssBlock(css, /\.mobile-nav\[open\]::after\s*(?=\{)/);
    const sidebarLayer = Number(css.match(/--shell-z-sidebar:\s*(\d+)/)?.[1]);
    const contentLayer = Number(css.match(/--shell-z-content:\s*(\d+)/)?.[1]);
    const summaryLayer = Number(summaryRule?.match(/z-index:\s*(\d+)/)?.[1]);
    const panelLayer = Number(panelRule?.match(/z-index:\s*(\d+)/)?.[1]);
    const backdropLayer = Number(backdropRule?.match(/z-index:\s*(\d+)/)?.[1]);

    expect(navRule).toMatch(/position:\s*relative/);
    expect(navRule).toMatch(/z-index:\s*var\(--shell-z-sidebar\)/);
    expect(panelRule).toMatch(/position:\s*absolute/);
    expect(panelRule).toMatch(/top:\s*100%/);
    expect(panelRule).toMatch(/left:\s*0/);
    expect(panelRule).toMatch(/right:\s*0/);
    expect(panelRule).toMatch(/max-height:\s*calc\(100vh - var\(--shell-header-height\)\)/);
    expect(panelRule).toMatch(/overflow-y:\s*auto/);
    expect(backdropRule).toMatch(/position:\s*fixed/);
    expect(backdropRule).toMatch(/inset:\s*var\(--shell-header-height\)\s+0\s+0/);
    expect(backdropRule).toMatch(/pointer-events:\s*auto/);
    expect(summaryLayer).toBeGreaterThan(panelLayer);
    expect(panelLayer).toBeGreaterThan(backdropLayer);
    expect(sidebarLayer).toBeGreaterThan(contentLayer);
  });

  it('swaps the closed page title for the app name while the disclosure is open', async () => {
    const page = await agent.get('/projects').expect(200);
    const summary = page.text.match(
      /<summary class="mobile-nav-summary">([\s\S]*?)<\/summary>/,
    )?.[1];
    const brandRule = cssBlock(css, /\.mobile-nav-brand\s*(?=\{)/);
    const sectionRule = cssBlock(css, /\.mobile-nav-section\s*(?=\{)/);
    const openBrandRule = cssBlock(
      css,
      /\.mobile-nav\[open\]\s+\.mobile-nav-brand\s*(?=\{)/,
    );
    const openSectionRule = cssBlock(
      css,
      /\.mobile-nav\[open\]\s+\.mobile-nav-section\s*(?=\{)/,
    );

    expect(summary).toContain('<span class="mobile-nav-brand">CreatorCrate</span>');
    expect(summary).toContain('<span class="mobile-nav-section">Projects</span>');
    expect(brandRule).toMatch(/display:\s*none/);
    expect(sectionRule).toMatch(/min-width:\s*0/);
    expect(sectionRule).toMatch(/text-overflow:\s*ellipsis/);
    expect(openBrandRule).toMatch(/display:\s*block/);
    expect(openBrandRule).toMatch(/flex:\s*1 1 auto/);
    expect(openSectionRule).toMatch(/display:\s*none/);
  });
});
