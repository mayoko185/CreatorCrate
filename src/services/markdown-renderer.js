import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const MARKDOWN_OPTIONS = {
  html: false,
  breaks: true,
  linkify: false,
  typographer: false,
};

const TOAST_UI_BREAK_RE = /^<br\s*\/?>/i;

export const MARKDOWN_PREVIEW_LIMITS = Object.freeze({
  visibleText: 480,
  contentUnits: 3,
  explicitLineBreaks: 5,
  codeLines: 6,
});

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

function normalizeHeadingText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function suppressMatchingLeadingH1(tokens, title) {
  if (typeof title !== 'string') return tokens;

  const [headingOpen, headingInline, headingClose] = tokens;
  const isLeadingH1 = headingOpen?.type === 'heading_open'
    && headingOpen.tag === 'h1'
    && headingInline?.type === 'inline'
    && headingClose?.type === 'heading_close'
    && headingClose.tag === 'h1';
  const headingText = headingInline?.children
    ?.filter((token) => ['text', 'code_inline', 'softbreak', 'hardbreak'].includes(token.type))
    .map((token) => ['softbreak', 'hardbreak'].includes(token.type) ? ' ' : token.content)
    .join('');

  return isLeadingH1
    && normalizeHeadingText(headingText ?? '') === normalizeHeadingText(title)
    ? tokens.slice(3)
    : tokens;
}

function cloneToken(token, overrides = {}) {
  return Object.assign(Object.create(Object.getPrototypeOf(token)), token, overrides);
}

function buildTokenTree(tokens) {
  const root = { children: [] };
  const stack = [root];

  for (const token of tokens) {
    if (token.nesting === 1) {
      const node = { token, close: null, children: [] };
      stack.at(-1).children.push(node);
      stack.push(node);
    } else if (token.nesting === -1) {
      stack.pop().close = token;
    } else {
      stack.at(-1).children.push({ token, close: null, children: [] });
    }
  }

  return root.children;
}

function flattenTokenTree(nodes, output = []) {
  for (const node of nodes) {
    output.push(node.token);
    flattenTokenTree(node.children, output);
    if (node.close) output.push(node.close);
  }
  return output;
}

function copyBudget(state) {
  return {
    visibleText: state.visibleText,
    contentUnits: state.contentUnits,
    explicitLineBreaks: state.explicitLineBreaks,
    stopped: false,
    truncated: false,
  };
}

function commitBudget(target, source) {
  target.visibleText = source.visibleText;
  target.contentUnits = source.contentUnits;
  target.explicitLineBreaks = source.explicitLineBreaks;
}

function stopPreview(state) {
  state.stopped = true;
  state.truncated = true;
}

function retainInlineNodes(nodes, state, { allowPartial }) {
  const retained = [];

  for (const node of nodes) {
    if (state.stopped) break;

    if (node.token.type === 'text' || node.token.type === 'code_inline') {
      const codePoints = [...node.token.content];
      const remaining = MARKDOWN_PREVIEW_LIMITS.visibleText - state.visibleText;
      if (codePoints.length <= remaining) {
        state.visibleText += codePoints.length;
        retained.push({ ...node, token: cloneToken(node.token) });
        continue;
      }
      if (allowPartial && remaining > 0) {
        retained.push({
          ...node,
          token: cloneToken(node.token, { content: codePoints.slice(0, remaining).join('') }),
        });
        state.visibleText += remaining;
      }
      stopPreview(state);
      break;
    }

    if (node.token.type === 'softbreak' || node.token.type === 'hardbreak') {
      if (state.explicitLineBreaks >= MARKDOWN_PREVIEW_LIMITS.explicitLineBreaks) {
        stopPreview(state);
        break;
      }
      state.explicitLineBreaks += 1;
      retained.push({ ...node, token: cloneToken(node.token) });
      continue;
    }

    if (node.children.length > 0) {
      const children = retainInlineNodes(node.children, state, { allowPartial });
      if (children.length > 0) {
        retained.push({
          ...node,
          token: cloneToken(node.token),
          close: node.close ? cloneToken(node.close) : null,
          children,
        });
      }
      continue;
    }

    retained.push({ ...node, token: cloneToken(node.token) });
  }

  return retained;
}

function retainInlineToken(node, state, { allowPartial }) {
  const children = buildTokenTree(node.token.children ?? []);
  const retainedChildren = retainInlineNodes(children, state, { allowPartial });
  if (state.stopped && !allowPartial) return null;
  if (retainedChildren.length === 0 && children.length > 0) return null;

  return {
    ...node,
    token: cloneToken(node.token, { children: flattenTokenTree(retainedChildren) }),
  };
}

function retainTextBlock(node, state) {
  if (state.contentUnits >= MARKDOWN_PREVIEW_LIMITS.contentUnits
    || state.visibleText >= MARKDOWN_PREVIEW_LIMITS.visibleText) {
    stopPreview(state);
    return null;
  }

  state.contentUnits += 1;
  const children = [];
  for (const child of node.children) {
    if (state.stopped) break;
    children.push(child.token.type === 'inline'
      ? retainInlineToken(child, state, { allowPartial: true })
      : retainBlockNode(child, state));
  }
  const retainedChildren = children.filter(Boolean);
  if (retainedChildren.length === 0 && node.children.length > 0) return null;

  return {
    ...node,
    token: cloneToken(node.token),
    close: node.close ? cloneToken(node.close) : null,
    children: retainedChildren,
  };
}

function retainCodeBlock(node, state) {
  if (state.contentUnits >= MARKDOWN_PREVIEW_LIMITS.contentUnits
    || state.visibleText >= MARKDOWN_PREVIEW_LIMITS.visibleText) {
    stopPreview(state);
    return null;
  }

  state.contentUnits += 1;
  const original = node.token.content;
  const hasTerminalNewline = original.endsWith('\n');
  const logicalContent = hasTerminalNewline ? original.slice(0, -1).replace(/\r$/, '') : original;
  const retained = [];
  let lineBreaksInCode = 0;
  let wasTruncated = false;

  for (const codePoint of logicalContent) {
    if (codePoint === '\r') continue;
    if (codePoint === '\n') {
      if (lineBreaksInCode >= MARKDOWN_PREVIEW_LIMITS.codeLines - 1
        || state.explicitLineBreaks >= MARKDOWN_PREVIEW_LIMITS.explicitLineBreaks) {
        wasTruncated = true;
        break;
      }
      lineBreaksInCode += 1;
      state.explicitLineBreaks += 1;
      retained.push(codePoint);
      continue;
    }
    if (state.visibleText >= MARKDOWN_PREVIEW_LIMITS.visibleText) {
      wasTruncated = true;
      break;
    }
    state.visibleText += 1;
    retained.push(codePoint);
  }

  if (wasTruncated) stopPreview(state);
  const content = wasTruncated ? retained.join('') : original;
  return { ...node, token: cloneToken(node.token, { content }) };
}

function retainTableRow(node, state) {
  if (state.contentUnits >= MARKDOWN_PREVIEW_LIMITS.contentUnits
    || state.visibleText >= MARKDOWN_PREVIEW_LIMITS.visibleText) return null;

  const trial = copyBudget(state);
  trial.contentUnits += 1;
  const cloneDescendants = (nodes) => {
    const retained = [];
    for (const child of nodes) {
      if (trial.stopped) break;
      if (child.token.type === 'inline') {
        const inline = retainInlineToken(child, trial, { allowPartial: false });
        if (inline) retained.push(inline);
      } else {
        const descendants = cloneDescendants(child.children);
        retained.push({
          ...child,
          token: cloneToken(child.token),
          close: child.close ? cloneToken(child.close) : null,
          children: descendants,
        });
      }
    }
    return retained;
  };
  const children = cloneDescendants(node.children);
  if (trial.stopped) return null;

  commitBudget(state, trial);
  return {
    ...node,
    token: cloneToken(node.token),
    close: node.close ? cloneToken(node.close) : null,
    children,
  };
}

function retainTable(node, state) {
  const trial = copyBudget(state);
  const children = [];
  let headerRetained = false;

  for (const section of node.children) {
    if (!['thead_open', 'tbody_open'].includes(section.token.type)) continue;
    const rows = [];
    for (const row of section.children) {
      const retainedRow = retainTableRow(row, trial);
      if (!retainedRow) {
        if (section.token.type === 'thead_open') {
          stopPreview(state);
          return null;
        }
        trial.stopped = true;
        trial.truncated = true;
        break;
      }
      rows.push(retainedRow);
      if (section.token.type === 'thead_open') headerRetained = true;
    }
    if (rows.length > 0) {
      children.push({
        ...section,
        token: cloneToken(section.token),
        close: section.close ? cloneToken(section.close) : null,
        children: rows,
      });
    }
    if (trial.stopped) break;
  }

  if (!headerRetained) {
    stopPreview(state);
    return null;
  }
  commitBudget(state, trial);
  if (trial.truncated) stopPreview(state);
  return {
    ...node,
    token: cloneToken(node.token),
    close: node.close ? cloneToken(node.close) : null,
    children,
  };
}

function retainBlockNode(node, state) {
  if (state.stopped) return null;

  if (node.token.type === 'paragraph_open' || node.token.type === 'heading_open') {
    return retainTextBlock(node, state);
  }
  if (node.token.type === 'fence' || node.token.type === 'code_block') {
    return retainCodeBlock(node, state);
  }
  if (node.token.type === 'hr') {
    if (state.contentUnits >= MARKDOWN_PREVIEW_LIMITS.contentUnits) {
      stopPreview(state);
      return null;
    }
    state.contentUnits += 1;
    return { ...node, token: cloneToken(node.token) };
  }
  if (node.token.type === 'table_open') return retainTable(node, state);
  if (node.token.type === 'inline') return retainInlineToken(node, state, { allowPartial: true });

  const children = [];
  for (const child of node.children) {
    const retained = retainBlockNode(child, state);
    if (retained) children.push(retained);
    if (state.stopped) break;
  }
  if (node.close && children.length === 0) return null;

  return {
    ...node,
    token: cloneToken(node.token),
    close: node.close ? cloneToken(node.close) : null,
    children,
  };
}

function retainPreviewTokens(tokens) {
  const state = {
    visibleText: 0,
    contentUnits: 0,
    explicitLineBreaks: 0,
    stopped: false,
    truncated: false,
  };
  const retained = [];

  for (const node of buildTokenTree(tokens)) {
    const retainedNode = retainBlockNode(node, state);
    if (retainedNode) retained.push(retainedNode);
    if (state.stopped) break;
  }

  return { tokens: flattenTokenTree(retained), truncated: state.truncated };
}

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
    renderMarkdown(source, { suppressLeadingH1Matching = null } = {}) {
      if (typeof source !== 'string') {
        throw new TypeError('renderMarkdown expects a Markdown string.');
      }

      let renderedHtml;
      if (typeof suppressLeadingH1Matching === 'string') {
        const tokens = markdown.parse(source, {});
        const filteredTokens = suppressMatchingLeadingH1(tokens, suppressLeadingH1Matching);
        renderedHtml = markdown.renderer.render(filteredTokens, markdown.options, {});
      } else {
        renderedHtml = markdown.render(source);
      }

      return sanitizeHtml(renderedHtml, SANITIZE_OPTIONS);
    },

    renderMarkdownPreview(source, { suppressLeadingH1Matching = null } = {}) {
      if (typeof source !== 'string') {
        throw new TypeError('renderMarkdownPreview expects a Markdown string.');
      }

      const parsedTokens = markdown.parse(source, {});
      const filteredTokens = suppressMatchingLeadingH1(parsedTokens, suppressLeadingH1Matching);
      const preview = retainPreviewTokens(filteredTokens);
      const renderedHtml = markdown.renderer.render(preview.tokens, markdown.options, {});
      return {
        contentHtml: sanitizeHtml(renderedHtml, SANITIZE_OPTIONS),
        truncated: preview.truncated,
      };
    },
  };
}
