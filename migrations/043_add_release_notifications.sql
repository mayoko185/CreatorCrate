-- External release notifications: one logical occurrence per release event,
-- fanned out to zero or more independent per-channel deliveries.
--
-- Every timestamp in these tables is ISO-8601 UTC text written by the
-- application clock (e.g. 2026-01-01T09:00:00.000Z) so that due, retry, and
-- lease comparisons are plain lexicographic comparisons. No destination URL,
-- credential, or provider response is stored; destinations are opaque digests.

CREATE TABLE release_notification_occurrences (
    event_id TEXT PRIMARY KEY,
    release_id INTEGER NOT NULL,
    -- Logical identity: release, reason, schedule fingerprint, and repeat due
    -- instant. Title/notes edits never participate, so they cannot mint new
    -- occurrences, and returning to a previously used schedule reuses its row.
    occurrence_key TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL CHECK (reason IN (
        'release.advance', 'release.scheduled', 'release.overdue', 'release.overdue_repeat'
    )),
    schedule_fingerprint TEXT NOT NULL CHECK (length(schedule_fingerprint) = 64),
    repeat_due_at TEXT,
    due_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    CHECK ((reason = 'release.overdue_repeat') = (repeat_due_at IS NOT NULL)),
    FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
);

CREATE INDEX idx_release_notification_occurrences_release
    ON release_notification_occurrences(release_id, reason);

CREATE TABLE release_notification_deliveries (
    delivery_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'ntfy', 'gotify', 'webhook')),
    destination_identity TEXT NOT NULL CHECK (length(destination_identity) = 64),
    activation_generation INTEGER NOT NULL CHECK (activation_generation >= 1),
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'sending', 'accepted', 'failed', 'cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TEXT,
    claim_token TEXT,
    claim_expires_at TEXT,
    last_attempt_at TEXT,
    accepted_at TEXT,
    failure_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((state = 'pending') = (next_attempt_at IS NOT NULL)),
    CHECK ((state = 'sending') = (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)),
    CHECK ((state = 'accepted') = (accepted_at IS NOT NULL)),
    UNIQUE (event_id, channel),
    FOREIGN KEY (event_id) REFERENCES release_notification_occurrences(event_id) ON DELETE CASCADE
);

CREATE INDEX idx_release_notification_deliveries_due
    ON release_notification_deliveries(next_attempt_at)
    WHERE state = 'pending';

CREATE INDEX idx_release_notification_deliveries_leases
    ON release_notification_deliveries(claim_expires_at)
    WHERE state = 'sending';

CREATE INDEX idx_release_notification_deliveries_channel_unsent
    ON release_notification_deliveries(channel)
    WHERE state IN ('pending', 'sending');

-- Last destination identity observed ready for each channel, scoped to the
-- channel's activation generation. It lets fan-out tell a temporary runtime
-- outage of an established destination apart from a channel that was never
-- configured or whose destination changed. Only the opaque digest is kept.
CREATE TABLE release_notification_channel_destinations (
    channel TEXT PRIMARY KEY CHECK (channel IN ('email', 'ntfy', 'gotify', 'webhook')),
    destination_identity TEXT NOT NULL CHECK (length(destination_identity) = 64),
    activation_generation INTEGER NOT NULL CHECK (activation_generation >= 1),
    established_at TEXT NOT NULL
);
