export const WORKFLOW_JSON_TOKEN_KINDS = Object.freeze({
  KEY: 'key',
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  NULL: 'null',
  PUNCTUATION: 'punctuation',
});

const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function stringEnd(source, start) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
    } else if (source[index] === '"') {
      return index + 1;
    } else {
      index += 1;
    }
  }
  throw new TypeError('Workflow JSON serialization produced an unterminated string.');
}

function nextNonWhitespaceIndex(source, start) {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

function tokenKindForString(source, end) {
  return source[nextNonWhitespaceIndex(source, end)] === ':'
    ? WORKFLOW_JSON_TOKEN_KINDS.KEY
    : WORKFLOW_JSON_TOKEN_KINDS.STRING;
}

function presentStringToken(serialized) {
  const value = JSON.parse(serialized);
  let text = '"';

  for (const character of value) {
    if (character === '"') {
      text += '\\"';
    } else if (character === '\b') {
      text += '\\\\b';
    } else if (character === '\f') {
      text += '\\\\f';
    } else if (character === '\n') {
      text += '\\\\n';
    } else if (character === '\r') {
      text += '\\\\r';
    } else if (character === '\t') {
      text += '\\\\t';
    } else if (character.codePointAt(0) < 0x20) {
      text += `\\${JSON.stringify(character).slice(1, -1)}`;
    } else {
      text += character;
    }
  }

  return `${text}"`;
}

function tokenizeWorkflowJson(source) {
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    if (character === '"') {
      const end = stringEnd(source, index);
      const serialized = source.slice(index, end);
      const kind = tokenKindForString(source, end);
      tokens.push({
        kind,
        text: kind === WORKFLOW_JSON_TOKEN_KINDS.STRING
          ? presentStringToken(serialized)
          : serialized,
      });
      index = end;
      continue;
    }

    NUMBER_PATTERN.lastIndex = index;
    const number = NUMBER_PATTERN.exec(source);
    if (number) {
      tokens.push({ kind: WORKFLOW_JSON_TOKEN_KINDS.NUMBER, text: number[0] });
      index += number[0].length;
      continue;
    }

    if (source.startsWith('true', index) || source.startsWith('false', index)) {
      const text = source.startsWith('true', index) ? 'true' : 'false';
      tokens.push({ kind: WORKFLOW_JSON_TOKEN_KINDS.BOOLEAN, text });
      index += text.length;
      continue;
    }

    if (source.startsWith('null', index)) {
      tokens.push({ kind: WORKFLOW_JSON_TOKEN_KINDS.NULL, text: 'null' });
      index += 4;
      continue;
    }

    const start = index;
    index += 1;
    while (index < source.length) {
      const next = source[index];
      if (next === '"' || next === '-' || /\d/.test(next) || next === 't' || next === 'f' || next === 'n') {
        break;
      }
      index += 1;
    }
    tokens.push({
      kind: WORKFLOW_JSON_TOKEN_KINDS.PUNCTUATION,
      text: source.slice(start, index),
    });
  }

  return tokens;
}

export function presentWorkflowJson(workflow) {
  const serialized = JSON.stringify(workflow, null, 2);
  if (typeof serialized !== 'string') {
    throw new TypeError('Workflow must serialize to JSON.');
  }
  return tokenizeWorkflowJson(serialized);
}
