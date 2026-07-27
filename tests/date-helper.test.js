/**
 * Tests for the application-local date helper.
 *
 * Phase 6B regression: the dashboard boundary used to call
 * `new Date().toISOString().split('T')[0]`, which always reports the UTC
 * date. Near local midnight, UTC and local can disagree, so a release
 * planned for "today" can be misclassified. The helper is the single source
 * of truth for application-local time and must use the local year/month/day
 * parts of a Date.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatLocalDate, getLocalTodayIso } from '../src/util/date.js';

describe('application-local date helper', () => {
  describe('formatLocalDate', () => {
    it('returns YYYY-MM-DD using the date\'s local year, month, and day', () => {
      // Construct a Date at local noon. In any OS timezone, the local date
      // parts are 2025-06-15.
      const date = new Date(2025, 5, 15, 12, 0, 0);
      expect(formatLocalDate(date)).toBe('2025-06-15');
    });

    it('pads single-digit months and days with a leading zero', () => {
      const date = new Date(2025, 0, 5, 12, 0, 0); // local 2025-01-05
      expect(formatLocalDate(date)).toBe('2025-01-05');
    });

    it('returns the local date even at the very end of the local day', () => {
      // 23:59:59 local — the local date is still the same day regardless of
      // OS timezone. The UTC date can be tomorrow in some zones, but the
      // helper must use the local parts.
      const date = new Date(2025, 5, 15, 23, 59, 59);
      expect(formatLocalDate(date)).toBe('2025-06-15');
    });

    it('returns the local date at the very start of the local day', () => {
      // 00:00:00 local — midnight belongs to the new day locally.
      const date = new Date(2025, 5, 16, 0, 0, 0);
      expect(formatLocalDate(date)).toBe('2025-06-16');
    });

    it('uses local date parts, not the UTC parts that toISOString would return', () => {
      // The UTC moment 2025-06-15T23:00:00Z. The local date depends on the
      // OS timezone, but it is always `date.getFullYear()-getMonth+1-getDate`.
      // The helper must use those local parts, never the UTC date that
      // `toISOString().split('T')[0]` would return.
      const date = new Date('2025-06-15T23:00:00Z');
      const localParts = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      expect(formatLocalDate(date)).toBe(localParts);
      // The local date must NOT be derived from the UTC ISO string. We
      // assert that by checking against the local parts rather than the
      // ISO date: in some timezones the two will differ and the helper
      // must still report the local parts.
      const utcDate = date.toISOString().split('T')[0];
      // No assertion that they differ — the test must pass regardless of OS
      // timezone. The point is the helper is independent of toISOString.
      expect([localParts, utcDate]).toContain(formatLocalDate(date));
    });
  });

  describe('getLocalTodayIso', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns a YYYY-MM-DD string for the current local date', () => {
      // Set the clock to local noon on 2025-06-15.
      vi.setSystemTime(new Date(2025, 5, 15, 12, 0, 0));
      const result = getLocalTodayIso();
      expect(result).toBe('2025-06-15');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('UTC midnight boundary: uses local date when local differs from UTC', () => {
      // The system clock is set to 2025-06-16 00:30 LOCAL. In some OS
      // timezones (UTC and east) the UTC date agrees; in others (west of
      // UTC) the UTC date is still 2025-06-15. The helper must return the
      // LOCAL date in every case — 2025-06-16.
      vi.setSystemTime(new Date(2025, 5, 16, 0, 30, 0));
      expect(getLocalTodayIso()).toBe('2025-06-16');
    });

    it('local date differs from UTC date for moments near local midnight', () => {
      // The system clock is set to 2025-06-15 23:30 LOCAL. The local date
      // is 2025-06-15 in every timezone. The helper must return 2025-06-15.
      // If a buggy implementation used toISOString, in some timezones the
      // returned value would be 2025-06-16 (the UTC date). Asserting the
      // local date pins the contract.
      vi.setSystemTime(new Date(2025, 5, 15, 23, 30, 0));
      expect(getLocalTodayIso()).toBe('2025-06-15');
    });
  });
});
