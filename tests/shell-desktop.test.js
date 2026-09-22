/**
 * Desktop application-shell integration tests.
 *
 * Destination inventories and route matching belong to navigation-model and
 * shell-http tests. Shared icon accessibility, keyboard focus, headings, and
 * mobile behavior likewise have focused owners. This suite keeps only the
 * rendered desktop-shell wiring and desktop-specific layout behavior.
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

async function extractStyle(agent, html) {
  expect(html).toContain('<link rel="stylesheet" href="/creatorcrate.css">');
  const res = await agent.get('/creatorcrate.css').expect(200);
  expect(res.headers['content-type']).toMatch(/text\/css/);
  return res.text;
}

describe('desktop application shell', () => {
  let agent;
  let db;
  let tmpDir;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-shell-desktop-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { authConfig: AUTH_CONFIG },
    );
    ({ agent } = await authenticate(app));
  });

  afterAll(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders the semantic desktop frame with representative navigation wiring', async () => {
    const res = await agent.get('/').expect(200);

    expect(res.text).toContain('<div class="app-shell">');
    expect(res.text).toContain('<aside class="app-sidebar">');
    expect(res.text).toContain('<nav class="app-nav" aria-label="Primary">');
    expect(res.text).toContain('<div class="app-main">');
    expect(res.text).toContain('<header class="app-header">');
    expect(res.text.match(/<main[\s>]/g) || []).toHaveLength(1);
    expect(res.text).toContain('<main id="main-content" tabindex="-1">');

    const projectsLink = res.text.match(
      /<a href="\/projects" class="app-nav-link" data-nav-key="projects"[^>]*>([\s\S]*?)<\/a>/,
    );
    expect(projectsLink).not.toBeNull();
    expect(projectsLink[0]).not.toMatch(/aria-label=/);
    expect(projectsLink[1]).toContain('<svg');
    expect(projectsLink[1]).toContain('<span class="app-nav-label">Projects</span>');
  });

  it('renders the Settings hierarchy as links with one current child', async () => {
    const res = await agent.get('/settings/security').expect(200);
    const children = res.text.match(/<ul class="app-nav-children">([\s\S]*?)<\/ul>/);

    expect(children).not.toBeNull();
    expect(res.text).toMatch(
      /<li class="app-nav-item app-nav-item--active app-nav-item--has-children">/,
    );
    expect(res.text).toContain(
      '<a href="/settings" class="app-nav-link" data-nav-key="settings">',
    );
    expect(children[1].match(/aria-current="page"/g) || []).toHaveLength(1);
    expect(children[1]).toMatch(
      /<a\b(?=[^>]*\bclass="app-nav-child-link")(?=[^>]*\bdata-nav-key="settings-security")(?=[^>]*\baria-current="page")[^>]*>/,
    );
    expect(children[1]).not.toMatch(/role="menu"|role="menuitem"|aria-expanded|\son\w+=/);
  });

  it('expands the desktop rail for pointer and keyboard use while keeping labels accessible', async () => {
    const page = await agent.get('/').expect(200);
    const css = await extractStyle(agent, page.text);
    const labelRule = css.match(/\.app-nav-label\s*\{[^}]*\}/);

    expect(css).toMatch(
      /\.app-sidebar:hover,\s*\.app-sidebar:focus-within\s*\{[^}]*width:\s*var\(--shell-sidebar-expanded\)/,
    );
    expect(css).toMatch(
      /\.app-sidebar:hover \.app-nav-label,\s*\.app-sidebar:focus-within \.app-nav-label\s*\{[^}]*opacity:\s*1;[^}]*width:\s*auto/,
    );
    expect(labelRule).not.toBeNull();
    expect(labelRule[0]).toMatch(/opacity:\s*0/);
    expect(labelRule[0]).toMatch(/overflow:\s*hidden/);
    expect(labelRule[0]).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  it('reveals the Settings submenu only through desktop expansion states', async () => {
    const page = await agent.get('/settings').expect(200);
    const css = await extractStyle(agent, page.text);
    const collapsedRule = css.match(/\.app-nav-children\s*\{[^}]*\}/);

    expect(collapsedRule).not.toBeNull();
    expect(collapsedRule[0]).toMatch(/max-height:\s*0/);
    expect(collapsedRule[0]).toMatch(/overflow:\s*hidden/);
    expect(collapsedRule[0]).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    expect(css).toMatch(
      /\.app-sidebar:hover \.app-nav-item--has-children:hover \.app-nav-children,[\s\S]*?\.app-sidebar:focus-within \.app-nav-item--has-children:focus-within \.app-nav-children,[\s\S]*?max-height:\s*20rem/,
    );
  });

  it('distinguishes the active desktop destination by structure as well as color', async () => {
    const page = await agent.get('/projects').expect(200);
    const css = await extractStyle(agent, page.text);

    expect(page.text).toContain(
      '<a href="/projects" class="app-nav-link" data-nav-key="projects" aria-current="page">',
    );
    const activeRule = css.match(
      /\.app-nav-link\[aria-current="page"\],\s*\.app-nav-item--active\s*>\s*\.app-nav-link\s*\{[^}]*\}/,
    );
    expect(activeRule).not.toBeNull();
    expect(activeRule[0]).toMatch(/background:\s*var\(--surface-hover\)/);
    expect(activeRule[0]).toMatch(/font-weight:\s*600/);
  });

  it('keeps desktop expansion out of content flow', async () => {
    const page = await agent.get('/').expect(200);
    const css = await extractStyle(agent, page.text);
    const sidebarRule = css.match(/\.app-sidebar\s*\{[^}]*\}/);
    const mainRule = css.match(/\.app-main\s*\{[^}]*\}/);
    const collapsed = Number(css.match(/--shell-sidebar-collapsed:\s*(\d+)px/)?.[1]);
    const expanded = Number(css.match(/--shell-sidebar-expanded:\s*(\d+)px/)?.[1]);

    expect(sidebarRule).not.toBeNull();
    expect(sidebarRule[0]).toMatch(/position:\s*fixed/);
    expect(sidebarRule[0]).toMatch(/width:\s*var\(--shell-sidebar-collapsed\)/);
    expect(mainRule).not.toBeNull();
    expect(mainRule[0]).toMatch(/margin-left:\s*var\(--shell-sidebar-collapsed\)/);
    expect(mainRule[0]).toMatch(/min-width:\s*0/);
    expect(expanded).toBeGreaterThan(collapsed);
  });

  it('keeps the desktop navigation root above shell content', async () => {
    const page = await agent.get('/').expect(200);
    const css = await extractStyle(agent, page.text);
    const sidebarLayer = Number(css.match(/--shell-z-sidebar:\s*(\d+)/)?.[1]);
    const contentLayer = Number(css.match(/--shell-z-content:\s*(\d+)/)?.[1]);
    const headerLayer = Number(css.match(/--shell-z-header:\s*(\d+)/)?.[1]);

    expect(css).toMatch(/\.app-sidebar\s*\{[^}]*z-index:\s*var\(--shell-z-sidebar\)/);
    expect(css).toMatch(/\.app-main\s*\{[^}]*z-index:\s*var\(--shell-z-content\)/);
    expect(css).toMatch(/\.app-header\s*\{[^}]*z-index:\s*var\(--shell-z-header\)/);
    expect(sidebarLayer).toBeGreaterThan(contentLayer);
    expect(sidebarLayer).toBeGreaterThan(headerLayer);
  });
});
