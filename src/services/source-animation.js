import fs from 'node:fs';

function hasWebpImagePayload(bytes, start, length, type) {
  if (type === 'VP8L') return length > 5 && bytes[start] === 0x2f;
  if (type !== 'VP8 ' || length < 11 || (bytes[start] & 1) !== 0
    || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01
    || bytes[start + 5] !== 0x2a) return false;
  const firstPartitionLength = (bytes[start] | (bytes[start + 1] << 8)
    | (bytes[start + 2] << 16)) >>> 5;
  return firstPartitionLength > 0 && firstPartitionLength <= length - 10;
}

// Only GIF and WebP can take the animated Preview-PNG exception.
export function inspectSourceAnimation(filePathOrDescriptor, extension) {
  if (extension !== 'gif' && extension !== 'webp') return null;
  const bytes = fs.readFileSync(filePathOrDescriptor);
  if (extension === 'webp') {
    if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF'
      || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
    const end = bytes.readUInt32LE(4) + 8;
    if (end !== bytes.length) return null;
    let frames = 0;
    let stillImage = false;
    for (let offset = 12; offset < end;) {
      if (offset + 8 > end) return null;
      const length = bytes.readUInt32LE(offset + 4);
      const next = offset + 8 + length + (length % 2);
      if (next > end) return null;
      const type = bytes.toString('ascii', offset, offset + 4);
      if (type === 'VP8 ' || type === 'VP8L') {
        if (!hasWebpImagePayload(bytes, offset + 8, length, type)) return null;
        stillImage = true;
      }
      if (type === 'ANMF') {
        if (length < 24) return null;
        let frameStart = offset + 8 + 16;
        let frameType = bytes.toString('ascii', frameStart, frameStart + 4);
        let frameLength = bytes.readUInt32LE(frameStart + 4);
        if (frameType === 'ALPH') {
          frameStart += 8 + frameLength + (frameLength % 2);
          if (frameStart + 8 > offset + 8 + length) return null;
          frameType = bytes.toString('ascii', frameStart, frameStart + 4);
          frameLength = bytes.readUInt32LE(frameStart + 4);
        }
        if (frameStart + 8 + frameLength > offset + 8 + length
          || !hasWebpImagePayload(bytes, frameStart + 8, frameLength, frameType)) return null;
        frames++;
      }
      offset = next;
    }
    return frames > 0 ? frames > 1 : stillImage ? false : null;
  }

  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return null;
  if (bytes.readUInt16LE(6) === 0 || bytes.readUInt16LE(8) === 0) return null;
  let offset = 13;
  const globalColorTable = Boolean(bytes[10] & 0x80);
  if (globalColorTable) offset += 3 * (2 ** ((bytes[10] & 7) + 1));
  if (offset > bytes.length) return null;
  let frames = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return offset === bytes.length && frames > 0 ? frames > 1 : null;
    if (marker === 0x21) {
      if (offset >= bytes.length) return null;
      offset++; // extension label
    } else if (marker === 0x2c) {
      if (offset + 9 > bytes.length) return null;
      if (bytes.readUInt16LE(offset + 4) === 0 || bytes.readUInt16LE(offset + 6) === 0) return null;
      const packed = bytes[offset + 8];
      if (!globalColorTable && !(packed & 0x80)) return null;
      offset += 9;
      if (packed & 0x80) offset += 3 * (2 ** ((packed & 7) + 1));
      if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset++] > 12) return null;
      frames++;
    } else {
      return null;
    }
    let imageData = false;
    for (;;) {
      if (offset >= bytes.length) return null;
      const length = bytes[offset++];
      if (length === 0) break;
      if (offset + length > bytes.length) return null;
      imageData = true;
      offset += length;
    }
    if (marker === 0x2c && !imageData) return null;
  }
  return null;
}
