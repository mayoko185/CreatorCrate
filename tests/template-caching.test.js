import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_MODES, createApp } from '../src/app.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const resources = [];

function createTemplateApp(assetMode, source = 'Hello {{ name }}') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-template-cache-'));
  const viewsRoot = path.join(root, 'views');
  const templatePath = path.join(viewsRoot, 'greeting.njk');
  fs.mkdirSync(viewsRoot);
  fs.writeFileSync(templatePath, source);

  const db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, MIGRATIONS_DIR);
  const app = createApp(
    { appName: 'CreatorCrate', db },
    {
      assetMode,
      assetManifest: { entry: () => ({ css: [], preload: [], js: '/assets/main.js' }) },
    },
  );
  const env = app.get('nunjucksEnv');
  const [loader] = env.loaders;
  loader.searchPaths = [viewsRoot];
  resources.push({ db, root });

  return { env, loader, templatePath };
}

afterEach(() => {
  for (const { db, root } of resources.splice(0)) {
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('application Nunjucks template caching', () => {
  it('sources and compiles a production template once while preserving rendered output', () => {
    const { env, loader } = createTemplateApp(ASSET_MODES.PRODUCTION);
    const getSource = vi.spyOn(loader, 'getSource');

    expect(env.render('greeting.njk', { name: 'Ada' })).toBe('Hello Ada');
    expect(env.render('greeting.njk', { name: 'Grace' })).toBe('Hello Grace');
    expect(getSource).toHaveBeenCalledTimes(1);
    expect(loader.cache['greeting.njk']).toBeDefined();
  });

  it('reloads a changed development template on the next render', () => {
    const { env, loader, templatePath } = createTemplateApp(ASSET_MODES.DEVELOPMENT);
    const getSource = vi.spyOn(loader, 'getSource');

    expect(env.render('greeting.njk', { name: 'Ada' })).toBe('Hello Ada');
    fs.writeFileSync(templatePath, 'Welcome {{ name }}');
    expect(env.render('greeting.njk', { name: 'Ada' })).toBe('Welcome Ada');
    expect(getSource).toHaveBeenCalledTimes(2);
    expect(loader.cache['greeting.njk']).toBeUndefined();
  });

  it('keeps compiled templates isolated between new application environments', () => {
    const first = createTemplateApp(ASSET_MODES.PRODUCTION, 'First {{ name }}');
    const second = createTemplateApp(ASSET_MODES.PRODUCTION, 'Second {{ name }}');

    expect(first.env).not.toBe(second.env);
    expect(first.loader.cache).not.toBe(second.loader.cache);
    expect(first.env.render('greeting.njk', { name: 'render' })).toBe('First render');
    expect(second.env.render('greeting.njk', { name: 'render' })).toBe('Second render');
  });
});
