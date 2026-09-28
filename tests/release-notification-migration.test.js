import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const IDENTITY = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const NOW = '2026-06-01T00:00:00.000Z';

describe('release notification migration', () => {
  let db;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function createRelease() {
    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, project_type, patreon_url)
      VALUES ('Project', 'project', '', '', 'tbd', 'images', NULL)
    `).run().lastInsertRowid);
    return Number(db.prepare("INSERT INTO releases (project_id, title) VALUES (?, 'Release')")
      .run(projectId).lastInsertRowid);
  }

  function insertOccurrence(releaseId, { eventId = 'event-1', key = 'key-1', reason = 'release.scheduled', repeatDueAt = null } = {}) {
    db.prepare(`
      INSERT INTO release_notification_occurrences
        (event_id, release_id, occurrence_key, reason, schedule_fingerprint, repeat_due_at, due_at, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(eventId, releaseId, key, reason, FINGERPRINT, repeatDueAt, NOW, NOW);
  }

  function insertDelivery(eventId, { deliveryId = 'delivery-1', channel = 'email', state = 'pending' } = {}) {
    db.prepare(`
      INSERT INTO release_notification_deliveries
        (delivery_id, event_id, channel, destination_identity, activation_generation, state, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(deliveryId, eventId, channel, IDENTITY, state, state === 'pending' ? NOW : null, NOW, NOW);
  }

  it('enforces one logical occurrence per key and one delivery per event and channel', () => {
    const releaseId = createRelease();
    insertOccurrence(releaseId);
    expect(() => insertOccurrence(releaseId, { eventId: 'event-2' })).toThrow(/UNIQUE/);

    insertDelivery('event-1');
    expect(() => insertDelivery('event-1', { deliveryId: 'delivery-2' })).toThrow(/UNIQUE/);
    insertDelivery('event-1', { deliveryId: 'delivery-3', channel: 'ntfy' });
  });

  it('rejects unknown reasons, channels, states, and repeat identity mismatches', () => {
    const releaseId = createRelease();
    expect(() => insertOccurrence(releaseId, { reason: 'notification.test' })).toThrow(/CHECK/);
    expect(() => insertOccurrence(releaseId, { reason: 'release.overdue_repeat' })).toThrow(/CHECK/);
    expect(() => insertOccurrence(releaseId, { repeatDueAt: NOW })).toThrow(/CHECK/);
    insertOccurrence(releaseId);
    expect(() => insertDelivery('event-1', { channel: 'webpush' })).toThrow(/CHECK/);
    expect(() => insertDelivery('event-1', { state: 'sent' })).toThrow(/CHECK/);
  });

  it('stores one opaque established destination per channel', () => {
    const insert = (channel, identity = IDENTITY, generation = 1) => db.prepare(`
      INSERT INTO release_notification_channel_destinations
        (channel, destination_identity, activation_generation, established_at)
      VALUES (?, ?, ?, ?)
    `).run(channel, identity, generation, NOW);
    insert('ntfy');
    expect(() => insert('ntfy')).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => insert('webpush')).toThrow(/CHECK/);
    expect(() => insert('email', 'https://hooks.example.test/secret')).toThrow(/CHECK/);
    expect(() => insert('email', IDENTITY, 0)).toThrow(/CHECK/);
  });

  it('requires an existing occurrence and cascades cleanup from release deletion', () => {
    expect(() => insertDelivery('missing-event')).toThrow(/FOREIGN KEY/);

    const releaseId = createRelease();
    insertOccurrence(releaseId);
    insertDelivery('event-1');
    db.prepare('DELETE FROM releases WHERE id = ?').run(releaseId);

    expect(db.prepare('SELECT COUNT(*) FROM release_notification_occurrences').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM release_notification_deliveries').pluck().get()).toBe(0);
  });
});
