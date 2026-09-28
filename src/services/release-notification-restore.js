import { createReleaseNotificationService } from './release-notification-service.js';

/**
 * Prepare a staged restore's release-notification state before it can become
 * the live database. An older backup carries an older notification ledger and
 * possibly enabled settings; neither may resume on its own. Notifications are
 * saved disabled through the WP1 core (so deactivation cancels unsent work
 * exactly as a user's own disable would) and any remaining unsent delivery is
 * cancelled as stale. Preferences are kept, so re-enabling in Settings starts
 * a fresh prospective baseline instead of replaying the restored history.
 */
export function disableReleaseNotificationsForRestore(db, { now = () => new Date() } = {}) {
  const service = createReleaseNotificationService({ db, now });
  const settings = service.getSettings();
  let disabled = false;
  if (settings.enabled) {
    const { version: _version, activation: _activation, ...preferences } = settings;
    service.updateSettings({ ...preferences, enabled: false });
    disabled = true;
  }
  const cancelled = service.invalidateStaleDeliveries({ destinations: {} });
  return { disabled, cancelled: cancelled.length };
}
