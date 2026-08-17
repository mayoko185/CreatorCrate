import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  calculateWatermarkBasis,
  calculateWatermarkPosition,
  deriveWatermarkGeometry,
  normalizeWatermarkOptions,
  renderWatermarkedImage,
  resolveWatermarkScale,
  trimTransparentBorder,
  validateScaleMap,
} from '../src/services/watermark-engine.js';

function options(raw = {}, scaleMap = null) {
  return normalizeWatermarkOptions({
    mode: 'patreon',
    marginRatio: 0,
    marginPx: 0,
    ...raw,
  }, { scaleMap });
}

function geometry(raw = {}, dimensions = {}) {
  return deriveWatermarkGeometry({
    sourceWidth: dimensions.sourceWidth ?? 400,
    sourceHeight: dimensions.sourceHeight ?? 300,
    compositeWidth: dimensions.compositeWidth ?? 400,
    compositeHeight: dimensions.compositeHeight ?? 300,
    watermarkWidth: dimensions.watermarkWidth ?? 2,
    watermarkHeight: dimensions.watermarkHeight ?? 1,
    options: options(raw, dimensions.scaleMap ?? null),
  });
}

async function solidImage(width, height, color) {
  return sharp({
    create: { width, height, channels: 4, background: color },
  }).png().toBuffer();
}

async function pixel(buffer, width, x, y) {
  const { data } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = ((y * width) + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}

describe('watermark geometry', () => {
  it('implements all Python scale bases', () => {
    expect(calculateWatermarkBasis({ width: 400, height: 300, scaleBasis: 'width' })).toBe(400);
    expect(calculateWatermarkBasis({ width: 400, height: 300, scaleBasis: 'height' })).toBe(300);
    expect(calculateWatermarkBasis({ width: 400, height: 300, scaleBasis: 'short' })).toBe(300);
    expect(calculateWatermarkBasis({ width: 400, height: 300, scaleBasis: 'long' })).toBe(400);
    expect(calculateWatermarkBasis({ width: 400, height: 300, scaleBasis: 'geo' })).toBe(Math.sqrt(120000));
    expect(calculateWatermarkBasis({ width: 400, height: 300, scaleBasis: 'diagonal' })).toBe(500);
    expect(calculateWatermarkBasis({ width: 400, height: 300, scaleBasis: 'window', windowAspect: 16 / 9 })).toBe(300);
    expect(calculateWatermarkBasis({ width: 400, height: 300, scaleBasis: 'window', windowAspect: 0.5 })).toBe(800);
  });

  it('uses fixed width, exact map, default map, then manual scale', () => {
    const map = { '400x300': 0.5, default: 0.4 };
    expect(geometry({ fixedWatermarkWidthPx: 123, scale: 0.3 }, { scaleMap: map })
      .watermarkDimensions).toEqual({ width: 123, height: 61 });
    expect(geometry({ scale: 0.3 }, { scaleMap: map }).effectiveScale).toBe(0.5);
    expect(geometry({ scale: 0.3 }, { sourceWidth: 401, scaleMap: map }).effectiveScale).toBe(0.4);
    expect(geometry({ scale: 0.3 }, { sourceWidth: 401, scaleMap: { '400x300': 0.5 } })
      .effectiveScale).toBe(0.3);
    expect(resolveWatermarkScale(401, 300, null, 1.5)).toBe(1.5);
    expect(geometry({ scale: 1.5, scaleBasis: 'width' }).watermarkDimensions.width).toBe(600);
  });

  it('uses original dimensions for maps and composite dimensions for basis and margin', () => {
    const result = geometry({
      scaleBasis: 'window',
      marginRatio: 0.02,
      scale: 0.25,
    }, {
      sourceWidth: 1365,
      sourceHeight: 768,
      compositeWidth: 1100,
      compositeHeight: 619,
      watermarkWidth: 10,
      watermarkHeight: 5,
      scaleMap: { '1365x768': 0.35, default: 0.1 },
    });
    expect(result.effectiveScale).toBe(0.35);
    expect(result.scaleBasisPixels).toBe(619);
    expect(result.watermarkDimensions).toEqual({ width: 216, height: 108 });
    expect(result.margin).toBe(12);
    expect(result.effectiveCoordinates).toEqual({ left: 12, top: 499 });
    expect(resolveWatermarkScale(768, 1365, { '1365x768': 0.35 }, 0.25)).toBe(0.25);
  });

  it('places all positions exactly and center ignores margin', () => {
    const input = { targetWidth: 400, targetHeight: 300, watermarkWidth: 100, watermarkHeight: 50, margin: 10 };
    expect(calculateWatermarkPosition({ ...input, position: 'br' })).toEqual({ left: 290, top: 240 });
    expect(calculateWatermarkPosition({ ...input, position: 'bl' })).toEqual({ left: 10, top: 240 });
    expect(calculateWatermarkPosition({ ...input, position: 'tr' })).toEqual({ left: 290, top: 10 });
    expect(calculateWatermarkPosition({ ...input, position: 'tl' })).toEqual({ left: 10, top: 10 });
    expect(calculateWatermarkPosition({ ...input, position: 'c' })).toEqual({ left: 150, top: 125 });
    expect(calculateWatermarkPosition({ ...input, position: 'bottom-left' })).toEqual({ left: 10, top: 240 });
  });

  it('uses proportional margin precedence and each nudge axis independently', () => {
    expect(geometry({ fixedWatermarkWidthPx: 10, marginPx: 7 }).margin).toBe(7);
    expect(geometry({ fixedWatermarkWidthPx: 10, marginPx: 7, marginRatio: 0.1, scaleBasis: 'height' }).margin).toBe(30);
    expect(geometry({ fixedWatermarkWidthPx: 10, marginPx: 7, marginRatio: 0 }).margin).toBe(7);
    expect(geometry({ fixedWatermarkWidthPx: 10, marginRatio: 0.1, scaleBasis: 'window', windowAspect: 0.5 }).margin).toBe(80);
    const expectedMargins = {
      width: 40,
      height: 30,
      short: 30,
      long: 40,
      geo: 34,
      diagonal: 50,
      window: 30,
    };
    for (const [scaleBasis, expectedMargin] of Object.entries(expectedMargins)) {
      expect(geometry({ fixedWatermarkWidthPx: 10, marginRatio: 0.1, scaleBasis }).margin).toBe(expectedMargin);
    }
    expect(geometry({ position: 'tl', fixedWatermarkWidthPx: 10, nudgeX: 7, nudgeY: -9 })
      .requestedCoordinates).toEqual({ left: 7, top: -9 });
    expect(geometry({ position: 'tl', fixedWatermarkWidthPx: 10, nudgeX: 7, nudgeY: -9, nudgeXRatio: 0.101 })
      .requestedCoordinates).toEqual({ left: 40, top: -9 });
    expect(geometry({ position: 'tl', fixedWatermarkWidthPx: 10, nudgeXRatio: -0.009, nudgeYRatio: -0.009 })
      .nudge).toEqual({ x: -3, y: -2 });
  });

  it('clamps coordinates without shrinking and derives visible intersections', () => {
    const wide = geometry({ position: 'tl', fixedWatermarkWidthPx: 500 });
    expect(wide.watermarkDimensions).toEqual({ width: 500, height: 250 });
    expect(wide.effectiveCoordinates).toEqual({ left: 0, top: 0 });
    expect(wide.visibleOverlay).toEqual({ left: 0, top: 0, width: 400, height: 250, cropLeft: 0, cropTop: 0 });
    const tall = geometry({ position: 'tl', fixedWatermarkWidthPx: 200 }, { watermarkWidth: 1, watermarkHeight: 2 });
    expect(tall.watermarkDimensions).toEqual({ width: 200, height: 400 });
    expect(tall.effectiveCoordinates).toEqual({ left: 0, top: 0 });
    expect(tall.visibleOverlay).toEqual({ left: 0, top: 0, width: 200, height: 300, cropLeft: 0, cropTop: 0 });
    const oversized = geometry({ position: 'tl', fixedWatermarkWidthPx: 500 }, { watermarkWidth: 2, watermarkHeight: 2 });
    expect(oversized.watermarkDimensions).toEqual({ width: 500, height: 500 });
    expect(oversized.effectiveCoordinates).toEqual({ left: 0, top: 0 });
    expect(oversized.visibleOverlay).toEqual({ left: 0, top: 0, width: 400, height: 300, cropLeft: 0, cropTop: 0 });
    const negative = geometry({ position: 'tl', fixedWatermarkWidthPx: 100, nudgeX: -20, nudgeY: -10, allowOffCanvas: true });
    expect(negative.effectiveCoordinates).toEqual({ left: -20, top: -10 });
    expect(negative.visibleOverlay).toEqual({ left: 0, top: 0, width: 80, height: 40, cropLeft: 20, cropTop: 10 });
    const overflowing = geometry({ position: 'br', fixedWatermarkWidthPx: 100, nudgeX: 20, nudgeY: 10, allowOffCanvas: true });
    expect(overflowing.effectiveCoordinates).toEqual({ left: 320, top: 260 });
    expect(overflowing.visibleOverlay).toEqual({ left: 320, top: 260, width: 80, height: 40, cropLeft: 0, cropTop: 0 });
    expect(geometry({ position: 'br', fixedWatermarkWidthPx: 100, nudgeX: 20, nudgeY: 10 })
      .effectiveCoordinates).toEqual({ left: 300, top: 250 });
    expect(geometry({ position: 'tl', fixedWatermarkWidthPx: 500, containment: 'shrink' })
      .watermarkDimensions).toEqual({ width: 400, height: 200 });
    expect(geometry({ position: 'tl', fixedWatermarkWidthPx: 10, nudgeX: 401, allowOffCanvas: true }).visibleOverlay).toBeNull();
  });

  it('renders each position and clips negative and oversized overlays', async () => {
    const base = await solidImage(8, 6, { r: 0, g: 0, b: 0, alpha: 1 });
    const watermark = await trimTransparentBorder(await solidImage(2, 2, { r: 255, g: 0, b: 0, alpha: 1 }));
    for (const [position, point] of Object.entries({ tl: [0, 0], tr: [6, 0], bl: [0, 4], br: [6, 4], c: [3, 2] })) {
      const result = await renderWatermarkedImage({
        baseInput: base,
        watermarkInput: watermark,
        options: options({ position, fixedWatermarkWidthPx: 2 }),
        outputFormat: 'png',
      });
      await expect(pixel(result.buffer, 8, ...point)).resolves.toEqual([255, 0, 0, 255]);
    }
    const negative = await renderWatermarkedImage({
      baseInput: base,
      watermarkInput: watermark,
      options: options({ position: 'tl', fixedWatermarkWidthPx: 4, nudgeX: -2, allowOffCanvas: true }),
      outputFormat: 'png',
    });
    expect(negative.watermark.geometry).toEqual(deriveWatermarkGeometry({
      sourceWidth: 8,
      sourceHeight: 6,
      compositeWidth: 8,
      compositeHeight: 6,
      watermarkWidth: 2,
      watermarkHeight: 2,
      options: options({ position: 'tl', fixedWatermarkWidthPx: 4, nudgeX: -2, allowOffCanvas: true }),
    }));
    await expect(pixel(negative.buffer, 8, 0, 0)).resolves.toEqual([255, 0, 0, 255]);
    await expect(pixel(negative.buffer, 8, 2, 0)).resolves.toEqual([0, 0, 0, 255]);
    const oversized = await renderWatermarkedImage({
      baseInput: base,
      watermarkInput: watermark,
      options: options({ position: 'tl', fixedWatermarkWidthPx: 12 }),
      outputFormat: 'png',
    });
    expect(oversized.watermark.width).toBe(12);
    await expect(pixel(oversized.buffer, 8, 7, 5)).resolves.toEqual([255, 0, 0, 255]);
  });

  it('accepts maps without default and rejects malformed maps', () => {
    expect(validateScaleMap({ '1365x768': 1.5 })).toEqual({ '1365x768': 1.5 });
    expect(() => validateScaleMap({ '0x768': 0.1 })).toThrowError(expect.objectContaining({ code: 'INVALID_SCALE_MAP' }));
    expect(() => validateScaleMap({ '1365x768': Infinity })).toThrowError(expect.objectContaining({ code: 'INVALID_SCALE_MAP' }));
    expect(() => normalizeWatermarkOptions({ scaleMapPath: 'C:/outside/map.json' }))
      .toThrowError(expect.objectContaining({ code: 'SCALE_MAP_PATH_NOT_ALLOWED' }));
  });
});
