import fs from 'node:fs';
import { openAssetFile, closeAssetFile } from '../storage/asset-file.js';
import { inspectSourceAnimation } from './source-animation.js';

const ANIMATION_EXTENSIONS = new Set(['gif', 'webp']);
const RECONCILABLE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', ...ANIMATION_EXTENSIONS]);

export function createSourceAnimationService({ assetRepository, projectRepository, projectsRoot }) {
  // Safely opens the current source and proves the descriptor and path still
  // identify one stable file. Only GIF/WebP are read for animation state; other
  // rasters cost an open and two stats and report `animated: undefined`.
  function inspectCurrent(asset, onInspected = (source) => source) {
    const project = projectRepository.findById(asset.project_id);
    if (!project?.project_dir) return null;

    let opened;
    try {
      let source;
      try {
        opened = openAssetFile(projectsRoot, project.project_dir, asset.relative_path);
        const extension = String(asset.extension).toLowerCase();
        const inspectsAnimation = ANIMATION_EXTENSIONS.has(extension);
        const animated = inspectsAnimation ? inspectSourceAnimation(opened.handle, extension) : undefined;
        const afterRead = fs.fstatSync(opened.handle);
        const atPath = fs.statSync(opened.absolutePath);
        if ((inspectsAnimation && animated == null) || opened.stat.dev !== afterRead.dev || opened.stat.ino !== afterRead.ino
          || opened.stat.size !== afterRead.size || opened.stat.mtimeMs !== afterRead.mtimeMs
          || opened.stat.ctimeMs !== afterRead.ctimeMs
          || atPath.dev !== afterRead.dev || atPath.ino !== afterRead.ino
          || atPath.size !== afterRead.size || atPath.mtimeMs !== afterRead.mtimeMs
          || atPath.ctimeMs !== afterRead.ctimeMs) return null;
        source = { animated, size: afterRead.size, mtime: afterRead.mtime.toISOString() };
      } catch {
        // An unavailable or unsafe source retains its prior classification.
        return null;
      }
      return onInspected(source);
    } finally {
      if (opened) closeAssetFile(opened);
    }
  }

  function ensureKnown(asset) {
    const extension = String(asset?.extension || '').toLowerCase();
    if (!asset?.is_present || asset.source_animated != null
      || (extension !== 'gif' && extension !== 'webp') || !projectsRoot) return asset;

    const current = assetRepository.findById(asset.id);
    if (!current || !current.is_present || current.source_animated != null) return current || asset;
    const source = inspectCurrent(current);
    if (!source || source.size !== current.size_bytes || source.mtime !== current.modified_at) return current;
    return assetRepository.setSourceAnimationIfUnknown(current, Number(source.animated))
      || assetRepository.findById(current.id) || current;
  }

  // Replace the row's source tuple with the file now on disk for any ordinary
  // raster (PNG/JPEG/GIF/WebP); GIF/WebP additionally reconcile animation.
  // `asset` is the row the caller started from and is the update's condition,
  // so a newer scan or reconciliation is never overwritten. `replaced` is the
  // caller's descriptor/path proof that the file is a new instance: the row is
  // then written (advancing its source generation) even when the observed
  // tuple is identical. Returns the updated row, or null when nothing changed
  // or the row moved on.
  function reconcileSource(asset, { replaced = false } = {}) {
    if (!asset?.is_present || !projectsRoot
      || !RECONCILABLE_EXTENSIONS.has(String(asset.extension).toLowerCase())) {
      return null;
    }
    return inspectCurrent(asset, (source) => {
      if (!replaced && source.size === asset.size_bytes && source.mtime === asset.modified_at
        && (source.animated === undefined
          || source.animated === (asset.source_animated == null ? null : Boolean(asset.source_animated)))) {
        return null;
      }
      return assetRepository.reconcileSource(asset, source, { replaced }) || null;
    });
  }

  return { ensureKnown, reconcileSource };
}
