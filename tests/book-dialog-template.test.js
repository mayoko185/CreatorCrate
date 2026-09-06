import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';
import { expectBookCoverForm } from './helpers/book-cover-form.js';

const env = nunjucks.configure(fileURLToPath(new URL('../src/views', import.meta.url)), {
  autoescape: true, noCache: true,
});

describe('Book dialog cover layout', () => {
  it.each([
    { kind: 'project_asset', id: 42, url: '/projects/1/assets/42/preview' },
    { kind: 'managed_asset', id: 'managed-cover', url: '/managed-media/book-covers/managed-cover/preview' },
  ])('keeps the existing $kind cover renderer once inside Book actions', (source) => {
    const book = { id: 7, title: 'Book', primaryImage: {
      state: 'available', previewUrl: source.url, alt: 'Current cover', selectedSource: source,
    } };
    const html = env.renderString(`
      {% import "partials/book-primary-image.njk" as bookPrimaryImage %}
      <form id="book-form" method="post" enctype="multipart/form-data">
        <input type="hidden" name="_csrf" value="csrf-token">
        {% include "notes/books/form-fields.njk" %}
      </form>`, { bookEditForm: { book }, bookCoverSource: source, values: { title: 'Book' }, errors: {} });
    expectBookCoverForm(html, source);
    const actions = html.match(/<section[^>]*aria-labelledby="book-actions-heading"[\s\S]*?<\/section>/)?.[0];
    expect(actions).toContain(book.primaryImage.previewUrl);
    expect(actions).toContain(env.renderString(`{% import "partials/book-primary-image.njk" as cover %}{{ cover.render(book, 'preview') }}`, { book }).trim());
    expect(html.match(/<img\b/g)).toHaveLength(1);
    expect(html.match(/>Book actions<\/h3>/g)).toHaveLength(1);
    expectDisclosure(html, true, 1);
  });

  it.each([false, true])('keeps the upload in a collapsed disclosure without a cover (edit=%s)', (edit) => {
    const html = env.renderString(`
      {% import "partials/book-primary-image.njk" as bookPrimaryImage %}
      <form id="book-form" method="post" enctype="multipart/form-data">
        <input type="hidden" name="_csrf" value="csrf-token">
        {% include "notes/books/form-fields.njk" %}
      </form>`, {
      bookEditForm: edit ? { book: { id: 7, primaryImage: { state: 'none' } } } : null,
      values: {}, errors: {},
    });
    expectBookCoverForm(html);
    expectDisclosure(html, edit, 0);
    expect(html).not.toContain('notes-book-cover--fallback');
  });
});

function expectDisclosure(html, edit, images) {
  const actions = html.match(/<section[^>]*aria-labelledby="book-actions-heading"[\s\S]*?<\/section>/)[0];
  const disclosures = [...actions.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)].map(([markup]) => markup);
  expect(disclosures).toHaveLength(edit ? 2 : 1);
  const cover = disclosures[0];
  expect(cover).toMatch(/^<details class="notes-workspace-disclosure">\s*<summary>Book cover<\/summary>\s*<div class="notes-workspace-disclosure-content">/);
  expect(cover).toContain('type="file" id="book-cover" name="cover"');
  expect(cover).toContain('id="book-cover-help"');
  expect(cover.match(/<img\b/g) || []).toHaveLength(images);
  expect(cover).not.toMatch(/<h[1-6]\b/);
  expect(html.match(/>Book actions<\/h3>/g)).toHaveLength(1);
  expect(html.match(/<summary>Book cover<\/summary>/g)).toHaveLength(1);
  expect(html).not.toContain('Secondary actions');
  if (edit) {
    expect(disclosures[1]).toBe(`<details class="notes-workspace-disclosure notes-workspace-disclosure--delete">
        <summary>Delete Book</summary>
        <div class="notes-workspace-disclosure-content">
          <p class="notes-workspace-warning">The Book must be empty before it can be deleted. This cannot be undone.</p>
          <button class="button button-small button-danger" type="submit" form="book-delete-form" data-confirm="Delete this Book permanently? This cannot be undone.">Delete Book</button>
        </div>
      </details>`.replace(/\n/g, html.includes('\r\n') ? '\r\n' : '\n'));
  }
}
