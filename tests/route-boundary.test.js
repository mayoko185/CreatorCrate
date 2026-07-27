/**
 * Structural tests for the route → service → repository boundary.
 *
 * The architecture plan states that routes must not call repositories
 * directly. This test verifies that constraint statically by scanning the
 * route source files for forbidden import patterns.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES_DIR = fileURLToPath(new URL('../src/routes', import.meta.url));

const ROUTE_FILES = fs.readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(ROUTES_DIR, f));

describe('route → repository boundary', () => {
  it('every route file is present in the routes directory', () => {
    expect(ROUTE_FILES.length).toBeGreaterThan(0);
  });

  for (const routeFile of ROUTE_FILES) {
    const name = path.basename(routeFile);

    it(`${name} does not import any *-repository module directly`, () => {
      const source = fs.readFileSync(routeFile, 'utf8');
      // Match ESM import of the form: import ... from '.../data/something-repository.js';
      // Also catch `from '../data/asset-repository.js'` style.
      const importRegex = /from\s+['"][^'"]*\/data\/[^'"]*-repository(?:\.js)?['"]/g;
      const matches = source.match(importRegex) || [];
      expect(matches).toEqual([]);
    });

    it(`${name} does not require() any *-repository module`, () => {
      const source = fs.readFileSync(routeFile, 'utf8');
      const requireRegex = /require\(\s*['"][^'"]*\/data\/[^'"]*-repository(?:\.js)?['"]\s*\)/g;
      const matches = source.match(requireRegex) || [];
      expect(matches).toEqual([]);
    });

    it(`${name} does not dynamically import any *-repository module`, () => {
      const source = fs.readFileSync(routeFile, 'utf8');
      const dynRegex = /import\(\s*['"][^'"]*\/data\/[^'"]*-repository(?:\.js)?['"]\s*\)/g;
      const matches = source.match(dynRegex) || [];
      expect(matches).toEqual([]);
    });
  }
});
