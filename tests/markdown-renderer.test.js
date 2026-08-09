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

  it('does not mutate the Markdown source', () => {
    const source = '# Heading\n\n**canonical source**';
    const before = source;

    renderer.renderMarkdown(source);

    expect(source).toBe(before);
  });
});
