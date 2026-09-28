import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { defaultReleaseNotificationPreferences } from '../src/services/release-notification-settings-service.js';
import {
  computeDestinationIdentity,
  createReleaseNotificationService,
  MATERIALIZATION_CANDIDATE_LIMIT,
  MAX_DELIVERY_ATTEMPTS,
  resolveDueOccurrence,
  TIME_CRITICAL_CANDIDATE_LIMIT,
  resolveReleaseSchedule,
} from '../src/services/release-notification-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const ALL_CHANNELS = ['email', 'ntfy', 'gotify', 'webhook'];
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const DESTINATIONS = {
  email: computeDestinationIdentity('email', { host: 'smtp.example.test', port: 587, from: 'cc@example.test', to: 'me@example.test' }),
  ntfy: computeDestinationIdentity('ntfy', { server: 'https://ntfy.example.test', topic: 'releases' }),
  gotify: computeDestinationIdentity('gotify', { server: 'https://gotify.example.test', token: 'app-token' }),
  webhook: computeDestinationIdentity('webhook', { url: 'https://hooks.example.test/in/secret' }),
};

// Local wall-clock instants, matching the server-local timezone policy.
const local = (month, day, hours = 0, minutes = 0) => new Date(2026, month - 1, day, hours, minutes);

function prefs(overrides = {}) {
  return {
    ...defaultReleaseNotificationPreferences(),
    enabled: true,
    enabledChannels: ALL_CHANNELS,
    ...overrides,
  };
}

describe('release notification core service', () => {
  let db;
  let clock;
  let service;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    clock = local(6, 1, 8);
    service = createReleaseNotificationService({
      db,
      now: () => new Date(clock),
      releaseUrlForId: (id) => `https://creatorcrate.example.test/releases/${id}`,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function createProject(title = 'Project') {
    return Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, project_type, patreon_url)
      VALUES (?, lower(?) || '-' || abs(random()), '', '', 'tbd', 'images', NULL)
    `).run(title, title).lastInsertRowid);
  }

  function createRelease({ projectId = createProject(), plannedDate = '2026-06-10', plannedTime = '14:00' } = {}) {
    return Number(db.prepare(`
      INSERT INTO releases (project_id, title, notes, planned_date, planned_time) VALUES (?, 'Release', '', ?, ?)
    `).run(projectId, plannedDate, plannedTime).lastInsertRowid);
  }

  function setClock(date) {
    clock = date;
  }

  function occurrences() {
    return db.prepare('SELECT * FROM release_notification_occurrences ORDER BY created_at, reason').all();
  }

  function deliveries(eventId) {
    return service.repository.listDeliveriesForEvent(eventId);
  }

  function claimAll(destinations = DESTINATIONS) {
    return Object.fromEntries(service.claimDueDeliveries({ destinations, limit: 50 })
      .sort((a, b) => ALL_CHANNELS.indexOf(a.channel) - ALL_CHANNELS.indexOf(b.channel))
      .map((claim) => [claim.channel, claim]));
  }

  describe('occurrence identity and fan-out', () => {
    it('materializes one parent with one child per selected channel, exactly once', () => {
      service.updateSettings(prefs());
      const releaseId = createRelease();
      setClock(local(6, 10, 14, 5));

      const [result] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(result.occurrence.reason).toBe('release.scheduled');
      expect(result.deliveries.map((d) => d.channel)).toEqual(ALL_CHANNELS);
      expect(service.materializeDueOccurrences({ destinations: DESTINATIONS })).toEqual([]);

      expect(occurrences()).toHaveLength(1);
      expect(deliveries(result.occurrence.event_id)).toHaveLength(4);
      const payload = JSON.parse(result.occurrence.payload_json);
      expect(payload).toMatchObject({
        eventId: result.occurrence.event_id,
        type: 'release.scheduled',
        release: { id: releaseId, title: 'Release', url: `https://creatorcrate.example.test/releases/${releaseId}` },
        project: { title: 'Project' },
        schedule: { plannedDate: '2026-06-10', plannedTime: '14:00', usedDefaultTime: false },
      });
      expect(payload.schedule.scheduledAt).toBe(local(6, 10, 14).toISOString());
      expect(payload.createdAt).toBe(result.occurrence.created_at);
      expect(payload.createdAt).toBe(new Date(clock).toISOString());
    });

    it('creates only the selected subset of channels', () => {
      service.updateSettings(prefs({ enabledChannels: ['ntfy', 'webhook'] }));
      createRelease();
      setClock(local(6, 10, 14));
      const [result] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(result.deliveries.map((d) => d.channel)).toEqual(['ntfy', 'webhook']);
    });

    it('ignores unrelated release edits but treats a schedule change as new identity and stale work', () => {
      service.updateSettings(prefs());
      const releaseId = createRelease();
      setClock(local(6, 10, 14));
      const [{ occurrence: original }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });

      db.prepare("UPDATE releases SET title = 'Renamed', notes = 'n', updated_at = datetime('now', '+1 day') WHERE id = ?")
        .run(releaseId);
      expect(service.materializeDueOccurrences({ destinations: DESTINATIONS })).toEqual([]);

      db.prepare("UPDATE releases SET planned_time = '13:00' WHERE id = ?").run(releaseId);
      expect(service.claimDueDeliveries({ destinations: DESTINATIONS })).toEqual([]);
      expect(deliveries(original.event_id).every((d) => d.state === 'cancelled' && d.failure_code === 'schedule_changed'))
        .toBe(true);

      const [rescheduled] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(rescheduled.occurrence.schedule_fingerprint).not.toBe(original.schedule_fingerprint);

      // Returning to the original schedule reuses the original occurrence instead of replaying it.
      db.prepare("UPDATE releases SET planned_time = '14:00' WHERE id = ?").run(releaseId);
      expect(service.materializeDueOccurrences({ destinations: DESTINATIONS })).toEqual([]);
      expect(occurrences()).toHaveLength(2);
    });
  });

  describe('independent delivery state', () => {
    it('retries and exhausts only the failing child while an accepted sibling stays accepted', () => {
      service.updateSettings(prefs({
        enabledChannels: ['email', 'ntfy', 'webhook'],
        overdue: { enabled: false, graceMinutes: 60 },
      }));
      createRelease();
      setClock(local(6, 10, 14));
      const [{ occurrence }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });

      const claims = claimAll();
      expect(Object.keys(claims)).toEqual(['email', 'ntfy', 'webhook']);
      expect(claims.ntfy.payload.eventId).toBe(occurrence.event_id);
      service.completeDelivery({ ...claims.email, outcome: 'accepted' });
      service.completeDelivery({ ...claims.webhook, outcome: 'accepted' });
      const acceptedEmail = service.repository.findDelivery(claims.email.deliveryId);

      const expectedDelays = [1, 5, 15, 60].map((m) => m * MINUTE);
      let claim = claims.ntfy;
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
        expect(claim.attempt).toBe(attempt);
        const { delivery } = service.completeDelivery({ ...claim, outcome: 'transient_failure', failureCode: 'http_503' });
        if (attempt === MAX_DELIVERY_ATTEMPTS) {
          expect(delivery).toMatchObject({ state: 'failed', failure_code: 'http_503', attempt_count: 5 });
          break;
        }
        expect(delivery.state).toBe('pending');
        expect(Date.parse(delivery.next_attempt_at) - clock.getTime()).toBe(expectedDelays[attempt - 1]);
        setClock(new Date(Date.parse(delivery.next_attempt_at)));
        const next = claimAll();
        expect(Object.keys(next)).toEqual(['ntfy']);
        // A retry carries the same frozen payload, including the materialization createdAt.
        expect(next.ntfy.deliveryId).toBe(claims.ntfy.deliveryId);
        expect(next.ntfy.payload).toStrictEqual(claims.ntfy.payload);
        expect(next.ntfy.payload.createdAt).toBe(occurrence.created_at);
        claim = next.ntfy;
      }

      expect(service.repository.findDelivery(claims.email.deliveryId)).toEqual(acceptedEmail);
      expect(service.materializeDueOccurrences({ destinations: DESTINATIONS })).toEqual([]);
      setClock(new Date(clock.getTime() + 24 * HOUR));
      expect(claimAll()).toEqual({});
    });

    it('lets a bounded Retry-After lengthen, but not shorten, the retry delay', () => {
      service.updateSettings(prefs({ enabledChannels: ['ntfy'] }));
      createRelease();
      setClock(local(6, 10, 14));
      service.materializeDueOccurrences({ destinations: DESTINATIONS });
      const { ntfy } = claimAll();
      const { delivery } = service.completeDelivery({
        ...ntfy, outcome: 'transient_failure', failureCode: 'http_429', retryAfterMs: 10 * HOUR,
      });
      expect(Date.parse(delivery.next_attempt_at) - clock.getTime()).toBe(60 * MINUTE);
    });

    it('rejects stale-claim completion and reclaims an expired lease', () => {
      service.updateSettings(prefs({ enabledChannels: ['email'] }));
      createRelease();
      setClock(local(6, 10, 14));
      service.materializeDueOccurrences({ destinations: DESTINATIONS });
      const first = claimAll().email;
      expect(claimAll()).toEqual({});

      setClock(new Date(clock.getTime() + 6 * MINUTE));
      const second = claimAll().email;
      expect(second.claimToken).not.toBe(first.claimToken);
      expect(second.attempt).toBe(2);

      expect(service.completeDelivery({ ...first, outcome: 'accepted' })).toMatchObject({ applied: false, code: 'stale_claim' });
      expect(service.completeDelivery({ ...second, outcome: 'accepted' }).delivery.state).toBe('accepted');
    });
  });

  describe('activation', () => {
    it('suppresses occurrences nominally due before notifications were first enabled', () => {
      createRelease({ plannedDate: '2026-05-31', plannedTime: '09:00' });
      service.updateSettings(prefs({ overdue: { enabled: false, graceMinutes: 60 } }));
      expect(service.materializeDueOccurrences({ destinations: DESTINATIONS })).toEqual([]);
    });

    it('never gives a newly enabled channel pre-activation events, but includes it in later repeats', () => {
      service.updateSettings(prefs({
        enabledChannels: ['email'],
        overdueRepeat: { enabled: true, intervalMinutes: 24 * 60 },
      }));
      createRelease();

      // Overdue at 15:00 on June 10 is materialized late, after ntfy is enabled.
      setClock(local(6, 10, 16));
      service.updateSettings(prefs({
        enabledChannels: ['email', 'ntfy'],
        overdueRepeat: { enabled: true, intervalMinutes: 24 * 60 },
      }));
      const [overdue] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(overdue.occurrence.reason).toBe('release.overdue');
      expect(overdue.deliveries.map((d) => d.channel)).toEqual(['email']);

      setClock(local(6, 11, 15));
      const [repeat] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(repeat.occurrence.reason).toBe('release.overdue_repeat');
      expect(repeat.deliveries.map((d) => d.channel)).toEqual(['email', 'ntfy']);
      expect(service.getSettings().activation.activatedAt).toBe(local(6, 1, 8).toISOString());
    });

    it('does not backfill an existing occurrence when a channel is enabled later', () => {
      service.updateSettings(prefs({ enabledChannels: ['email'] }));
      createRelease();
      setClock(local(6, 10, 14));
      const [{ occurrence }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      service.updateSettings(prefs({ enabledChannels: ['email', 'gotify'] }));
      expect(service.materializeDueOccurrences({ destinations: DESTINATIONS })).toEqual([]);
      expect(deliveries(occurrence.event_id).map((d) => d.channel)).toEqual(['email']);
    });

    it('disabling a channel cancels only its unsent work and re-enabling uses a new generation', () => {
      service.updateSettings(prefs({ enabledChannels: ['email', 'ntfy', 'webhook'] }));
      createRelease();
      setClock(local(6, 10, 14));
      const [{ occurrence }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      const { email, webhook } = claimAll();
      service.completeDelivery({ ...email, outcome: 'accepted' });
      service.completeDelivery({ ...webhook, outcome: 'transient_failure', failureCode: 'timeout' });

      service.updateSettings(prefs({ enabledChannels: ['email', 'webhook'] }));
      service.updateSettings(prefs({ enabledChannels: ['ntfy', 'webhook'] }));
      const byChannel = Object.fromEntries(deliveries(occurrence.event_id).map((d) => [d.channel, d]));
      expect(byChannel.email.state).toBe('accepted');
      expect(byChannel.ntfy).toMatchObject({ state: 'cancelled', failure_code: 'channel_disabled' });
      expect(byChannel.webhook.state).toBe('pending');

      const settings = service.getSettings();
      expect(settings.activation.channels.ntfy.generation).toBe(2);
      expect(settings.activation.channels.webhook.generation).toBe(1);
      setClock(new Date(clock.getTime() + MINUTE));
      expect(Object.keys(claimAll())).toEqual(['webhook']);
    });

    it('treats a delivery from an older activation generation as stale', () => {
      service.updateSettings(prefs({ enabledChannels: ['ntfy'] }));
      createRelease();
      setClock(local(6, 10, 14));
      const [{ deliveries: [delivery] }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      db.prepare('UPDATE release_notification_deliveries SET activation_generation = 7 WHERE delivery_id = ?')
        .run(delivery.delivery_id);
      expect(claimAll()).toEqual({});
      expect(service.repository.findDelivery(delivery.delivery_id).failure_code).toBe('channel_generation_changed');
    });
  });

  describe('destination identity', () => {
    it('excludes credentials from identity but treats routing and Gotify token changes as new destinations', () => {
      expect(computeDestinationIdentity('ntfy', { server: 'https://user:pw@ntfy.example.test/', topic: 'releases' }))
        .toBe(DESTINATIONS.ntfy);
      expect(computeDestinationIdentity('ntfy', { server: 'https://ntfy.example.test', topic: 'other' }))
        .not.toBe(DESTINATIONS.ntfy);
      expect(computeDestinationIdentity('gotify', { server: 'https://gotify.example.test', token: 'rotated' }))
        .not.toBe(DESTINATIONS.gotify);
      expect(() => computeDestinationIdentity('webhook', { url: 'ftp://secret-value' }))
        .toThrow(/^Invalid webhook notification destination: url\.$/);
    });

    it('cancels stale unsent work on destination change, keeps identity-preserving retries, never replays accepted', () => {
      service.updateSettings(prefs({ enabledChannels: ['email', 'ntfy', 'gotify'] }));
      createRelease();
      setClock(local(6, 10, 14));
      const [{ occurrence }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      const claims = claimAll();
      service.completeDelivery({ ...claims.email, outcome: 'accepted' });
      service.completeDelivery({ ...claims.ntfy, outcome: 'transient_failure', failureCode: 'timeout' });
      service.completeDelivery({ ...claims.gotify, outcome: 'transient_failure', failureCode: 'timeout' });

      const rotated = {
        ...DESTINATIONS,
        email: computeDestinationIdentity('email', { host: 'smtp.example.test', port: 587, from: 'cc@example.test', to: 'new@example.test' }),
        gotify: computeDestinationIdentity('gotify', { server: 'https://gotify.example.test', token: 'new-app-token' }),
        // ntfy credentials rotated; server and topic unchanged.
        ntfy: computeDestinationIdentity('ntfy', { server: 'https://ntfy.example.test', topic: 'releases' }),
      };
      expect(service.reconcileDestinations({ destinations: rotated })).toEqual({ email: 0, ntfy: 0, gotify: 1, webhook: 0 });

      setClock(new Date(clock.getTime() + 2 * MINUTE));
      expect(Object.keys(claimAll(rotated))).toEqual(['ntfy']);
      const byChannel = Object.fromEntries(deliveries(occurrence.event_id).map((d) => [d.channel, d]));
      expect(byChannel.email.state).toBe('accepted');
      expect(byChannel.gotify).toMatchObject({ state: 'cancelled', failure_code: 'destination_changed' });
    });
  });

  describe('eligibility and stale-work invalidation', () => {
    it('only materializes unpublished, unarchived, dated releases of active projects', () => {
      service.updateSettings(prefs());
      const published = createRelease();
      db.prepare("UPDATE releases SET published_date = '2026-06-09' WHERE id = ?").run(published);
      const archived = createRelease();
      db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(archived);
      const archivedAtProject = createProject('Archived at');
      db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(archivedAtProject);
      createRelease({ projectId: archivedAtProject });
      const archivedStatusProject = createProject('Archived status');
      db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(archivedStatusProject);
      createRelease({ projectId: archivedStatusProject });
      createRelease({ plannedDate: null, plannedTime: null });
      const completedProject = createProject('Completed');
      db.prepare("UPDATE projects SET status = 'completed' WHERE id = ?").run(completedProject);
      const eligible = createRelease({ projectId: completedProject });

      setClock(local(6, 10, 14));
      const results = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(results.map((r) => r.occurrence.release_id)).toEqual([eligible]);
    });

    it('cancels queued work when the release is published or its project archived', () => {
      service.updateSettings(prefs({ enabledChannels: ['email'] }));
      const projectId = createProject();
      const publishedRelease = createRelease({ projectId: createProject('Other') });
      createRelease({ projectId });
      setClock(local(6, 10, 14));
      service.materializeDueOccurrences({ destinations: DESTINATIONS });

      db.prepare("UPDATE releases SET published_date = '2026-06-10' WHERE id = ?").run(publishedRelease);
      db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(projectId);
      const cancelled = service.invalidateStaleDeliveries({ destinations: DESTINATIONS });
      expect(cancelled.map((c) => c.code).sort()).toEqual(['project_archived', 'release_published']);
    });

    it('cancels queued work of a disabled notification type at save time', () => {
      service.updateSettings(prefs({ enabledChannels: ['email'] }));
      createRelease();
      setClock(local(6, 10, 14));
      const [{ deliveries: [delivery] }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      service.updateSettings(prefs({ enabledChannels: ['email'], scheduled: { enabled: false } }));
      expect(service.repository.findDelivery(delivery.delivery_id))
        .toMatchObject({ state: 'cancelled', failure_code: 'notification_type_disabled' });
    });
  });

  describe('timing-setting changes', () => {
    const noScheduled = { scheduled: { enabled: false } };
    it.each([
      {
        name: 'advance lead',
        before: { ...noScheduled, advance: { enabled: true, leadMinutes: 60 } },
        after: { ...noScheduled, advance: { enabled: true, leadMinutes: 30 } },
        reason: 'release.advance', warmup: [], materializeAt: local(6, 10, 13),
        staleAt: local(6, 10, 13, 10), newDueAt: local(6, 10, 13, 30),
      },
      {
        name: 'overdue grace',
        before: { ...noScheduled, overdue: { enabled: true, graceMinutes: 60 } },
        after: { ...noScheduled, overdue: { enabled: true, graceMinutes: 90 } },
        reason: 'release.overdue', warmup: [], materializeAt: local(6, 10, 15),
        staleAt: local(6, 10, 15, 10), newDueAt: local(6, 10, 15, 30),
      },
      {
        name: 'repeat interval',
        before: { ...noScheduled, overdueRepeat: { enabled: true, intervalMinutes: 60 } },
        after: { ...noScheduled, overdueRepeat: { enabled: true, intervalMinutes: 120 } },
        reason: 'release.overdue_repeat', warmup: [local(6, 10, 15)], materializeAt: local(6, 10, 16),
        staleAt: local(6, 10, 16, 10), newDueAt: local(6, 10, 17),
      },
    ])('$name change cancels stale unsent work and materializes the newly timed notice', (row) => {
      service.updateSettings(prefs({ enabledChannels: ['ntfy'], ...row.before }));
      createRelease();
      for (const at of row.warmup) {
        setClock(at);
        service.materializeDueOccurrences({ destinations: DESTINATIONS });
        service.completeDelivery({ ...claimAll().ntfy, outcome: 'accepted' });
      }
      setClock(row.materializeAt);
      const [{ occurrence: stale, deliveries: [staleDelivery] }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(stale).toMatchObject({ reason: row.reason, due_at: row.materializeAt.toISOString() });

      service.updateSettings(prefs({ enabledChannels: ['ntfy'], ...row.after }));
      setClock(row.staleAt);
      expect(claimAll()).toEqual({});
      expect(service.repository.findDelivery(staleDelivery.delivery_id))
        .toMatchObject({ state: 'cancelled', failure_code: 'timing_changed', attempt_count: 0 });
      expect(service.materializeDueOccurrences({ destinations: DESTINATIONS })).toEqual([]);

      setClock(row.newDueAt);
      const [current] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(current.occurrence).toMatchObject({ reason: row.reason, due_at: row.newDueAt.toISOString() });
      const { ntfy } = claimAll();
      expect(ntfy.payload).toMatchObject({ type: row.reason, dueAt: row.newDueAt.toISOString() });
      expect(service.revalidateClaim({ ...ntfy, destinations: DESTINATIONS })).toMatchObject({ valid: true });
    });

    it('never resends an accepted notice when timing changes or returns to the accepted timing', () => {
      const lead = (leadMinutes) => prefs({ enabledChannels: ['email', 'ntfy'], advance: { enabled: true, leadMinutes } });
      service.updateSettings(lead(60));
      createRelease();
      setClock(local(6, 10, 13));
      const [{ occurrence: original }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      const claims = claimAll();
      service.completeDelivery({ ...claims.email, outcome: 'accepted' });
      service.completeDelivery({ ...claims.ntfy, outcome: 'accepted' });
      const acceptedBefore = deliveries(original.event_id);

      service.updateSettings(lead(30));
      setClock(local(6, 10, 13, 30));
      const [retimed] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(retimed.deliveries).toEqual([]);
      expect(retimed.skippedChannels.map((s) => s.reason)).toEqual(['already_accepted', 'already_accepted']);
      expect(claimAll()).toEqual({});

      service.updateSettings(lead(60));
      setClock(local(6, 10, 13, 40));
      expect(service.materializeDueOccurrences({ destinations: DESTINATIONS })).toEqual([]);
      expect(claimAll()).toEqual({});
      expect(deliveries(original.event_id)).toEqual(acceptedBefore);
    });
  });

  describe('phase supersession', () => {
    it('expires a queued advance once the scheduled instant arrives, at claim and at final revalidation', () => {
      service.updateSettings(prefs({ enabledChannels: ['email', 'ntfy'], advance: { enabled: true, leadMinutes: 60 } }));
      createRelease();
      setClock(local(6, 10, 13));
      const [{ deliveries: advance }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      setClock(local(6, 10, 13, 59));
      const { email } = claimAll({ email: DESTINATIONS.email });

      // Scheduled time arrives before anything materializes the scheduled notice.
      setClock(local(6, 10, 14));
      expect(service.revalidateClaim({ ...email, destinations: DESTINATIONS }))
        .toEqual({ valid: false, code: 'superseded', cancelled: true });
      expect(claimAll()).toEqual({});
      expect(advance.map((d) => service.repository.findDelivery(d.delivery_id)))
        .toMatchObject([
          { state: 'cancelled', failure_code: 'superseded' },
          { state: 'cancelled', failure_code: 'superseded' },
        ]);

      service.materializeDueOccurrences({ destinations: DESTINATIONS });
      const claims = claimAll();
      expect(Object.values(claims).map((c) => c.payload.type)).toEqual(['release.scheduled', 'release.scheduled']);
    });

    it('supersedes a scheduled retry once the overdue phase applies', () => {
      service.updateSettings(prefs({ enabledChannels: ['ntfy'] }));
      createRelease();
      setClock(local(6, 10, 14));
      const [{ deliveries: [scheduled] }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      service.completeDelivery({ ...claimAll().ntfy, outcome: 'transient_failure', failureCode: 'http_429', retryAfterMs: HOUR });

      setClock(local(6, 10, 15));
      expect(claimAll()).toEqual({});
      expect(service.repository.findDelivery(scheduled.delivery_id))
        .toMatchObject({ state: 'cancelled', failure_code: 'superseded', attempt_count: 1 });
      service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(claimAll().ntfy.payload.type).toBe('release.overdue');
    });

    it('dispatches only the latest phase after downtime and preserves accepted history', () => {
      service.updateSettings(prefs({
        enabledChannels: ['email', 'ntfy'],
        advance: { enabled: true, leadMinutes: 60 },
        overdueRepeat: { enabled: true, intervalMinutes: 60 },
      }));
      createRelease();
      setClock(local(6, 10, 13));
      const [{ occurrence: advance }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      const claims = claimAll();
      service.completeDelivery({ ...claims.email, outcome: 'accepted' });
      service.completeDelivery({ ...claims.ntfy, outcome: 'transient_failure', failureCode: 'timeout' });
      const acceptedAdvance = service.repository.findDelivery(claims.email.deliveryId);
      setClock(local(6, 10, 14));
      const [{ occurrence: scheduled }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });

      // Down until 16:30: overdue (15:00) and repeat 16:00 are both past.
      setClock(local(6, 10, 16, 30));
      expect(claimAll()).toEqual({});
      const materialized = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(materialized.map((r) => [r.occurrence.reason, r.occurrence.due_at]))
        .toEqual([['release.overdue_repeat', local(6, 10, 16).toISOString()]]);
      expect(Object.values(claimAll()).map((c) => c.payload.type))
        .toEqual(['release.overdue_repeat', 'release.overdue_repeat']);

      expect(service.repository.findDelivery(claims.email.deliveryId)).toEqual(acceptedAdvance);
      expect(deliveries(advance.event_id).find((d) => d.channel === 'ntfy'))
        .toMatchObject({ state: 'cancelled', failure_code: 'superseded' });
      expect(deliveries(scheduled.event_id).map((d) => d.failure_code)).toEqual(['superseded', 'superseded']);
    });
  });

  describe('temporary destination unavailability', () => {
    function channelsOf(result) {
      return result.deliveries.map((d) => [d.channel, d.destination_identity]);
    }

    it('keeps a paused child for an established destination and resumes it with retry state', () => {
      service.updateSettings(prefs({ enabledChannels: ['email', 'ntfy'] }));
      createRelease();
      service.materializeDueOccurrences({ destinations: DESTINATIONS });

      setClock(local(6, 10, 14));
      const [result] = service.materializeDueOccurrences({ destinations: { email: DESTINATIONS.email } });
      expect(channelsOf(result)).toEqual([['email', DESTINATIONS.email], ['ntfy', DESTINATIONS.ntfy]]);
      const { email, ntfy } = claimAll();
      expect(service.completeDelivery({ ...email, outcome: 'accepted' }).applied).toBe(true);
      service.completeDelivery({ ...ntfy, outcome: 'transient_failure', failureCode: 'timeout' });

      // ntfy is unavailable again when its retry is due: it stays pending, not lost.
      setClock(local(6, 10, 14, 5));
      expect(claimAll({ email: DESTINATIONS.email })).toEqual({});
      expect(service.repository.findDelivery(ntfy.deliveryId)).toMatchObject({ state: 'pending', attempt_count: 1 });
      expect(service.repository.findDelivery(email.deliveryId).state).toBe('accepted');

      setClock(local(6, 10, 14, 10));
      const resumed = claimAll();
      expect(Object.keys(resumed)).toEqual(['ntfy']);
      expect(resumed.ntfy).toMatchObject({ deliveryId: ntfy.deliveryId, attempt: 2 });
      expect(resumed.ntfy.payload.eventId).toBe(result.occurrence.event_id);
    });

    it('does not backfill a channel whose destination was never established', () => {
      service.updateSettings(prefs({ enabledChannels: ['email', 'ntfy'] }));
      createRelease();
      setClock(local(6, 10, 14));
      const [scheduled] = service.materializeDueOccurrences({ destinations: { email: DESTINATIONS.email } });
      expect(channelsOf(scheduled)).toEqual([['email', DESTINATIONS.email]]);
      expect(scheduled.skippedChannels).toEqual([{ channel: 'ntfy', reason: 'destination_not_established' }]);

      setClock(local(6, 10, 14, 5));
      expect(Object.keys(claimAll())).toEqual(['email']);
      expect(deliveries(scheduled.occurrence.event_id).map((d) => d.channel)).toEqual(['email']);

      setClock(local(6, 10, 15));
      const [overdue] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(channelsOf(overdue)).toEqual([['email', DESTINATIONS.email], ['ntfy', DESTINATIONS.ntfy]]);
    });

    it('never sends old-destination work to a changed destination; later occurrences use the new one', () => {
      const moved = computeDestinationIdentity('ntfy', { server: 'https://ntfy.example.test', topic: 'moved' });
      service.updateSettings(prefs({ enabledChannels: ['email', 'ntfy'] }));
      createRelease();
      service.materializeDueOccurrences({ destinations: DESTINATIONS });

      setClock(local(6, 10, 14));
      const [scheduled] = service.materializeDueOccurrences({ destinations: { email: DESTINATIONS.email } });
      const paused = scheduled.deliveries.find((d) => d.channel === 'ntfy');
      expect(paused.destination_identity).toBe(DESTINATIONS.ntfy);

      const claims = claimAll({ ...DESTINATIONS, ntfy: moved });
      expect(Object.keys(claims)).toEqual(['email']);
      service.completeDelivery({ ...claims.email, outcome: 'accepted' });
      expect(service.repository.findDelivery(paused.delivery_id))
        .toMatchObject({ state: 'cancelled', failure_code: 'destination_changed' });

      // The moved destination is now established, so an outage keeps it.
      setClock(local(6, 10, 15));
      const [overdue] = service.materializeDueOccurrences({ destinations: { email: DESTINATIONS.email } });
      expect(channelsOf(overdue)).toEqual([['email', DESTINATIONS.email], ['ntfy', moved]]);
      expect(Object.keys(claimAll({ ...DESTINATIONS, ntfy: moved }))).toEqual(['email', 'ntfy']);
    });
  });

  describe('claim lease expiry', () => {
    function setupClaim() {
      service.updateSettings(prefs({ enabledChannels: ['email'], overdue: { enabled: false, graceMinutes: 60 } }));
      createRelease();
      setClock(local(6, 10, 14));
      service.materializeDueOccurrences({ destinations: DESTINATIONS });
      return claimAll().email;
    }

    it('refuses dispatch on an expired lease and leaves recovery to reclaim', () => {
      const first = setupClaim();
      setClock(local(6, 10, 14, 4));
      expect(service.revalidateClaim({ ...first, destinations: DESTINATIONS })).toMatchObject({ valid: true });

      setClock(local(6, 10, 14, 5));
      expect(service.revalidateClaim({ ...first, destinations: DESTINATIONS }))
        .toEqual({ valid: false, code: 'claim_expired', cancelled: false });
      expect(service.repository.findDelivery(first.deliveryId)).toMatchObject({ state: 'sending', attempt_count: 1 });

      const second = claimAll().email;
      expect(second).toMatchObject({ deliveryId: first.deliveryId, attempt: 2 });
      expect(service.revalidateClaim({ ...first, destinations: DESTINATIONS })).toMatchObject({ valid: false, code: 'stale_claim' });
      expect(service.completeDelivery({ ...first, outcome: 'accepted' })).toMatchObject({ applied: false, code: 'stale_claim' });
      expect(service.revalidateClaim({ ...second, destinations: DESTINATIONS })).toMatchObject({ valid: true });
      expect(service.completeDelivery({ ...second, outcome: 'accepted' }).delivery.state).toBe('accepted');
    });

    it('fails a fifth-attempt lease that expires without authorizing a sixth dispatch', () => {
      let claim = setupClaim();
      for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
        const { delivery } = service.completeDelivery({ ...claim, outcome: 'transient_failure', failureCode: 'timeout' });
        setClock(new Date(Date.parse(delivery.next_attempt_at)));
        claim = claimAll().email;
      }
      expect(claim.attempt).toBe(MAX_DELIVERY_ATTEMPTS);

      setClock(new Date(clock.getTime() + 5 * MINUTE));
      expect(service.revalidateClaim({ ...claim, destinations: DESTINATIONS })).toMatchObject({ valid: false, code: 'claim_expired' });
      expect(claimAll()).toEqual({});
      expect(service.repository.findDelivery(claim.deliveryId))
        .toMatchObject({ state: 'failed', failure_code: 'lease_expired', attempt_count: MAX_DELIVERY_ATTEMPTS });
      expect(service.revalidateClaim({ ...claim, destinations: DESTINATIONS })).toMatchObject({ valid: false, code: 'stale_claim' });
      setClock(new Date(clock.getTime() + 24 * HOUR));
      expect(claimAll()).toEqual({});
    });
  });

  describe('claim candidate page', () => {
    it('reports a full page that only cancelled stale rows as progress with more possibly behind it', () => {
      service.updateSettings(prefs({
        enabledChannels: ['email'],
        advance: { enabled: true, leadMinutes: 1 },
        scheduled: { enabled: false },
        overdue: { enabled: false, graceMinutes: 60 },
      }));
      const stale = [createRelease({ plannedTime: '13:59' }), createRelease({ plannedTime: '13:59' })];
      const valid = createRelease({ plannedTime: '14:00' });
      setClock(local(6, 10, 13, 58));
      service.materializeDueOccurrences({ destinations: DESTINATIONS });
      setClock(local(6, 10, 13, 59));
      service.materializeDueOccurrences({ destinations: DESTINATIONS });

      // The bounded page holds only the two expired advance rows.
      expect(service.claimDueDeliveryPage({ destinations: DESTINATIONS, limit: 2 }))
        .toEqual({ claims: [], hasMore: true, madeProgress: true, cleared: 2 });
      const cancelled = db.prepare(`
        SELECT d.state, d.failure_code FROM release_notification_deliveries d
        JOIN release_notification_occurrences o ON o.event_id = d.event_id
        WHERE o.release_id IN (?, ?)
      `).all(...stale);
      expect(cancelled).toEqual(Array(2).fill({ state: 'cancelled', failure_code: 'superseded' }));

      const next = service.claimDueDeliveryPage({ destinations: DESTINATIONS, limit: 2 });
      expect(next).toMatchObject({ hasMore: false, madeProgress: true, cleared: 0 });
      expect(next.claims).toHaveLength(1);
      expect(next.claims[0]).toMatchObject({ attempt: 1, payload: { type: 'release.advance', release: { id: valid } } });

      expect(service.claimDueDeliveryPage({ destinations: DESTINATIONS, limit: 2 }))
        .toEqual({ claims: [], hasMore: false, madeProgress: false, cleared: 0 });
    });

    it('counts a recovered final-attempt lease as cleared', () => {
      service.updateSettings(prefs({ enabledChannels: ['email'], overdue: { enabled: false, graceMinutes: 60 } }));
      createRelease();
      setClock(local(6, 10, 14));
      service.materializeDueOccurrences({ destinations: DESTINATIONS });
      let claim = claimAll().email;
      for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
        const { delivery } = service.completeDelivery({ ...claim, outcome: 'transient_failure', failureCode: 'timeout' });
        setClock(new Date(Date.parse(delivery.next_attempt_at)));
        claim = claimAll().email;
      }
      // Abandoned fifth attempt: its send may have begun, so the attempt stands.
      setClock(new Date(clock.getTime() + 6 * MINUTE));
      expect(service.claimDueDeliveryPage({ destinations: DESTINATIONS, limit: 1 }))
        .toEqual({ claims: [], hasMore: true, madeProgress: true, cleared: 1 });
      expect(service.repository.findDelivery(claim.deliveryId))
        .toMatchObject({ state: 'failed', failure_code: 'lease_expired', attempt_count: MAX_DELIVERY_ATTEMPTS });
    });
  });

  describe('claim relinquish', () => {
    function setupClaims(channels = ['email']) {
      service.updateSettings(prefs({ enabledChannels: channels, overdue: { enabled: false, graceMinutes: 60 } }));
      createRelease();
      setClock(local(6, 10, 14));
      service.materializeDueOccurrences({ destinations: DESTINATIONS });
      return claimAll();
    }

    const row = (claim) => service.repository.findDelivery(claim.deliveryId);

    it('returns a fresh unsent claim to pending with its attempt restored and no failure recorded', () => {
      const { email } = setupClaims();
      expect(row(email)).toMatchObject({ state: 'sending', attempt_count: 1, last_attempt_at: null });

      setClock(local(6, 10, 14, 1));
      expect(service.relinquishClaim(email)).toMatchObject({ applied: true, code: null });
      expect(row(email)).toMatchObject({
        state: 'pending',
        attempt_count: 0,
        claim_token: null,
        claim_expires_at: null,
        next_attempt_at: clock.toISOString(),
        last_attempt_at: null,
        failure_code: null,
        accepted_at: null,
      });

      // Immediately claimable again, well inside the old lease, as attempt 1 again.
      const again = claimAll().email;
      expect(again).toMatchObject({ deliveryId: email.deliveryId, attempt: 1 });
      expect(again.claimToken).not.toBe(email.claimToken);
    });

    it('only the current claim holder can relinquish', () => {
      const { email } = setupClaims();
      const before = row(email);
      expect(service.relinquishClaim({ ...email, claimToken: 'not-the-token' }))
        .toMatchObject({ applied: false, code: 'stale_claim' });
      expect(row(email)).toEqual(before);

      // A reclaimed expired lease supersedes the old token.
      setClock(new Date(clock.getTime() + 6 * MINUTE));
      const second = claimAll().email;
      const reclaimed = row(email);
      expect(service.relinquishClaim(email)).toMatchObject({ applied: false, code: 'stale_claim' });
      expect(row(email)).toEqual(reclaimed);
      expect(service.relinquishClaim(second)).toMatchObject({ applied: true });
      // The expired first lease keeps its attempt; only the unsent reclaim is returned.
      expect(row(email)).toMatchObject({ state: 'pending', attempt_count: 1 });
    });

    it('never resurrects accepted, failed, or cancelled deliveries', () => {
      const claims = setupClaims(['email', 'ntfy', 'gotify']);
      service.completeDelivery({ ...claims.email, outcome: 'accepted' });
      service.completeDelivery({ ...claims.ntfy, outcome: 'permanent_failure', failureCode: 'rejected' });
      db.prepare("UPDATE releases SET published_date = '2026-06-10'").run();
      expect(service.revalidateClaim({ ...claims.gotify, destinations: DESTINATIONS }))
        .toMatchObject({ valid: false, cancelled: true });

      for (const claim of Object.values(claims)) {
        const before = row(claim);
        expect(service.relinquishClaim(claim)).toMatchObject({ applied: false, code: 'stale_claim' });
        expect(row(claim)).toEqual(before);
      }
      expect(Object.values(claims).map((claim) => row(claim).state)).toEqual(['accepted', 'failed', 'cancelled']);
    });

    it('cannot exhaust the retry budget through repeated claim/relinquish cycles', () => {
      let { email } = setupClaims();
      for (let cycle = 0; cycle < MAX_DELIVERY_ATTEMPTS * 3; cycle += 1) {
        expect(email.attempt).toBe(1);
        service.relinquishClaim(email);
        setClock(new Date(clock.getTime() + MINUTE));
        email = claimAll().email;
      }
      expect(row(email)).toMatchObject({ state: 'sending', attempt_count: 1 });
      expect(service.revalidateClaim({ ...email, destinations: DESTINATIONS })).toMatchObject({ valid: true });
      expect(service.completeDelivery({ ...email, outcome: 'accepted' }).delivery)
        .toMatchObject({ state: 'accepted', attempt_count: 1 });
    });

    it('keeps the last real attempt and does not delay a due retry', () => {
      const { email } = setupClaims();
      expect(service.revalidateClaim({ ...email, destinations: DESTINATIONS })).toMatchObject({ valid: true });
      const dispatchedAt = clock.toISOString();
      const { delivery: failed } = service.completeDelivery({ ...email, outcome: 'transient_failure', failureCode: 'timeout' });
      expect(failed).toMatchObject({ state: 'pending', attempt_count: 1, last_attempt_at: dispatchedAt });

      setClock(new Date(Date.parse(failed.next_attempt_at)));
      const retry = claimAll().email;
      expect(retry.attempt).toBe(2);
      expect(row(retry).last_attempt_at).toBe(dispatchedAt);
      setClock(new Date(clock.getTime() + 30 * 1000));
      service.relinquishClaim(retry);
      expect(row(retry)).toMatchObject({
        state: 'pending',
        attempt_count: 1,
        failure_code: 'timeout',
        last_attempt_at: dispatchedAt,
        next_attempt_at: clock.toISOString(),
      });
      expect(claimAll().email).toMatchObject({ deliveryId: email.deliveryId, attempt: 2 });
    });

    it('leaves sibling channel deliveries untouched', () => {
      const claims = setupClaims(['email', 'ntfy', 'webhook']);
      service.completeDelivery({ ...claims.webhook, outcome: 'accepted' });
      const ntfyBefore = row(claims.ntfy);
      const webhookBefore = row(claims.webhook);
      service.relinquishClaim(claims.email);
      expect(row(claims.ntfy)).toEqual(ntfyBefore);
      expect(row(claims.webhook)).toEqual(webhookBefore);
      expect(row(claims.email).state).toBe('pending');
    });
  });

  describe('bounded materialization', () => {
    function enableAt(time = local(6, 10, 14)) {
      service.updateSettings(prefs({ enabledChannels: ['email'], overdue: { enabled: false, graceMinutes: 60 } }));
      setClock(time);
    }

    function trackCandidateQueries() {
      const pages = [];
      const original = service.repository.listCandidateReleases;
      service.repository.listCandidateReleases = (input) => {
        const page = original(input);
        pages.push({ ...input, ids: page.releases.map((release) => release.id), hasMore: page.hasMore });
        return page;
      };
      return pages;
    }

    const materializedReleaseIds = () => db
      .prepare('SELECT release_id FROM release_notification_occurrences ORDER BY release_id')
      .pluck()
      .all();

    it('uses a fixed release-notification candidate limit', () => {
      expect(MATERIALIZATION_CANDIDATE_LIMIT).toBe(500);
      expect(() => service.materializeDueOccurrenceBatch({ destinations: DESTINATIONS, limit: 0 })).toThrow(RangeError);
    });

    it('bounds the candidate query and advances a wrapping cursor across batches', () => {
      const ids = Array.from({ length: 5 }, () => createRelease());
      enableAt();
      const pages = trackCandidateQueries();
      const batch = (afterReleaseId) => service.materializeDueOccurrenceBatch({
        destinations: DESTINATIONS, afterReleaseId, limit: 2,
      });

      const first = batch(0);
      expect(first).toMatchObject({ scanned: 2, nextAfterReleaseId: ids[1] });
      expect(first.results.map((r) => r.occurrence.release_id)).toEqual(ids.slice(0, 2));
      expect(materializedReleaseIds()).toEqual(ids.slice(0, 2));

      const second = batch(first.nextAfterReleaseId);
      expect(second).toMatchObject({ scanned: 2, nextAfterReleaseId: ids[3] });
      const third = batch(second.nextAfterReleaseId);
      expect(third).toMatchObject({ scanned: 1, nextAfterReleaseId: 0 });
      expect(materializedReleaseIds()).toEqual(ids);

      // Wrapped: the front is already materialized and creates nothing new.
      expect(batch(third.nextAfterReleaseId)).toMatchObject({ scanned: 2, results: [], nextAfterReleaseId: ids[1] });

      // The data-access layer itself returned at most the bound on every page.
      expect(pages.map((page) => page.ids)).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4), ids.slice(0, 2)]);
      expect(pages.map((page) => page.hasMore)).toEqual([true, true, false, true]);
      expect(pages.every((page) => page.limit === 2)).toBe(true);
    });

    it('knows an exactly full final batch ends the sweep and wraps without an empty batch', () => {
      const ids = [createRelease(), createRelease()];
      enableAt();
      const pages = trackCandidateQueries();
      const first = service.materializeDueOccurrenceBatch({ destinations: DESTINATIONS, limit: 2 });
      expect(first).toMatchObject({ scanned: 2, nextAfterReleaseId: 0 });
      expect(first.results.map((r) => r.occurrence.release_id)).toEqual(ids);

      const second = service.materializeDueOccurrenceBatch({
        destinations: DESTINATIONS, afterReleaseId: first.nextAfterReleaseId, limit: 2,
      });
      expect(second).toMatchObject({ scanned: 2, nextAfterReleaseId: 0 });
      expect(pages.map((page) => [page.afterReleaseId, page.ids, page.hasMore])).toEqual([
        [0, ids, false],
        [0, ids, false],
      ]);
    });

    it('returns at most the limit from a bounded look-ahead page', () => {
      const ids = Array.from({ length: 3 }, () => createRelease());
      const first = service.repository.listCandidateReleases({ limit: 2 });
      expect(first.releases.map((r) => r.id)).toEqual(ids.slice(0, 2));
      expect(first.hasMore).toBe(true);
      const last = service.repository.listCandidateReleases({ afterReleaseId: ids[1], limit: 2 });
      expect(last.releases.map((r) => r.id)).toEqual([ids[2]]);
      expect(last.hasMore).toBe(false);
    });

    it('does not let not-yet-due front releases starve later ones', () => {
      createRelease({ plannedDate: '2026-07-01' });
      createRelease({ plannedDate: '2026-07-02' });
      const due = createRelease();
      enableAt();
      let cursor = 0;
      const created = [];
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const result = service.materializeDueOccurrenceBatch({ destinations: DESTINATIONS, afterReleaseId: cursor, limit: 2 });
        cursor = result.nextAfterReleaseId;
        created.push(...result.results.map((r) => r.occurrence.release_id));
      }
      expect(created).toEqual([due]);
      expect(materializedReleaseIds()).toEqual([due]);
    });

    it('stays correct when releases leave or join the candidate set between batches', () => {
      const ids = Array.from({ length: 4 }, () => createRelease());
      enableAt();
      const first = service.materializeDueOccurrenceBatch({ destinations: DESTINATIONS, limit: 2 });
      expect(first.nextAfterReleaseId).toBe(ids[1]);

      // The cursor's own release and one later release leave the candidate set.
      db.prepare("UPDATE releases SET archived_at = '2026-06-10T00:00:00.000Z' WHERE id = ?").run(ids[1]);
      db.prepare("UPDATE releases SET published_date = '2026-06-10' WHERE id = ?").run(ids[2]);
      const added = createRelease();
      const second = service.materializeDueOccurrenceBatch({
        destinations: DESTINATIONS, afterReleaseId: first.nextAfterReleaseId, limit: 2,
      });
      expect(second.results.map((r) => r.occurrence.release_id)).toEqual([ids[3], added]);

      // A cursor past every remaining release yields an empty batch and wraps.
      expect(service.materializeDueOccurrenceBatch({ destinations: DESTINATIONS, afterReleaseId: added + 100, limit: 2 }))
        .toEqual({ results: [], scanned: 0, nextAfterReleaseId: 0 });
    });
  });

  describe('time-critical materialization', () => {
    // A one-minute advance notice with no later phase, as in the reviewer's reproduction.
    const ADVANCE_ONLY = {
      advance: { enabled: true, leadMinutes: 1 },
      scheduled: { enabled: false },
      overdue: { enabled: false, graceMinutes: 60 },
      overdueRepeat: { enabled: false, intervalMinutes: 60 },
    };

    function trackTimeCriticalQueries() {
      const queries = [];
      const original = service.repository.listTimeCriticalReleases;
      service.repository.listTimeCriticalReleases = (input) => {
        const rows = original(input);
        queries.push({
          ...input, ids: rows.map((release) => release.id), handled: rows.map((release) => release.handled),
        });
        return rows;
      };
      return queries;
    }

    const timeCritical = (limit = 2) => service.materializeTimeCriticalOccurrences({ destinations: DESTINATIONS, limit });
    const created = (result) => result.results.map((r) => [r.occurrence.release_id, r.occurrence.reason]);

    it('uses a fixed, positive time-critical limit', () => {
      expect(TIME_CRITICAL_CANDIDATE_LIMIT).toBe(100);
      expect(() => timeCritical(0)).toThrow(RangeError);
    });

    it('catches a one-minute advance window on a page the background sweep is not visiting', () => {
      service.updateSettings(prefs({ enabledChannels: ['email'], ...ADVANCE_ONLY }));
      const target = createRelease();
      const others = Array.from({ length: 5 }, () => createRelease({ plannedDate: '2026-07-01' }));
      let cursor = 0;
      const sweep = () => {
        const batch = service.materializeDueOccurrenceBatch({ destinations: DESTINATIONS, afterReleaseId: cursor, limit: 2 });
        cursor = batch.nextAfterReleaseId;
        return batch;
      };

      // 13:58: the sweep inspects the target's page before its advance window opens.
      setClock(local(6, 10, 13, 58));
      expect(timeCritical()).toEqual({ results: [], scanned: 0, hasMore: false });
      expect(sweep().results).toEqual([]);
      expect(cursor).toBe(others[0]);

      // 13:59: the sweep is on another page; the time-critical pass still
      // materializes the advance notice inside its only minute.
      setClock(local(6, 10, 13, 59));
      expect(created(timeCritical())).toEqual([[target, 'release.advance']]);
      expect(sweep().results).toEqual([]);
      expect(cursor).toBe(others[2]);

      // 14:00: the advance phase has expired and nothing further appears.
      setClock(local(6, 10, 14));
      expect(timeCritical()).toEqual({ results: [], scanned: 0, hasMore: false });
      expect(occurrences().map((row) => [row.release_id, row.reason, row.due_at]))
        .toEqual([[target, 'release.advance', local(6, 10, 13, 59).toISOString()]]);
    });

    it('catches a date-only release using the configured fallback time', () => {
      service.updateSettings(prefs({ enabledChannels: ['email'], dateOnlyTime: '09:30', ...ADVANCE_ONLY }));
      const dateOnly = createRelease({ plannedTime: null });
      createRelease({ plannedTime: '09:31' });
      setClock(local(6, 10, 9, 29));
      expect(created(timeCritical())).toEqual([[dateOnly, 'release.advance']]);
    });

    it('considers a scheduled notice during its window before overdue supersedes it', () => {
      service.updateSettings(prefs({ enabledChannels: ['email'] }));
      const target = createRelease();
      setClock(local(6, 10, 14, 59));
      expect(created(timeCritical())).toEqual([[target, 'release.scheduled']]);
      // Once overdue applies with no repeats it stays current: background work.
      setClock(local(6, 10, 15));
      expect(timeCritical()).toEqual({ results: [], scanned: 0, hasMore: false });
    });

    it('orders expiring phases by expiry and leaves persistent repeats to the sweep', () => {
      service.updateSettings(prefs({
        enabledChannels: ['email'],
        overdue: { enabled: true, graceMinutes: 60 },
        overdueRepeat: { enabled: true, intervalMinutes: 60 },
      }));
      const oldRepeats = Array.from({ length: 3 }, () => createRelease({ plannedDate: '2026-06-02' }));
      const scheduledPhase = createRelease({ plannedTime: '15:10' });
      const initialOverdue = createRelease({ plannedTime: '14:00' });
      setClock(local(6, 10, 15, 30));
      const queries = trackTimeCriticalQueries();

      // The initial overdue is superseded by the first repeat at 16:00; the
      // scheduled notice by overdue at 16:10.
      expect(created(timeCritical(1))).toEqual([[initialOverdue, 'release.overdue']]);
      expect(created(timeCritical(1))).toEqual([[scheduledPhase, 'release.scheduled']]);
      expect(timeCritical(1)).toMatchObject({ results: [], scanned: 1 });
      const queried = new Set(queries.flatMap((query) => query.ids));
      expect(oldRepeats.some((id) => queried.has(id))).toBe(false);
      expect(queries.every((query) => query.limit === 1 && query.ids.length <= 1)).toBe(true);

      // The background sweep still materializes the latest repeat of the old releases.
      const batch = service.materializeDueOccurrenceBatch({ destinations: DESTINATIONS, limit: 10 });
      expect(created(batch)).toEqual(oldRepeats.map((id) => [id, 'release.overdue_repeat']));
    });

    it('makes progress across cycles when more releases share a window than the limit', () => {
      service.updateSettings(prefs({
        enabledChannels: ['email'], ...ADVANCE_ONLY, advance: { enabled: true, leadMinutes: 60 },
      }));
      const late = createRelease({ plannedTime: '14:40' });
      const tied = [createRelease({ plannedTime: '14:20' }), createRelease({ plannedTime: '14:20' })];
      const soonest = createRelease({ plannedTime: '14:10' });
      setClock(local(6, 10, 13, 45));
      const queries = trackTimeCriticalQueries();

      expect(created(timeCritical(2)).map(([id]) => id)).toEqual([soonest, tied[0]]);
      expect(created(timeCritical(2)).map(([id]) => id)).toEqual([tied[1], late]);
      expect(timeCritical(2)).toMatchObject({ results: [], scanned: 2 });
      expect(queries.every((query) => query.limit === 2 && query.ids.length <= 2)).toBe(true);
      expect(occurrences()).toHaveLength(4);
    });

    it('still reconsiders a release whose notice in the same window belongs to an old schedule', () => {
      service.updateSettings(prefs({
        enabledChannels: ['email'], ...ADVANCE_ONLY, advance: { enabled: true, leadMinutes: 60 },
      }));
      const id = createRelease({ plannedTime: '14:30' });
      setClock(local(6, 10, 13, 40));
      expect(created(timeCritical())).toEqual([[id, 'release.advance']]);
      db.prepare("UPDATE releases SET planned_time = '14:20' WHERE id = ?").run(id);
      setClock(local(6, 10, 13, 45));
      expect(created(timeCritical())).toEqual([[id, 'release.advance']]);
      expect(occurrences().map((row) => row.due_at))
        .toEqual([local(6, 10, 13, 30).toISOString(), local(6, 10, 13, 20).toISOString()]);
    });

    it('produces one occurrence when a release is in both the time-critical and background passes', () => {
      service.updateSettings(prefs({ enabledChannels: ['email'] }));
      createRelease();
      setClock(local(6, 10, 14, 5));
      expect(timeCritical().results).toHaveLength(1);
      expect(service.materializeDueOccurrenceBatch({ destinations: DESTINATIONS, limit: 2 }))
        .toMatchObject({ results: [], scanned: 1 });
      expect(occurrences()).toHaveLength(1);
      expect(deliveries(occurrences()[0].event_id)).toHaveLength(1);
    });

    it('does not query at all when no enabled phase can be superseded', () => {
      service.updateSettings(prefs({ enabledChannels: ['email'], overdue: { enabled: false, graceMinutes: 60 } }));
      createRelease();
      setClock(local(6, 10, 14, 5));
      const queries = trackTimeCriticalQueries();
      expect(timeCritical()).toEqual({ results: [], scanned: 0, hasMore: false });
      expect(queries).toEqual([]);
    });

    it('never lets expired scheduled rows fill the page and hide a due scheduled notice', () => {
      // Reviewer reproduction: one-minute grace, and more releases whose
      // scheduled notice already expired into overdue than the page holds.
      service.updateSettings(prefs({ enabledChannels: ['email'], overdue: { enabled: true, graceMinutes: 1 } }));
      const expired = Array.from({ length: 3 }, () => createRelease({ plannedTime: '14:19' }));
      const target = createRelease({ plannedTime: '14:20' });
      const elsewhere = Array.from({ length: 2 }, () => createRelease({ plannedDate: '2026-07-01' }));
      setClock(local(6, 10, 14, 20));
      // The background sweep is on a page that does not contain the target.
      expect(service.materializeDueOccurrenceBatch({ destinations: DESTINATIONS, afterReleaseId: target, limit: 2 }))
        .toMatchObject({ results: [], scanned: elsewhere.length });
      const queries = trackTimeCriticalQueries();

      expect(created(timeCritical(2))).toEqual([[target, 'release.scheduled']]);
      expect(queries.flatMap((query) => query.ids)).toEqual([target]);
      expect(queries.flatMap((query) => query.ids).some((id) => expired.includes(id))).toBe(false);

      // Overdue supersedes it a minute later; the scheduled notice was not lost.
      setClock(local(6, 10, 14, 21));
      expect(timeCritical(2)).toEqual({ results: [], scanned: 0, hasMore: false });
      expect(occurrences().filter((row) => row.release_id === target).map((row) => row.reason))
        .toEqual(['release.scheduled']);
    });

    it('selects exactly the releases resolveLatestPhase puts in each expiring phase', () => {
      service.updateSettings(prefs({
        enabledChannels: ['email'],
        advance: { enabled: true, leadMinutes: 60 },
        overdue: { enabled: true, graceMinutes: 60 },
        overdueRepeat: { enabled: true, intervalMinutes: 60 },
      }));
      const firstRepeat = createRelease({ plannedTime: '12:00' });
      const initialOverdue = createRelease({ plannedTime: '13:00' });
      const scheduledNow = createRelease({ plannedTime: '14:00' });
      const advanceStart = createRelease({ plannedTime: '15:00' });
      const notYetDue = createRelease({ plannedTime: '15:01' });
      setClock(local(6, 10, 14));
      const queries = trackTimeCriticalQueries();

      expect(timeCritical(10)).toMatchObject({ scanned: 3 });
      expect(queries.map((query) => [query.reason, query.ids])).toEqual([
        ['release.advance', [advanceStart]],
        ['release.scheduled', [scheduledNow]],
        ['release.overdue', [initialOverdue]],
      ]);
      const queried = queries.flatMap((query) => query.ids);
      expect(queried).not.toContain(firstRepeat);
      expect(queried).not.toContain(notYetDue);
    });

    it('does not treat an old schedule\'s occurrence as handling the current schedule', () => {
      service.updateSettings(prefs({
        enabledChannels: ['email'], dateOnlyTime: '14:30', ...ADVANCE_ONLY, advance: { enabled: true, leadMinutes: 60 },
      }));
      const settled = [createRelease({ plannedTime: '14:30' }), createRelease({ plannedTime: '14:30' })];
      // Schedule A: date-only, resolved through the 14:30 fallback.
      const rescheduled = createRelease({ plannedTime: null });
      setClock(local(6, 10, 13, 40));
      expect(created(timeCritical(3)).map(([id]) => id)).toEqual([...settled, rescheduled]);

      // Schedule B: an explicit 14:30. Its advance notice has the same
      // release, reason, and even due_at as A's, but a different identity.
      db.prepare("UPDATE releases SET planned_time = '14:30' WHERE id = ?").run(rescheduled);
      setClock(local(6, 10, 13, 45));
      const queries = trackTimeCriticalQueries();
      expect(created(timeCritical(2))).toEqual([[rescheduled, 'release.advance']]);
      expect(queries[0]).toMatchObject({ ids: [rescheduled, settled[0]], handled: [false, true] });

      const rows = occurrences().filter((row) => row.release_id === rescheduled);
      expect(rows.map((row) => [row.reason, row.due_at])).toEqual([
        ['release.advance', local(6, 10, 13, 30).toISOString()],
        ['release.advance', local(6, 10, 13, 30).toISOString()],
      ]);
      expect(new Set(rows.map((row) => row.schedule_fingerprint)).size).toBe(2);

      // B is now genuinely handled.
      expect(timeCritical(3)).toMatchObject({ results: [], scanned: 3 });
      expect(queries[1].handled).toEqual([true, true, true]);
    });

    it('does not treat an occurrence due under earlier timing settings as handled', () => {
      service.updateSettings(prefs({
        enabledChannels: ['email'], ...ADVANCE_ONLY, advance: { enabled: true, leadMinutes: 60 },
      }));
      const retimed = createRelease({ plannedTime: '14:30' });
      setClock(local(6, 10, 13, 40));
      expect(created(timeCritical(1))).toEqual([[retimed, 'release.advance']]);
      // Same schedule, shorter lead: the current notice is now due at 13:40.
      service.updateSettings(prefs({
        enabledChannels: ['email'], ...ADVANCE_ONLY, advance: { enabled: true, leadMinutes: 50 },
      }));
      const others = [createRelease({ plannedTime: '14:25' }), createRelease({ plannedTime: '14:25' })];
      setClock(local(6, 10, 13, 41));
      expect(created(timeCritical(2)).map(([id]) => id)).toEqual(others);
      const queries = trackTimeCriticalQueries();

      setClock(local(6, 10, 13, 42));
      expect(created(timeCritical(2))).toEqual([[retimed, 'release.advance']]);
      expect(queries[0]).toMatchObject({ ids: [retimed, others[0]], handled: [false, true] });
      expect(occurrences().filter((row) => row.release_id === retimed).map((row) => row.due_at))
        .toEqual([local(6, 10, 13, 30).toISOString(), local(6, 10, 13, 40).toISOString()]);
    });

    it('ranks a release whose current occurrence exists behind unhandled ones', () => {
      service.updateSettings(prefs({
        enabledChannels: ['email'], ...ADVANCE_ONLY, advance: { enabled: true, leadMinutes: 60 },
      }));
      const handledFirst = createRelease({ plannedTime: '14:10' });
      setClock(local(6, 10, 13, 15));
      expect(created(timeCritical(1))).toEqual([[handledFirst, 'release.advance']]);
      const later = [createRelease({ plannedTime: '14:15' }), createRelease({ plannedTime: '14:15' })];
      setClock(local(6, 10, 13, 16));
      const queries = trackTimeCriticalQueries();

      // It expires soonest, but its exact current occurrence already exists.
      expect(created(timeCritical(2)).map(([id]) => id)).toEqual(later);
      expect(queries[0]).toMatchObject({ ids: later, handled: [false, false] });
      expect(timeCritical(3)).toMatchObject({ results: [], scanned: 3 });
      expect(queries[1]).toMatchObject({ ids: [handledFirst, ...later], handled: [true, true, true] });
      expect(occurrences()).toHaveLength(3);
    });

    it('reports more priority work after a full unhandled page and none once it is drained', () => {
      // Reviewer reproduction, scaled down: a one-minute advance window
      // holding more releases than one page.
      service.updateSettings(prefs({ enabledChannels: ['email'], ...ADVANCE_ONLY }));
      const due = Array.from({ length: 3 }, () => createRelease());
      setClock(local(6, 10, 13, 59));
      const queries = trackTimeCriticalQueries();

      const first = timeCritical(2);
      expect(created(first).map(([id]) => id)).toEqual(due.slice(0, 2));
      expect(first.hasMore).toBe(true);
      // Materialized rows now rank as handled, so the next page selects the rest.
      const second = timeCritical(2);
      expect(created(second)).toEqual([[due[2], 'release.advance']]);
      expect(second.hasMore).toBe(false);
      expect(queries[1]).toMatchObject({ ids: [due[2], due[0]], handled: [false, true] });
      expect(timeCritical(2)).toMatchObject({ results: [], hasMore: false });
      expect(queries.every((query) => query.limit === 2 && query.ids.length <= 2)).toBe(true);
      expect(occurrences().map((row) => [row.release_id, row.reason]).sort((a, b) => a[0] - b[0]))
        .toEqual(due.map((id) => [id, 'release.advance']));
    });

    it('reports more priority work when unhandled candidates are cut across phases', () => {
      service.updateSettings(prefs({
        enabledChannels: ['email'], advance: { enabled: true, leadMinutes: 60 }, overdue: { enabled: true, graceMinutes: 60 },
      }));
      const scheduledNow = createRelease({ plannedTime: '14:00' });
      const advancing = createRelease({ plannedTime: '14:30' });
      setClock(local(6, 10, 14));
      const first = timeCritical(1);
      expect(created(first)).toEqual([[advancing, 'release.advance']]);
      expect(first.hasMore).toBe(true);
      // A full page is a conservative "may remain"; one more pass settles it.
      expect(created(timeCritical(1))).toEqual([[scheduledNow, 'release.scheduled']]);
      expect(timeCritical(1)).toMatchObject({ results: [], hasMore: false });
    });

    it('does not report backlog for a full page it cannot make progress on', () => {
      service.updateSettings(prefs({ enabledChannels: ['email'], ...ADVANCE_ONLY }));
      createRelease();
      createRelease();
      setClock(local(6, 10, 13, 59));
      // Every row on the page is refused by the final phase decision.
      const original = service.repository.listTimeCriticalReleases;
      service.repository.listTimeCriticalReleases = (input) => original(input)
        .map((row) => ({ ...row, planned_date: '2026-07-01' }));
      expect(timeCritical(2)).toEqual({ results: [], scanned: 0, hasMore: false });
    });

    describe('around DST transitions', () => {
      let savedTimeZone;

      beforeEach(() => {
        savedTimeZone = process.env.TZ;
        process.env.TZ = 'America/New_York';
        setClock(local(2, 1, 8));
        service.updateSettings(prefs({
          enabledChannels: ['email'], ...ADVANCE_ONLY, advance: { enabled: true, leadMinutes: 60 },
        }));
      });

      afterEach(() => {
        if (savedTimeZone === undefined) delete process.env.TZ;
        else process.env.TZ = savedTimeZone;
      });

      it('selects advance candidates by resolved instant across a DST gap', () => {
        // 2026-03-08: 02:00 EST jumps to 03:00 EDT; a 02:xx wall-clock time
        // resolves an hour later (02:30 -> 03:30 EDT).
        const stale = [
          ...Array.from({ length: 3 }, () => createRelease({ plannedDate: '2026-03-08', plannedTime: '01:30' })),
          createRelease({ plannedDate: '2026-03-08', plannedTime: '02:05' }),
          createRelease({ plannedDate: '2026-03-08', plannedTime: '03:05' }),
          createRelease({ plannedDate: '2026-03-08', plannedTime: '04:30' }),
        ];
        const inGap = createRelease({ plannedDate: '2026-03-08', plannedTime: '02:30' });
        const afterGap = createRelease({ plannedDate: '2026-03-08', plannedTime: '03:20' });
        setClock(new Date('2026-03-08T07:10:00.000Z')); // 03:10 EDT
        const queries = trackTimeCriticalQueries();

        // 03:20 EDT expires before the gap's 02:30 (03:30 EDT) despite its later wall-clock text.
        expect(created(timeCritical(2))).toEqual([[afterGap, 'release.advance'], [inGap, 'release.advance']]);
        expect(queries.flatMap((query) => query.ids)).toEqual([afterGap, inGap]);
        expect(queries.flatMap((query) => query.ids).some((id) => stale.includes(id))).toBe(false);
        expect(occurrences().map((row) => row.due_at).sort())
          .toEqual(['2026-03-08T06:20:00.000Z', '2026-03-08T06:30:00.000Z']);
      });

      it('excludes a repeated wall-clock time that already resolved to its earlier instant', () => {
        // 2026-11-01: 02:00 EDT falls back to 01:00 EST; a repeated 01:xx
        // wall-clock time resolves to its first (EDT) instant.
        const stale = Array.from({ length: 3 }, () => createRelease({ plannedDate: '2026-11-01', plannedTime: '01:50' }));
        const target = createRelease({ plannedDate: '2026-11-01', plannedTime: '02:30' });
        setClock(new Date('2026-11-01T06:40:00.000Z')); // 01:40 EST, the second 01:40
        const queries = trackTimeCriticalQueries();

        expect(created(timeCritical(2))).toEqual([[target, 'release.advance']]);
        expect(queries.flatMap((query) => query.ids)).toEqual([target]);
        expect(queries.flatMap((query) => query.ids).some((id) => stale.includes(id))).toBe(false);
      });
    });

    describe('in a zone that changes offset on its own schedule', () => {
      let savedTimeZone;

      beforeEach(() => {
        savedTimeZone = process.env.TZ;
      });

      afterEach(() => {
        if (savedTimeZone === undefined) delete process.env.TZ;
        else process.env.TZ = savedTimeZone;
      });

      function useZone(timeZone, activationClock) {
        process.env.TZ = timeZone;
        setClock(activationClock);
        service.updateSettings(prefs({ enabledChannels: ['email'], ...ADVANCE_ONLY }));
      }

      it('never lets releases on a skipped local date fill the page and hide a due release', () => {
        // Pacific/Apia skipped 2011-12-30 entirely (-10:00 -> +14:00). The
        // resolver pushes a 2011-12-30 14:00 wall-clock time onto 2011-12-31,
        // the same instant as the genuine 2011-12-31 14:00, and rejects it.
        useZone('Pacific/Apia', new Date('2011-12-20T00:00:00.000Z'));
        const skipped = Array.from({ length: 3 }, () => createRelease({ plannedDate: '2011-12-30', plannedTime: '14:00' }));
        const target = createRelease({ plannedDate: '2011-12-31', plannedTime: '14:00' });
        expect(resolveReleaseSchedule({ planned_date: '2011-12-30', planned_time: '14:00' }, service.getSettings()))
          .toBeNull();
        setClock(new Date('2011-12-30T23:59:00.000Z')); // 2011-12-31 13:59 +14:00
        const queries = trackTimeCriticalQueries();

        expect(created(timeCritical(2))).toEqual([[target, 'release.advance']]);
        expect(queries.flatMap((query) => query.ids)).toEqual([target]);
        expect(queries.flatMap((query) => query.ids).some((id) => skipped.includes(id))).toBe(false);
        expect(queries.flatMap((query) => query.wallClockRanges).some(([from, through]) => (
          from.startsWith('2011-12-30') || through.startsWith('2011-12-30')
        ))).toBe(false);
        expect(occurrences().map((row) => [row.release_id, row.due_at]))
          .toEqual([[target, '2011-12-30T23:59:00.000Z']]);
      });

      it('keeps a same-date 30-minute DST gap time eligible at its resolved instant', () => {
        // Australia/Lord_Howe 2026-10-04: 02:00 +10:30 jumps to 02:30 +11:00;
        // a 02:15 wall-clock time resolves to 02:45 +11:00 on the same date.
        useZone('Australia/Lord_Howe', new Date('2026-09-20T00:00:00.000Z'));
        const inGap = createRelease({ plannedDate: '2026-10-04', plannedTime: '02:15' });
        createRelease({ plannedDate: '2026-10-04', plannedTime: '02:46' }); // due a minute later
        setClock(new Date('2026-10-03T15:44:00.000Z')); // 02:44 +11:00
        const queries = trackTimeCriticalQueries();

        expect(created(timeCritical(2))).toEqual([[inGap, 'release.advance']]);
        expect(queries.flatMap((query) => query.ids)).toEqual([inGap]);
        expect(occurrences().map((row) => [row.release_id, row.due_at]))
          .toEqual([[inGap, '2026-10-03T15:44:00.000Z']]);
      });
    });
  });

  describe('timing', () => {
    const baseSettings = (overrides = {}) => ({
      ...prefs(overrides),
      activation: { activatedAt: local(1, 1).toISOString(), channels: {} },
    });
    const release = { planned_date: '2026-06-10', planned_time: '14:00' };

    function due(settings, now, input = release) {
      return resolveDueOccurrence(resolveReleaseSchedule(input, settings), settings, now);
    }

    it('resolves advance, scheduled, and overdue boundaries', () => {
      const settings = baseSettings({ advance: { enabled: true, leadMinutes: 60 } });
      expect(due(settings, local(6, 10, 12, 59))).toBeNull();
      expect(due(settings, local(6, 10, 13))).toMatchObject({ reason: 'release.advance', dueAt: local(6, 10, 13).toISOString() });
      expect(due(settings, local(6, 10, 14))).toMatchObject({ reason: 'release.scheduled' });
      expect(due(settings, local(6, 10, 14, 59))).toMatchObject({ reason: 'release.scheduled' });
      expect(due(settings, local(6, 10, 15))).toMatchObject({ reason: 'release.overdue', dueAt: local(6, 10, 15).toISOString() });
    });

    it('returns only the latest overdue repeat after downtime', () => {
      const settings = baseSettings({ overdueRepeat: { enabled: true, intervalMinutes: 60 } });
      expect(due(settings, local(6, 10, 15, 59))).toMatchObject({ reason: 'release.overdue' });
      expect(due(settings, local(6, 10, 19, 30))).toEqual({
        reason: 'release.overdue_repeat',
        dueAt: local(6, 10, 19).toISOString(),
        repeatDueAt: local(6, 10, 19).toISOString(),
      });
    });

    it('uses the configured date-only time and records the fallback', () => {
      const settings = baseSettings({ dateOnlyTime: '10:30' });
      const schedule = resolveReleaseSchedule({ planned_date: '2026-06-10', planned_time: null }, settings);
      expect(schedule).toMatchObject({ effectiveTime: '10:30', usedDefaultTime: true, plannedTime: null });
      expect(schedule.scheduledAt).toEqual(local(6, 10, 10, 30));
      expect(resolveReleaseSchedule({ planned_date: null, planned_time: null }, settings)).toBeNull();
    });

    it('freezes the date-only fallback into the occurrence payload', () => {
      service.updateSettings(prefs({ enabledChannels: ['email'] }));
      createRelease({ plannedTime: null });
      setClock(local(6, 10, 9));
      const [{ occurrence }] = service.materializeDueOccurrences({ destinations: DESTINATIONS });
      expect(JSON.parse(occurrence.payload_json).schedule)
        .toMatchObject({ plannedTime: null, effectiveTime: '09:00', usedDefaultTime: true });
    });
  });
});
