import fs from 'node:fs';
import path from 'node:path';
import { create7zArchive } from './watermark-7z.js';
import { validateArchiveNamePart } from './watermark-archive.js';
import { pathKey } from './asset-processing-contracts.js';

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

function normalizeOutputDirectory(value, { canonical = false } = {}) {
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
  const normalized = value.replace(/\\/g, '/');
  if (canonical) {
    const directory = path.posix.normalize(normalized || '.');
    return directory === '.' ? '' : directory.replace(/\/+$/, '');
  }
  const directory = normalized.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return directory === '.' ? '' : directory;
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

const LEGACY_ARCHIVE_FIELDS = new Set([
  'makeArchives', 'makeCbz', 'archiveFormat', 'zipJpgQuality', 'zipWebpQuality',
  'cbzJpgQuality', 'setName', 'archivePrefix', 'zipBaseName', 'cbzPrefix',
]);
const ARCHIVE_ENTRY_FIELDS = new Set([
  'archiveFormat', 'imageFormat', 'setName', 'prefix', 'baseName', 'quality', 'lossless',
]);

function normalizeEntryName(value, label, options) {
  const name = normalizeName(value, label, options);
  if (/[<>:"|?*]/.test(name)) {
    throw archiveOptionError(`${label} must be a safe filename component.`, 'INVALID_ARCHIVE_NAME');
  }
  return name;
}

function normalizeArchiveEntry(entry, index) {
  const field = `archives[${index}]`;
  try {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw archiveOptionError('must be an archive configuration object.', 'INVALID_ARCHIVE_ENTRY');
    }
    for (const key of Object.keys(entry)) {
      if (!ARCHIVE_ENTRY_FIELDS.has(key)) {
        throw archiveOptionError(`contains an unsupported field: ${key}.`, 'INVALID_ARCHIVE_ENTRY');
      }
    }
    const { archiveFormat, imageFormat } = entry;
    if (!['zip', '7z', 'cbz', 'cb7'].includes(archiveFormat)) {
      throw archiveOptionError('archiveFormat must be zip, 7z, cbz, or cb7.', 'INVALID_ARCHIVE_FORMAT');
    }
    if (!['jpeg', 'webp', 'png'].includes(imageFormat)) {
      throw archiveOptionError('imageFormat must be jpeg, webp, or png.', 'INVALID_ARCHIVE_IMAGE_FORMAT');
    }
    if (Object.hasOwn(entry, 'lossless') && (imageFormat !== 'webp' || typeof entry.lossless !== 'boolean')) {
      throw archiveOptionError('lossless must be a boolean and is valid only for WebP.', 'INVALID_ARCHIVE_LOSSLESS');
    }
    if (imageFormat === 'png' && Object.hasOwn(entry, 'quality')) {
      throw archiveOptionError('quality is valid only for JPEG or WebP.', 'INVALID_ARCHIVE_QUALITY');
    }
    if (Object.hasOwn(entry, 'quality') && (!Number.isInteger(entry.quality) || entry.quality < 1 || entry.quality > 100)) {
      throw archiveOptionError('quality must be an integer from 1 to 100.', 'INVALID_ARCHIVE_QUALITY');
    }
    const comic = archiveFormat === 'cbz' || archiveFormat === 'cb7';
    return {
      archiveFormat,
      imageFormat,
      setName: normalizeEntryName(entry.setName ?? '', 'setName'),
      prefix: normalizeEntryName(entry.prefix ?? (comic ? 'archive_' : ''), 'prefix'),
      ...(!comic || Object.hasOwn(entry, 'baseName') ? {
        baseName: normalizeEntryName(entry.baseName ?? 'archive', 'baseName', { allowEmpty: false }),
      } : {}),
      ...(imageFormat !== 'png' ? {
        quality: archiveQuality(entry, 'quality', imageFormat === 'webp' ? 90 : comic ? 85 : 80),
      } : {}),
      ...(imageFormat === 'webp' ? { lossless: entry.lossless ?? false } : {}),
    };
  } catch (cause) {
    throw archiveOptionError(`${field}: ${cause.message}`, cause.code || 'INVALID_ARCHIVE_ENTRY', cause);
  }
}

export function normalizeArchiveOptions(rawOptions = {}) {
  if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    throw archiveOptionError('Archive options are required.', 'INVALID_OPTIONS');
  }

  if (Object.hasOwn(rawOptions, 'archives')) {
    if (!Array.isArray(rawOptions.archives) || rawOptions.archives.length === 0) {
      throw archiveOptionError('archives must be a nonempty array.', 'INVALID_ARCHIVE_ENTRIES');
    }
    for (const key of Object.keys(rawOptions)) {
      if (LEGACY_ARCHIVE_FIELDS.has(key)) {
        throw archiveOptionError(`archives cannot be combined with legacy field ${key}.`, 'AMBIGUOUS_ARCHIVE_OPTIONS');
      }
      if (!['archives', 'outputDirectory', 'replaceExistingArchives'].includes(key)) {
        throw archiveOptionError(`Archive options contain an unsupported field: ${key}.`, 'INVALID_ARCHIVE_OPTIONS');
      }
    }
    const replaceExistingArchives = rawOptions.replaceExistingArchives ?? false;
    if (typeof replaceExistingArchives !== 'boolean') {
      throw archiveOptionError('replaceExistingArchives must be boolean.', 'INVALID_ARCHIVE_OPTIONS');
    }
    const outputDirectory = normalizeOutputDirectory(rawOptions.outputDirectory ?? '', { canonical: true });
    if (outputDirectory.split('/').some((part) => /[<>:"|?*]|[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw archiveOptionError('The archive output directory must be a safe project-relative path.', 'INVALID_OUTPUT_DIRECTORY');
    }
    const options = {
      archives: Array.from(rawOptions.archives, normalizeArchiveEntry),
      outputDirectory,
      replaceExistingArchives,
    };
    return options;
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
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || /[\u0000-\u001f\u007f]/.test(normalized)
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

function addPlan(plans, {
  kind, format, containerFormat, quality, filename, extension, sources, options,
  imageFormat, lossless, configurationIndex = plans.length,
}) {
  const entries = sources.map((source) => ({
    name: replaceExtension(source.sourceRelativePath, extension),
    source,
  }));
  const names = new Map();
  for (const entry of entries) {
    // Archives must extract safely on case-insensitive filesystems on every host.
    const key = entry.name.toLowerCase();
    if (names.has(key)) {
      throw archiveOptionError(
        `Archive ${filename} has conflicting entry names: "${names.get(key)}" and "${entry.name}".`,
        'ARCHIVE_ENTRY_COLLISION',
      );
    }
    names.set(key, entry.name);
  }
  plans.push({
    kind,
    format,
    containerFormat,
    quality,
    configurationIndex,
    imageFormat: imageFormat || (extension === 'jpg' ? 'jpeg' : extension),
    ...(extension === 'webp' ? { lossless: lossless ?? false } : {}),
    relativePath: archiveRelativePath(options, filename),
    entries,
    variants: ['source'],
  });
}

export function deriveArchivePlans({ sources, options, projectSlug }) {
  if (!Array.isArray(sources)) {
    throw archiveOptionError('Archive sources are required.', 'INVALID_ARCHIVE_SOURCES');
  }
  if (options.archives) {
    const plans = [];
    const destinations = new Map();
    for (const [configurationIndex, entry] of options.archives.entries()) {
      try {
        const { archiveFormat, imageFormat, quality, lossless } = entry;
        const base = entry.setName.trim() || `${entry.prefix}${entry.baseName
          ?? normalizeEntryName(String(projectSlug || 'project'), 'projectSlug', { allowEmpty: false })}`;
        const extension = imageFormat === 'jpeg' ? 'jpg' : imageFormat;
        const suffix = imageFormat === 'png' ? 'png'
          : lossless ? 'webp_lossless' : `${extension}_q${quality}`;
        const filename = `${base}_${suffix}.${archiveFormat}`;
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) {
          throw archiveOptionError('The archive filename must not use a reserved device name.', 'INVALID_ARCHIVE_NAME');
        }
        const relativePath = archiveRelativePath(options, filename);
        const key = pathKey(relativePath);
        if (destinations.has(key)) {
          throw archiveOptionError(`destination ${relativePath} duplicates archives[${destinations.get(key)}].`, 'INTRA_BATCH_COLLISION');
        }
        destinations.set(key, configurationIndex);
        addPlan(plans, {
          configurationIndex,
          kind: archiveFormat === 'cbz' && imageFormat === 'jpeg' ? STANDALONE_ARCHIVE_KINDS.cbz
            : STANDALONE_ARCHIVE_KINDS[imageFormat === 'jpeg' ? 'jpg' : imageFormat] || `archive-${imageFormat}`,
          format: archiveFormat,
          containerFormat: archiveFormat === 'cbz' ? 'zip' : archiveFormat === 'cb7' ? '7z' : archiveFormat,
          imageFormat, quality, lossless, filename,
          extension,
          sources, options,
        });
      } catch (cause) {
        throw archiveOptionError(`archives[${configurationIndex}]: ${cause.message}`, cause.code || 'ARCHIVE_PRECHECK_FAILED', cause);
      }
    }
    return plans;
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

async function writeZipArchive(filePath, entries, descriptor) {
  const { default: yazl } = await import('yazl');
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    // A caller-owned descriptor stays open for the caller to verify and close.
    const output = descriptor === undefined
      ? fs.createWriteStream(filePath, { flags: 'wx' })
      : fs.createWriteStream(null, { fd: descriptor, autoClose: false });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    output.once('error', finish);
    output.once(descriptor === undefined ? 'close' : 'finish', () => finish());
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

/**
 * Writes an archive exclusively at `filePath`, or into `descriptor` when the caller already
 * created the file exclusively and owns that open descriptor (the caller closes it).
 */
export async function writeArchiveFile(filePath, format, entries, { descriptor } = {}) {
  try {
    if (!['zip', '7z', 'cbz', 'cb7'].includes(format)) {
      throw archiveOptionError('archiveFormat must be zip, 7z, cbz, or cb7.', 'INVALID_ARCHIVE_FORMAT');
    }
    if (format === '7z' || format === 'cb7') {
      const bytes = await create7zArchive(entries);
      if (descriptor === undefined) fs.writeFileSync(filePath, bytes, { flag: 'wx' });
      else fs.writeFileSync(descriptor, bytes);
    } else {
      await writeZipArchive(filePath, entries, descriptor);
    }
  } catch (cause) {
    if (cause instanceof ArchiveProcessingError) throw cause;
    throw new ArchiveProcessingError('Archive container creation failed.', {
      code: 'ARCHIVE_BUILD_FAILED',
      cause,
    });
  }
}
