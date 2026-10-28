/**
 * WP11 — Login and generic HTML error page presentation.
 *
 * Login shows the shell's existing /logo.png in its card without exposing
 * authenticated navigation; error pages take the refined foundation and mark
 * severity by status class while keeping the status/message markup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { AUTH_CONFIG, TEST_PASSWORD, extractCsrfToken } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const STYLESHEET = fs.readFileSync(fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url)), 'utf8');

function loginCard(html) {
  return html.match(/<div class="login-card">[\s\S]*?<\/form>\s*<\/div>/)?.[0] || '';
}

describe('Login and error page presentation', () => {
  let tmpDir;
  let db;
  let app;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-login-error-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db }, { authConfig: AUTH_CONFIG });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function authenticatedAgent() {
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').expect(200);
    await agent.post('/login').type('form')
      .send({ username: 'admin', password: TEST_PASSWORD, _csrf: extractCsrfToken(loginPage.text) })
      .expect(302);
    return agent;
  }

  it('renders the existing logo above the login heading inside the card', async () => {
    const res = await request(app).get('/login').expect(200);
    const card = loginCard(res.text);

    expect(res.text).toMatch(/<body class="refined-page login-page">/);
    expect(card).toContain('<img src="/logo.png" alt="CreatorCrate" class="login-logo" width="72" height="72">');
    expect(card.indexOf('class="login-logo"')).toBeLessThan(card.indexOf('<h1>Log in</h1>'));
    expect(card.indexOf('<h1>Log in</h1>')).toBeLessThan(card.indexOf('<form method="post" action="/login"'));
    // Decorative-free: the logo is a plain image, never a link or focus stop.
    expect(card).not.toMatch(/<a[^>]*>\s*<img[^>]*login-logo/);
    expect(card).not.toMatch(/login-logo[^>]*tabindex/);
    expect(res.text).not.toContain('class="app-sidebar"');
    expect(res.text).not.toContain('action="/logout"');
  });

  it('keeps the failed-login notice and form inside the card', async () => {
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').expect(200);
    const res = await agent.post('/login').type('form')
      .send({ username: 'admin', password: 'wrong', _csrf: extractCsrfToken(loginPage.text) });
    const card = loginCard(res.text);

    expect(card).toContain('class="login-logo"');
    expect(card).toContain('<div class="notice notice--danger"><p>Invalid username or password.</p></div>');
    expect(card).toMatch(/id="password"[^>]*autocomplete="current-password"[^>]*autofocus/);
  });

  it('marks a 404 page as a client error and keeps its status markup', async () => {
    const agent = await authenticatedAgent();
    const res = await agent.get('/not-a-route').set('Accept', 'text/html').expect(404);

    expect(res.text).toMatch(/<body class="refined-page error-page">/);
    expect(res.text).toContain('<div class="error-box" data-error-severity="client">');
    expect(res.text).toContain('<p class="error-status">404</p>');
    expect(res.text).toContain('<p class="error-message">');
  });

  it('marks a 500 page as a server error with the generic message', async () => {
    const agent = await authenticatedAgent();
    const book = app.locals.bookService.createBook({ title: 'Broken Book' });
    vi.spyOn(app.locals.bookService, 'listBookContents').mockImplementation(() => {
      throw new Error('secret internal detail');
    });
    const res = await agent.get(`/notes/books/${book.id}`).set('Accept', 'text/html').expect(500);

    expect(res.text).toContain('<div class="error-box" data-error-severity="server">');
    expect(res.text).toContain('<p class="error-status">500</p>');
    expect(res.text).toContain('<p class="error-message">Something went wrong.</p>');
    expect(res.text).not.toContain('secret internal detail');
  });

  it('scopes the login and error card rules to their pages', () => {
    expect(STYLESHEET).toMatch(/:where\(\.login-page main\) \.login-card \{[^}]*max-width: 24rem;/);
    expect(STYLESHEET).toMatch(/:where\(\.login-page main\) \.login-logo \{[^}]*height: auto;[^}]*aspect-ratio: 1;/);
    expect(STYLESHEET).toMatch(/:where\(\.error-page main\) \.error-box\[data-error-severity='server'\] \.error-status \{[^}]*color: var\(--danger\);/);
    expect(STYLESHEET).toMatch(/:where\(\.error-page main\) \.error-box \.error-message \{[^}]*overflow-wrap: anywhere;/);
  });
});
