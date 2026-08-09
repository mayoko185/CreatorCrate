import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const MARKDOWN_OPTIONS = {
  html: false,
  breaks: false,
  linkify: false,
  typographer: false,
};

const SANITIZE_OPTIONS = {
  allowedTags: [
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'strong',
    'em',
    's',
    'ol',
    'ul',
    'li',
    'blockquote',
    'a',
    'code',
    'pre',
    'br',
    'hr',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    code: ['class'],
  },
  allowedClasses: {
    code: ['language-*'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    a: ['http', 'https', 'mailto'],
  },
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  allowComments: false,
  disallowedTagsMode: 'discard',
};

export function createMarkdownRenderer() {
  const markdown = new MarkdownIt(MARKDOWN_OPTIONS)
    .disable('image')
    .enable(['strikethrough', 'table']);

  return {
    renderMarkdown(source) {
      if (typeof source !== 'string') {
        throw new TypeError('renderMarkdown expects a Markdown string.');
      }

      return sanitizeHtml(markdown.render(source), SANITIZE_OPTIONS);
    },
  };
}
