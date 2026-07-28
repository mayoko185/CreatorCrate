import { describe, it, expect } from 'vitest';
import { evaluateReleaseReadiness } from '../src/services/release-readiness-policy.js';

/**
 * Build a minimal valid readiness facts object.
 * All fields are populated with sensible defaults so individual tests can
 * override only the fields they care about.
 */
function buildFacts(overrides = {}) {
  return {
    release_id: 1,
    project_id: 1,
    release_status: 'ready',
    release_archived_at: null,
    project_archived_at: null,
    selected_asset_count: 2,
    present_selected_asset_count: 2,
    missing_selected_asset_count: 0,
    primary_role_count: 1,
    preview_role_count: 0,
    attachment_role_count: 1,
    source_role_count: 0,
    ...overrides,
  };
}

describe('evaluateReleaseReadiness', () => {
  // ─── Fully publishable ─────────────────────────────────────────────────

  it('returns publishable=true when all checks pass', () => {
    const facts = buildFacts();
    const result = evaluateReleaseReadiness(facts);

    expect(result.publishable).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  // ─── status_ready ──────────────────────────────────────────────────────

  it('fails status_ready when release_status is not "ready"', () => {
    const statuses = ['idea', 'planned', 'drafting', 'published', 'cancelled'];
    for (const status of statuses) {
      const facts = buildFacts({ release_status: status });
      const result = evaluateReleaseReadiness(facts);

      expect(result.publishable).toBe(false);
      const check = result.checks.find((c) => c.key === 'status_ready');
      expect(check.passed).toBe(false);
      expect(check.details.status).toBe(status);
    }
  });

  // ─── assets_selected ───────────────────────────────────────────────────

  it('fails assets_selected when selected_asset_count is 0', () => {
    const facts = buildFacts({ selected_asset_count: 0 });
    const result = evaluateReleaseReadiness(facts);

    expect(result.publishable).toBe(false);
    const check = result.checks.find((c) => c.key === 'assets_selected');
    expect(check.passed).toBe(false);
    expect(check.details.selectedAssetCount).toBe(0);
  });

  // ─── selected_assets_present: zero-assets semantics ────────────────────

  it('returns selected_assets_present=true when no assets are selected (zero-assets semantics)', () => {
    // Contract: when selected_asset_count === 0, assets_selected = false
    // but selected_assets_present = true (no assets are missing).
    const facts = buildFacts({
      selected_asset_count: 0,
      present_selected_asset_count: 0,
      missing_selected_asset_count: 0,
    });
    const result = evaluateReleaseReadiness(facts);

    const assetsSelected = result.checks.find((c) => c.key === 'assets_selected');
    expect(assetsSelected.passed).toBe(false);

    const assetsPresent = result.checks.find((c) => c.key === 'selected_assets_present');
    expect(assetsPresent.passed).toBe(true);
    expect(assetsPresent.details.missingSelectedAssetCount).toBe(0);

    expect(result.publishable).toBe(false);
  });

  // ─── selected_assets_present: one missing asset ─────────────────────────

  it('fails selected_assets_present when one selected asset is missing', () => {
    const facts = buildFacts({
      selected_asset_count: 2,
      present_selected_asset_count: 1,
      missing_selected_asset_count: 1,
    });
    const result = evaluateReleaseReadiness(facts);

    expect(result.publishable).toBe(false);
    const check = result.checks.find((c) => c.key === 'selected_assets_present');
    expect(check.passed).toBe(false);
    expect(check.details.missingSelectedAssetCount).toBe(1);
  });

  // ─── selected_assets_present: multiple missing assets ──────────────────

  it('fails selected_assets_present when multiple selected assets are missing', () => {
    const facts = buildFacts({
      selected_asset_count: 5,
      present_selected_asset_count: 2,
      missing_selected_asset_count: 3,
    });
    const result = evaluateReleaseReadiness(facts);

    expect(result.publishable).toBe(false);
    const check = result.checks.find((c) => c.key === 'selected_assets_present');
    expect(check.passed).toBe(false);
    expect(check.details.missingSelectedAssetCount).toBe(3);
  });

  // ─── scope_mutable: archived release ───────────────────────────────────

  it('fails scope_mutable when release is archived', () => {
    const facts = buildFacts({
      release_archived_at: '2025-06-15 10:00:00',
    });
    const result = evaluateReleaseReadiness(facts);

    expect(result.publishable).toBe(false);
    const check = result.checks.find((c) => c.key === 'scope_mutable');
    expect(check.passed).toBe(false);
    expect(check.details.releaseArchived).toBe(true);
    expect(check.details.projectArchived).toBe(false);
  });

  // ─── scope_mutable: archived parent project ────────────────────────────

  it('fails scope_mutable when parent project is archived', () => {
    const facts = buildFacts({
      project_archived_at: '2025-06-15 10:00:00',
    });
    const result = evaluateReleaseReadiness(facts);

    expect(result.publishable).toBe(false);
    const check = result.checks.find((c) => c.key === 'scope_mutable');
    expect(check.passed).toBe(false);
    expect(check.details.releaseArchived).toBe(false);
    expect(check.details.projectArchived).toBe(true);
  });

  // ─── Multiple simultaneous blockers ────────────────────────────────────

  it('reports multiple failing checks simultaneously', () => {
    const facts = buildFacts({
      release_status: 'drafting',
      selected_asset_count: 0,
      missing_selected_asset_count: 0,
      release_archived_at: '2025-06-15 10:00:00',
    });
    const result = evaluateReleaseReadiness(facts);

    expect(result.publishable).toBe(false);

    const statusCheck = result.checks.find((c) => c.key === 'status_ready');
    expect(statusCheck.passed).toBe(false);

    const assetsSelected = result.checks.find((c) => c.key === 'assets_selected');
    expect(assetsSelected.passed).toBe(false);

    const assetsPresent = result.checks.find((c) => c.key === 'selected_assets_present');
    expect(assetsPresent.passed).toBe(true); // zero assets → no missing

    const scopeCheck = result.checks.find((c) => c.key === 'scope_mutable');
    expect(scopeCheck.passed).toBe(false);

    const failedChecks = result.checks.filter((c) => !c.passed);
    expect(failedChecks).toHaveLength(3);
  });

  // ─── Role counts do not affect publishability ──────────────────────────

  it('returns publishable=true regardless of role count distribution', () => {
    // All checks pass; role counts are informational only.
    const facts = buildFacts({
      primary_role_count: 0,
      preview_role_count: 0,
      attachment_role_count: 0,
      source_role_count: 0,
    });
    const result = evaluateReleaseReadiness(facts);

    expect(result.publishable).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('returns publishable=true with only primary role selected', () => {
    const facts = buildFacts({
      selected_asset_count: 1,
      present_selected_asset_count: 1,
      missing_selected_asset_count: 0,
      primary_role_count: 1,
      preview_role_count: 0,
      attachment_role_count: 0,
      source_role_count: 0,
    });
    const result = evaluateReleaseReadiness(facts);

    expect(result.publishable).toBe(true);
  });

  // ─── Deterministic output ─────────────────────────────────────────────

  it('returns identical results for identical inputs (deterministic)', () => {
    const facts = buildFacts();
    const result1 = evaluateReleaseReadiness(facts);
    const result2 = evaluateReleaseReadiness(facts);

    expect(result1).toEqual(result2);
  });

  it('returns a fresh object on each call (no shared mutable state)', () => {
    const facts = buildFacts();
    const result1 = evaluateReleaseReadiness(facts);
    const result2 = evaluateReleaseReadiness(facts);

    expect(result1).not.toBe(result2);
    expect(result1.checks).not.toBe(result2.checks);
    expect(result1.checks[0]).not.toBe(result2.checks[0]);
  });

  // ─── Input object is not mutated ───────────────────────────────────────

  it('does not mutate the input facts object', () => {
    const facts = buildFacts();
    const frozen = Object.freeze({ ...facts });

    // Should not throw — the function must not mutate its input.
    expect(() => evaluateReleaseReadiness(frozen)).not.toThrow();
  });

  it('preserves the original facts object in the result', () => {
    const facts = buildFacts();
    const result = evaluateReleaseReadiness(facts);

    // The result.facts must be the same reference (not a clone).
    expect(result.facts).toBe(facts);
    expect(result.facts).toEqual(facts);
  });

  // ─── Exact check keys and order ────────────────────────────────────────

  it('returns checks in the exact expected order', () => {
    const facts = buildFacts();
    const result = evaluateReleaseReadiness(facts);

    const keys = result.checks.map((c) => c.key);
    expect(keys).toEqual([
      'status_ready',
      'assets_selected',
      'selected_assets_present',
      'scope_mutable',
    ]);
  });

  it('each check has exactly key, passed, severity, and details properties', () => {
    const facts = buildFacts();
    const result = evaluateReleaseReadiness(facts);

    for (const check of result.checks) {
      expect(check).toHaveProperty('key');
      expect(check).toHaveProperty('passed');
      expect(check).toHaveProperty('severity');
      expect(check).toHaveProperty('details');
      expect(Object.keys(check)).toEqual(['key', 'passed', 'severity', 'details']);
    }
  });

  it('all checks use blocker severity', () => {
    const facts = buildFacts();
    const result = evaluateReleaseReadiness(facts);

    for (const check of result.checks) {
      expect(check.severity).toBe('blocker');
    }
  });

  // ─── Result shape contract ────────────────────────────────────────────

  it('returns a stable plain object with publishable, checks, and facts', () => {
    const facts = buildFacts();
    const result = evaluateReleaseReadiness(facts);

    expect(result).toHaveProperty('publishable');
    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('facts');
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks).toHaveLength(4);
  });

  it('publishable is true only when every check passes', () => {
    // Verify the contract: publishable = checks.every(c => c.passed)
    const passing = buildFacts();
    const passResult = evaluateReleaseReadiness(passing);
    expect(passResult.publishable).toBe(passResult.checks.every((c) => c.passed));

    const failing = buildFacts({ release_status: 'idea' });
    const failResult = evaluateReleaseReadiness(failing);
    expect(failResult.publishable).toBe(failResult.checks.every((c) => c.passed));
  });
});
