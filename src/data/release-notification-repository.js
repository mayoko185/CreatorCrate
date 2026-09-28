import { ACTIVE_PARENT_PROJECT, ACTIVE_UNPUBLISHED } from './release-repository.js';

const OCCURRENCE_COLUMNS = [
  'event_id', 'release_id', 'occurrence_key', 'reason', 'schedule_fingerprint',
  'repeat_due_at', 'due_at', 'payload_json', 'created_at',
];

const DELIVERY_COLUMNS = [
  'delivery_id', 'event_id', 'channel', 'destination_identity', 'activation_generation', 'state',
  'attempt_count', 'next_attempt_at', 'claim_token', 'claim_expires_at', 'last_attempt_at',
  'accepted_at', 'failure_code', 'created_at', 'updated_at',
];

const OCCURRENCE_SELECT = OCCURRENCE_COLUMNS.join(', ');
const DELIVERY_SELECT = DELIVERY_COLUMNS.join(', ');
const QUALIFIED_DELIVERY_SELECT = DELIVERY_COLUMNS.map((column) => `d.${column}`).join(', ');
const UNSENT = "state IN ('pending', 'sending')";

/**
 * Persistence for release-notification occurrences and their per-channel
 * deliveries. Every write that changes a delivery's state is guarded by the
 * state (and, for claimed rows, the claim token) it expects, so a stale
 * worker can never overwrite a newer transition.
 */
export function createReleaseNotificationRepository(db) {
  const listCandidateReleasesStmt = db.prepare(`
    SELECT releases.id, releases.title, releases.planned_date, releases.planned_time,
           releases.project_id, projects.title AS project_title
    FROM releases
    JOIN projects ON projects.id = releases.project_id
    WHERE ${ACTIVE_UNPUBLISHED}
      AND ${ACTIVE_PARENT_PROJECT}
      AND releases.planned_date IS NOT NULL
      AND releases.id > @afterReleaseId
    ORDER BY releases.id ASC
    LIMIT @limit
  `);
  // Local wall-clock 'YYYY-MM-DD HH:MM' of the release's effective schedule.
  const EFFECTIVE_TIME = `COALESCE(NULLIF(releases.planned_time, ''), @dateOnlyTime)`;
  const EFFECTIVE_WALL_CLOCK = `releases.planned_date || ' ' || ${EFFECTIVE_TIME}`;
  // Each range maps its wall-clock minutes to instants by one fixed offset,
  // so the resolved schedule instant is plain arithmetic here. Ranges are
  // disjoint, so a release joins at most one. Rows resolveReleaseSchedule
  // would reject (malformed date or time) are excluded so they cannot take a
  // place on the page.
  //
  // `handled` means the release's exact current occurrence exists: same
  // reason, due instant, and schedule identity. The schedule fingerprint is a
  // digest of the plannedDate, plannedTime, effectiveTime, and timeZone that
  // every occurrence also freezes into its payload, so comparing those fields
  // compares the fingerprint without recomputing the digest in SQL.
  const listTimeCriticalReleasesStmt = db.prepare(`
    WITH ranges AS (
      SELECT json_extract(value, '$[0]') AS from_wall, json_extract(value, '$[1]') AS through_wall,
             json_extract(value, '$[2]') AS offset_seconds
      FROM json_each(@wallClockRanges)
    ),
    candidates AS (
      SELECT releases.id, releases.title, releases.planned_date, releases.planned_time,
             releases.project_id, projects.title AS project_title,
             NULLIF(releases.planned_time, '') AS schedule_planned_time,
             ${EFFECTIVE_TIME} AS schedule_effective_time,
             CAST(strftime('%s', ${EFFECTIVE_WALL_CLOCK}) AS INTEGER) - ranges.offset_seconds AS scheduled_epoch
      FROM releases
      JOIN projects ON projects.id = releases.project_id
      JOIN ranges ON ${EFFECTIVE_WALL_CLOCK} BETWEEN ranges.from_wall AND ranges.through_wall
      WHERE ${ACTIVE_UNPUBLISHED}
        AND ${ACTIVE_PARENT_PROJECT}
        AND releases.planned_date IS NOT NULL
        AND releases.planned_date BETWEEN @fromDate AND @toDate
        AND releases.planned_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(releases.planned_date) = releases.planned_date
        AND (NULLIF(releases.planned_time, '') IS NULL
          OR releases.planned_time GLOB '[01][0-9]:[0-5][0-9]'
          OR releases.planned_time GLOB '2[0-3]:[0-5][0-9]')
    )
    SELECT c.id, c.title, c.planned_date, c.planned_time, c.project_id, c.project_title,
           EXISTS (
             SELECT 1 FROM release_notification_occurrences o
             WHERE o.release_id = c.id AND o.reason = @reason
               AND o.due_at = strftime('%Y-%m-%dT%H:%M:%fZ', c.scheduled_epoch + @dueOffsetSeconds, 'unixepoch')
               AND json_extract(o.payload_json, '$.schedule.plannedDate') = c.planned_date
               AND json_extract(o.payload_json, '$.schedule.plannedTime') IS c.schedule_planned_time
               AND json_extract(o.payload_json, '$.schedule.effectiveTime') = c.schedule_effective_time
               AND json_extract(o.payload_json, '$.schedule.timeZone') = @timeZone
           ) AS handled
    FROM candidates c
    ORDER BY handled ASC, c.scheduled_epoch ASC, c.id ASC
    LIMIT @limit
  `);
  const findReleaseStateStmt = db.prepare(`
    SELECT r.id, r.title, r.planned_date, r.planned_time, r.published_date, r.archived_at,
           r.project_id, p.title AS project_title, p.status AS project_status,
           p.archived_at AS project_archived_at
    FROM releases r
    JOIN projects p ON p.id = r.project_id
    WHERE r.id = ?
  `);
  const findOccurrenceByKeyStmt = db.prepare(
    `SELECT ${OCCURRENCE_SELECT} FROM release_notification_occurrences WHERE occurrence_key = ?`,
  );
  const findOccurrenceStmt = db.prepare(
    `SELECT ${OCCURRENCE_SELECT} FROM release_notification_occurrences WHERE event_id = ?`,
  );
  const insertOccurrenceStmt = db.prepare(`
    INSERT INTO release_notification_occurrences (${OCCURRENCE_SELECT})
    VALUES (@eventId, @releaseId, @occurrenceKey, @reason, @scheduleFingerprint,
            @repeatDueAt, @dueAt, @payloadJson, @createdAt)
    ON CONFLICT(occurrence_key) DO NOTHING
    RETURNING ${OCCURRENCE_SELECT}
  `);
  const insertDeliveryStmt = db.prepare(`
    INSERT INTO release_notification_deliveries (
      delivery_id, event_id, channel, destination_identity, activation_generation,
      state, attempt_count, next_attempt_at, created_at, updated_at
    )
    VALUES (@deliveryId, @eventId, @channel, @destinationIdentity, @activationGeneration,
            'pending', 0, @nextAttemptAt, @now, @now)
    RETURNING ${DELIVERY_SELECT}
  `);
  const findDeliveryStmt = db.prepare(
    `SELECT ${DELIVERY_SELECT} FROM release_notification_deliveries WHERE delivery_id = ?`,
  );
  const listDeliveriesForEventStmt = db.prepare(`
    SELECT ${DELIVERY_SELECT} FROM release_notification_deliveries
    WHERE event_id = ?
    ORDER BY channel ASC
  `);
  const listClaimCandidatesStmt = db.prepare(`
    SELECT ${QUALIFIED_DELIVERY_SELECT},
           o.release_id, o.reason, o.schedule_fingerprint, o.due_at, o.repeat_due_at, o.payload_json
    FROM release_notification_deliveries d
    JOIN release_notification_occurrences o ON o.event_id = d.event_id
    WHERE d.channel IN (SELECT value FROM json_each(@channels))
      AND ((d.state = 'pending' AND d.next_attempt_at <= @now)
        OR (d.state = 'sending' AND d.claim_expires_at <= @now))
    ORDER BY COALESCE(d.next_attempt_at, d.claim_expires_at) ASC, d.created_at ASC, d.delivery_id ASC
    LIMIT @limit
  `);
  const listUnsentWithOccurrenceStmt = db.prepare(`
    SELECT ${QUALIFIED_DELIVERY_SELECT},
           o.release_id, o.reason, o.schedule_fingerprint, o.due_at, o.repeat_due_at, o.payload_json
    FROM release_notification_deliveries d
    JOIN release_notification_occurrences o ON o.event_id = d.event_id
    WHERE d.${UNSENT} AND (@releaseId IS NULL OR o.release_id = @releaseId)
    ORDER BY d.created_at ASC, d.delivery_id ASC
  `);
  const findDeliveryWithOccurrenceStmt = db.prepare(`
    SELECT ${QUALIFIED_DELIVERY_SELECT},
           o.release_id, o.reason, o.schedule_fingerprint, o.due_at, o.repeat_due_at, o.payload_json
    FROM release_notification_deliveries d
    JOIN release_notification_occurrences o ON o.event_id = d.event_id
    WHERE d.delivery_id = ?
  `);
  const claimStmt = db.prepare(`
    UPDATE release_notification_deliveries
    SET state = 'sending', claim_token = @claimToken, claim_expires_at = @claimExpiresAt,
        attempt_count = attempt_count + 1, next_attempt_at = NULL, updated_at = @now
    WHERE delivery_id = @deliveryId AND state = @expectedState AND claim_token IS @expectedToken
    RETURNING ${DELIVERY_SELECT}
  `);
  const markDispatchedStmt = db.prepare(`
    UPDATE release_notification_deliveries
    SET last_attempt_at = @now, updated_at = @now
    WHERE delivery_id = @deliveryId AND state = 'sending' AND claim_token = @claimToken
  `);
  // Undo a claim whose send never began: the attempt it consumed is returned,
  // and last_attempt_at/failure_code keep describing the last real attempt.
  const relinquishClaimStmt = db.prepare(`
    UPDATE release_notification_deliveries
    SET state = 'pending', attempt_count = MAX(attempt_count - 1, 0), next_attempt_at = @now,
        claim_token = NULL, claim_expires_at = NULL, updated_at = @now
    WHERE delivery_id = @deliveryId AND state = 'sending' AND claim_token = @claimToken
    RETURNING ${DELIVERY_SELECT}
  `);
  const completeClaimStmt = db.prepare(`
    UPDATE release_notification_deliveries
    SET state = @state, next_attempt_at = @nextAttemptAt, accepted_at = @acceptedAt,
        failure_code = @failureCode, claim_token = NULL, claim_expires_at = NULL, updated_at = @now
    WHERE delivery_id = @deliveryId AND state = 'sending' AND claim_token = @claimToken
    RETURNING ${DELIVERY_SELECT}
  `);
  const cancelSet = `
    SET state = 'cancelled', failure_code = @code, next_attempt_at = NULL,
        claim_token = NULL, claim_expires_at = NULL, updated_at = @now
  `;
  const cancelDeliveryStmt = db.prepare(`
    UPDATE release_notification_deliveries ${cancelSet}
    WHERE delivery_id = @deliveryId AND ${UNSENT}
    RETURNING ${DELIVERY_SELECT}
  `);
  const cancelUnsentByChannelStmt = db.prepare(`
    UPDATE release_notification_deliveries ${cancelSet}
    WHERE channel = @channel AND ${UNSENT}
  `);
  const cancelUnsentByChannelOtherDestinationStmt = db.prepare(`
    UPDATE release_notification_deliveries ${cancelSet}
    WHERE channel = @channel AND destination_identity <> @destinationIdentity AND ${UNSENT}
  `);
  const cancelUnsentByReasonsStmt = db.prepare(`
    UPDATE release_notification_deliveries ${cancelSet}
    WHERE ${UNSENT}
      AND event_id IN (
        SELECT event_id FROM release_notification_occurrences
        WHERE reason IN (SELECT value FROM json_each(@reasons))
      )
  `);
  const listAcceptedChannelsForNoticeStmt = db.prepare(`
    SELECT DISTINCT d.channel
    FROM release_notification_deliveries d
    JOIN release_notification_occurrences o ON o.event_id = d.event_id
    WHERE o.release_id = @releaseId AND o.reason = @reason
      AND o.schedule_fingerprint = @scheduleFingerprint AND d.state = 'accepted'
  `).pluck();
  const findChannelDestinationStmt = db.prepare(`
    SELECT channel, destination_identity, activation_generation, established_at
    FROM release_notification_channel_destinations WHERE channel = ?
  `);
  const upsertChannelDestinationStmt = db.prepare(`
    INSERT INTO release_notification_channel_destinations
      (channel, destination_identity, activation_generation, established_at)
    VALUES (@channel, @destinationIdentity, @activationGeneration, @now)
    ON CONFLICT(channel) DO UPDATE SET
      destination_identity = excluded.destination_identity,
      activation_generation = excluded.activation_generation,
      established_at = excluded.established_at
    WHERE destination_identity <> excluded.destination_identity
       OR activation_generation <> excluded.activation_generation
  `);

  return {
    /**
     * One id-ordered page of at most `limit` releases eligible for
     * notification by publication/archive state and a planned date, strictly
     * after `afterReleaseId`; `hasMore` is false when the page ends the sweep.
     */
    listCandidateReleases({ afterReleaseId = 0, limit }) {
      // One look-ahead row reveals whether this page ends the sweep.
      const rows = listCandidateReleasesStmt.all({ afterReleaseId, limit: limit + 1 });
      return { releases: rows.slice(0, limit), hasMore: rows.length > limit };
    },

    /**
     * At most `limit` eligible releases whose effective local wall-clock
     * schedule lies in one of `wallClockRanges` ([from, through, offset
     * seconds], ascending and disjoint): releases without their exact current
     * `reason` occurrence (due `dueOffsetMs` from the resolved schedule, under
     * the current schedule identity in `timeZone`) first, then earliest
     * resolved schedule, then id. The caller makes the final phase decision.
     */
    listTimeCriticalReleases({
      reason, dateOnlyTime, timeZone, wallClockRanges, dueOffsetMs, limit,
    }) {
      if (wallClockRanges.length === 0) return [];
      return listTimeCriticalReleasesStmt.all({
        reason,
        dateOnlyTime,
        timeZone,
        wallClockRanges: JSON.stringify(wallClockRanges),
        fromDate: wallClockRanges[0][0].slice(0, 10),
        toDate: wallClockRanges[wallClockRanges.length - 1][1].slice(0, 10),
        dueOffsetSeconds: dueOffsetMs / 1000,
        limit,
      }).map((row) => ({ ...row, handled: row.handled === 1 }));
    },

    /** Current release and parent-project state, including ineligible rows, for revalidation. */
    findReleaseState(releaseId) {
      return findReleaseStateStmt.get(releaseId);
    },

    findOccurrenceByKey(occurrenceKey) {
      return findOccurrenceByKeyStmt.get(occurrenceKey);
    },

    findOccurrence(eventId) {
      return findOccurrenceStmt.get(eventId);
    },

    /** Returns the inserted row, or undefined when the logical occurrence already exists. */
    insertOccurrence(occurrence) {
      return insertOccurrenceStmt.get(occurrence);
    },

    insertDelivery(delivery) {
      return insertDeliveryStmt.get(delivery);
    },

    findDelivery(deliveryId) {
      return findDeliveryStmt.get(deliveryId);
    },

    findDeliveryWithOccurrence(deliveryId) {
      return findDeliveryWithOccurrenceStmt.get(deliveryId);
    },

    listDeliveriesForEvent(eventId) {
      return listDeliveriesForEventStmt.all(eventId);
    },

    /** Due pending rows plus rows whose claim lease expired, for the given channels only. */
    listClaimCandidates({ now, channels, limit }) {
      return listClaimCandidatesStmt.all({ now, channels: JSON.stringify(channels), limit });
    },

    listUnsentWithOccurrence({ releaseId = null } = {}) {
      return listUnsentWithOccurrenceStmt.all({ releaseId });
    },

    claimDelivery({ deliveryId, expectedState, expectedToken = null, claimToken, claimExpiresAt, now }) {
      return claimStmt.get({ deliveryId, expectedState, expectedToken, claimToken, claimExpiresAt, now });
    },

    /** Record that the current claim is about to contact the provider. */
    markClaimDispatched({ deliveryId, claimToken, now }) {
      return markDispatchedStmt.run({ deliveryId, claimToken, now }).changes === 1;
    },

    relinquishClaim({ deliveryId, claimToken, now }) {
      return relinquishClaimStmt.get({ deliveryId, claimToken, now });
    },

    completeClaim({
      deliveryId, claimToken, state, nextAttemptAt = null, acceptedAt = null, failureCode = null, now,
    }) {
      return completeClaimStmt.get({
        deliveryId, claimToken, state, nextAttemptAt, acceptedAt, failureCode, now,
      });
    },

    cancelDelivery({ deliveryId, code, now }) {
      return cancelDeliveryStmt.get({ deliveryId, code, now });
    },

    cancelUnsentByChannel({ channel, code, now }) {
      return cancelUnsentByChannelStmt.run({ channel, code, now }).changes;
    },

    cancelUnsentForOtherDestinations({ channel, destinationIdentity, code, now }) {
      return cancelUnsentByChannelOtherDestinationStmt.run({ channel, destinationIdentity, code, now }).changes;
    },

    cancelUnsentByReasons({ reasons, code, now }) {
      return cancelUnsentByReasonsStmt.run({ reasons: JSON.stringify(reasons), code, now }).changes;
    },

    /** Channels that already accepted any occurrence of one release/reason/schedule notice. */
    listAcceptedChannelsForNotice({ releaseId, reason, scheduleFingerprint }) {
      return listAcceptedChannelsForNoticeStmt.all({ releaseId, reason, scheduleFingerprint });
    },

    /** Last ready destination identity recorded for a channel, or undefined. */
    findChannelDestination(channel) {
      return findChannelDestinationStmt.get(channel);
    },

    upsertChannelDestination({ channel, destinationIdentity, activationGeneration, now }) {
      upsertChannelDestinationStmt.run({ channel, destinationIdentity, activationGeneration, now });
    },

    /** Runs fn inside an IMMEDIATE transaction so claim selection and update cannot interleave. */
    transaction(fn) {
      return db.transaction(fn).immediate();
    },
  };
}
