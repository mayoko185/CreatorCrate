import { describe, it, expect } from 'vitest';

// Phase 10.1A: narrowest practical Sharp smoke test. Proves the dependency
// can be imported in the current runtime and reports its version. No
// transformation, no I/O — just import + versions.

describe('sharp dependency (Phase 10.1A smoke)', () => {
  it('imports sharp and reports runtime versions', async () => {
    const sharp = (await import('sharp')).default;

    expect(sharp).toBeDefined();
    expect(typeof sharp).toBe('function');

    const versions = sharp.versions;
    expect(versions).toBeDefined();
    expect(typeof versions.sharp).toBe('string');
    expect(versions.sharp.length).toBeGreaterThan(0);

    // libvips version is reported as "vips" in sharp.versions.
    expect(typeof versions.vips).toBe('string');
    expect(versions.vips.length).toBeGreaterThan(0);
  });

  it('reports the Node version this runtime loaded against', async () => {
    const sharp = (await import('sharp')).default;
    const v = sharp.versions;
    // Smoke output for the required report: sharp, vips, node.
    expect(v.sharp).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.vips).toMatch(/^\d+\.\d+\.\d+/);
    expect(process.versions.node).toMatch(/^\d+\.\d+\.\d+/);
  });
});