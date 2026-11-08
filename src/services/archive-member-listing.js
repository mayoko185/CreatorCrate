// Parses and validates `7zz l -slt` output produced by archive-member-decoder-worker.js.
// Pure functions: the parent process runs them, so a decoder cannot vouch for its own listing.

export class ArchiveDecoderError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = 'ArchiveDecoderError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export const ARCHIVE_INPUT_PATH = '/in/archive';

const LINE_PATTERN = /^([A-Z][A-Za-z0-9 ]*?) =(?: (.*))?$/;
const HEADER_FAILURE_KEYS = new Set(['ERROR', 'ERRORS', 'WARNING', 'WARNINGS', 'Open WARNING', 'Open ERROR']);
const FOOTER_PATTERN = /^(Errors|Warnings): \d+$/;
const DIGITS = /^\d+$/;
const CRC_PATTERN = /^[0-9A-F]{8}$/;
// Windows attribute letters 7-Zip prints: RHS8DAdNTsLCOnE plus extension markers.
const WIN_ATTRIBUTES = /^[RHS8DAdNTsLCOnEV_]*$/;
const LINK_KEYS = ['Symbolic Link', 'Hard Link', 'Copy Link'];
// C0, DEL and C1 controls; 7-Zip 26.06 already prints them as "_", this is defence in depth.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function fail(code, message) {
  throw new ArchiveDecoderError(code, message);
}

function splitLines(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function parseKeyValue(line) {
  const match = LINE_PATTERN.exec(line);
  return match ? { key: match[1], value: match[2] ?? '' } : null;
}

// Returns null when the archive header section is missing (open failure).
export function parseArchiveHeader(lines) {
  const start = lines.indexOf('Listing archive: ' + ARCHIVE_INPUT_PATH);
  if (start < 0 || lines[start + 2] !== '--') return null;
  const header = new Map();
  const problems = [];
  let index = start + 3;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '----------' || line === '') break;
    const pair = parseKeyValue(line);
    if (!pair) {
      problems.push(line);
      continue;
    }
    // 7-Zip prints multi-line values as "Key = " + "{" ... "}" with raw inner lines. Only an
    // archive comment may span lines; injected lines can then only add or duplicate header
    // keys, and the real "----------" separator still has to follow.
    if (pair.key === 'Comment' && pair.value === '' && lines[index + 1] === '{') {
      const close = lines.indexOf('}', index + 2);
      if (close < 0) {
        problems.push(line);
        break;
      }
      index = close;
    }
    if (HEADER_FAILURE_KEYS.has(pair.key)) problems.push(line);
    if (header.has(pair.key)) problems.push(line);
    header.set(pair.key, pair.value);
  }
  return { header, problems, end: index };
}

// Value forms: "", "A", "A -rw-r--r--", " lrwxrwxrwx" (Windows letters, space, Unix mode).
function classifyAttributes(value) {
  if (value === '') return { win: '', unixType: null };
  const space = value.indexOf(' ');
  const win = space < 0 ? value : value.slice(0, space);
  const unix = space < 0 ? '' : value.slice(space + 1);
  if (!WIN_ATTRIBUTES.test(win) || (space >= 0 && !/^\S{10}$/.test(unix))) return null;
  return { win, unixType: unix ? unix[0] : null };
}

// RAR prints "Folder"; 7z only marks directories through attributes.
function entryType(record) {
  const folder = record.get('Folder');
  if (folder !== undefined && folder !== '+' && folder !== '-') return null;
  if (record.get('Alternate Stream') === '+') return 'unsupported';
  if (LINK_KEYS.some((key) => (record.get(key) ?? '') !== '')) return 'unsupported';
  if (/(^|\s)Link:/.test(record.get('Characteristics') ?? '')) return 'unsupported';
  const attributes = classifyAttributes(record.get('Attributes') ?? '');
  if (!attributes) return 'unsupported';
  const { win, unixType } = attributes;
  if (/[L8d]/.test(win)) return 'unsupported';
  const directoryAttribute = win.includes('D') || unixType === 'd';
  if (folder === '+' || (folder === undefined && directoryAttribute)) {
    return unixType === null || unixType === 'd' ? 'directory' : 'unsupported';
  }
  if (directoryAttribute) return 'unsupported';
  return unixType === null || unixType === '-' ? 'file' : 'unsupported';
}

export function assertSafeMemberPath(memberPath, maxPathLength) {
  if (typeof memberPath !== 'string' || memberPath.length === 0 || memberPath.length > maxPathLength) {
    fail('ARCHIVE_ENTRY_UNSAFE', 'Archive member path is empty or too long.');
  }
  if (!memberPath.isWellFormed()
    || CONTROL_CHARS.test(memberPath)
    || memberPath.includes('\\')
    || memberPath.startsWith('/')
    || /^[A-Za-z]:/.test(memberPath)
    || memberPath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail('ARCHIVE_ENTRY_UNSAFE', 'Archive member path is unsafe.');
  }
}

function parseSize(value, label) {
  if (!DIGITS.test(value)) fail('ARCHIVE_CORRUPT', 'Archive listing has an invalid ' + label + '.');
  const size = Number(value);
  if (!Number.isSafeInteger(size)) fail('ARCHIVE_CORRUPT', 'Archive listing has an invalid ' + label + '.');
  return size;
}

function toEntry(record, index, maxPathLength) {
  const path = record.get('Path');
  assertSafeMemberPath(path, maxPathLength);
  if (record.get('Encrypted') === '+') fail('ARCHIVE_ENCRYPTED', 'Encrypted archive members are not supported.');
  if (record.get('Split Before') === '+' || record.get('Split After') === '+') {
    fail('ARCHIVE_MULTIVOLUME', 'Multi-volume archives are not supported.');
  }
  const type = entryType(record);
  if (type === null) fail('ARCHIVE_CORRUPT', 'Archive listing has an invalid entry type.');
  const sizeText = record.get('Size') ?? '';
  if (type === 'file' && sizeText === '') fail('ARCHIVE_CORRUPT', 'Archive file entry has no size.');
  const packedText = record.get('Packed Size') ?? '';
  const crc = record.get('CRC') ?? '';
  if (crc !== '' && !CRC_PATTERN.test(crc)) fail('ARCHIVE_CORRUPT', 'Archive listing has an invalid CRC.');
  return {
    index,
    path,
    type,
    size: sizeText === '' ? 0 : parseSize(sizeText, 'size'),
    packedSize: packedText === '' ? null : parseSize(packedText, 'packed size'),
    crc32: type === 'file' && crc !== '' ? Number.parseInt(crc, 16) : null,
    modified: record.get('Modified') || null,
  };
}

function parseRecords(lines, start, { maxEntries, maxPathLength, checkpoint }) {
  const entries = [];
  let record = null;
  let index = start;
  const close = () => {
    if (!record) return;
    checkpoint();
    if (!record.has('Path')) fail('ARCHIVE_CORRUPT', 'Archive listing record has no path.');
    entries.push(toEntry(record, entries.length, maxPathLength));
    record = null;
  };
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '') {
      close();
      continue;
    }
    if (FOOTER_PATTERN.test(line)) break;
    const pair = parseKeyValue(line);
    if (!pair) fail('ARCHIVE_CORRUPT', 'Archive listing is malformed.');
    if (!record) {
      if (pair.key !== 'Path') fail('ARCHIVE_CORRUPT', 'Archive listing is malformed.');
      if (entries.length >= maxEntries) fail('ENTRY_LIMIT_EXCEEDED', 'Archive has too many entries.');
      record = new Map();
    } else if (record.has(pair.key)) {
      fail('ARCHIVE_CORRUPT', 'Archive listing is ambiguous.');
    }
    record.set(pair.key, pair.value);
  }
  close();
  if (index < lines.length) fail('ARCHIVE_CORRUPT', 'The decoder reported archive errors.');
  return entries;
}

// First index whose path is >= target, in an array sorted by UTF-16 code units.
function lowerBound(sorted, target) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

// entries: [{ path, type: 'file'|'directory'|'unsupported' }]. Also used by the CBZ page reader.
export function assertUnambiguous(entries, checkpoint = NO_CHECKPOINT) {
  const exact = new Map();
  const folded = new Set();
  for (const entry of entries) {
    checkpoint();
    const previous = exact.get(entry.path);
    if (previous && (previous !== 'directory' || entry.type !== 'directory')) {
      fail('ARCHIVE_ENTRY_AMBIGUOUS', 'Archive contains duplicate member paths.');
    }
    exact.set(entry.path, entry.type);
    if (entry.type === 'directory' || previous) continue;
    const key = entry.path.normalize('NFC').toLowerCase();
    if (folded.has(key)) fail('ARCHIVE_ENTRY_AMBIGUOUS', 'Archive contains member paths that differ only by case or normalization.');
    folded.add(key);
  }
  // A non-directory entry must not be an ancestor of another entry. In code-unit order every
  // path starting with "P/" sits in one run that begins at the insertion point of "P/", so one
  // binary search per entry finds a descendant. Storage stays one array of the existing path
  // strings; ancestor prefixes are never built, so memory does not grow with path depth.
  const sorted = [...exact.keys()].sort();
  for (const [path, type] of exact) {
    checkpoint();
    if (type === 'directory') continue;
    const prefix = path + '/';
    const next = sorted[lowerBound(sorted, prefix)];
    if (next !== undefined && next.startsWith(prefix)) {
      fail('ARCHIVE_ENTRY_AMBIGUOUS', 'Archive uses a member path as both a file and a directory.');
    }
  }
}

export function classifyDecoderDiagnostics(text) {
  if (/wrong password|encrypted/i.test(text)) return ['ARCHIVE_ENCRYPTED', 'Encrypted archives are not supported.'];
  if (/missing volume|multivolume/i.test(text)) return ['ARCHIVE_MULTIVOLUME', 'Multi-volume archives are not supported.'];
  if (/allocate|memory/i.test(text)) return ['MEMORY_LIMIT_EXCEEDED', 'The archive needs more decoder memory than allowed.'];
  return null;
}

const NO_CHECKPOINT = () => {};

// expectedType is the 7-Zip handler name chosen from the file signature: 7z, Rar or Rar5.
// checkpoint is called between records and collision checks; it throws to stop validation
// once the job's deadline has passed or the job was cancelled.
export function interpretListing({ exitCode, stdout, stderr }, {
  expectedType, inputSize, maxEntries, maxPathLength, checkpoint = NO_CHECKPOINT,
}) {
  const lines = splitLines(stdout);
  const parsed = parseArchiveHeader(lines);
  const header = parsed?.header ?? new Map();
  const diagnostics = [stderr, ...(parsed?.problems ?? [])].join('\n');

  if (header.get('Encrypted') === '+') fail('ARCHIVE_ENCRYPTED', 'Encrypted archives are not supported.');
  if (header.get('Multivolume') === '+' || (header.has('Volumes') && header.get('Volumes') !== '1')) {
    fail('ARCHIVE_MULTIVOLUME', 'Multi-volume archives are not supported.');
  }
  const diagnosed = classifyDecoderDiagnostics(diagnostics);
  if (diagnosed && (exitCode !== 0 || stderr.trim() !== '' || parsed?.problems.length)) fail(...diagnosed);
  if (exitCode !== 0 || stderr.trim() !== '' || !parsed || parsed.problems.length > 0) {
    fail('ARCHIVE_CORRUPT', 'The archive could not be read.');
  }
  if (header.get('Path') !== ARCHIVE_INPUT_PATH || header.get('Type') !== expectedType) {
    fail('UNSUPPORTED_FORMAT', 'The archive format does not match its signature.');
  }
  if (header.has('Offset') && header.get('Offset') !== '0') fail('UNSUPPORTED_FORMAT', 'Embedded archives are not supported.');
  if (parseSize(header.get('Physical Size') ?? '', 'physical size') !== inputSize) {
    fail('ARCHIVE_CORRUPT', 'The archive size does not match its contents.');
  }
  // The header ends with one blank line, then the entry separator.
  if (lines[parsed.end] !== '' || lines[parsed.end + 1] !== '----------') {
    fail('ARCHIVE_CORRUPT', 'Archive listing is malformed.');
  }

  const entries = parseRecords(lines, parsed.end + 2, { maxEntries, maxPathLength, checkpoint });
  assertUnambiguous(entries, checkpoint);
  return { solid: header.get('Solid') === '+', entries };
}
