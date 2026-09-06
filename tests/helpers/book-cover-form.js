import { expect } from 'vitest';

export function expectBookCoverForm(html, source = null) {
  const form = html.match(/<form\b[^>]*id="book-form"[\s\S]*?<\/form>/)?.[0];
  expect(form).toBeDefined();
  expect(form).toContain('enctype="multipart/form-data"');
  expect(form).toContain('name="expectedCoverKind" value="' + (source?.kind ?? 'none') + '"');
  expect(form).toContain('name="expectedCoverId" value="' + (source?.id ?? '') + '"');
  expect(form).toContain('name="coverReplacementConfirmed" value="false"');
  expect(form).toMatch(/name="_csrf" value="[^"]+"/);
  expect(form).toContain('name="title"');
  const input = form.match(/<input\b[^>]*type="file"[^>]*>/)?.[0];
  expect(input).toContain('name="cover"');
  expect(input).toContain('accept="image/png,image/jpeg,image/webp"');
  expect(input).toContain('id="book-cover"');
  expect(input).toContain('aria-describedby="book-cover-help"');
  expect(input).not.toMatch(/\bvalue=/);
  expect(form).toContain('<label for="book-cover">Book cover image</label>');
  expect(form).toContain('id="book-cover-help"');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  let depth = 0;
  for (const [tag] of html.matchAll(/<\/?form\b[^>]*>/g)) {
    depth += tag.startsWith('</') ? -1 : 1;
    expect(depth).toBeGreaterThanOrEqual(0);
    expect(depth).toBeLessThanOrEqual(1);
  }
  expect(depth).toBe(0);
}
