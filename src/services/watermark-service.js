import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { resolveContainedAssetPath } from '../storage/asset-file.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/u;

export class WatermarkServiceError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = 'WatermarkServiceError';
    this.code = code;
  }
}

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function publicRecord(record) {
  return {
    id: record.id,
    displayName: record.display_name,
    width: record.width,
    height: record.height,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') {
    throw new WatermarkServiceError('Watermark display name must be a string.', { code: 'INVALID_WATERMARK_NAME' });
  }
  const displayName = value.trim();
  if (displayName.length === 0 || displayName.length > 200 || CONTROL_CHARACTERS.test(displayName)) {
    throw new WatermarkServiceError('Watermark display name is invalid.', { code: 'INVALID_WATERMARK_NAME' });
  }
  return displayName;
}

/**
 * Owns registry-backed PNG files rooted under APP_DATA_ROOT/watermarks.
 * Returned public metadata intentionally never includes storage_key or a path.
 */
export function createWatermarkService({ repository, storageRoot, sharpImplementation = sharp } = {}) {
  if (!repository
    || typeof repository.findById !== 'function'
    || typeof repository.list !== 'function'
    || typeof repository.create !== 'function'
    || typeof repository.rename !== 'function'
    || typeof repository.replaceImage !== 'function'
    || typeof repository.delete !== 'function') {
    throw new Error('createWatermarkService requires a watermark repository.');
  }
  if (typeof storageRoot !== 'string' || storageRoot.length === 0) {
    throw new Error('createWatermarkService requires a managed watermark storageRoot.');
  }
  if (typeof sharpImplementation !== 'function') {
    throw new Error('createWatermarkService requires a Sharp implementation.');
  }

  const root = path.resolve(storageRoot);

  function ensureRoot() {
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const stats = fs.lstatSync(root);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Managed watermark root is unsafe.');
    } catch (cause) {
      throw new WatermarkServiceError('Managed watermark storage is unavailable.', {
        code: 'WATERMARK_STORAGE_UNAVAILABLE',
        cause,
      });
    }
  }

  function resolveStoragePath(storageKey) {
    if (typeof storageKey !== 'string' || !/^wm-[0-9a-f-]{36}\.png$/i.test(storageKey)) {
      throw new WatermarkServiceError('Watermark storage metadata is invalid.', { code: 'WATERMARK_RESOURCE_TAMPERED' });
    }
    try {
      return resolveContainedAssetPath(root, storageKey, { checkFinalSymlink: false });
    } catch (cause) {
      throw new WatermarkServiceError('Watermark storage path is unsafe.', {
        code: 'WATERMARK_RESOURCE_TAMPERED',
        cause,
      });
    }
  }

  function readVerified(record) {
    if (!record || !SHA256_PATTERN.test(record.sha256 || '')) {
      throw new WatermarkServiceError('Watermark registry metadata is invalid.', { code: 'WATERMARK_RESOURCE_TAMPERED' });
    }
    const filePath = resolveStoragePath(record.storage_key);
    let before;
    try {
      before = fs.lstatSync(filePath);
      if (before.isSymbolicLink() || !before.isFile()) throw new Error('Not a regular file.');
      const bytes = fs.readFileSync(filePath);
      const after = fs.lstatSync(filePath);
      if (after.isSymbolicLink() || !after.isFile()
        || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || sha256(bytes) !== record.sha256.toLowerCase()) {
        throw new Error('Managed bytes do not match the registry.');
      }
      return { filePath, bytes, stat: after };
    } catch (cause) {
      throw new WatermarkServiceError('Managed Watermark bytes are missing or changed.', {
        code: 'WATERMARK_RESOURCE_TAMPERED',
        cause,
      });
    }
  }

  async function validatePng(input) {
    const submitted = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
    if (submitted.length < PNG_SIGNATURE.length || !submitted.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new WatermarkServiceError('Watermark files must be PNG images.', { code: 'INVALID_WATERMARK_PNG' });
    }

    let stored;
    let metadata;
    let pixels;
    try {
      stored = await sharpImplementation(submitted, { animated: false }).png().toBuffer();
      metadata = await sharpImplementation(stored).metadata();
      pixels = await sharpImplementation(stored).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    } catch (cause) {
      throw new WatermarkServiceError('Watermark PNG could not be decoded.', {
        code: 'INVALID_WATERMARK_PNG',
        cause,
      });
    }
    if (metadata.format !== 'png' || !Number.isSafeInteger(metadata.width) || metadata.width <= 0
      || !Number.isSafeInteger(metadata.height) || metadata.height <= 0) {
      throw new WatermarkServiceError('Watermark dimensions are invalid.', { code: 'INVALID_WATERMARK_PNG' });
    }

    const channels = pixels.info.channels;
    let visible = false;
    for (let index = channels - 1; index < pixels.data.length; index += channels) {
      if (pixels.data[index] !== 0) {
        visible = true;
        break;
      }
    }
    if (!visible) {
      throw new WatermarkServiceError('Watermark must contain visible alpha content.', {
        code: 'EMPTY_WATERMARK',
      });
    }
    return { bytes: stored, sha256: sha256(stored), width: metadata.width, height: metadata.height };
  }

  function createStagingDirectory() {
    ensureRoot();
    let directory;
    try {
      directory = fs.mkdtempSync(path.join(root, '.creatorcrate-watermark-'));
      const stats = fs.lstatSync(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Unsafe staging directory.');
      return directory;
    } catch (cause) {
      if (directory) {
        try { fs.rmdirSync(directory); } catch { /* best effort */ }
      }
      throw new WatermarkServiceError('Watermark staging could not be prepared.', {
        code: 'WATERMARK_STORAGE_UNAVAILABLE',
        cause,
      });
    }
  }

  function cleanDirectory(directory) {
    try {
      fs.rmdirSync(directory);
      return true;
    } catch (cause) {
      if (cause.code === 'ENOENT') return true;
      return false;
    }
  }

  function removeIfSha(filePath, expectedSha) {
    try {
      const stats = fs.lstatSync(filePath);
      if (stats.isSymbolicLink() || !stats.isFile() || sha256(fs.readFileSync(filePath)) !== expectedSha) return false;
      fs.unlinkSync(filePath);
      return true;
    } catch (cause) {
      return cause.code === 'ENOENT';
    }
  }

  function requireRecord(id) {
    if (!isPositiveId(id)) {
      throw new WatermarkServiceError('watermarkId must be a positive integer.', { code: 'INVALID_WATERMARK_ID' });
    }
    const record = repository.findById(id);
    if (!record) throw new WatermarkServiceError('Watermark not found.', { code: 'WATERMARK_NOT_FOUND' });
    return record;
  }

  function mapRepositoryError(error) {
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new WatermarkServiceError('A Watermark with that display name already exists.', {
        code: 'WATERMARK_NAME_CONFLICT',
        cause: error,
      });
    }
    throw error;
  }

  return {
    listWatermarks() {
      return repository.list().map(publicRecord);
    },

    getWatermark(id) {
      return publicRecord(requireRecord(id));
    },

    async createWatermark({ displayName, pngBytes } = {}) {
      const normalizedName = normalizeDisplayName(displayName);
      const image = await validatePng(pngBytes);
      const storageKey = `wm-${randomUUID()}.png`;
      const directory = createStagingDirectory();
      const stagedPath = path.join(directory, 'candidate.png');
      const destinationPath = resolveStoragePath(storageKey);
      let published = false;
      let databaseCreated = false;
      try {
        fs.writeFileSync(stagedPath, image.bytes, { flag: 'wx', mode: 0o600 });
        fs.renameSync(stagedPath, destinationPath);
        published = true;
        let record;
        try {
          record = repository.create({
            displayName: normalizedName,
            storageKey,
            sha256: image.sha256,
            width: image.width,
            height: image.height,
          });
          databaseCreated = true;
        } catch (error) {
          mapRepositoryError(error);
        }
        if (!cleanDirectory(directory)) {
          throw new WatermarkServiceError('Watermark was created but staging cleanup failed.', {
            code: 'RECOVERY_REQUIRED',
          });
        }
        return publicRecord(record);
      } catch (cause) {
        if (databaseCreated) {
          throw new WatermarkServiceError('Watermark was created but staging cleanup requires recovery.', {
            code: 'RECOVERY_REQUIRED',
            cause,
          });
        }
        const removed = !published || removeIfSha(destinationPath, image.sha256);
        cleanDirectory(directory);
        if (!removed) {
          throw new WatermarkServiceError('Watermark creation requires filesystem recovery.', {
            code: 'RECOVERY_REQUIRED',
            cause,
          });
        }
        if (cause instanceof WatermarkServiceError) throw cause;
        throw new WatermarkServiceError('Watermark could not be created.', { code: 'WATERMARK_CREATE_FAILED', cause });
      }
    },

    renameWatermark(id, displayName) {
      requireRecord(id);
      try {
        const record = repository.rename(id, normalizeDisplayName(displayName));
        if (!record) throw new WatermarkServiceError('Watermark not found.', { code: 'WATERMARK_NOT_FOUND' });
        return publicRecord(record);
      } catch (error) {
        mapRepositoryError(error);
      }
    },

    async replaceWatermark(id, { pngBytes } = {}) {
      const record = requireRecord(id);
      const existing = readVerified(record);
      const image = await validatePng(pngBytes);
      const directory = createStagingDirectory();
      const stagedPath = path.join(directory, 'replacement.png');
      const backupPath = path.join(directory, 'previous.png');
      let priorMoved = false;
      let replacementPublished = false;
      let databaseUpdated = false;
      try {
        fs.writeFileSync(stagedPath, image.bytes, { flag: 'wx', mode: 0o600 });
        fs.renameSync(existing.filePath, backupPath);
        priorMoved = true;
        fs.renameSync(stagedPath, existing.filePath);
        replacementPublished = true;
        const updated = repository.replaceImage(id, record.sha256, image);
        if (!updated) throw new WatermarkServiceError('Watermark registry changed during replacement.', { code: 'STALE_WATERMARK' });
        databaseUpdated = true;
        if (!removeIfSha(backupPath, record.sha256) || !cleanDirectory(directory)) {
          throw new WatermarkServiceError('Watermark was replaced but prior-file cleanup failed.', { code: 'RECOVERY_REQUIRED' });
        }
        return publicRecord(updated);
      } catch (cause) {
        if (databaseUpdated) {
          throw new WatermarkServiceError('Watermark was replaced but filesystem cleanup requires recovery.', {
            code: 'RECOVERY_REQUIRED',
            cause,
          });
        }
        let recovered = true;
        if (replacementPublished) recovered = removeIfSha(existing.filePath, image.sha256);
        if (priorMoved && recovered) {
          try { fs.renameSync(backupPath, existing.filePath); } catch { recovered = false; }
        }
        cleanDirectory(directory);
        if (!recovered) {
          throw new WatermarkServiceError('Watermark replacement requires filesystem recovery.', {
            code: 'RECOVERY_REQUIRED',
            cause,
          });
        }
        if (cause instanceof WatermarkServiceError) throw cause;
        throw new WatermarkServiceError('Watermark could not be replaced.', { code: 'WATERMARK_REPLACE_FAILED', cause });
      }
    },

    deleteWatermark(id) {
      const record = requireRecord(id);
      const existing = readVerified(record);
      const directory = createStagingDirectory();
      const quarantinePath = path.join(directory, 'deleted.png');
      let quarantined = false;
      let databaseDeleted = false;
      try {
        fs.renameSync(existing.filePath, quarantinePath);
        quarantined = true;
        const deleted = repository.delete(id, record);
        if (!deleted) throw new WatermarkServiceError('Watermark registry changed during deletion.', { code: 'STALE_WATERMARK' });
        databaseDeleted = true;
        if (!removeIfSha(quarantinePath, record.sha256) || !cleanDirectory(directory)) {
          throw new WatermarkServiceError('Watermark was deleted but filesystem cleanup failed.', { code: 'RECOVERY_REQUIRED' });
        }
        return publicRecord(deleted);
      } catch (cause) {
        if (databaseDeleted) {
          throw new WatermarkServiceError('Watermark was deleted but filesystem cleanup requires recovery.', {
            code: 'RECOVERY_REQUIRED',
            cause,
          });
        }
        let recovered = true;
        if (quarantined) {
          try { fs.renameSync(quarantinePath, existing.filePath); } catch { recovered = false; }
        }
        cleanDirectory(directory);
        if (!recovered) {
          throw new WatermarkServiceError('Watermark deletion requires filesystem recovery.', {
            code: 'RECOVERY_REQUIRED',
            cause,
          });
        }
        if (cause instanceof WatermarkServiceError) throw cause;
        throw new WatermarkServiceError('Watermark could not be deleted.', { code: 'WATERMARK_DELETE_FAILED', cause });
      }
    },

    resolveForProcessing(id) {
      const record = requireRecord(id);
      const { filePath } = readVerified(record);
      return { watermark: publicRecord(record), filePath };
    },
  };
}
