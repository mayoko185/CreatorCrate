import { describe, expect, it } from 'vitest';
import { isProjectArchived } from '../src/services/project-state.js';

describe('project operational archived state', () => {
  it.each([
    [{ status: 'ready', archived_at: null }, false],
    [{ status: 'archived', archived_at: '2026-09-09 12:00:00' }, true],
    [{ status: 'archived', archived_at: null }, true],
  ])('classifies %o as archived=%s', (project, expected) => {
    expect(isProjectArchived(project)).toBe(expected);
  });
});
