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

  it('suppresses only a matching leading H1 when explicitly requested', () => {
    const source = [
      '# Page **Title**',
      '',
      'Body after the title.',
      '',
      '## Section',
      '',
      '### Subsection',
      '',
      '> # Page Title',
      '',
      '```md',
      '# Page Title',
      '```',
      '',
      'Inline `# Page Title` stays content.',
    ].join('\n');

    const html = renderer.renderMarkdown(source, { suppressLeadingH1Matching: 'Page Title' });

    expect(html).not.toContain('<h1>Page <strong>Title</strong></h1>');
    expect(html).toContain('<p>Body after the title.</p>');
    expect(html).toContain('<h2>Section</h2>');
    expect(html).toContain('<h3>Subsection</h3>');
    expect(html).toContain('<blockquote>\n<h1>Page Title</h1>\n</blockquote>');
    expect(html).toContain('<pre><code class="language-md"># Page Title\n</code></pre>');
    expect(html).toContain('<p>Inline <code># Page Title</code> stays content.</p>');
  });

  it('keeps a matching leading H1 with the default renderer behavior', () => {
    expect(renderer.renderMarkdown('# Page Title\n\nBody'))
      .toContain('<h1>Page Title</h1>');
  });

  it.each([
    ['exact text', '# Page Title', 'Page Title'],
    ['repeated spaces', '# Page   Title', 'Page Title'],
    ['tabs', '# Page\t\tTitle', 'Page Title'],
    ['title whitespace', '# Page Title', '  Page \t Title  '],
    ['inline formatting', '# [Page](https://example.com) *`Title`*', 'Page Title'],
    ['explicit break', '# Page<br>Title', 'Page Title'],
    ['Setext soft break', 'Page\nTitle\n====', 'Page Title'],
  ])('suppresses a matching leading H1 with %s without changing the remaining content', (_label, heading, title) => {
    const rest = 'Body **remains**.\n\n## Section\n\n### Subsection\n\n# Page Title\n\n> # Page Title\n\n```md\n# Page Title\n```';
    expect(renderer.renderMarkdown(`${heading}\n\n${rest}`, {
      suppressLeadingH1Matching: title,
    })).toBe(renderer.renderMarkdown(rest));
    expect(renderer.renderMarkdown(`${heading}\n\n${rest}`)).toContain('<h1>');
  });

  it.each([
    ['explicit br', '# Foo<br>Bar'],
    ['Setext soft break', 'Foo\nBar\n===='],
    ['Setext hard break', 'Foo  \nBar\n===='],
    ['Setext backslash break', 'Foo\\\nBar\n===='],
  ])('preserves the word boundary in a leading H1 with %s', (_label, heading) => {
    const source = `${heading}\n\nBody remains.`;
    const html = renderer.renderMarkdown(source, { suppressLeadingH1Matching: 'FooBar' });
    expect(html).toBe(renderer.renderMarkdown(source));
    expect(html).toContain('<h1>Foo<br />\nBar</h1>');
    expect(renderer.renderMarkdown(source, { suppressLeadingH1Matching: 'Foo Bar' }))
      .toBe(renderer.renderMarkdown('Body remains.'));
  });

  it('keeps a different leading H1 in opt-in mode', () => {
    expect(renderer.renderMarkdown('# Different title\n\nBody', {
      suppressLeadingH1Matching: 'Page Title',
    })).toContain('<h1>Different title</h1>');
  });

  it('keeps a later H1 that matches the Page title', () => {
    const html = renderer.renderMarkdown('Introduction\n\n# Page Title\n\nAfter', {
      suppressLeadingH1Matching: 'Page Title',
    });

    expect(html).toContain('<p>Introduction</p>');
    expect(html).toContain('<h1>Page Title</h1>');
    expect(html).toContain('<p>After</p>');
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

describe('Markdown preview renderer', () => {
  const renderer = createMarkdownRenderer();

  it.each([
    ['just below', 479],
    ['at', 480],
  ])('keeps a structurally complete paragraph %s the visible-text limit', (_label, length) => {
    const source = 'x'.repeat(length);

    expect(renderer.renderMarkdownPreview(source)).toEqual({
      contentHtml: `<p>${source}</p>\n`,
      truncated: false,
    });
  });

  it('truncates limit-plus-one by Unicode code point before rendering HTML', () => {
    const preview = renderer.renderMarkdownPreview(`${'😀'.repeat(480)}TAIL`);

    expect([...preview.contentHtml.match(/😀/gu) ?? []]).toHaveLength(480);
    expect(preview.contentHtml).not.toContain('TAIL');
    expect(preview.truncated).toBe(true);
  });

  it('bounds content units and leaves a huge document tail out of generated HTML', () => {
    const preview = renderer.renderMarkdownPreview([
      'first', '', 'second', '', 'third', '', `OMITTED-TAIL-${'z'.repeat(20_000)}`,
    ].join('\n'));

    expect(preview.contentHtml).toBe('<p>first</p>\n<p>second</p>\n<p>third</p>\n');
    expect(preview.contentHtml).not.toContain('OMITTED-TAIL');
    expect(preview.truncated).toBe(true);
  });

  it('shortens nested emphasis, strong, links, and inline code with balanced markup', () => {
    const preview = renderer.renderMarkdownPreview(
      `start ***nested [safe link](https://example.com) with \`${'c'.repeat(470)}\` tail*** omitted`,
    );

    expect(preview.contentHtml).toMatch(/^<p>start <em><strong>nested <a href="https:\/\/example\.com">safe link<\/a> with <code>c+/);
    expect(preview.contentHtml).toMatch(/<\/code><\/strong><\/em><\/p>\n$/);
    expect(preview.contentHtml).not.toContain('omitted');
    expect(preview.truncated).toBe(true);
  });

  it('keeps list and blockquote containers balanced at a content-unit cutoff', () => {
    const preview = renderer.renderMarkdownPreview([
      '> quoted one', '>', '> quoted two', '', '- list one', '- list two', '- omitted item',
    ].join('\n'));

    expect(preview.contentHtml).toContain('<blockquote>');
    expect(preview.contentHtml).toContain('</blockquote>');
    expect(preview.contentHtml).toContain('<ul>');
    expect(preview.contentHtml).toContain('</ul>');
    expect(preview.contentHtml).not.toContain('omitted item');
    expect(preview.truncated).toBe(true);
  });

  it.each([
    ['unordered list items', '-\n'.repeat(100), 'ul', 'li'],
    ['ordered list items', '1.\n'.repeat(100), 'ol', 'li'],
    ['blockquotes', '>\n\n'.repeat(100), 'blockquote', 'blockquote'],
  ])('omits repeated empty %s instead of emitting unbounded structure', (_label, source, container, child) => {
    const preview = renderer.renderMarkdownPreview(source);

    expect(preview).toEqual({ contentHtml: '', truncated: false });
    expect(preview.contentHtml).not.toContain(`<${container}>`);
    expect(preview.contentHtml).not.toContain(`<${child}>`);
  });

  it('omits empty structural nodes before real content while preserving the normal cutoff', () => {
    const preview = renderer.renderMarkdownPreview([
      '-', '1.', '>', '', 'first', '', 'second', '', 'third', '', '-', '>', '', 'OMITTED-AFTER-CUTOFF',
    ].join('\n'));

    expect(preview.contentHtml).toBe('<p>first</p>\n<p>second</p>\n<p>third</p>\n');
    expect(preview.contentHtml).not.toMatch(/<(?:ul|ol|li|blockquote)>/);
    expect(preview.contentHtml).not.toContain('OMITTED-AFTER-CUTOFF');
    expect(preview.truncated).toBe(true);
  });

  it('keeps fenced code structurally complete and limits it to six lines', () => {
    const preview = renderer.renderMarkdownPreview([
      '```js', 'one', 'two', 'three', 'four', 'five', 'six', 'OMITTED-CODE-TAIL', '```',
    ].join('\n'));

    expect(preview.contentHtml).toBe('<pre><code class="language-js">one\ntwo\nthree\nfour\nfive\nsix</code></pre>\n');
    expect(preview.contentHtml).not.toContain('OMITTED-CODE-TAIL');
    expect(preview.truncated).toBe(true);
  });

  it('applies the same six-line boundary to indented code', () => {
    const preview = renderer.renderMarkdownPreview([
      '    one', '    two', '    three', '    four', '    five', '    six', '    OMITTED',
    ].join('\n'));

    expect(preview.contentHtml).toBe('<pre><code>one\ntwo\nthree\nfour\nfive\nsix</code></pre>\n');
    expect(preview.truncated).toBe(true);
  });

  it('allows five explicit breaks and stops before a sixth', () => {
    const complete = renderer.renderMarkdownPreview('one\ntwo\nthree\nfour\nfive\nsix');
    const truncated = renderer.renderMarkdownPreview('one\ntwo\nthree\nfour\nfive\nsix\nOMITTED');

    expect(complete.truncated).toBe(false);
    expect(complete.contentHtml.match(/<br \/>/g)).toHaveLength(5);
    expect(truncated.contentHtml.match(/<br \/>/g)).toHaveLength(5);
    expect(truncated.contentHtml).not.toContain('OMITTED');
    expect(truncated.truncated).toBe(true);
  });

  it('shortens fenced code by the remaining Unicode text budget', () => {
    const preview = renderer.renderMarkdownPreview(`\`\`\`\n${'😀'.repeat(481)}\n\`\`\``);

    expect([...preview.contentHtml.match(/😀/gu) ?? []]).toHaveLength(480);
    expect(preview.contentHtml).toMatch(/^<pre><code>.*<\/code><\/pre>\n$/su);
    expect(preview.truncated).toBe(true);
  });

  it('keeps a complete table header and only complete body rows that fit', () => {
    const preview = renderer.renderMarkdownPreview([
      '| Name | Value |', '| --- | --- |', '| one | 1 |', '| two | 2 |', '| OMITTED | 3 |',
    ].join('\n'));

    expect(preview.contentHtml).toContain('<thead>');
    expect(preview.contentHtml).toContain('<th>Name</th>');
    expect(preview.contentHtml).toContain('<td>two</td>');
    expect(preview.contentHtml).not.toContain('OMITTED');
    expect(preview.contentHtml.match(/<tr>/g)).toHaveLength(3);
    expect(preview.truncated).toBe(true);
  });

  it('stops before a table when its complete header cannot fit', () => {
    const preview = renderer.renderMarkdownPreview([
      `| ${'h'.repeat(481)} |`, '| --- |', '| body |',
    ].join('\n'));

    expect(preview).toEqual({ contentHtml: '', truncated: true });
  });

  it('does not emit a partial oversized table body row', () => {
    const preview = renderer.renderMarkdownPreview([
      '| Header |', '| --- |', `| ${'x'.repeat(481)} |`, '| later |',
    ].join('\n'));

    expect(preview.contentHtml).toContain('<th>Header</th>');
    expect(preview.contentHtml).not.toContain('<tbody>');
    expect(preview.contentHtml).not.toContain('later');
    expect(preview.truncated).toBe(true);
  });

  it('suppresses a normalized matching leading H1 before budgeting without creating truncation', () => {
    expect(renderer.renderMarkdownPreview('# Page<br>Title', {
      suppressLeadingH1Matching: ' Page  Title ',
    })).toEqual({ contentHtml: '', truncated: false });
  });

  it('does not charge a suppressed H1 and retains nonmatching and later headings within budget', () => {
    const matching = renderer.renderMarkdownPreview('# Page Title\n\nfirst\n\n## Later\n\nthird', {
      suppressLeadingH1Matching: 'Page Title',
    });
    const nonmatching = renderer.renderMarkdownPreview('# Other\n\nbody');

    expect(matching).toEqual({
      contentHtml: '<p>first</p>\n<h2>Later</h2>\n<p>third</p>\n',
      truncated: false,
    });
    expect(nonmatching.contentHtml).toContain('<h1>Other</h1>');
    expect(nonmatching.truncated).toBe(false);
  });

  it('preserves sanitizer, unsafe-link, and disabled-image behavior', () => {
    const preview = renderer.renderMarkdownPreview([
      '[safe](https://example.com) [unsafe](javascript:alert(1))',
      '',
      '<script>alert("preview")</script>',
      '',
      '![remote](https://example.com/image.png)',
    ].join('\n'));

    expect(preview.contentHtml).toContain('<a href="https://example.com">safe</a>');
    expect(preview.contentHtml).not.toMatch(/href=["']javascript:/i);
    expect(preview.contentHtml).not.toContain('<script>');
    expect(preview.contentHtml).not.toContain('<img');
  });

  it.each(['', '   \n\t'])('returns a safe empty preview for empty Markdown', (source) => {
    expect(renderer.renderMarkdownPreview(source)).toEqual({ contentHtml: '', truncated: false });
  });

  it('leaves normal full rendering unchanged and untruncated', () => {
    const source = ['one', '', 'two', '', 'three', '', 'FULL-DETAIL-TAIL'].join('\n');

    expect(renderer.renderMarkdown(source)).toContain('FULL-DETAIL-TAIL');
    expect(renderer.renderMarkdownPreview(source).contentHtml).not.toContain('FULL-DETAIL-TAIL');
  });
});
