import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });
const CONFIRMATION_TEMPLATES = [
  'projects/assets.njk',
  'projects/detail.njk',
  'projects/form.njk',
  'notes/books/form.njk',
  'notes/chapters/form.njk',
  'notes/form.njk',
  'partials/asset-edit-dialog.njk',
  'partials/project-asset-category-management.njk',
  'releases/detail.njk',
  'releases/form.njk',
  'settings/asset-categories.njk',
];

function renderLayout() {
  return env.renderString(
    `{% extends "layout.njk" %}{% block content %}<p>Page content</p>{% endblock %}`,
    {
      appName: 'CreatorCrate',
      assetMode: 'test',
      auth: { enabled: false, authenticated: false },
      shell: { appName: 'CreatorCrate', activeSection: 'Projects', navigation: [] },
    },
  );
}

describe('shared confirmation dialog template', () => {
  it('renders one standalone app dialog with the confirmation hooks and no form', () => {
    const html = renderLayout();
    const appDialogs = html.match(/<dialog\b[^>]*\bdata-app-dialog\b[^>]*>/g) || [];

    expect(appDialogs).toHaveLength(1);
    expect(appDialogs[0]).toContain('id="app-confirmation-dialog"');
    expect(html).not.toMatch(/<dialog\b[^>]*\bdata-app-dialog\b[^>]*>[\s\S]*<dialog\b[^>]*id="app-confirmation-dialog"/);
    expect(html).toContain('<h2 id="app-confirmation-dialog-title">Confirm action</h2>');
    expect(html).toContain('data-app-dialog-confirmation-message');
    expect(html).toContain('data-app-dialog-confirmation-cancel');
    expect(html).toContain('data-app-dialog-confirmation-confirm');
    expect(html).not.toContain('data-dialog-form');
  });

  it('keeps all fourteen production data-confirm controls on the shared dialog contract', () => {
    const source = CONFIRMATION_TEMPLATES
      .map((template) => fs.readFileSync(`${VIEWS_DIR}/${template}`, 'utf8'))
      .join('\n');

    expect(source.match(/\bdata-confirm=/g) || []).toHaveLength(14);
    expect(source).not.toMatch(/\bdata-confirm-dialog(?:\s|=|>)/);
  });
});
