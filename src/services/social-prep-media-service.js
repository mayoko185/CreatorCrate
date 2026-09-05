import fs from 'node:fs';

import { closeAssetFile, openAssetFile } from '../storage/asset-file.js';
import { sanitizeDispositionFilename } from './media-service.js';

export class SocialPrepMediaError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'SocialPrepMediaError';
    this.code = code;
    this.status = status;
  }
}

function safeMimeType(value) {
  return typeof value === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
    ? value
    : 'application/octet-stream';
}

function downloadDisposition(filename) {
  const { ascii, utf8 } = sanitizeDispositionFilename(filename);
  return `attachment; filename="${ascii}"; filename*=${utf8}`;
}

export function createSocialPrepMediaService({ db, projectsRoot, socialPrepRepository } = {}) {
  if (!db || !projectsRoot || !socialPrepRepository) {
    throw new Error('createSocialPrepMediaService requires db, projectsRoot, and socialPrepRepository.');
  }
  const findLiveAsset = db.prepare(`
    SELECT a.id, a.project_id, a.relative_path, a.filename, a.mime_type, p.project_dir
    FROM assets a
    JOIN projects p ON p.id = a.project_id
    WHERE a.id = ?
  `);

  function prepareDownload({ sessionId, assetId }) {
    const snapshot = socialPrepRepository.findSessionAsset(sessionId, assetId);
    if (!snapshot) throw new SocialPrepMediaError('asset_not_in_preparation', 404, 'The asset is not in this preparation.');

    const liveAsset = findLiveAsset.get(assetId);
    if (!liveAsset || liveAsset.project_id !== snapshot.project_id) {
      throw new SocialPrepMediaError('asset_unavailable', 404, 'The asset is unavailable.');
    }

    let opened;
    try {
      opened = openAssetFile(projectsRoot, liveAsset.project_dir, liveAsset.relative_path);
      const stream = fs.createReadStream('', { fd: opened.handle, autoClose: true });
      const cleanup = () => {
        if (!stream.destroyed) stream.destroy();
      };
      return {
        stream,
        cleanup,
        headers: {
          'Content-Type': safeMimeType(liveAsset.mime_type),
          'Content-Length': String(opened.stat.size),
          'Content-Disposition': downloadDisposition(liveAsset.filename),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      };
    } catch {
      closeAssetFile(opened);
      throw new SocialPrepMediaError('asset_unavailable', 404, 'The asset is unavailable.');
    }
  }

  return Object.freeze({ prepareDownload });
}
