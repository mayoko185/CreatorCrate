/**
 * WP8B: the invocation-scoped authority for settling processing recovery after a
 * successful MANUAL scan. App construction creates one pair and hands each half to
 * exactly one owner; neither half is exposed through app.locals, HTTP or JSON.
 *
 * - `grant` (scanner only): `withAcceptance(projectId, callback)` mints a fresh opaque
 *   acceptance for that project, live only while `callback` runs. The scanner calls it
 *   inside its own project-operation section, after its reconciliation committed.
 * - `verifier` (Recovery Evidence service only): `consume(projectId, acceptance)` is true
 *   once for the exact live acceptance minted for that project, then never again.
 *
 * A project ID, a boolean, a copied object or an acceptance that outlived its callback
 * authorizes nothing; neither does an unrelated active project operation.
 */
export function createManualScanAcceptanceAuthority() {
  const live = new WeakMap();

  const grant = Object.freeze({
    withAcceptance(projectId, callback) {
      const acceptance = Object.freeze(Object.create(null));
      live.set(acceptance, projectId);
      try {
        return callback(acceptance);
      } finally {
        live.delete(acceptance);
      }
    },
  });

  const verifier = Object.freeze({
    consume(projectId, acceptance) {
      if (acceptance === null || typeof acceptance !== 'object') return false;
      if (!live.has(acceptance) || live.get(acceptance) !== projectId) return false;
      live.delete(acceptance);
      return true;
    },
  });

  return Object.freeze({ grant, verifier });
}
