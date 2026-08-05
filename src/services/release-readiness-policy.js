/**
 * Release readiness policy — pure evaluation of release readiness facts.
 *
 * This module contains a single pure function, `evaluateReleaseReadiness`,
 * that determines whether a release is ready to be published based on a set
 * of pre-computed facts. It performs no SQL, no filesystem access, no clock
 * access, no service calls, no mutation, and no rendering.
 *
 * Conventions:
 *   - All checks use `blocker` severity. A single failing blocker prevents
 *     publication.
 *   - The result is a stable plain object with `publishable`, `checks`, and
 *     `facts` properties.
 *   - No scores, percentages, UI labels, URLs, suggested actions, or
 *     persisted readiness state are included.
 */

/**
 * @typedef {object} ReadinessFact
 * Properties mirror the shape returned by
 * `releaseRepository.findReadinessFactsById()`.
 * @property {number} release_id
 * @property {number} project_id
 * @property {string} project_status
 * @property {string|null} release_archived_at
 * @property {string|null} project_archived_at
 * @property {number} selected_asset_count
 * @property {number} present_selected_asset_count
 * @property {number} missing_selected_asset_count
 * @property {number} primary_role_count
 * @property {number} preview_role_count
 * @property {number} attachment_role_count
 * @property {number} source_role_count
 */

/**
 * @typedef {object} ReadinessCheck
 * @property {string} key — stable check identifier
 * @property {boolean} passed — whether the check passes
 * @property {'blocker'} severity — all checks are blockers
 * @property {object} [details] — optional factual details
 */

/**
 * @typedef {object} ReadinessResult
 * @property {boolean} publishable — true only when every blocker passes
 * @property {ReadinessCheck[]} checks — ordered list of all checks
 * @property {ReadinessFact} facts — the input facts, unmodified
 */

/**
 * Evaluate release readiness facts and return a stable readiness verdict.
 *
 * @param {ReadinessFact} facts — pre-computed readiness facts
 * @returns {ReadinessResult} stable plain object
 */
export function evaluateReleaseReadiness(facts) {
  // ── project_status_ready ───────────────────────────────────────────────
  const projectStatusReady = facts.project_status === 'ready';

  // ── assets_selected ───────────────────────────────────────────────────
  const assetsSelected = facts.selected_asset_count > 0;

  // ── selected_assets_present ────────────────────────────────────────────
  // For zero selected assets, no assets are missing (the separate selection
  // blocker still prevents publication).
  const selectedAssetsPresent = facts.missing_selected_asset_count === 0;

  // ── scope_mutable ──────────────────────────────────────────────────────
  const scopeMutable = !facts.release_archived_at && !facts.project_archived_at;

  const checks = [
    {
      key: 'project_status_ready',
      passed: projectStatusReady,
      severity: 'blocker',
      details: { projectStatus: facts.project_status },
    },
    {
      key: 'assets_selected',
      passed: assetsSelected,
      severity: 'blocker',
      details: { selectedAssetCount: facts.selected_asset_count },
    },
    {
      key: 'selected_assets_present',
      passed: selectedAssetsPresent,
      severity: 'blocker',
      details: { missingSelectedAssetCount: facts.missing_selected_asset_count },
    },
    {
      key: 'scope_mutable',
      passed: scopeMutable,
      severity: 'blocker',
      details: {
        releaseArchived: Boolean(facts.release_archived_at),
        projectArchived: Boolean(facts.project_archived_at),
      },
    },
  ];

  const publishable = checks.every((c) => c.passed);

  return { publishable, checks, facts };
}
