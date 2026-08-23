import fs from 'node:fs';
import { createAssetRepository } from '../data/asset-repository.js';
import { createProjectRepository } from '../data/project-repository.js';
import { closeAssetFile, openAssetFile } from '../storage/asset-file.js';
import { crc32, extractWorkflowMetadataFromPngReader } from './workflow-prompt-editor.js';

export class AssetWorkflowMetadataError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = 'AssetWorkflowMetadataError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function assertPositiveAssetId(assetId) {
  if (!Number.isSafeInteger(assetId) || assetId <= 0) {
    throw new AssetWorkflowMetadataError('assetId must be a positive integer.', {
      code: 'INVALID_ASSET_ID',
    });
  }
}

function isPngAsset(asset) {
  return String(asset.extension || '').toLowerCase() === 'png';
}

function isImageAsset(asset) {
  return ['png', 'webp', 'jpg', 'jpeg', 'bmp', 'gif']
    .includes(String(asset.extension || '').toLowerCase());
}

function validDimensions(metadata) {
  const { width, height } = metadata || {};
  if (!Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0) {
    return null;
  }
  return { width, height };
}

function readAssetRange(handle, offset, length) {
  const bytes = Buffer.allocUnsafe(length);
  let totalBytesRead = 0;

  while (totalBytesRead < length) {
    const bytesRead = fs.readSync(
      handle,
      bytes,
      totalBytesRead,
      length - totalBytesRead,
      offset + totalBytesRead
    );
    if (bytesRead === 0) break;
    totalBytesRead += bytesRead;
  }

  return bytes.subarray(0, totalBytesRead);
}

function readImageHeader(handle, offset, length) {
  return readAssetRange(handle, offset, length);
}

function readPngDimensions(handle) {
  const header = readImageHeader(handle, 0, 33);
  if (
    header.length !== 33
    || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || header.readUInt32BE(8) !== 13
    || header.toString('ascii', 12, 16) !== 'IHDR'
    || crc32(header.subarray(12, 29)) !== header.readUInt32BE(29)
  ) {
    return null;
  }

  return validDimensions({
    width: header.readUInt32BE(16),
    height: header.readUInt32BE(20),
  });
}

function readGifDimensions(handle) {
  const header = readImageHeader(handle, 0, 13);
  if (
    header.length !== 13
    || !['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6))
  ) {
    return null;
  }

  return validDimensions({
    width: header.readUInt16LE(6),
    height: header.readUInt16LE(8),
  });
}

function readBmpDimensions(handle, size) {
  const header = readImageHeader(handle, 0, 26);
  if (header.length !== 26 || header.toString('ascii', 0, 2) !== 'BM') return null;

  const dibHeaderSize = header.readUInt32LE(14);
  if (14 + dibHeaderSize > size) return null;
  if (dibHeaderSize === 12) {
    return validDimensions({
      width: header.readUInt16LE(18),
      height: header.readUInt16LE(20),
    });
  }
  if (dibHeaderSize < 40) return null;

  const width = header.readInt32LE(18);
  const height = header.readInt32LE(22);
  return validDimensions({ width, height: Math.abs(height) });
}

function readWebpDimensions(handle, size) {
  const riffHeader = readImageHeader(handle, 0, 12);
  if (
    riffHeader.length !== 12
    || riffHeader.toString('ascii', 0, 4) !== 'RIFF'
    || riffHeader.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }

  const riffEnd = riffHeader.readUInt32LE(4) + 8;
  if (!Number.isSafeInteger(riffEnd) || riffEnd < 12 || riffEnd > size) return null;

  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const chunkHeader = readImageHeader(handle, offset, 8);
    if (chunkHeader.length !== 8) return null;

    const chunkType = chunkHeader.toString('ascii', 0, 4);
    const chunkLength = chunkHeader.readUInt32LE(4);
    const payloadOffset = offset + 8;
    const nextOffset = payloadOffset + chunkLength + (chunkLength % 2);
    if (
      !Number.isSafeInteger(payloadOffset)
      || !Number.isSafeInteger(nextOffset)
      || nextOffset <= offset
      || nextOffset > riffEnd
    ) {
      return null;
    }

    if (chunkType === 'VP8X') {
      if (chunkLength < 10) return null;
      const header = readImageHeader(handle, payloadOffset, 10);
      if (header.length !== 10) return null;
      return validDimensions({
        width: header.readUIntLE(4, 3) + 1,
        height: header.readUIntLE(7, 3) + 1,
      });
    }
    if (chunkType === 'VP8 ') {
      if (chunkLength < 10) return null;
      const header = readImageHeader(handle, payloadOffset, 10);
      if (
        header.length !== 10
        || !header.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))
      ) {
        return null;
      }
      return validDimensions({
        width: header.readUInt16LE(6) & 0x3fff,
        height: header.readUInt16LE(8) & 0x3fff,
      });
    }
    if (chunkType === 'VP8L') {
      if (chunkLength < 5) return null;
      const header = readImageHeader(handle, payloadOffset, 5);
      if (header.length !== 5 || header[0] !== 0x2f) return null;
      const bits = header.readUInt32LE(1);
      return validDimensions({
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      });
    }

    offset = nextOffset;
  }

  return null;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpegDimensions(handle, size) {
  const signature = readImageHeader(handle, 0, 2);
  if (signature.length !== 2 || signature[0] !== 0xff || signature[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < size) {
    const markerPrefix = readImageHeader(handle, offset, 1);
    if (markerPrefix.length !== 1 || markerPrefix[0] !== 0xff) return null;
    offset += 1;

    let marker;
    do {
      const markerByte = readImageHeader(handle, offset, 1);
      if (markerByte.length !== 1) return null;
      marker = markerByte[0];
      offset += 1;
    } while (marker === 0xff);

    if (marker === 0x00) return null;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const segmentLengthBytes = readImageHeader(handle, offset, 2);
    if (segmentLengthBytes.length !== 2) return null;
    const segmentLength = segmentLengthBytes.readUInt16BE(0);
    if (segmentLength < 2) return null;

    const nextOffset = offset + segmentLength;
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > size) return null;

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      const frameHeader = readImageHeader(handle, offset + 2, 6);
      if (frameHeader.length !== 6) return null;

      const componentCount = frameHeader[5];
      if (componentCount === 0 || segmentLength !== 8 + (3 * componentCount)) return null;

      return validDimensions({
        width: frameHeader.readUInt16BE(3),
        height: frameHeader.readUInt16BE(1),
      });
    }

    offset = nextOffset;
  }

  return null;
}

function readImageDimensions(handle, size, extension) {
  switch (extension) {
    case 'png': return readPngDimensions(handle);
    case 'jpg':
    case 'jpeg': return readJpegDimensions(handle, size);
    case 'gif': return readGifDimensions(handle);
    case 'bmp': return readBmpDimensions(handle, size);
    case 'webp': return readWebpDimensions(handle, size);
    default: return null;
  }
}

/**
 * Read-only ComfyUI workflow metadata inspection for one stored asset.
 *
 * Returns the same { metadataKey, workflow } shape as
 * extractWorkflowMetadataFromPng, or null when the asset is not a PNG or the
 * successfully parsed PNG contains no supported ComfyUI workflow metadata.
 *
 * Storage, read, and PNG parser failures deliberately propagate: callers must
 * distinguish an inspected asset with no workflow from an inspection failure.
 *
 * @param {{ db: import('better-sqlite3').Database, projectsRoot: string }} deps
 */
export function createAssetWorkflowMetadataService({ db, projectsRoot } = {}) {
  if (!db) {
    throw new Error('createAssetWorkflowMetadataService requires a db dependency.');
  }
  if (!projectsRoot) {
    throw new Error('createAssetWorkflowMetadataService requires a projectsRoot dependency.');
  }

  const projectRepository = createProjectRepository(db);
  const assetRepository = createAssetRepository(db);

  function requireAssetAndProject(assetId) {
    assertPositiveAssetId(assetId);

    const asset = assetRepository.findById(assetId);
    if (!asset) {
      throw new AssetWorkflowMetadataError('Asset not found.', {
        code: 'ASSET_NOT_FOUND',
      });
    }

    const project = projectRepository.findById(asset.project_id);
    if (!project || !project.project_dir) {
      throw new AssetWorkflowMetadataError('Asset project is not available for inspection.', {
        code: 'PROJECT_NOT_AVAILABLE',
      });
    }

    return { asset, project };
  }

  return {
    /**
     * @param {number} assetId
     * @returns {{ metadataKey: string, workflow: object }|null}
     */
    getWorkflowMetadata(assetId) {
      const { asset, project } = requireAssetAndProject(assetId);

      // The extractor only supports PNG textual metadata. Avoid opening or
      // parsing a source that cannot contain it.
      if (!isPngAsset(asset)) return null;

      const opened = openAssetFile(
        projectsRoot,
        project.project_dir,
        asset.relative_path
      );
      try {
        return extractWorkflowMetadataFromPngReader(
          (offset, length) => readAssetRange(opened.handle, offset, length),
          opened.stat.size
        );
      } finally {
        closeAssetFile(opened);
      }
    },

    /**
     * Read the dimensions of a supported image asset without decoding its
     * pixels. Returns null for non-image assets or unavailable dimensions.
     *
     * @param {number} assetId
     * @returns {Promise<{ width: number, height: number }|null>}
     */
    async getImageDimensions(assetId) {
      const { asset, project } = requireAssetAndProject(assetId);
      if (!isImageAsset(asset)) return null;

      const opened = openAssetFile(
        projectsRoot,
        project.project_dir,
        asset.relative_path
      );
      try {
        try {
          return readImageDimensions(
            opened.handle,
            opened.stat.size,
            String(asset.extension || '').toLowerCase()
          );
        } catch {
          return null;
        }
      } finally {
        closeAssetFile(opened);
      }
    },
  };
}
