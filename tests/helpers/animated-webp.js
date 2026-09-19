import sharp from 'sharp';

export async function makeAnimatedWebp(frameCount, { width = 2, height = 2,
  delay = Array.from({ length: frameCount }, (_, index) => 100 + index), loop = 2,
  lossless = true, transparent = true } = {}) {
  const raw = Buffer.alloc(width * height * frameCount * 4);
  for (let frame = 0; frame < frameCount; frame++) {
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = (frame * width * height + pixel) * 4;
      raw[offset] = frame % 256;
      raw[offset + 1] = (frame * 3 + pixel) % 256;
      raw[offset + 2] = (frame * 7 + pixel) % 256;
      raw[offset + 3] = transparent && frame === frameCount - 1 && pixel === 0 ? 128 : 255;
    }
  }
  return sharp(raw, { raw: { width, height: height * frameCount, channels: 4, pageHeight: height } })
    .webp({ lossless, delay, loop }).toBuffer();
}

export async function makeSolidAnimatedWebp(frameCount, { width, height, delay = 63, loop = 0 } = {}) {
  const frameBytes = width * height * 3;
  const raw = Buffer.alloc(frameBytes * frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    raw.fill((frame * 5) % 256, frame * frameBytes, (frame + 1) * frameBytes);
  }
  return sharp(raw, { raw: { width, height: height * frameCount, channels: 3, pageHeight: height } })
    .webp({ lossless: true, delay: Array(frameCount).fill(delay), loop }).toBuffer();
}

export function webpChunks(bytes) {
  const chunks = [];
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4);
    const next = offset + 8 + length + length % 2;
    chunks.push({ type: bytes.toString('latin1', offset, offset + 4), offset,
      start: offset + 8, end: offset + 8 + length, next, bytes: bytes.subarray(offset, next) });
    offset = next;
  }
  return chunks;
}

export function rebuildWebp(chunks) {
  const result = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), ...chunks.map((entry) => entry.bytes ?? entry)]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

export function setWebpCanvas(bytes, width, height) {
  const result = Buffer.from(bytes);
  const vp8x = webpChunks(result).find((entry) => entry.type === 'VP8X');
  result.writeUIntLE(width - 1, vp8x.start + 4, 3);
  result.writeUIntLE(height - 1, vp8x.start + 7, 3);
  return result;
}
