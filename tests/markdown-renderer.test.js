import { describe, expect, it } from 'vitest';
import { createMarkdownRenderer } from '../src/services/markdown-renderer.js';

describe('Markdown renderer', () => {
  const renderer = createMarkdownRenderer();

  it('renders the supported Markdown formatting subset', () => {
    const html = renderer.renderMarkdown([
      '# Heading',
      '',
      '**bold** and *italic* and ~~struck~~ with `inline code`.',
      '',
      '1. ordered',
      '2. list',
      '',
      '- unordered',
      '- list',
      '',
      '> quoted',
      '',
      '[safe link](https://example.com)',
      '',
      '```js',
      'const answer = 42;',
      '```',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| note | 42 |',
    ].join('\n'));

    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<s>struck</s>');
    expect(html).toContain('<code>inline code</code>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<a href="https://example.com">safe link</a>');
    expect(html).toContain('<pre><code class="language-js">const answer = 42;\n</code></pre>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<td>42</td>');
  });

  it('does not allow raw HTML, event attributes, or images', () => {
    const html = renderer.renderMarkdown([
      '<script>alert("xss")</script>',
      '<div onclick="alert(\'xss\')">raw HTML</div>',
      '![remote image](https://example.com/image.png)',
    ].join('\n\n'));

    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/<[^>]+\bonclick\s*=/i);
    expect(html).not.toContain('<div');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.example/path',
  ])('neutralizes unsafe link destination %s', (href) => {
    const html = renderer.renderMarkdown(`[link](${href})`);

    expect(html).not.toMatch(/<a\b[^>]*\bhref\s*=\s*["'][^"']*(javascript:|data:|\/\/)/i);
  });

  it('keeps safe HTTPS links usable', () => {
    expect(renderer.renderMarkdown('[safe](https://example.com/path)'))
      .toContain('<a href="https://example.com/path">safe</a>');
  });

  it('renders a single Markdown newline as a visible line break', () => {
    expect(renderer.renderMarkdown('first\nsecond'))
      .toContain('<p>first<br />\nsecond</p>');
  });

  it('keeps a blank line as a paragraph boundary', () => {
    expect(renderer.renderMarkdown('First paragraph\n\nSecond paragraph'))
      .toContain('<p>First paragraph</p>\n<p>Second paragraph</p>');
  });

  it('keeps multiple Markdown blank lines within normal paragraph semantics', () => {
    const html = renderer.renderMarkdown('First paragraph\n\n\nSecond paragraph');

    expect((html.match(/<p>/g) || [])).toHaveLength(2);
    expect(html).toContain('<p>First paragraph</p>');
    expect(html).toContain('<p>Second paragraph</p>');
  });

  it('preserves Markdown hard breaks', () => {
    expect(renderer.renderMarkdown('first  \nsecond'))
      .toContain('<p>first<br />\nsecond</p>');
  });

  it('preserves backslash hard breaks', () => {
    expect(renderer.renderMarkdown('first\\\nsecond'))
      .toContain('<p>first<br />\nsecond</p>');
  });

  it('renders TOAST UI br syntax as hard breaks without enabling raw HTML', () => {
    const html = renderer.renderMarkdown('first<br>second');

    expect(html).toContain('<p>first<br />\nsecond</p>');
    expect(html).not.toContain('&lt;br&gt;');
  });

  it.each(['<br/>', '<br />', '<BR>'])('renders the TOAST UI br variant %s', (breakSyntax) => {
    expect(renderer.renderMarkdown(`first${breakSyntax}second`))
      .toContain('<p>first<br />\nsecond</p>');
  });

  it('renders consecutive TOAST UI br values as consecutive breaks', () => {
    expect(renderer.renderMarkdown('first<br><br><br>second'))
      .toContain('<p>first<br />\n<br />\n<br />\nsecond</p>');
  });

  it('keeps TOAST UI br syntax literal inside inline code', () => {
    expect(renderer.renderMarkdown('`<br>`'))
      .toContain('<p><code>&lt;br&gt;</code></p>');
  });

  it('keeps TOAST UI br syntax literal inside fenced code', () => {
    expect(renderer.renderMarkdown('```html\n<br>\n```'))
      .toContain('<pre><code class="language-html">&lt;br&gt;\n</code></pre>');
  });

  it('does not reinterpret fenced HTML or code examples', () => {
    const html = renderer.renderMarkdown('```html\n<strong>hello</strong>\n<br>\n```');

    expect(html).toContain('<pre><code class="language-html">&lt;strong&gt;hello&lt;/strong&gt;\n&lt;br&gt;\n</code></pre>');
    expect(html).not.toContain('<strong>hello</strong>');
  });

  it('keeps arbitrary raw HTML disabled', () => {
    expect(renderer.renderMarkdown('<strong>hello</strong>'))
      .toContain('<p>&lt;strong&gt;hello&lt;/strong&gt;</p>');
  });

  it('does not mutate the Markdown source', () => {
    const source = '# Heading\n\nbefore<br>after\n\n`<br>`';
    const before = source;

    renderer.renderMarkdown(source);

    expect(source).toBe(before);
  });
});
