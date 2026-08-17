import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  WATERMARK_WINDOW_SCALE_MAP,
  applyWatermarkOpacity,
  calculateWindowBasis,
  calculateProportionalMargins,
  calculateWatermarkDimensions,
  calculateWatermarkPosition,
  deriveWatermarkOutputPlan,
  fitWatermarkDimensions,
  normalizeWatermarkOptions,
  renderWatermarkedImage,
  resolveWatermarkScale,
  trimTransparentBorder,
} from '../src/services/watermark-engine.js';

async function makeBorderedWatermark() {
  const visible = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  }).png().toBuffer();
  return sharp({
    create: {
      width: 6,
      height: 4,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: visible, left: 2, top: 1 }]).png().toBuffer();
}

async function makeWideWatermark() {
  const visible = await sharp({
    create: {
      width: 22,
      height: 10,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).png().toBuffer();
  return sharp({
    create: {
      width: 26,
      height: 14,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: visible, left: 2, top: 2 }]).png().toBuffer();
}

describe('watermark engine', () => {
  it('normalizes independent ZIP/CBZ archive defaults and rejects unsafe archive names', () => {
    expect(normalizeWatermarkOptions({ makeArchives: true, makeCbz: true })).toMatchObject({
      archiveFormat: 'zip',
      zipJpgQuality: 80,
      zipWebpQuality: 90,
      cbzJpgQuality: 85,
      archiveIncludeResized: false,
      cbzFrom: 'unresized',
      zipBaseName: 'watermarked',
      cbzPrefix: 'watermarked_',
    });
    expect(normalizeWatermarkOptions({ maxDimension: 100, makeArchives: true }).archiveResizedOnlyBlocked).toBe(true);
    expect(() => normalizeWatermarkOptions({ setName: '../unsafe' })).toThrow(/safe filename component/);
    expect(normalizeWatermarkOptions({ archiveFormat: '7z' }).archiveFormat).toBe('7z');
    expect(() => normalizeWatermarkOptions({ archiveFormat: 'tar' })).toThrow(/zip or 7z/);
  });

  it('trims transparent border while preserving visible dimensions', async () => {
    const result = await trimTransparentBorder(await makeBorderedWatermark());
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);

    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.hasAlpha).toBe(true);
  });

  it('applies opacity to the watermark alpha channel only', async () => {
    const input = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 200, g: 40, b: 10, alpha: 1 },
      },
    }).png().toBuffer();
    const result = await applyWatermarkOpacity(input, 0.5);
    const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });

    expect(info.channels).toBe(4);
    expect([...data]).toEqual([200, 40, 10, 128]);
  });

  it('uses the window basis for margins and supports bottom-left placement', () => {
    const margin = calculateProportionalMargins(1000, 500, 0.02);
    expect(margin).toEqual({ x: 11, y: 11 });
    expect(calculateWatermarkPosition({
      position: 'bottom-left',
      targetWidth: 1000,
      targetHeight: 500,
      watermarkWidth: 200,
      watermarkHeight: 80,
      margin,
    })).toEqual({ left: 11, top: 409 });
    expect(calculateWatermarkPosition({
      position: 'bottom-right',
      targetWidth: 1000,
      targetHeight: 500,
      watermarkWidth: 200,
      watermarkHeight: 80,
      margin,
    })).toEqual({ left: 789, top: 409 });
  });

  it('resolves every supplied resolution exactly with default fallback only', () => {
    const expectedScales = {
      '1365x768': 0.35,
      '1248x832': 0.35,
      '2496x1664': 0.35,
      '5376x3072': 0.35,
      '4992x3328': 0.35,
      '1024x1024': 0.37,
      '2048x2048': 0.37,
      '2304x2304': 0.37,
      '3072x3072': 0.37,
      '4096x4096': 0.37,
      '1600x2592': 0.31,
      '2560x6144': 0.28,
      '832x1248': 0.32,
      '1365x2048': 0.32,
      '1664x2496': 0.32,
      '3328x4992': 0.32,
      default: 0.1,
    };
    expect(WATERMARK_WINDOW_SCALE_MAP).toEqual(expectedScales);
    for (const [resolution, expectedScale] of Object.entries(expectedScales)) {
      if (resolution === 'default') continue;
      const [width, height] = resolution.split('x').map(Number);
      expect(resolveWatermarkScale(width, height)).toBe(expectedScale);
    }
    expect(resolveWatermarkScale(1111, 777)).toBe(0.1);
    expect(resolveWatermarkScale(1366, 768)).toBe(0.1);
    expect(resolveWatermarkScale(768, 1365)).toBe(0.1);
  });

  it('uses the Python window basis for watermark dimensions', () => {
    expect(calculateWindowBasis(2000, 1000)).toBeCloseTo(2000 / 1.777778);
    expect(calculateWatermarkDimensions({
      targetWidth: 2000,
      targetHeight: 1000,
      visibleWidth: 100,
      visibleHeight: 50,
      scale: 0.1,
    })).toMatchObject({ width: 112, height: 56 });
    expect(calculateProportionalMargins(1100, 550, 0.02)).toEqual({ x: 12, y: 12 });
  });

  it('fits watermark dimensions proportionally and reduces only impossible margins', () => {
    expect(fitWatermarkDimensions({
      targetWidth: 100,
      targetHeight: 100,
      watermarkWidth: 200,
      watermarkHeight: 100,
      margin: { x: 0, y: 0 },
    })).toEqual({
      width: 100,
      height: 50,
      margin: { x: 0, y: 0 },
    });

    const constrained = fitWatermarkDimensions({
      targetWidth: 3,
      targetHeight: 100,
      watermarkWidth: 10,
      watermarkHeight: 5,
      margin: { x: 22, y: 22 },
    });
    expect(constrained.margin).toEqual({ x: 1, y: 22 });
    expect(constrained.width).toBe(1);
    expect(constrained.height).toBe(1);
    expect(() => fitWatermarkDimensions({
      targetWidth: 0,
      targetHeight: 100,
      watermarkWidth: 10,
      watermarkHeight: 5,
      margin: { x: 0, y: 0 },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_WATERMARK_DIMENSIONS' }));
  });

  it('uses PNG, bottom-left, and reference resize defaults for both modes', () => {
    expect(normalizeWatermarkOptions({ mode: 'patreon' })).toMatchObject({
      position: 'bl',
      outputFormat: 'png',
      maxDimension: null,
      deleteSource: false,
      overwrite: true,
      socialSuffix: '_wm',
    });
    expect(normalizeWatermarkOptions({ mode: 'social' })).toMatchObject({
      position: 'bl',
      outputFormat: 'png',
      maxDimension: 1100,
      deleteSource: true,
      overwrite: true,
      socialSuffix: '_lq_wm',
    });
  });

  it('derives deduplicated dual-variant output paths beneath a project-relative output directory', () => {
    const options = normalizeWatermarkOptions({
      mode: 'custom',
      maxDimension: 900,
      alsoUnresized: true,
      outputDirectory: 'processed/wm',
      outputFormat: 'png',
      additionalFormats: ['webp', 'png'],
      additionalFormatsResized: ['jpg', 'webp', 'jpg'],
    });
    expect(deriveWatermarkOutputPlan('Final/sub/image.tiff', options).outputs).toMatchObject([
      { variant: 'unresized', outputFormat: 'png', outputRelativePath: 'processed/wm/Final/sub/image_wm.png' },
      { variant: 'unresized', outputFormat: 'webp', outputRelativePath: 'processed/wm/Final/sub/image_wm.webp' },
      { variant: 'resized', outputFormat: 'png', outputRelativePath: 'processed/wm/Final/sub/image_lq_wm.png' },
      { variant: 'resized', outputFormat: 'jpg', outputRelativePath: 'processed/wm/Final/sub/image_lq_wm.jpg' },
      { variant: 'resized', outputFormat: 'webp', outputRelativePath: 'processed/wm/Final/sub/image_lq_wm.webp' },
    ]);
  });

  it.each(['../x', '/x', '\\x', 'a/b', 'a\\b', 'x\n'])('rejects unsafe watermark suffix %j', (suffix) => {
    expect(() => normalizeWatermarkOptions({ mode: 'custom', suffix })).toThrowError(
      expect.objectContaining({ code: 'INVALID_SUFFIX' }),
    );
  });

  it.each(['watermarkPath', 'watermarkFile'])('rejects caller-supplied %s', (field) => {
    expect(() => normalizeWatermarkOptions({ mode: 'patreon', [field]: '/outside/mark.png' }))
      .toThrowError(expect.objectContaining({ code: 'WATERMARK_PATH_NOT_ALLOWED' }));
  });

  it('looks up Social scale before resize and composes after resize', async () => {
    const source = await sharp({
      create: {
        width: 1365,
        height: 768,
        channels: 4,
        background: { r: 20, g: 100, b: 180, alpha: 1 },
      },
    }).png().toBuffer();
    const options = normalizeWatermarkOptions({ mode: 'social' });
    const result = await renderWatermarkedImage({
      baseInput: source,
      watermarkInput: await trimTransparentBorder(await makeBorderedWatermark()),
      options,
      outputFormat: 'png',
    });

    expect(result.width).toBe(1100);
    expect(result.height).toBeLessThan(768);
    expect(result.watermark.scale).toBe(0.35);
    expect(result.watermark.width).toBe(calculateWatermarkDimensions({
      targetWidth: result.width,
      targetHeight: result.height,
      visibleWidth: 2,
      visibleHeight: 2,
      scale: 0.35,
    }).width);
    expect(result.watermark.height).toBe(calculateWatermarkDimensions({
      targetWidth: result.width,
      targetHeight: result.height,
      visibleWidth: 2,
      visibleHeight: 2,
      scale: 0.35,
    }).height);
    expect(result.watermark.margin).toEqual({
      x: Math.floor(calculateWindowBasis(result.width, result.height) * 0.02),
      y: Math.floor(calculateWindowBasis(result.width, result.height) * 0.02),
    });
    expect(result.watermark.left).toBe(result.watermark.margin.x);
    expect(result.watermark.top).toBe(
      result.height - result.watermark.height - result.watermark.margin.y,
    );
  });

  it('clips the reviewer tall narrow Social case without shrinking', async () => {
    const source = await sharp({
      create: {
        width: 200,
        height: 4000,
        channels: 4,
        background: { r: 20, g: 100, b: 180, alpha: 1 },
      },
    }).png().toBuffer();
    const trimmed = await trimTransparentBorder(await makeWideWatermark());
    const options = normalizeWatermarkOptions({ mode: 'social' });
    const result = await renderWatermarkedImage({
      baseInput: source,
      watermarkInput: trimmed,
      options,
      outputFormat: 'png',
    });
    const desired = calculateWatermarkDimensions({
      targetWidth: result.width,
      targetHeight: result.height,
      visibleWidth: trimmed.width,
      visibleHeight: trimmed.height,
      scale: 0.1,
    });

    expect({ width: result.width, height: result.height }).toEqual({ width: 55, height: 1100 });
    expect(desired).toMatchObject({ width: 110, height: 50, windowDimension: 1100 });
    expect(result.watermark.width).toBe(desired.width);
    expect(result.watermark.height).toBe(desired.height);
    expect(result.watermark.left).toBe(0);
    expect(result.watermark.top).toBe(
      result.height - result.watermark.height - result.watermark.margin.y,
    );
    expect(result.watermark.left).toBeGreaterThanOrEqual(0);
    expect(result.watermark.top).toBeGreaterThanOrEqual(0);
    expect(result.watermark.left + result.watermark.width).toBeGreaterThan(result.width);
    expect(result.watermark.top + result.watermark.height).toBeLessThanOrEqual(result.height);
    await expect(sharp(result.buffer).metadata()).resolves.toMatchObject({
      width: 55,
      height: 1100,
      format: 'png',
    });
  });

  it('clips a very wide short Social image to the canvas height', async () => {
    const source = await sharp({
      create: {
        width: 4000,
        height: 100,
        channels: 4,
        background: { r: 20, g: 100, b: 180, alpha: 1 },
      },
    }).png().toBuffer();
    const trimmed = await trimTransparentBorder(await makeBorderedWatermark());
    const options = normalizeWatermarkOptions({ mode: 'social' });
    const result = await renderWatermarkedImage({
      baseInput: source,
      watermarkInput: trimmed,
      options,
      outputFormat: 'png',
    });
    expect(result.width).toBe(1100);
    expect(result.height).toBeLessThan(100);
    expect(result.watermark.height).toBe(calculateWatermarkDimensions({
      targetWidth: result.width,
      targetHeight: result.height,
      visibleWidth: trimmed.width,
      visibleHeight: trimmed.height,
      scale: 0.1,
    }).height);
    expect(result.watermark.left).toBe(result.watermark.margin.x);
    expect(result.watermark.top).toBe(0);
    expect(result.watermark.top).toBeGreaterThanOrEqual(0);
    expect(result.watermark.top + result.watermark.height).toBeGreaterThan(result.height);
  });
});
