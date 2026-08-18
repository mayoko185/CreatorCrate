import fs from 'node:fs';
import path from 'node:path';
import { create7zArchive } from './watermark-7z.js';
import { validateArchiveNamePart } from './watermark-archive.js';

export const ARCHIVES_GENERATED_BY = 'archives';

export const STANDALONE_ARCHIVE_KINDS = Object.freeze({
  jpg: 'archive-jpg',
  webp: 'archive-webp',
  cbz: 'archive-cbz',
});

export const ARCHIVE_SOURCE_IMAGE_EXTENSIONS = Object.freeze(new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'tif',
  'tiff',
  'bmp',
  'gif',
]));

export class ArchiveProcessingError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = 'ArchiveProcessingError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function archiveOptionError(message, code, cause) {
  return new ArchiveProcessingError(message, { code, cause });
}

function normalizeOutputDirectory(value) {
  if (typeof value !== 'string'
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.startsWith('/')
    || value.startsWith('\\')
    || /^[a-zA-Z]:/.test(value)
    || value.split(/[\\/]/).some((part) => part === '..')) {
    throw archiveOptionError(
      'The archive output directory must be a safe project-relative path.',
      'INVALID_OUTPUT_DIRECTORY',
    );
  }
  return value.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '');
}

function normalizeName(value, label, { allowEmpty = true } = {}) {
  try {
    return validateArchiveNamePart(value, label, { allowEmpty });
  } catch (cause) {
    throw archiveOptionError(cause.message, cause.code || 'INVALID_ARCHIVE_NAME', cause);
  }
}

function archiveQuality(rawOptions, name, defaultValue) {
  const value = rawOptions[name] ?? defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw archiveOptionError(
      `${name} must be an integer from 1 to 100.`,
      'INVALID_ARCHIVE_QUALITY',
    );
  }
  return value;
}

export function normalizeArchiveOptions(rawOptions = {}) {
  if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    throw archiveOptionError('Archive options are required.', 'INVALID_OPTIONS');
  }

  const makeArchives = rawOptions.makeArchives ?? true;
  const makeCbz = rawOptions.makeCbz ?? false;
  const replaceExistingArchives = rawOptions.replaceExistingArchives ?? false;
  if (![makeArchives, makeCbz, replaceExistingArchives].every((value) => typeof value === 'boolean')) {
    throw archiveOptionError('Archive options must be boolean values.', 'INVALID_ARCHIVE_OPTIONS');
  }

  const archiveFormat = rawOptions.archiveFormat ?? 'zip';
  if (!['zip', '7z'].includes(archiveFormat)) {
    throw archiveOptionError('archiveFormat must be zip or 7z.', 'INVALID_ARCHIVE_FORMAT');
  }

  const setName = normalizeName(rawOptions.setName ?? '', 'setName');
  const archivePrefix = normalizeName(rawOptions.archivePrefix ?? '', 'archivePrefix');
  const zipBaseName = normalizeName(rawOptions.zipBaseName ?? 'archive', 'zipBaseName', { allowEmpty: false });
  const cbzPrefix = normalizeName(rawOptions.cbzPrefix ?? 'archive_', 'cbzPrefix');
  const outputDirectory = normalizeOutputDirectory(rawOptions.outputDirectory ?? '');

  if (!setName.trim() && !`${archivePrefix}${zipBaseName}`.trim()) {
    throw archiveOptionError('The archive filename must not be empty.', 'INVALID_ARCHIVE_NAME');
  }

  return {
    makeArchives,
    makeCbz,
    archiveFormat,
    zipJpgQuality: archiveQuality(rawOptions, 'zipJpgQuality', 80),
    zipWebpQuality: archiveQuality(rawOptions, 'zipWebpQuality', 90),
    cbzJpgQuality: archiveQuality(rawOptions, 'cbzJpgQuality', 85),
    setName,
    archivePrefix,
    zipBaseName,
    cbzPrefix,
    outputDirectory,
    replaceExistingArchives,
  };
}

function normalizeEntryPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw archiveOptionError('Archive source path is invalid.', 'ARCHIVE_ENTRY_UNSAFE');
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/')
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw archiveOptionError('Archive entry path is unsafe.', 'ARCHIVE_ENTRY_UNSAFE');
  }
  return normalized;
}

function replaceExtension(relativePath, extension) {
  const normalized = normalizeEntryPath(relativePath);
  const sourceExtension = path.posix.extname(normalized);
  const stem = sourceExtension ? normalized.slice(0, -sourceExtension.length) : normalized;
  return `${stem}.${extension}`;
}

function archiveRelativePath(options, filename) {
  return options.outputDirectory ? `${options.outputDirectory}/${filename}` : filename;
}

function archiveBase(options) {
  return options.setName.trim() || `${options.archivePrefix}${options.zipBaseName}`;
}

function cbzBase(options, projectSlug) {
  return options.setName.trim() || `${options.cbzPrefix}${projectSlug}`;
}

function addPlan(plans, { kind, format, containerFormat, quality, filename, extension, sources, options }) {
  const entries = sources.map((source) => ({
    name: replaceExtension(source.sourceRelativePath, extension),
    source,
  }));
  const names = new Set();
  for (const entry of entries) {
    if (names.has(entry.name)) {
      throw archiveOptionError('Two archive sources would use the same entry name.', 'ARCHIVE_ENTRY_COLLISION');
    }
    names.add(entry.name);
  }
  plans.push({
    kind,
    format,
    containerFormat,
    quality,
    relativePath: archiveRelativePath(options, filename),
    entries,
    variants: ['source'],
  });
}

export function deriveArchivePlans({ sources, options, projectSlug }) {
  if (!Array.isArray(sources)) {
    throw archiveOptionError('Archive sources are required.', 'INVALID_ARCHIVE_SOURCES');
  }
  if (!options.makeArchives && !options.makeCbz) return [];

  const plans = [];
  if (options.makeArchives) {
    const base = archiveBase(options);
    addPlan(plans, {
      kind: STANDALONE_ARCHIVE_KINDS.jpg,
      format: options.archiveFormat,
      containerFormat: options.archiveFormat,
      quality: options.zipJpgQuality,
      filename: `${base}_jpg_q${options.zipJpgQuality}.${options.archiveFormat}`,
      extension: 'jpg',
      sources,
      options,
    });
    addPlan(plans, {
      kind: STANDALONE_ARCHIVE_KINDS.webp,
      format: options.archiveFormat,
      containerFormat: options.archiveFormat,
      quality: options.zipWebpQuality,
      filename: `${base}_webp_q${options.zipWebpQuality}.${options.archiveFormat}`,
      extension: 'webp',
      sources,
      options,
    });
  }
  if (options.makeCbz) {
    const normalizedSlug = normalizeName(String(projectSlug || 'project'), 'projectSlug', { allowEmpty: false });
    const base = cbzBase(options, normalizedSlug);
    addPlan(plans, {
      kind: STANDALONE_ARCHIVE_KINDS.cbz,
      format: 'cbz',
      containerFormat: 'zip',
      quality: options.cbzJpgQuality,
      filename: `${base}_jpg_q${options.cbzJpgQuality}.cbz`,
      extension: 'jpg',
      sources,
      options,
    });
  }
  return plans;
}

async function writeZipArchive(filePath, entries) {
  const { default: yazl } = await import('yazl');
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(filePath, { flags: 'wx' });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    output.once('error', finish);
    output.once('close', () => finish());
    zip.outputStream.once('error', finish);
    zip.outputStream.pipe(output);
    try {
      for (const entry of entries) {
        zip.addBuffer(entry.buffer, entry.name, {
          compress: true,
          mtime: new Date('1980-01-01T00:00:00.000Z'),
        });
      }
      zip.end();
    } catch (err) {
      output.destroy();
      finish(err);
    }
  });
}

export async function writeArchiveFile(filePath, format, entries) {
  try {
    if (format === '7z') {
      fs.writeFileSync(filePath, await create7zArchive(entries), { flag: 'wx' });
    } else {
      await writeZipArchive(filePath, entries);
    }
  } catch (cause) {
    if (cause instanceof ArchiveProcessingError) throw cause;
    throw new ArchiveProcessingError('Archive container creation failed.', {
      code: 'ARCHIVE_BUILD_FAILED',
      cause,
    });
  }
}
