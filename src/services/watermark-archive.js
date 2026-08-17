import path from 'node:path';

export const WATERMARK_ARCHIVE_KINDS = Object.freeze({
  jpg: 'watermark-archive-jpg',
  webp: 'watermark-archive-webp',
  cbz: 'watermark-cbz',
});

export class WatermarkArchiveError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'WatermarkArchiveError';
    this.code = code;
  }
}

export function validateArchiveNamePart(value, label, { allowEmpty = true } = {}) {
  if (typeof value !== 'string' || /[\\/\u0000-\u001f\u007f]/.test(value)) {
    throw new WatermarkArchiveError(`${label} must be a safe filename component.`, { code: 'INVALID_ARCHIVE_NAME' });
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new WatermarkArchiveError(`${label} must not be empty.`, { code: 'INVALID_ARCHIVE_NAME' });
  }
  if (value === '.' || value === '..') {
    throw new WatermarkArchiveError(`${label} must not be a traversal path.`, { code: 'INVALID_ARCHIVE_NAME' });
  }
  return value;
}

function extensionlessSourcePath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const extension = path.posix.extname(normalized);
  return extension ? normalized.slice(0, -extension.length) : normalized;
}

function selectedVariants(derived, options, target) {
  const variants = [];
  const seen = new Set();
  for (const output of derived.outputs) {
    if (seen.has(output.variant)) continue;
    seen.add(output.variant);
    if (target === 'archive' && output.variant === 'resized' && !options.archiveIncludeResized) continue;
    if (target === 'cbz' && output.variant !== 'single' && output.variant !== options.cbzFrom) continue;
    variants.push(output);
  }
  return variants;
}

function entryFor(sourceRelativePath, output, extension) {
  const entry = `${extensionlessSourcePath(sourceRelativePath)}${output.suffix}.${extension}`;
  if (entry.startsWith('/') || entry.includes('\\') || entry.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new WatermarkArchiveError('Archive entry path is unsafe.', { code: 'ARCHIVE_ENTRY_UNSAFE' });
  }
  return entry;
}

function archiveBase(options) {
  return options.setName.trim() || `${options.archivePrefix}${options.zipBaseName}`;
}

function cbzBase(options, projectSlug) {
  return options.setName.trim() || `${options.cbzPrefix}${projectSlug}`;
}

function archiveRelativePath(options, filename) {
  return options.outputDirectory ? `${options.outputDirectory}/${filename}` : filename;
}

export function deriveWatermarkArchivePlans({ sources, options, projectSlug }) {
  if (!options.makeArchives && !options.makeCbz) return [];
  if (options.archiveResizedOnlyBlocked) {
    throw new WatermarkArchiveError(
      'Refusing to create archives from resized-only output unless resized archive inclusion is explicitly enabled.',
      { code: 'RESIZED_ONLY_ARCHIVE_BLOCKED' },
    );
  }

  const plans = [];
  const addPlan = ({ kind, format, quality, filename, target, extension }) => {
    const entries = sources.flatMap((source) => selectedVariants(source.derivedOutput, options, target).map((output) => ({
      name: entryFor(source.sourceRelativePath, output, extension),
      source,
      variant: output.variant,
      maxDimension: output.maxDimension,
    })));
    const names = new Set();
    for (const entry of entries) {
      if (names.has(entry.name)) {
        throw new WatermarkArchiveError('Two watermark variants would use the same archive entry name.', {
          code: 'ARCHIVE_ENTRY_COLLISION',
        });
      }
      names.add(entry.name);
    }
    plans.push({
      kind,
      format,
      quality,
      relativePath: archiveRelativePath(options, filename),
      entries,
      variants: [...new Set(entries.map((entry) => entry.variant))],
    });
  };

  if (options.makeArchives) {
    const base = archiveBase(options);
    addPlan({
      kind: WATERMARK_ARCHIVE_KINDS.jpg,
      format: options.archiveFormat,
      quality: options.zipJpgQuality,
      filename: `${base}_jpg_q${options.zipJpgQuality}.${options.archiveFormat}`,
      target: 'archive',
      extension: 'jpg',
    });
    addPlan({
      kind: WATERMARK_ARCHIVE_KINDS.webp,
      format: options.archiveFormat,
      quality: options.zipWebpQuality,
      filename: `${base}_webp_q${options.zipWebpQuality}.${options.archiveFormat}`,
      target: 'archive',
      extension: 'webp',
    });
  }
  if (options.makeCbz) {
    const base = cbzBase(options, projectSlug);
    addPlan({
      kind: WATERMARK_ARCHIVE_KINDS.cbz,
      format: 'cbz',
      quality: options.cbzJpgQuality,
      filename: `${base}_jpg_q${options.cbzJpgQuality}.cbz`,
      target: 'cbz',
      extension: 'jpg',
    });
  }
  return plans;
}
