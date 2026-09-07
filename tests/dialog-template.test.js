import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';

const VIEWS_DIR = fileURLToPath(new URL('../src/views', import.meta.url));
const env = nunjucks.configure(VIEWS_DIR, { autoescape: true, noCache: true });

function renderDialogCard(cardAttributes) {
  const html = env.renderString(
    `{% import "partials/dialog.njk" as dialog %}
{% call dialog.render('test-dialog', 'Test dialog', false, '', '', '', cardAttributes) %}{% endcall %}`,
    { cardAttributes },
  );
  return html.match(/<div class="app-dialog-card" role="document"[^>]*>/)?.[0] || '';
}

describe('shared dialog template', () => {
  it('renders only literal true as a bare card attribute', () => {
    const card = renderDialogCard([
      ['data-number-one', 1],
      ['data-string-one', '1'],
      ['data-number-two', 2],
      ['data-enabled', true],
      ['data-label', 'normal value'],
      ['data-escaped', 'A&B"'],
    ]);

    expect(card).toContain('data-number-one="1"');
    expect(card).toContain('data-string-one="1"');
    expect(card).toContain('data-number-two="2"');
    expect(card).toMatch(/ data-enabled(?:\s|>)/);
    expect(card).not.toContain('data-enabled=');
    expect(card).toContain('data-label="normal value"');
    expect(card).toContain('data-escaped="A&amp;B&quot;"');
  });
});
