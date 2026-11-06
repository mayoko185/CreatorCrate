/**
 * Reviewed-state witness for the Asset detail Delete (WP10A3-B F2), Rename and
 * Move (WP10A3-A F2B).
 *
 * The Asset detail page renders this token into its Delete form from the asset
 * row it shows. The Delete request carries it back, and the asset action
 * service recomputes it from the authoritative row under the project lock,
 * before anything is staged or deleted: a Delete confirmed against one state of
 * the asset can never remove a later state of it (a Rename, a Move, a replaced
 * source) — however late the request reaches the service, and from whichever
 * document it was sent.
 *
 * The token is a domain-separated SHA-256 digest of:
 *   project_id, asset id, category_id, relative_path, source_generation
 * It names nothing the page does not already show, carries no filesystem path
 * in readable form, and is never used to locate a file — only compared with the
 * digest of the current row. A forged or tampered token is simply a mismatch.
 *
 * relative_path changes on every Rename and every Move (the category directory
 * is part of it); category_id is included as well so a category re-pointed at
 * the same directory also counts; source_generation is the row's monotonic
 * source-instance counter, advanced whenever a new file replaces the bytes at
 * that path (scan, processing, request-time reconciliation).
 *
 * Rename and Move (F2B) carry the same token in their own field: it names the
 * asset state the page showed when the request was submitted, and the service
 * refuses a Rename or Move whose row no longer has that state (ASSET_REVIEW_STALE)
 * before any file is touched — so a request delayed past a newer change, made
 * from another tab or before a reload, can never overwrite that change. The
 * generic names below (assetReviewToken, isAssetReviewToken, assetReviewMatches)
 * are the same functions as the Delete-named ones.
 *
 * Known limit (no monotonic location revision exists in the schema): a Rename
 * or Move that later returns the same row to the exact same path, category and
 * source generation produces the same token. That row is then, in every
 * recorded respect, the asset the user reviewed, so deleting it is what the
 * confirmation asked for. The same holds for a Rename or Move: the row it then
 * changes is in every recorded respect the one the request was made against.
 */

import crypto from 'node:crypto';

const DOMAIN = 'creatorcrate.asset-delete-review.v1';
const VERSION_PREFIX = 'v1.';
const TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;

/**
 * @param {{ project_id: number, id: number, category_id: number|null, relative_path: string, source_generation?: number|null }} asset
 * @returns {string|null} null when the row cannot be witnessed
 */
export function assetDeleteReviewToken(asset) {
  if (!asset || !Number.isSafeInteger(asset.project_id) || !Number.isSafeInteger(asset.id)
    || typeof asset.relative_path !== 'string') {
    return null;
  }
  const parts = [
    DOMAIN,
    String(asset.project_id),
    String(asset.id),
    asset.category_id == null ? '' : String(asset.category_id),
    asset.relative_path,
    String(asset.source_generation ?? 0),
  ];
  const digest = crypto.createHash('sha256').update(parts.join('\0'), 'utf8').digest('base64url');
  return `${VERSION_PREFIX}${digest}`;
}

/** True when `value` has the exact shape of a token (one string, nothing else). */
export function isAssetDeleteReviewToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/** Constant-time comparison of a submitted token with the current row's. */
export function assetDeleteReviewMatches(asset, submitted) {
  const expected = assetDeleteReviewToken(asset);
  if (!expected || !isAssetDeleteReviewToken(submitted)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(submitted));
}

// Shared names for every action that confirms one reviewed asset state.
export const assetReviewToken = assetDeleteReviewToken;
export const isAssetReviewToken = isAssetDeleteReviewToken;
export const assetReviewMatches = assetDeleteReviewMatches;
