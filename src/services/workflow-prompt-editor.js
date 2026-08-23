import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXT_CHUNK_TYPES = new Set(['tEXt', 'zTXt', 'iTXt']);
const SUPPORTED_METADATA_KEYS = Object.freeze(['prompt', 'workflow', 'comfyui', 'parameters']);
const PROMPT_RULE_TYPES = new Set(['prepend', 'append', 'remove', 'replace']);
export const PNG_TEXT_CHUNK_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const PNG_TEXT_CHUNK_MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024;
export const PNG_TOTAL_TEXT_MAX_BYTES = 16 * 1024 * 1024;
const EMPTY_PROMPT_RULES = Object.freeze({ positive: [], negative: [] });
const PARAMETER_LINE_NAMES = [
  'Steps',
  'Sampler',
  'Scheduler',
  'CFG scale',
  'Seed',
  'Size',
  'Model hash',
  'Model',
  'VAE hash',
  'VAE',
  'Clip skip',
  'Version',
  'Denoising strength',
  'Hires upscale',
  'Hires steps',
  'Hires upscaler',
  'Lora hashes',
];
const PARAMETER_LINE_PATTERN = new RegExp(
  `^[\\t ]*(?:${PARAMETER_LINE_NAMES.map((name) => name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')).join('|')})\\s*:`,
  'i',
);

const A1111_PARAMETERS_FORMAT = 'creatorcrate.comfyui-a1111-import-metadata/v1';
const A1111_MAX_LORAS = 64;
const A1111_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

let crcTable;

export class WorkflowPromptMetadataError extends Error {
  constructor(message, { code = 'MALFORMED_PNG', cause, metadataKey } = {}) {
    super(message);
    this.name = 'WorkflowPromptMetadataError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    if (metadataKey !== undefined) this.metadataKey = metadataKey;
  }
}

function fail(message, options) {
  throw new WorkflowPromptMetadataError(message, options);
}

function asBuffer(input) {
  if (!Buffer.isBuffer(input)) {
    fail('PNG input must be a Buffer.', { code: 'INVALID_PNG_INPUT' });
  }
  return input;
}

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

function updateCrc32(value, input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const table = getCrcTable();
  let next = value;
  for (const byte of bytes) {
    next = table[(next ^ byte) & 0xff] ^ (next >>> 8);
  }
  return next;
}

function crc32Parts(parts) {
  let value = 0xffffffff;
  for (const part of parts) {
    value = updateCrc32(value, part);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function crc32(input) {
  return crc32Parts([input]);
}

export function createPngChunk(type, data = Buffer.alloc(0)) {
  if (typeof type !== 'string' || !/^[A-Za-z]{4}$/.test(type)) {
    throw new TypeError('PNG chunk type must contain four ASCII letters.');
  }
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const typeBytes = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBytes, payload]);
  const result = Buffer.alloc(12 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  typeBytes.copy(result, 4);
  payload.copy(result, 8);
  result.writeUInt32BE(crc32(crcInput), 8 + payload.length);
  return result;
}

export function parsePngChunks(input) {
  const buffer = asBuffer(input);
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('PNG signature is missing or invalid.', { code: 'INVALID_PNG_SIGNATURE' });
  }

  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  let foundIhdr = false;
  let foundIend = false;

  while (offset < buffer.length) {
    if (buffer.length - offset < 12) {
      fail('PNG chunk header or trailer is truncated.');
    }

    const length = buffer.readUInt32BE(offset);
    const remainingAfterHeader = buffer.length - offset - 8;
    if (length > remainingAfterHeader - 4) {
      fail('PNG chunk data is truncated.');
    }

    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      fail('PNG contains an invalid chunk type.');
    }
    if (chunks.length === 0 && type !== 'IHDR') {
      fail('PNG first chunk must be IHDR.');
    }
    if (type === 'IHDR') {
      if (foundIhdr) fail('PNG contains a duplicate IHDR chunk.');
      if (length !== 13) fail('PNG IHDR chunk must contain 13 bytes.');
      foundIhdr = true;
    }

    const end = offset + 12 + length;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const storedCrc = buffer.readUInt32BE(dataEnd);
    const calculatedCrc = crc32(buffer.subarray(offset + 4, dataEnd));
    if (storedCrc !== calculatedCrc) {
      fail(`PNG chunk ${type} has an invalid CRC.`, { code: 'INVALID_PNG_CRC' });
    }

    chunks.push({
      type,
      length,
      data: buffer.subarray(dataStart, dataEnd),
      raw: buffer.subarray(offset, end),
      offset,
    });

    offset = end;
    if (type === 'IEND') {
      if (length !== 0) fail('PNG IEND chunk must be empty.');
      if (offset !== buffer.length) fail('PNG contains data after IEND.');
      foundIend = true;
      break;
    }
  }

  if (!foundIhdr) fail('PNG is missing its IHDR chunk.');
  if (!foundIend) fail('PNG is missing its IEND chunk.');
  return chunks;
}

const PNG_CHUNK_READ_BUFFER_BYTES = 64 * 1024;

function readPngRange(readAt, offset, length, errorMessage) {
  const bytes = readAt(offset, length);
  if (!Buffer.isBuffer(bytes) || bytes.length !== length) {
    fail(errorMessage);
  }
  return bytes;
}

function validatePngReaderChunkCrc(readAt, { type, length, data, offset }) {
  let value = updateCrc32(0xffffffff, Buffer.from(type, 'ascii'));
  if (data) {
    value = updateCrc32(value, data);
  } else {
    let remaining = length;
    let dataOffset = offset + 8;
    while (remaining > 0) {
      const byteCount = Math.min(remaining, PNG_CHUNK_READ_BUFFER_BYTES);
      value = updateCrc32(
        value,
        readPngRange(readAt, dataOffset, byteCount, 'PNG chunk data is truncated.')
      );
      dataOffset += byteCount;
      remaining -= byteCount;
    }
  }

  const storedCrc = readPngRange(
    readAt,
    offset + 8 + length,
    4,
    'PNG chunk header or trailer is truncated.'
  ).readUInt32BE(0);
  if (storedCrc !== ((value ^ 0xffffffff) >>> 0)) {
    fail(`PNG chunk ${type} has an invalid CRC.`, { code: 'INVALID_PNG_CRC' });
  }
}

function readPngTextChunks(readAt, byteLength) {
  if (typeof readAt !== 'function' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    fail('PNG reader input is invalid.', { code: 'INVALID_PNG_INPUT' });
  }

  const signature = readPngRange(
    readAt,
    0,
    Math.min(byteLength, PNG_SIGNATURE.length),
    'PNG signature is missing or invalid.'
  );
  if (signature.length < PNG_SIGNATURE.length || !signature.equals(PNG_SIGNATURE)) {
    fail('PNG signature is missing or invalid.', { code: 'INVALID_PNG_SIGNATURE' });
  }

  const chunks = [];
  let chunkCount = 0;
  let offset = PNG_SIGNATURE.length;
  let foundIhdr = false;
  let foundIend = false;

  while (offset < byteLength) {
    if (byteLength - offset < 12) {
      fail('PNG chunk header or trailer is truncated.');
    }

    const header = readPngRange(readAt, offset, 8, 'PNG chunk header or trailer is truncated.');
    const length = header.readUInt32BE(0);
    const remainingAfterHeader = byteLength - offset - 8;
    if (length > remainingAfterHeader - 4) {
      fail('PNG chunk data is truncated.');
    }

    const type = header.toString('ascii', 4, 8);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      fail('PNG contains an invalid chunk type.');
    }
    if (chunkCount === 0 && type !== 'IHDR') {
      fail('PNG first chunk must be IHDR.');
    }
    if (type === 'IHDR') {
      if (foundIhdr) fail('PNG contains a duplicate IHDR chunk.');
      if (length !== 13) fail('PNG IHDR chunk must contain 13 bytes.');
      foundIhdr = true;
    }

    if (TEXT_CHUNK_TYPES.has(type) && length > PNG_TEXT_CHUNK_MAX_INPUT_BYTES) {
      fail('PNG textual metadata chunk exceeds the maximum input size.', {
        code: 'OVERSIZED_PNG_METADATA',
      });
    }

    const data = TEXT_CHUNK_TYPES.has(type)
      ? readPngRange(readAt, offset + 8, length, 'PNG chunk data is truncated.')
      : null;
    validatePngReaderChunkCrc(readAt, { type, length, data, offset });

    if (data) chunks.push({ type, length, data, offset });

    offset += 12 + length;
    chunkCount += 1;
    if (type === 'IEND') {
      if (length !== 0) fail('PNG IEND chunk must be empty.');
      if (offset !== byteLength) fail('PNG contains data after IEND.');
      foundIend = true;
      break;
    }
  }

  if (!foundIhdr) fail('PNG is missing its IHDR chunk.');
  if (!foundIend) fail('PNG is missing its IEND chunk.');
  return chunks;
}

function textEncodingCanRepresentLatin1(text) {
  for (const character of text) {
    if (character.codePointAt(0) > 0xff) return false;
  }
  return true;
}

function findNullByte(data, start) {
  const index = data.indexOf(0, start);
  if (index < 0) fail('PNG textual metadata is missing a separator.');
  return index;
}

function inflateText(data, type) {
  try {
    return inflateSync(data, { maxOutputLength: PNG_TEXT_CHUNK_MAX_DECOMPRESSED_BYTES });
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
      fail(`PNG ${type} metadata exceeds the maximum decompressed size.`, {
        code: 'OVERSIZED_PNG_METADATA',
        cause: err,
      });
    }
    fail(`PNG ${type} metadata could not be decompressed.`, {
      code: 'MALFORMED_PNG_METADATA',
      cause: err,
    });
  }
}

function parseTextChunk(chunk) {
  const data = chunk.data;
  if (chunk.type === 'tEXt') {
    const keywordEnd = findNullByte(data, 0);
    if (keywordEnd < 1 || keywordEnd > 79) {
      fail('PNG tEXt keyword is invalid.');
    }
    const textBytes = data.subarray(keywordEnd + 1);
    return {
      key: data.toString('latin1', 0, keywordEnd),
      text: textBytes.toString('latin1'),
      textByteLength: textBytes.length,
      kind: chunk.type,
      keyword: data.subarray(0, keywordEnd),
    };
  }

  if (chunk.type === 'zTXt') {
    const keywordEnd = findNullByte(data, 0);
    if (keywordEnd < 1 || keywordEnd > 79 || data.length <= keywordEnd + 2) {
      fail('PNG zTXt metadata is invalid.');
    }
    if (data[keywordEnd + 1] !== 0) {
      fail('PNG zTXt uses an unsupported compression method.');
    }
    const textBytes = inflateText(data.subarray(keywordEnd + 2), 'zTXt');
    return {
      key: data.toString('latin1', 0, keywordEnd),
      text: textBytes.toString('latin1'),
      textByteLength: textBytes.length,
      kind: chunk.type,
      keyword: data.subarray(0, keywordEnd),
    };
  }

  const keywordEnd = findNullByte(data, 0);
  if (keywordEnd < 1 || keywordEnd > 79 || data.length <= keywordEnd + 2) {
    fail('PNG iTXt metadata is invalid.');
  }
  const compressionFlag = data[keywordEnd + 1];
  const compressionMethod = data[keywordEnd + 2];
  if (compressionFlag !== 0 && compressionFlag !== 1) {
    fail('PNG iTXt uses an invalid compression flag.');
  }
  if (compressionMethod !== 0) {
    fail('PNG iTXt uses an unsupported compression method.');
  }

  const languageEnd = findNullByte(data, keywordEnd + 3);
  const translatedEnd = findNullByte(data, languageEnd + 1);
  const textStart = translatedEnd + 1;
  let textBytes = data.subarray(textStart);
  if (compressionFlag === 1) {
    textBytes = inflateText(textBytes, 'iTXt');
  }

  return {
    key: data.toString('latin1', 0, keywordEnd),
    text: textBytes.toString('utf8'),
    textByteLength: textBytes.length,
    kind: chunk.type,
    keyword: data.subarray(0, keywordEnd),
    prefix: data.subarray(0, textStart),
    compressionFlag,
  };
}

function encodeTextChunk(metadata, text) {
  if (metadata.kind === 'tEXt' && textEncodingCanRepresentLatin1(text)) {
    return createPngChunk('tEXt', Buffer.concat([
      metadata.keyword,
      Buffer.from([0]),
      Buffer.from(text, 'latin1'),
    ]));
  }

  if (metadata.kind === 'zTXt' && textEncodingCanRepresentLatin1(text)) {
    return createPngChunk('zTXt', Buffer.concat([
      metadata.keyword,
      Buffer.from([0, 0]),
      deflateSync(Buffer.from(text, 'latin1')),
    ]));
  }

  if (metadata.kind === 'iTXt') {
    const textBytes = Buffer.from(text, 'utf8');
    const encoded = metadata.compressionFlag === 1 ? deflateSync(textBytes) : textBytes;
    return createPngChunk('iTXt', Buffer.concat([metadata.prefix, encoded]));
  }

  // tEXt and zTXt are Latin-1 formats. Pillow promotes a non-Latin-1 text
  // value to iTXt rather than silently replacing prompt characters.
  return createPngChunk('iTXt', Buffer.concat([
    metadata.keyword,
    Buffer.from([0, 0, 0, 0, 0]),
    Buffer.from(text, 'utf8'),
  ]));
}

function normalizeRule(rule, side, index) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    fail(`${side}.rules[${index}] must be an object.`, { code: 'INVALID_PROMPT_RULE' });
  }
  if (!PROMPT_RULE_TYPES.has(rule.type)) {
    fail(`${side}.rules[${index}] has an unsupported type.`, { code: 'INVALID_PROMPT_RULE' });
  }

  if (rule.type === 'replace') {
    if (typeof rule.search !== 'string' || typeof rule.replacement !== 'string') {
      fail(`${side}.rules[${index}] replace requires search and replacement strings.`, {
        code: 'INVALID_PROMPT_RULE',
      });
    }
    return { type: rule.type, search: rule.search, replacement: rule.replacement };
  }

  if (typeof rule.text !== 'string') {
    fail(`${side}.rules[${index}] requires a text string.`, { code: 'INVALID_PROMPT_RULE' });
  }
  return { type: rule.type, text: rule.text };
}

function normalizeRuleList(value, side) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${side} must be an object.`, { code: 'INVALID_PROMPT_RULES' });
  }
  if (value.rules === undefined) return [];
  if (!Array.isArray(value.rules)) {
    fail(`${side}.rules must be an array.`, { code: 'INVALID_PROMPT_RULES' });
  }
  return normalizeRuleArray(value.rules, side);
}

function normalizeRuleArray(value, side) {
  if (!Array.isArray(value)) {
    fail(`${side}.rules must be an array.`, { code: 'INVALID_PROMPT_RULES' });
  }
  return value.map((rule, index) => normalizeRule(rule, side, index));
}

export function normalizePromptEditOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('Prompt editing options are required.', { code: 'INVALID_PROMPT_OPTIONS' });
  }
  return {
    positive: normalizeRuleList(options.positive, 'positive'),
    negative: normalizeRuleList(options.negative, 'negative'),
  };
}

export function normalizeOrUsePromptEditOptions(options) {
  if (Array.isArray(options?.positive) && Array.isArray(options?.negative)) {
    return {
      positive: normalizeRuleArray(options.positive, 'positive'),
      negative: normalizeRuleArray(options.negative, 'negative'),
    };
  }
  return normalizePromptEditOptions(options);
}

export function applyPromptRules(value, rules) {
  const normalizedRules = normalizeRuleArray(rules, 'rules');
  if (typeof value !== 'string') return value;

  const phases = {
    remove: [],
    replace: [],
    prepend: [],
    append: [],
  };
  for (const rule of normalizedRules) phases[rule.type].push(rule);

  let result = value;

  for (const rule of phases.remove) {
    if (rule.text !== '') result = result.split(rule.text).join('');
  }

  for (const rule of phases.replace) {
    if (rule.search === '') {
      if (rule.replacement !== '') {
        const characters = Array.from(result);
        result = characters.length === 0
          ? rule.replacement
          : rule.replacement + characters.join(rule.replacement) + rule.replacement;
      }
    } else {
      result = result.split(rule.search).join(rule.replacement);
    }
  }

  for (const rule of phases.prepend) {
    if (rule.text !== '' && !result.startsWith(rule.text)) result = rule.text + result;
  }

  for (const rule of phases.append) {
    if (rule.text !== '' && !result.endsWith(rule.text)) result += rule.text;
  }

  return result;
}

const PROMPT_EXCERPT_MAX_LENGTH = 240;

function promptExcerpt(value) {
  if (typeof value !== 'string') return null;
  if (value.length <= PROMPT_EXCERPT_MAX_LENGTH) return value;
  const headLength = Math.floor(PROMPT_EXCERPT_MAX_LENGTH / 2);
  const tailLength = PROMPT_EXCERPT_MAX_LENGTH - headLength - 3;
  return `${value.slice(0, headLength)}...${value.slice(-tailLength)}`;
}

function addPromptExcerpt(result, side, before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return;
  const prefix = side === 'positive' ? 'positive' : 'negative';
  const beforeKey = `${prefix}Before`;
  const afterKey = `${prefix}After`;
  if (result[beforeKey] === undefined) {
    result[beforeKey] = promptExcerpt(before);
    result[afterKey] = promptExcerpt(after);
  }
}

function editParametersText(value, rules) {
  const negativeMarker = /^([\t ]*Negative prompt\s*:\s*)/im.exec(value);
  if (!negativeMarker) {
    const parameterLine = new RegExp(`\\r?\\n(?=${PARAMETER_LINE_PATTERN.source})`, 'im').exec(value);
    const positiveEnd = parameterLine ? parameterLine.index : value.length;
    const positivePrefix = /^([\t ]*Positive prompt\s*:\s*)/i.exec(value);
    if (!positivePrefix) {
      const beforePrompt = value.slice(0, positiveEnd);
      const editedPrompt = applyPromptRules(beforePrompt, rules.positive);
      const edited = editedPrompt + value.slice(positiveEnd);
      return {
        value: edited,
        positiveChanged: edited !== value,
        negativeChanged: false,
        positiveBefore: beforePrompt,
        positiveAfter: editedPrompt,
        negativeBefore: null,
        negativeAfter: null,
      };
    }
    const start = positivePrefix[0].length;
    const beforePrompt = value.slice(start, positiveEnd);
    const editedPrompt = applyPromptRules(beforePrompt, rules.positive);
    const edited = value.slice(0, start) + editedPrompt + value.slice(positiveEnd);
    return {
      value: edited,
      positiveChanged: edited !== value,
      negativeChanged: false,
      positiveBefore: beforePrompt,
      positiveAfter: editedPrompt,
      negativeBefore: null,
      negativeAfter: null,
    };
  }

  const positiveEnd = negativeMarker.index;
  const positivePrefixText = value.slice(0, positiveEnd);
  const positiveContentEnd = positivePrefixText.endsWith('\r\n')
    ? positiveEnd - 2
    : positivePrefixText.endsWith('\n')
      ? positiveEnd - 1
      : positiveEnd;
  const positivePrefix = /^([\t ]*Positive prompt\s*:\s*)/i.exec(value);
  const positiveStart = positivePrefix && positivePrefix[0].length < positiveContentEnd
    ? positivePrefix[0].length
    : 0;
  const beforePositive = value.slice(positiveStart, positiveContentEnd);
  const editedPositive = applyPromptRules(beforePositive, rules.positive);

  const negativeStart = negativeMarker.index + negativeMarker[0].length;
  const negativeRemainder = value.slice(negativeStart);
  const parameterLine = new RegExp(`\\r?\\n(?=${PARAMETER_LINE_PATTERN.source})`, 'im').exec(negativeRemainder);
  const negativeEnd = parameterLine ? negativeStart + parameterLine.index : value.length;
  const beforeNegative = value.slice(negativeStart, negativeEnd);
  const editedNegative = applyPromptRules(beforeNegative, rules.negative);

  const edited = value.slice(0, positiveStart)
    + editedPositive
    + value.slice(positiveContentEnd, negativeStart)
    + editedNegative
    + value.slice(negativeEnd);
  return {
    value: edited,
    positiveChanged: editedPositive !== beforePositive,
    negativeChanged: editedNegative !== beforeNegative,
    positiveBefore: beforePositive,
    positiveAfter: editedPositive,
    negativeBefore: beforeNegative,
    negativeAfter: editedNegative,
  };
}

function nodeClassName(node) {
  return String(node?.class_type ?? node?.type ?? node?.name ?? '').toLowerCase();
}

function isSamplerNode(node) {
  return nodeClassName(node).includes('sampler');
}

function isTextNode(node) {
  const className = nodeClassName(node);
  return className.includes('textencode') || className.includes('text_encode') || className.includes('prompt');
}

function normalizeNodeId(value) {
  return value === undefined || value === null ? null : String(value);
}

function extractNodeReference(value) {
  if (Array.isArray(value) && value.length > 0
    && (typeof value[0] === 'string' || typeof value[0] === 'number')) {
    return normalizeNodeId(value[0]);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value.node_id ?? value.nodeId ?? value.origin_id ?? value.originId;
    if (typeof candidate === 'string' || typeof candidate === 'number') return normalizeNodeId(candidate);
  }
  return null;
}

function hasValidNodeId(value) {
  return (typeof value === 'string' && value.trim().length > 0)
    || (typeof value === 'number' && Number.isFinite(value));
}

function hasNodeType(node, keys) {
  return keys.some((key) => typeof node?.[key] === 'string' && node[key].trim().length > 0);
}

function executionGraphEntries(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return [];
  return Object.entries(graph).filter(([id, node]) => hasValidNodeId(id)
    && node && typeof node === 'object'
    && !Array.isArray(node)
    && hasNodeType(node, ['class_type'])
    && node.inputs && typeof node.inputs === 'object'
    && !Array.isArray(node.inputs));
}

function textInputKeys(node) {
  if (!node || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) return [];
  const className = nodeClassName(node);
  return Object.keys(node.inputs).filter((key) => typeof node.inputs[key] === 'string'
    && (key === 'text' || (className.includes('textencode') && key.toLowerCase().includes('text'))));
}

function editExecutionGraph(graph, rules) {
  const entries = executionGraphEntries(graph);
  if (entries.length === 0) return { changed: false, positiveChanged: false, negativeChanged: false };
  const nodes = new Map(entries.map(([id, node]) => [String(id), node]));
  const visited = { positive: new Set(), negative: new Set() };
  const edited = { positive: new Set(), negative: new Set() };
  const result = { changed: false, positiveChanged: false, negativeChanged: false, usable: false };

  function visit(nodeId, side) {
    const normalizedId = normalizeNodeId(nodeId);
    if (normalizedId === null || visited[side].has(normalizedId)) return;
    visited[side].add(normalizedId);
    const node = nodes.get(normalizedId);
    if (!node) return;

    const keys = textInputKeys(node);
    if (keys.length > 0) {
      result.usable = true;
      if (rules[side].length === 0) return;
      if (!edited[side].has(normalizedId)) {
        edited[side].add(normalizedId);
        for (const key of keys) {
          const current = node.inputs[key];
          const next = applyPromptRules(current, rules[side]);
          addPromptExcerpt(result, side, current, next);
          if (next !== current) {
            node.inputs[key] = next;
            result.changed = true;
            result[`${side}Changed`] = true;
          }
        }
      }
      return;
    }

    if (!node.inputs || typeof node.inputs !== 'object') return;
    for (const input of Object.values(node.inputs)) {
      const reference = extractNodeReference(input);
      if (reference !== null) visit(reference, side);
    }
  }

  for (const [, sampler] of entries) {
    if (!isSamplerNode(sampler) || !sampler.inputs || typeof sampler.inputs !== 'object') continue;
    for (const side of ['positive', 'negative']) {
      const value = sampler.inputs[side];
      if (typeof value === 'string') {
        result.usable = true;
        if (rules[side].length === 0) continue;
        const next = applyPromptRules(value, rules[side]);
        addPromptExcerpt(result, side, value, next);
        if (next !== value) {
          sampler.inputs[side] = next;
          result.changed = true;
          result[`${side}Changed`] = true;
        }
        continue;
      }
      const reference = extractNodeReference(value);
      if (reference !== null) visit(reference, side);
    }
  }

  return result;
}

function workflowNodeEntries(graph) {
  return Array.isArray(graph?.nodes)
    ? graph.nodes.filter((node) => node && typeof node === 'object'
      && !Array.isArray(node)
      && hasValidNodeId(node.id)
      && hasNodeType(node, ['class_type', 'type', 'name']))
    : [];
}

function workflowLinkParts(link) {
  if (Array.isArray(link) && link.length >= 3) {
    return { id: String(link[0]), originId: String(link[1]) };
  }
  if (link && typeof link === 'object') {
    const id = link.id ?? link.link_id ?? link.linkId;
    const originId = link.origin_id ?? link.originId ?? link.source_id ?? link.sourceId;
    if (id !== undefined && originId !== undefined) return { id: String(id), originId: String(originId) };
  }
  return null;
}

function workflowTextValues(node) {
  if (node.inputs && !Array.isArray(node.inputs) && typeof node.inputs === 'object') {
    const keys = Object.keys(node.inputs).filter((key) => typeof node.inputs[key] === 'string'
      && (key === 'text' || key.toLowerCase().includes('text')));
    if (keys.length > 0) return { kind: 'object', keys };
  }
  if (Array.isArray(node.widgets_values) && isTextNode(node)) {
    return { kind: 'widgets', keys: [0] };
  }
  return null;
}

function editWorkflowGraph(graph, rules) {
  const nodes = workflowNodeEntries(graph);
  if (nodes.length === 0) return { changed: false, positiveChanged: false, negativeChanged: false };
  const nodesById = new Map(nodes.map((node) => [String(node.id), node]));
  const linksById = new Map();
  for (const link of graph.links || []) {
    const parts = workflowLinkParts(link);
    if (parts) linksById.set(parts.id, parts.originId);
  }
  const visited = { positive: new Set(), negative: new Set() };
  const edited = { positive: new Set(), negative: new Set() };
  const result = { changed: false, positiveChanged: false, negativeChanged: false, usable: false };

  function visit(nodeId, side) {
    const normalizedId = normalizeNodeId(nodeId);
    if (normalizedId === null || visited[side].has(normalizedId)) return;
    visited[side].add(normalizedId);
    const node = nodesById.get(normalizedId);
    if (!node) return;

    const textValues = workflowTextValues(node);
    if (textValues) {
      const hasTextValue = textValues.keys.some((key) => {
        const value = textValues.kind === 'widgets' ? node.widgets_values[key] : node.inputs[key];
        return typeof value === 'string';
      });
      if (hasTextValue) result.usable = true;
      if (!hasTextValue || rules[side].length === 0) return;
      if (edited[side].has(normalizedId)) return;
      edited[side].add(normalizedId);
      for (const key of textValues.keys) {
        const current = textValues.kind === 'widgets' ? node.widgets_values[key] : node.inputs[key];
        const next = applyPromptRules(current, rules[side]);
        addPromptExcerpt(result, side, current, next);
        if (next !== current) {
          if (textValues.kind === 'widgets') node.widgets_values[key] = next;
          else node.inputs[key] = next;
          result.changed = true;
          result[`${side}Changed`] = true;
        }
      }
      return;
    }

    if (Array.isArray(node.inputs)) {
      for (const input of node.inputs) {
        if (input?.link !== undefined && input.link !== null) {
          const originId = linksById.get(String(input.link));
          if (originId !== undefined) visit(originId, side);
        }
      }
    } else if (node.inputs && typeof node.inputs === 'object') {
      for (const input of Object.values(node.inputs)) {
        const reference = extractNodeReference(input);
        if (reference !== null) visit(reference, side);
      }
    }
  }

  for (const sampler of nodes) {
    if (!isSamplerNode(sampler)) continue;
    for (const side of ['positive', 'negative']) {
      const input = Array.isArray(sampler.inputs)
        ? sampler.inputs.find((item) => item?.name === side)
        : sampler.inputs?.[side];
      if (input === undefined || input === null) continue;
      if (typeof input === 'string') {
        result.usable = true;
        if (rules[side].length === 0) continue;
        const next = applyPromptRules(input, rules[side]);
        addPromptExcerpt(result, side, input, next);
        if (next !== input) {
          if (Array.isArray(sampler.inputs)) input.value = next;
          else sampler.inputs[side] = next;
          result.changed = true;
          result[`${side}Changed`] = true;
        }
      } else if (input.link !== undefined) {
        const originId = linksById.get(String(input.link));
        if (originId !== undefined) visit(originId, side);
      } else {
        const reference = extractNodeReference(input);
        if (reference !== null) visit(reference, side);
      }
    }
  }

  return result;
}

function graphCandidates(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const candidates = [];
  if (Array.isArray(value.nodes)) candidates.push(value);
  if (executionGraphEntries(value).length > 0) candidates.push(value);
  for (const key of ['prompt', 'workflow', 'comfyui', 'graph']) {
    if (value[key] && typeof value[key] === 'object') {
      candidates.push(...graphCandidates(value[key], seen));
    }
  }
  return candidates;
}

function editComfyJson(value, rules) {
  let firstResult = { changed: false, positiveChanged: false, negativeChanged: false };
  for (const candidate of graphCandidates(value)) {
    const result = Array.isArray(candidate.nodes)
      ? editWorkflowGraph(candidate, rules)
      : editExecutionGraph(candidate, rules);
    if (result.changed) return result;
    firstResult = result;
  }
  return firstResult;
}

function findUsableWorkflowGraph(value) {
  return graphCandidates(value).find((candidate) => {
    const result = Array.isArray(candidate.nodes)
      ? editWorkflowGraph(candidate, EMPTY_PROMPT_RULES)
      : editExecutionGraph(candidate, EMPTY_PROMPT_RULES);
    return result.usable;
  }) ?? null;
}

function findWorkflowGraph(value) {
  return graphCandidates(value).find((candidate) => (
    Array.isArray(candidate.nodes)
      ? workflowNodeEntries(candidate).length > 0
      : executionGraphEntries(candidate).length > 0
  )) ?? null;
}

function metadataChunks(chunks) {
  const metadata = [];
  let totalTextBytes = 0;
  for (const chunk of chunks) {
    if (!TEXT_CHUNK_TYPES.has(chunk.type)) continue;
    if (chunk.length > PNG_TEXT_CHUNK_MAX_INPUT_BYTES) {
      fail('PNG textual metadata chunk exceeds the maximum input size.', {
        code: 'OVERSIZED_PNG_METADATA',
      });
    }
    const parsed = parseTextChunk(chunk);
    totalTextBytes += parsed.textByteLength;
    if (totalTextBytes > PNG_TOTAL_TEXT_MAX_BYTES) {
      fail('PNG textual metadata exceeds the maximum total size.', {
        code: 'OVERSIZED_PNG_METADATA',
      });
    }
    metadata.push({ chunk, ...parsed, normalizedKey: parsed.key.toLowerCase() });
  }
  return metadata;
}

function findWorkflowMetadata(metadata, findGraph = findUsableWorkflowGraph) {
  for (const candidate of metadata) {
    let parsed;
    try {
      parsed = JSON.parse(candidate.text);
    } catch {
      continue;
    }

    const workflow = findGraph(parsed);
    if (workflow) {
      return {
        target: candidate,
        parsed,
        workflow,
        metadataKey: SUPPORTED_METADATA_KEYS.includes(candidate.normalizedKey)
          ? candidate.normalizedKey
          : candidate.key,
      };
    }
  }
  return null;
}

function parameterSettingValue(settingsSuffix, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|,[\\t ]*)${escapedName}[\\t ]*:[\\t ]?([^,\\r\\n]+)`, 'i')
    .exec(settingsSuffix);
  return match?.[1] ?? null;
}

function parseA1111Number(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || !A1111_NUMBER_PATTERN.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseA1111Loras(...prompts) {
  const loras = [];
  const loraPattern = /<lora:([^\r\n<>]+):([+-]?(?:\d+(?:\.\d+)?|\.\d+))>/gi;
  for (const prompt of prompts) {
    loraPattern.lastIndex = 0;
    let match;
    while ((match = loraPattern.exec(prompt)) && loras.length < A1111_MAX_LORAS) {
      const name = match[1];
      const weight = parseA1111Number(match[2]);
      if (name.trim() && weight !== null) loras.push({ name, weight });
    }
    if (loras.length === A1111_MAX_LORAS) break;
  }
  return loras;
}

function withoutSectionTerminator(value) {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function parseA1111Parameters(value) {
  if (typeof value !== 'string' || value.length === 0) return null;

  const negativeMarker = /^[\t ]*Negative prompt[\t ]*:[\t ]?/im.exec(value);
  const settingsMarker = /^[\t ]*Steps[\t ]*:[\t ]*\d+\b.*$/im.exec(value);
  if (!negativeMarker || !settingsMarker || settingsMarker.index <= negativeMarker.index) return null;

  const positivePrompt = withoutSectionTerminator(
    value.slice(0, negativeMarker.index)
      .replace(/^[\t ]*Positive prompt[\t ]*:[\t ]?/i, '')
  );
  const negativePrompt = withoutSectionTerminator(
    value.slice(negativeMarker.index + negativeMarker[0].length, settingsMarker.index)
  );
  const settingsSuffix = value.slice(settingsMarker.index);
  const steps = parseA1111Number(parameterSettingValue(settingsSuffix, 'Steps'));
  const sampler = parameterSettingValue(settingsSuffix, 'Sampler');
  const cfgScale = parseA1111Number(parameterSettingValue(settingsSuffix, 'CFG scale'));
  const seed = parseA1111Number(parameterSettingValue(settingsSuffix, 'Seed'));
  const size = /^([1-9]\d*)\s*x\s*([1-9]\d*)$/i.exec(
    parameterSettingValue(settingsSuffix, 'Size')?.trim() ?? ''
  );
  const width = size ? Number(size[1]) : null;
  const height = size ? Number(size[2]) : null;

  if (!positivePrompt
    || !Number.isSafeInteger(steps) || steps <= 0
    || !sampler?.trim()
    || cfgScale === null
    || !Number.isSafeInteger(seed)
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return null;
  }

  const model = parameterSettingValue(settingsSuffix, 'Model');
  return {
    format: A1111_PARAMETERS_FORMAT,
    source: 'parameters',
    native_workflow: false,
    positive_prompt: positivePrompt,
    negative_prompt: negativePrompt,
    settings_suffix: settingsSuffix,
    settings: {
      steps,
      sampler,
      cfg_scale: cfgScale,
      seed,
      width,
      height,
      ...(model?.trim() ? { model } : {}),
    },
    loras: parseA1111Loras(positivePrompt, negativePrompt),
  };
}

function findWorkflowMetadataByKey(metadata, normalizedKey) {
  return findWorkflowMetadata(
    metadata.filter((candidate) => candidate.normalizedKey === normalizedKey),
    findWorkflowGraph
  );
}

function findA1111ParametersMetadata(metadata) {
  for (const candidate of metadata) {
    if (candidate.normalizedKey !== 'parameters') continue;
    const workflow = parseA1111Parameters(candidate.text);
    if (workflow) return { metadataKey: 'parameters', workflow };
  }
  return null;
}

function extractWorkflowMetadataFromChunks(chunks) {
  const metadata = metadataChunks(chunks);
  const native = findWorkflowMetadataByKey(metadata, 'workflow')
    ?? findWorkflowMetadataByKey(metadata, 'prompt')
    ?? findWorkflowMetadataByKey(metadata, 'comfyui');
  const match = native ?? findA1111ParametersMetadata(metadata);

  return match
    ? { metadataKey: match.metadataKey, workflow: match.workflow }
    : null;
}

export function extractWorkflowMetadataFromPng(input) {
  const buffer = asBuffer(input);
  return extractWorkflowMetadataFromChunks(parsePngChunks(buffer));
}

/**
 * Inspect PNG textual metadata through a bounded positional reader.
 *
 * @param {(offset: number, length: number) => Buffer} readAt
 * @param {number} byteLength
 * @returns {{ metadataKey: string, workflow: object }|null}
 */
export function extractWorkflowMetadataFromPngReader(readAt, byteLength) {
  return extractWorkflowMetadataFromChunks(readPngTextChunks(readAt, byteLength));
}

function rewriteMetadataChunk(chunks, target, text) {
  const replacement = encodeTextChunk(target, text);
  return Buffer.concat([
    PNG_SIGNATURE,
    ...chunks.map((chunk) => (chunk === target.chunk ? replacement : chunk.raw)),
  ]);
}

export function editWorkflowPromptsInPng(input, rawOptions = {}) {
  const buffer = asBuffer(input);
  const chunks = parsePngChunks(buffer);
  const rules = normalizeOrUsePromptEditOptions(rawOptions);

  const metadata = metadataChunks(chunks);
  const workflow = findWorkflowMetadata(metadata);
  if (workflow) {
    const { target, parsed, metadataKey } = workflow;
    const edited = editComfyJson(parsed, rules);
    if (edited.changed) {
      return {
        buffer: rewriteMetadataChunk(chunks, target, JSON.stringify(parsed)),
        changed: true,
        metadataKey,
        positiveChanged: edited.positiveChanged,
        negativeChanged: edited.negativeChanged,
        beforePositive: edited.positiveBefore ?? null,
        afterPositive: edited.positiveAfter ?? null,
        beforeNegative: edited.negativeBefore ?? null,
        afterNegative: edited.negativeAfter ?? null,
      };
    }

    return {
      buffer,
      changed: false,
      metadataKey,
      positiveChanged: false,
      negativeChanged: false,
      beforePositive: edited.positiveBefore ?? null,
      afterPositive: edited.positiveAfter ?? null,
      beforeNegative: edited.negativeBefore ?? null,
      afterNegative: edited.negativeAfter ?? null,
    };
  }

  const target = metadata.find((candidate) => candidate.normalizedKey === 'parameters'
    && candidate.text.length > 0);
  if (target) {
    const edited = editParametersText(target.text, rules);
    if (edited.positiveChanged || edited.negativeChanged) {
      return {
        buffer: rewriteMetadataChunk(chunks, target, edited.value),
        changed: true,
        metadataKey: target.normalizedKey,
        positiveChanged: edited.positiveChanged,
        negativeChanged: edited.negativeChanged,
        beforePositive: promptExcerpt(edited.positiveBefore),
        afterPositive: promptExcerpt(edited.positiveAfter),
        beforeNegative: promptExcerpt(edited.negativeBefore),
        afterNegative: promptExcerpt(edited.negativeAfter),
      };
    }
    return {
      buffer,
      changed: false,
      metadataKey: target.normalizedKey,
      positiveChanged: false,
      negativeChanged: false,
      beforePositive: promptExcerpt(edited.positiveBefore),
      afterPositive: promptExcerpt(edited.positiveAfter),
      beforeNegative: promptExcerpt(edited.negativeBefore),
      afterNegative: promptExcerpt(edited.negativeAfter),
    };
  }

  return {
    buffer,
    changed: false,
    metadataKey: null,
    positiveChanged: false,
    negativeChanged: false,
    beforePositive: null,
    afterPositive: null,
    beforeNegative: null,
    afterNegative: null,
  };
}

export { PNG_SIGNATURE };
