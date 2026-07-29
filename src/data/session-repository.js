/**
 * Phase 12.1+ — server-side session storage. Every row keyed by an opaque
 * HMAC token hash (see auth/session-token.js); this repository never sees
 * or stores a raw session token. Phase 12.2 added csrf_secret for per-session
 * CSRF token derivation.
 */
export function createSessionRepository(db) {
  const insertStmt = db.prepare(
    'INSERT INTO sessions (id, username, csrf_secret, created_at, expires_at) VALUES (@id, @username, @csrfSecret, @createdAt, @expiresAt)'
  );
  const findStmt = db.prepare(
    'SELECT id, username, csrf_secret AS csrfSecret, created_at AS createdAt, expires_at AS expiresAt FROM sessions WHERE id = ?'
  );
  const deleteStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
  const deleteExpiredStmt = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const deleteAllStmt = db.prepare('DELETE FROM sessions');

  return {
    create(session) {
      insertStmt.run(session);
      return session;
    },
    findById(id) {
      return findStmt.get(id) || null;
    },
    deleteById(id) {
      return deleteStmt.run(id).changes > 0;
    },
    deleteExpired(nowIso) {
      return deleteExpiredStmt.run(nowIso).changes;
    },
    deleteAll() {
      return deleteAllStmt.run().changes;
    },
  };
}
