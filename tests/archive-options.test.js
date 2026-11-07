import { describe, expect, it } from 'vitest';
import { deriveArchivePlans, normalizeArchiveOptions } from '../src/services/archive-processing.js';

const jpeg = { archiveFormat: 'zip', imageFormat: 'jpeg' };
const sources = [{ sourceRelativePath: 'Final/nested/second.png' }, { sourceRelativePath: 'Final/first.webp' }];
function plans(rawOptions, selectedSources = sources, projectSlug = 'project-slug') {
  return deriveArchivePlans({ sources: selectedSources, options: normalizeArchiveOptions(rawOptions), projectSlug });
}

describe('archive request contract', () => {
  it('preserves legacy defaults, filenames, output directory, ordering, and repeated normalization', () => {
    const options = normalizeArchiveOptions({ makeCbz: true });
    expect(options).toEqual({
      makeArchives: true, makeCbz: true, archiveFormat: 'zip',
      zipJpgQuality: 80, zipWebpQuality: 90, cbzJpgQuality: 85,
      setName: '', archivePrefix: '', zipBaseName: 'archive', cbzPrefix: 'archive_',
      outputDirectory: '', replaceExistingArchives: false,
    });
    expect(normalizeArchiveOptions(normalizeArchiveOptions(options))).toEqual(options);
    expect(plans(options).map((plan) => plan.relativePath)).toEqual([
      'archive_jpg_q80.zip', 'archive_webp_q90.zip', 'archive_project-slug_jpg_q85.cbz',
    ]);
    const named = plans({ makeCbz: true, archiveFormat: '7z', setName: ' Set ',
      archivePrefix: 'ignored', zipBaseName: 'ignored', cbzPrefix: 'ignored', outputDirectory: 'Exports\\nested/' });
    expect(named.map((plan) => plan.relativePath)).toEqual([
      'Exports/nested/Set_jpg_q80.7z', 'Exports/nested/Set_webp_q90.7z', 'Exports/nested/Set_jpg_q85.cbz',
    ]);
    expect(named[0].entries.map((entry) => entry.name)).toEqual(['Final/nested/second.jpg', 'Final/first.jpg']);
    expect(plans({ makeArchives: false, makeCbz: false })).toEqual([]);
    expect(plans({ archivePrefix: 'custom-', zipBaseName: 'base', makeCbz: true, cbzPrefix: 'book-' })
      .map((plan) => plan.relativePath)).toEqual([
      'custom-base_jpg_q80.zip', 'custom-base_webp_q90.zip', 'book-project-slug_jpg_q85.cbz',
    ]);
  });

  it('represents the same legacy outputs as independent configurations', () => {
    const legacy = plans({ makeCbz: true });
    const explicit = plans({ archives: [jpeg, { archiveFormat: 'zip', imageFormat: 'webp' },
      { archiveFormat: 'cbz', imageFormat: 'jpeg' }] });
    expect(explicit).toEqual(legacy);
  });

  it.each(['zip', '7z', 'cbz', 'cb7'].flatMap((archiveFormat) =>
    ['jpeg', 'webp', 'png'].map((imageFormat) => [archiveFormat, imageFormat])))
  ('plans %s / %s with the correct container, member extensions, and defaults', (archiveFormat, imageFormat) => {
    const [plan] = plans({ archives: [{ archiveFormat, imageFormat }] });
    expect(plan).toMatchObject({ configurationIndex: 0, format: archiveFormat, imageFormat,
      containerFormat: ['7z', 'cb7'].includes(archiveFormat) ? '7z' : 'zip' });
    expect(plan.relativePath.endsWith(`.${archiveFormat}`)).toBe(true);
    const extension = imageFormat === 'jpeg' ? 'jpg' : imageFormat;
    expect(plan.entries.map((entry) => entry.name)).toEqual([`Final/nested/second.${extension}`, `Final/first.${extension}`]);
    if (imageFormat === 'png') expect(plan.quality).toBeUndefined();
    else expect(plan.quality).toBe(imageFormat === 'webp' ? 90 : ['cbz', 'cb7'].includes(archiveFormat) ? 85 : 80);
    if (imageFormat === 'webp') expect(plan.lossless).toBe(false);
  });

  it('derives independent names and distinguishes PNG and lossless WebP', () => {
    const output = plans({ outputDirectory: './Exports//nested/', archives: [
      { ...jpeg, setName: ' Set ', prefix: 'ignored-', baseName: 'ignored', quality: 71 },
      { archiveFormat: '7z', imageFormat: 'webp', prefix: 'pre-', baseName: 'base', quality: 82 },
      { archiveFormat: 'zip', imageFormat: 'webp', setName: 'Set', lossless: true },
      { archiveFormat: 'cb7', imageFormat: 'png', setName: 'Set' },
    ] });
    expect(output.map((plan) => plan.relativePath)).toEqual([
      'Exports/nested/Set_jpg_q71.zip', 'Exports/nested/pre-base_webp_q82.7z',
      'Exports/nested/Set_webp_lossless.zip', 'Exports/nested/Set_png.cb7',
    ]);
    expect(output.map((plan) => plan.configurationIndex)).toEqual([0, 1, 2, 3]);
  });

  it.each(['', '.', '././Exports//nested/', '.hidden', '..hidden', 'Exports\\nested\\'])
  ('normalizes explicit options idempotently with directory %s', (outputDirectory) => {
    const raw = { outputDirectory, replaceExistingArchives: true, archives: [jpeg,
      { archiveFormat: 'cbz', imageFormat: 'jpeg' },
      { archiveFormat: 'cb7', imageFormat: 'webp', lossless: true },
      { archiveFormat: 'zip', imageFormat: 'png' }] };
    const normalized = normalizeArchiveOptions(raw);
    const repeated = normalizeArchiveOptions(normalizeArchiveOptions(JSON.parse(JSON.stringify(normalized))));
    expect(repeated).toEqual(normalized);
    expect(plans(repeated)).toEqual(plans(raw));
    expect(raw.archives[0]).toEqual(jpeg);
  });

  it.each(['.', '././Exports/', '.hidden', '..hidden'])
  ('keeps legacy relative output directory %s stable across Preview, Apply, and execution normalization', (outputDirectory) => {
    const first = normalizeArchiveOptions({ outputDirectory });
    expect(normalizeArchiveOptions(normalizeArchiveOptions(first))).toEqual(first);
    if (outputDirectory.startsWith('.hidden') || outputDirectory.startsWith('..hidden')) {
      expect(first.outputDirectory).toBe(outputDirectory);
    }
  });

  it.each(['CON.txt', 'aux.book', 'LPT1.comic'])('rejects reserved final filename %s', (setName) => {
    expect(() => plans({ archives: [{ ...jpeg, setName }] }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARCHIVE_NAME', message: expect.stringContaining('archives[0]') }));
  });

  it.each([[], null, {}, 'zip', [null], [false], [[]], new Array(1)])('rejects empty or malformed archives %j', (archives) => {
    expect(() => normalizeArchiveOptions({ archives })).toThrow(/archives/);
  });

  it.each([
    [{ archiveFormat: 'rar' }, 'INVALID_ARCHIVE_FORMAT'],
    [{ archiveFormat: 'cbr' }, 'INVALID_ARCHIVE_FORMAT'],
    [{ archiveFormat: 'ZIP' }, 'INVALID_ARCHIVE_FORMAT'],
    [{ archiveFormat: null }, 'INVALID_ARCHIVE_FORMAT'],
    [{ imageFormat: 'gif' }, 'INVALID_ARCHIVE_IMAGE_FORMAT'],
    [{ imageFormat: 'jpg' }, 'INVALID_ARCHIVE_IMAGE_FORMAT'],
    ...[0, 101, 1.5, '80', null, true, NaN].map((quality) => [{ quality }, 'INVALID_ARCHIVE_QUALITY']),
    [{ imageFormat: 'png', quality: 80 }, 'INVALID_ARCHIVE_QUALITY'],
    [{ lossless: false }, 'INVALID_ARCHIVE_LOSSLESS'],
    [{ imageFormat: 'webp', lossless: 'true' }, 'INVALID_ARCHIVE_LOSSLESS'],
    [{ imageFormat: 'webp', lossless: null }, 'INVALID_ARCHIVE_LOSSLESS'],
    [{ imageFormat: 'png', lossless: true }, 'INVALID_ARCHIVE_LOSSLESS'],
    [{ setName: '../escape' }, 'INVALID_ARCHIVE_NAME'],
    [{ prefix: 'bad\\prefix' }, 'INVALID_ARCHIVE_NAME'],
    [{ baseName: '' }, 'INVALID_ARCHIVE_NAME'],
    [{ setName: 'bad:name' }, 'INVALID_ARCHIVE_NAME'],
    [{ baseName: '..' }, 'INVALID_ARCHIVE_NAME'],
    [{ prefix: '\u0000' }, 'INVALID_ARCHIVE_NAME'],
    [{ outputDirectory: '../escape' }, 'INVALID_ARCHIVE_ENTRY'],
    [{ replaceExistingArchives: true }, 'INVALID_ARCHIVE_ENTRY'],
    [{ cbr: true }, 'INVALID_ARCHIVE_ENTRY'],
  ])('rejects invalid per-entry settings %j with an indexed error', (overrides, code) => {
    expect(() => normalizeArchiveOptions({ archives: [jpeg, { ...jpeg, ...overrides }] }))
      .toThrow(expect.objectContaining({ code, message: expect.stringContaining('archives[1]') }));
  });

  it.each([1, 100])('accepts quality boundary %i', (quality) => {
    expect(normalizeArchiveOptions({ archives: [{ ...jpeg, quality }] }).archives[0].quality).toBe(quality);
  });

  it.each(['makeArchives', 'makeCbz', 'archiveFormat', 'zipJpgQuality', 'zipWebpQuality', 'cbzJpgQuality',
    'setName', 'archivePrefix', 'zipBaseName', 'cbzPrefix'])('rejects mixed legacy field %s', (field) => {
    expect(() => normalizeArchiveOptions({ archives: [jpeg], [field]: normalizeArchiveOptions({})[field] }))
      .toThrow(expect.objectContaining({ code: 'AMBIGUOUS_ARCHIVE_OPTIONS', message: expect.stringContaining(field) }));
  });

  it.each(['../escape', 'C:\\escape', '/escape', '\\server\\share', 'dir/../escape', 'dir:stream',
    'CON', 'dir./child', 'dir /child', 'dir\u0000'])('rejects unsafe output directory %j', (outputDirectory) => {
    expect(() => normalizeArchiveOptions({ archives: [jpeg], outputDirectory }))
      .toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT_DIRECTORY' }));
  });

  it('rejects exact destination duplicates and lossless entries differing only in ignored quality', () => {
    expect(() => plans({ archives: [jpeg, { ...jpeg }] })).toThrow(expect.objectContaining({
      code: 'INTRA_BATCH_COLLISION', message: expect.stringContaining('archives[1]'),
    }));
    expect(() => plans({ archives: [80, 90].map((quality) => ({
      archiveFormat: 'zip', imageFormat: 'webp', lossless: true, quality,
    })) })).toThrow(expect.objectContaining({ code: 'INTRA_BATCH_COLLISION' }));
  });

  it.runIf(process.platform === 'win32')('rejects case-insensitive destination aliases', () => {
    expect(() => plans({ archives: ['Name', 'name'].map((setName) => ({ ...jpeg, setName })) }))
      .toThrow(expect.objectContaining({ code: 'INTRA_BATCH_COLLISION' }));
  });

  it.each(['../escape.png', '/absolute.png', 'C:/absolute.png', 'bad\u0000.png', 'nested/./bad.png'])
  ('rejects unsafe member path %j before writing', (sourceRelativePath) => {
    expect(() => plans({ archives: [jpeg] }, [{ sourceRelativePath }]))
      .toThrow(expect.objectContaining({ code: 'ARCHIVE_ENTRY_UNSAFE', message: expect.stringContaining('archives[0]') }));
  });

  it('rejects colliding converted member names without reordering the sources', () => {
    expect(() => plans({ archives: [jpeg] }, [
      { sourceRelativePath: 'same.png' }, { sourceRelativePath: 'same.webp' },
    ])).toThrow(expect.objectContaining({ code: 'ARCHIVE_ENTRY_COLLISION', message: expect.stringContaining('archives[0]') }));
  });

  it.each(['zip', '7z', 'cbz', 'cb7'].flatMap((archiveFormat) =>
    ['jpeg', 'webp', 'png'].map((imageFormat) => [archiveFormat, imageFormat])))
  ('rejects case-insensitive converted members in %s / %s', (archiveFormat, imageFormat) => {
    const extension = imageFormat === 'jpeg' ? 'jpg' : imageFormat;
    for (const otherPath of ['Final/PAGE.webp', 'final/page.webp']) {
      const selected = [{ sourceRelativePath: 'Final/page.png' }, { sourceRelativePath: otherPath }];
      expect(() => plans({ archives: [{ archiveFormat, imageFormat }] }, selected))
        .toThrow(expect.objectContaining({
          code: 'ARCHIVE_ENTRY_COLLISION',
          message: expect.stringContaining('archives[0]'),
        }));
      expect(() => plans({ archives: [{ archiveFormat, imageFormat }] }, selected))
        .toThrow(expect.objectContaining({ message: expect.stringContaining(`Final/page.${extension}`) }));
      expect(() => plans({ archives: [{ archiveFormat, imageFormat }] }, selected))
        .toThrow(expect.objectContaining({ message: expect.stringContaining(otherPath.replace(/\.webp$/, `.${extension}`)) }));
    }
  });

  it('preserves distinct converted member casing and allows matching members in separate archives', () => {
    const selected = [{ sourceRelativePath: 'Final/page.png' }, { sourceRelativePath: 'final/OTHER.webp' }];
    const output = plans({ archives: [
      { archiveFormat: 'zip', imageFormat: 'png' },
      { archiveFormat: 'cb7', imageFormat: 'png' },
    ] }, selected);
    expect(output).toHaveLength(2);
    for (const plan of output) {
      expect(plan.entries.map((entry) => entry.name)).toEqual(['Final/page.png', 'final/OTHER.png']);
    }
  });

  it.each([{ archiveFormat: 'zip' }, { archiveFormat: '7z' }, { makeArchives: false, makeCbz: true }])
  ('rejects case-insensitive converted members for legacy options %j', (options) => {
    expect(() => plans(options, [
      { sourceRelativePath: 'Final/page.png' }, { sourceRelativePath: 'final/PAGE.webp' },
    ])).toThrow(expect.objectContaining({ code: 'ARCHIVE_ENTRY_COLLISION' }));
  });

  it('keeps explicit configurations stable across repeated boundary normalization', () => {
    const normalized = normalizeArchiveOptions({ archives: [jpeg] });
    for (const options of [{ archives: [jpeg] }, normalized]) {
      expect(normalizeArchiveOptions(options)).toEqual(normalized);
    }
  });
});
