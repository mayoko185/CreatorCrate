import fs from 'node:fs';
import { openAssetFile, closeAssetFile } from '../storage/asset-file.js';
import { inspectSourceAnimation } from './source-animation.js';
import { createProjectDirectoryOwnershipVerifier, ProjectOwnershipError } from './project-directory-ownership.js';

const ANIMATION_EXTENSIONS = new Set(['gif', 'webp']);
const RECONCILABLE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', ...ANIMATION_EXTENSIONS]);

/**
 * Source-derived SQLite authority (animation classification, source tuple,
 * source generation) is written only from a project root proven by the
 * canonical ownership verifier (PM-1B). Ownership is a root-level witness:
 * artwork edited in place inside an owned root is still detected and
 * reconciled normally, and a matching marker never implies the source bytes
 * are unchanged. When ownership cannot be proven (unbound, mismatch, an
 * unavailable share) the row keeps its prior state; nothing is rewritten.
 */
export function createSourceAnimationService({
  assetRepository, projectRepository, projectsRoot, projectDirectoryOwnershipRepository,
}) {
  if (!projectDirectoryOwnershipRepository) {
    throw new Error('createSourceAnimationService requires a projectDirectoryOwnershipRepository dependency.');
  }
  const ownershipVerifier = createProjectDirectoryOwnershipVerifier({
    ownershipRepository: projectDirectoryOwnershipRepository,
    projectsRoot,
  });

  // Safely opens the current source and proves the descriptor and path still
  // identify one stable file. Only GIF/WebP are read for animation state; other
  // rasters cost an open and two stats and report `animated: undefined`.
  // `ownership` is the caller's operation handle (one verification per project
  // per logical operation); without one, this call verifies on its own.
  function inspectCurrent(asset, onInspected = (source) => source, ownership = undefined) {
    const project = projectRepository.findById(asset.project_id);
    if (!project?.project_dir) return null;
    try {
      ownershipVerifier.operationFor(ownership).verifyProject(project);
    } catch (err) {
      if (err instanceof ProjectOwnershipError) return null;
      throw err;
    }

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

  function ensureKnown(asset, { ownership } = {}) {
    const extension = String(asset?.extension || '').toLowerCase();
    if (!asset?.is_present || asset.source_animated != null
      || (extension !== 'gif' && extension !== 'webp') || !projectsRoot) return asset;

    const current = assetRepository.findById(asset.id);
    if (!current || !current.is_present || current.source_animated != null) return current || asset;
    const source = inspectCurrent(current, undefined, ownership);
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
  function reconcileSource(asset, { replaced = false, ownership } = {}) {
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
    }, ownership);
  }

  // Lets a caller that reconciles several assets in one logical operation
  // (a listing's presentation policy) verify each project once.
  const beginOperation = () => ownershipVerifier.beginOperation();

  return { ensureKnown, reconcileSource, beginOperation };
}
