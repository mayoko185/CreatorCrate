import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ownedPathContentSnapshot,
  ownedPathContinuityChange,
  ownedPathContinuityFailure,
  ownedPathSettledContentSnapshot,
} from '../src/services/owned-path-content.js';

// Production trace (project 41, asset 3165, output 6): the pathname mtime/ctime (always equal)
// reported before the first pre-commit hash, after it and after the re-hash, with identity,
// size (22693514) and both hashes matching. Three distinct values: no reversion.
const PRODUCTION_TIMES = [1791505303076261800n, 1791505302897584100n, 1791505304096824900n];

// WP3: the deferred settling verification of an output whose NAS write metadata reported a
// new value after each of its snapshot reads.
describe('ownedPathContentSnapshot NAS settling', () => {
  let projectDir;
  let filePath;
  let identity;
  let content;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-owned-path-content-'));
    filePath = path.join(projectDir, 'output.png');
    const bytes = Buffer.from('watermarked output bytes');
    fs.writeFileSync(filePath, bytes);
    const stats = fs.lstatSync(filePath, { bigint: true });
    identity = { dev: stats.dev, ino: stats.ino };
    content = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Bigint lstats of the file report mtime = ctime = timeAfter(n) after n completed content
  // reads, plus any real change since the model started (a real write still shows).
  const modelReads = (timeAfter) => {
    const realLstat = fs.lstatSync.bind(fs);
    const realRead = fs.readFileSync.bind(fs);
    const initial = realLstat(filePath, { bigint: true });
    const state = { reads: 0, observed: [] };
    vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...args) => {
      const result = realRead(target, ...args);
      if (typeof target === 'number') state.reads += 1;
      return result;
    });
    vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      const stats = realLstat(target, ...args);
      if (typeof stats.ino !== 'bigint' || path.resolve(String(target)) !== filePath) return stats;
      const base = timeAfter(state.reads);
      const modelled = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        mtimeNs: base + (stats.mtimeNs - initial.mtimeNs), ctimeNs: base + (stats.ctimeNs - initial.ctimeNs),
      });
      state.observed.push(modelled.mtimeNs);
      return modelled;
    });
    return state;
  };
  // A, B, C over the snapshot's two reads; C holds from then on.
  const productionThenSettled = (reads) => PRODUCTION_TIMES[Math.min(reads, 2)];
  const fingerprintOf = (time) => ({ size: BigInt(content.size), mtimeNs: time, ctimeNs: time });
  const traced = () => [];
  const phaseTimes = (trace, phase) => trace.filter((entry) => entry.phase === phase).map((entry) => entry.mtimeNs);

  it('reproduces the production A-B-C sequence as an unsettled snapshot, failing by default', () => {
    const trace = traced();
    modelReads(productionThenSettled);
    expect(ownedPathContentSnapshot(projectDir, filePath, identity, content, trace)).toEqual({
      failure: 'content', unstable: true,
    });
    expect([
      ...phaseTimes(trace, 'precommit-before-hash'),
      ...phaseTimes(trace, 'precommit-after-hash'),
      ...phaseTimes(trace, 'precommit-after-rehash'),
    ]).toEqual(PRODUCTION_TIMES.map(String));
  });

  it('settles the production A-B-C sequence with one more bracketed verification', () => {
    modelReads(productionThenSettled);
    expect(ownedPathContentSnapshot(projectDir, filePath, identity, content, undefined, { deferUnsettled: true }))
      .toEqual({ failure: null, fingerprint: null, unsettled: true });
    const settled = ownedPathSettledContentSnapshot(projectDir, filePath, identity, content);
    expect(settled).toEqual({ failure: null, fingerprint: fingerprintOf(PRODUCTION_TIMES[2]) });
    expect(ownedPathContinuityFailure(filePath, identity, settled.fingerprint)).toBeNull();
  });

  it('never accepts an earlier observed value at the continuity sweep', () => {
    modelReads(productionThenSettled);
    ownedPathContentSnapshot(projectDir, filePath, identity, content, undefined, { deferUnsettled: true });
    const { fingerprint } = ownedPathSettledContentSnapshot(projectDir, filePath, identity, content);
    for (const earlier of PRODUCTION_TIMES.slice(0, 2)) {
      vi.restoreAllMocks();
      modelReads(() => earlier);
      expect(ownedPathContinuityFailure(filePath, identity, fingerprint)).toBe('content');
    }
  });

  it('rejects metadata that keeps moving across the settling read', () => {
    modelReads((reads) => PRODUCTION_TIMES[2] + BigInt(reads) * 1000n);
    ownedPathContentSnapshot(projectDir, filePath, identity, content, undefined, { deferUnsettled: true });
    expect(ownedPathSettledContentSnapshot(projectDir, filePath, identity, content)).toEqual({
      failure: 'content', unstable: true,
    });
  });

  it('rejects changed bytes, a foreign identity or unknown identity at the settling verification', () => {
    modelReads(productionThenSettled);
    expect(ownedPathContentSnapshot(projectDir, filePath, identity, content, undefined, { deferUnsettled: true }).unsettled)
      .toBe(true);
    const descriptor = fs.openSync(filePath, 'r+');
    try {
      fs.writeSync(descriptor, Buffer.alloc(content.size, 0x45), 0, content.size, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    expect(ownedPathSettledContentSnapshot(projectDir, filePath, identity, content)).toEqual({ failure: 'content' });
    expect(ownedPathSettledContentSnapshot(projectDir, filePath, { ...identity, ino: identity.ino + 1n }, content))
      .toEqual({ failure: 'identity' });
    expect(ownedPathSettledContentSnapshot(projectDir, filePath, { dev: 0n, ino: 0n }, content))
      .toEqual({ failure: 'identity' });
  });

  it('rejects a write landing after the settling hash at the continuity sweep', () => {
    modelReads(productionThenSettled);
    ownedPathContentSnapshot(projectDir, filePath, identity, content, undefined, { deferUnsettled: true });
    const { fingerprint } = ownedPathSettledContentSnapshot(projectDir, filePath, identity, content);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(filePath, later, later);
    expect(ownedPathContinuityFailure(filePath, identity, fingerprint)).toBe('content');
  });

  // WP3 C4 production trace (same output, a later run): the re-hash matched and its post-rehash
  // mtime/ctime held; the final metadata sweep then reported a later value, same dev/ino/size.
  describe('final-sweep reverification (WP3 C4)', () => {
    const AFTER_REHASH = 1791519731780353400n;
    const FINAL_SWEEP = 1791519732993764300n;
    const REVERIFY = { before: 'precommit-reverify-before-hash', after: 'precommit-reverify-after-hash' };
    // Moved before the hash, held across the re-hash; FINAL_SWEEP once `sweep.moved`.
    const productionFinalSweep = (sweep) => (reads) => {
      if (sweep.moved) return FINAL_SWEEP;
      return reads === 0 ? AFTER_REHASH - 1000000000n : AFTER_REHASH;
    };
    const writeSameSize = () => {
      const descriptor = fs.openSync(filePath, 'r+');
      try {
        fs.writeSync(descriptor, Buffer.alloc(content.size, 0x47), 0, content.size, 0);
      } finally {
        fs.closeSync(descriptor);
      }
    };

    it('re-proves the expected bytes under a fresh bracketed fingerprint, under its own phases', () => {
      const sweep = { moved: false };
      const trace = traced();
      modelReads(productionFinalSweep(sweep));
      const snapshot = ownedPathContentSnapshot(projectDir, filePath, identity, content, trace);
      expect(snapshot).toEqual({ failure: null, fingerprint: fingerprintOf(AFTER_REHASH) });
      sweep.moved = true;
      expect(ownedPathContinuityFailure(filePath, identity, snapshot.fingerprint, trace)).toBe('content');
      const reverified = ownedPathSettledContentSnapshot(projectDir, filePath, identity, content, trace, REVERIFY);
      expect(reverified).toEqual({ failure: null, fingerprint: fingerprintOf(FINAL_SWEEP) });
      expect(phaseTimes(trace, REVERIFY.before)).toEqual([String(FINAL_SWEEP)]);
      expect(phaseTimes(trace, REVERIFY.after)).toEqual([String(FINAL_SWEEP)]);
      expect(phaseTimes(trace, 'precommit-settle-before-hash')).toEqual([]);
      expect(ownedPathContinuityFailure(filePath, identity, reverified.fingerprint)).toBeNull();
      // The earlier post-rehash value is never evidence once the metadata moved.
      expect(ownedPathContinuityFailure(filePath, identity, snapshot.fingerprint)).toBe('content');
    });

    it('rejects same-size changed bytes, a foreign identity or unknown identity at the reverification', () => {
      const sweep = { moved: false };
      modelReads(productionFinalSweep(sweep));
      expect(ownedPathContentSnapshot(projectDir, filePath, identity, content).failure).toBeNull();
      sweep.moved = true;
      expect(ownedPathSettledContentSnapshot(projectDir, filePath, { ...identity, ino: identity.ino + 1n }, content,
        undefined, REVERIFY)).toEqual({ failure: 'identity' });
      expect(ownedPathSettledContentSnapshot(projectDir, filePath, { dev: 0n, ino: 0n }, content, undefined, REVERIFY))
        .toEqual({ failure: 'identity' });
      writeSameSize();
      expect(ownedPathSettledContentSnapshot(projectDir, filePath, identity, content, undefined, REVERIFY))
        .toEqual({ failure: 'content' });
    });

    it('rejects metadata that moves across the reverification read', () => {
      const sweep = { moved: false };
      const held = productionFinalSweep(sweep);
      modelReads((reads) => (sweep.moved ? FINAL_SWEEP + BigInt(reads) * 1000n : held(reads)));
      expect(ownedPathContentSnapshot(projectDir, filePath, identity, content).failure).toBeNull();
      sweep.moved = true;
      expect(ownedPathSettledContentSnapshot(projectDir, filePath, identity, content, undefined, REVERIFY)).toEqual({
        failure: 'content', unstable: true,
      });
    });

    // WP3 C6: only write-time movement at the verified size is a reverification candidate.
    describe('final-sweep change classification (WP3 C6)', () => {
      const snapshotThenMove = () => {
        const sweep = { moved: false };
        modelReads(productionFinalSweep(sweep));
        const snapshot = ownedPathContentSnapshot(projectDir, filePath, identity, content);
        expect(snapshot.failure).toBeNull();
        sweep.moved = true;
        return snapshot.fingerprint;
      };
      const append = (bytes) => fs.appendFileSync(filePath, bytes);

      it('classifies write-time movement at the verified size and exact identity as write-times', () => {
        const fingerprint = snapshotThenMove();
        expect(ownedPathContinuityChange(filePath, identity, fingerprint)).toBe('write-times');
        expect(ownedPathContinuityFailure(filePath, identity, fingerprint)).toBe('content');
      });

      it('classifies a size the sweep observes as size, whatever the write times', () => {
        const fingerprint = snapshotThenMove();
        append(Buffer.alloc(16, 0x4d));
        expect(ownedPathContinuityChange(filePath, identity, fingerprint)).toBe('size');
        expect(ownedPathContinuityChange(filePath, identity, { ...fingerprint, mtimeNs: FINAL_SWEEP, ctimeNs: FINAL_SWEEP }))
          .toBe('size');
        // The shared helper's outcome is unchanged.
        expect(ownedPathContinuityFailure(filePath, identity, fingerprint)).toBe('content');
      });

      it('classifies unknown, foreign, missing and nonregular paths as identity', () => {
        const fingerprint = snapshotThenMove();
        expect(ownedPathContinuityChange(filePath, { dev: 0n, ino: 0n }, fingerprint)).toBe('identity');
        expect(ownedPathContinuityChange(filePath, { ...identity, ino: identity.ino + 1n }, fingerprint)).toBe('identity');
        expect(ownedPathContinuityChange(path.join(projectDir, 'missing.png'), identity, fingerprint)).toBe('identity');
        expect(ownedPathContinuityChange(projectDir, identity, fingerprint)).toBe('identity');
      });

      it('never classifies a change without a verified fingerprint as write-times', () => {
        snapshotThenMove();
        expect(ownedPathContinuityChange(filePath, identity, null)).toBe('content');
        expect(ownedPathContinuityChange(filePath, identity, undefined)).toBe('content');
      });
    });
  });
});
