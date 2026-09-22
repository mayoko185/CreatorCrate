import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });

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
    expect(html).toContain('data-app-dialog-confirmation-field hidden');
    expect(html).toContain('data-app-dialog-confirmation-cancel');
    expect(html).toContain('data-app-dialog-confirmation-confirm');
    expect(html).not.toContain('data-dialog-form');
  });

});
