import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const MARKDOWN_OPTIONS = {
  html: false,
  breaks: true,
  linkify: false,
  typographer: false,
};

const TOAST_UI_BREAK_RE = /^<br\s*\/?>/i;

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

  markdown.inline.ruler.before('text', 'toast_ui_break', (state, silent) => {
    const match = TOAST_UI_BREAK_RE.exec(state.src.slice(state.pos));
    if (!match) return false;

    if (!silent) state.push('hardbreak', 'br', 0);
    state.pos += match[0].length;
    return true;
  });

  return {
    renderMarkdown(source) {
      if (typeof source !== 'string') {
        throw new TypeError('renderMarkdown expects a Markdown string.');
      }

      return sanitizeHtml(markdown.render(source), SANITIZE_OPTIONS);
    },
  };
}
