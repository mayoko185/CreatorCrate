import express from 'express';
import {
  RELEASE_NOTIFICATION_CHANNELS,
  ReleaseNotificationSettingsValidationError,
  validateReleaseNotificationPreferences,
} from '../services/release-notification-settings-service.js';
import { recentResultFromOutcome } from '../services/release-notification-recent-result-service.js';
import {
  DURATION_UNITS,
  ENABLE_REQUIRES_READY_CHANNEL_MESSAGE,
  isValidTimeZone,
  mapCoreErrors,
  normalizeChannelStatus,
  parseSubmittedPreferences,
  presentChannels,
  presentDateOnlyExample,
  presentNotReadyTestFeedback,
  presentTestFeedback,
  unavailableChannelStatus,
  valuesFromSettings,
} from '../services/release-notification-settings-presenter.js';

export const RELEASE_NOTIFICATION_SETTINGS_PATH = '/settings/release-notifications';

const NOTICES = Object.freeze({
  saved: { variant: 'success', text: 'Release notification settings saved.' },
});

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

function canonicalChannels(channels) {
  return RELEASE_NOTIFICATION_CHANNELS.filter((channel) => channels.includes(channel));
}

function sameChannels(left, right) {
  return left.length === right.length && left.every((channel, index) => channel === right[index]);
}

/**
 * Settings → Release Notifications.
 *
 * Preferences are saved only through the notification core's
 * updateSettings(), which derives channel activation generations and cancels
 * unsent work in the same transaction. Transport configuration is never read
 * here: `releaseNotificationRuntime` supplies already-safe status
 * (getChannelStatus), the effective timezone (getEffectiveTimeZone), and a
 * lifecycle-aware test action (sendTest) that runs on the channel's delivery
 * lane rather than calling a sender directly from this request.
 */
export function createReleaseNotificationSettingsRouter({
  appName,
  releaseNotificationService,
  recentResultService,
  releaseNotificationRuntime,
  applicationLogger = null,
  now = () => new Date(),
} = {}) {
  if (!releaseNotificationService || typeof releaseNotificationService.updateSettings !== 'function'
    || typeof releaseNotificationService.getSettings !== 'function') {
    throw new Error('createReleaseNotificationSettingsRouter requires a releaseNotificationService dependency.');
  }
  if (!recentResultService || typeof recentResultService.getRecentResults !== 'function'
    || typeof recentResultService.recordResult !== 'function') {
    throw new Error('createReleaseNotificationSettingsRouter requires a recentResultService dependency.');
  }
  if (!releaseNotificationRuntime || typeof releaseNotificationRuntime.getChannelStatus !== 'function'
    || typeof releaseNotificationRuntime.getEffectiveTimeZone !== 'function'
    || typeof releaseNotificationRuntime.sendTest !== 'function') {
    throw new Error('createReleaseNotificationSettingsRouter requires a releaseNotificationRuntime dependency.');
  }

  const router = express.Router();

  /**
   * Readiness is evaluated against a recipient because the email transport's
   * destination address is a stored preference, not deployment config.
   */
  function readChannelStatus({ emailRecipient }) {
    try {
      return normalizeChannelStatus(releaseNotificationRuntime.getChannelStatus({ emailRecipient }));
    } catch {
      return unavailableChannelStatus();
    }
  }

  function readTimeZone() {
    try {
      const timeZone = releaseNotificationRuntime.getEffectiveTimeZone();
      return isValidTimeZone(timeZone) ? timeZone : null;
    } catch {
      return null;
    }
  }

  function renderPage(res, {
    status = 200,
    settings = releaseNotificationService.getSettings(),
    values = valuesFromSettings(settings),
    errors = {},
    notice = null,
    testFeedback = null,
  } = {}) {
    const clockFormat = res.locals.clockFormat === '12h' ? '12h' : '24h';
    const channelStatus = readChannelStatus({ emailRecipient: settings.emailRecipient });
    const channels = presentChannels({
      settings,
      values,
      status: channelStatus,
      recentResults: recentResultService.getRecentResults(),
      testFeedback,
      clockFormat,
    });
    const savedReadyChannels = channels.filter((channel) => channel.savedSelected && channel.ready);
    res.status(status).render('settings/release-notifications.njk', {
      appName,
      notice,
      values,
      errors,
      errorMessages: Object.values(errors),
      channels,
      saved: {
        enabled: settings.enabled,
        hasReadyDestination: savedReadyChannels.length > 0,
      },
      durationUnits: DURATION_UNITS,
      timeZone: readTimeZone(),
      dateOnlyExample: presentDateOnlyExample(settings, now(), clockFormat),
      clockFormat,
    });
  }

  router.get('/', (req, res) => {
    const code = typeof req.query.notice === 'string' ? req.query.notice : '';
    renderPage(res, { notice: Object.hasOwn(NOTICES, code) ? NOTICES[code] : null });
  });

  router.post('/', (req, res, next) => {
    try {
      const previous = releaseNotificationService.getSettings();
      const { input, values, minutes, errors: formErrors } = parseSubmittedPreferences(req.body);
      const rerender = (errors) => renderPage(res, { status: 422, settings: previous, values, errors });
      if (Object.keys(formErrors).length > 0) return rerender(formErrors);

      // The core deliberately ignores transport readiness, so enabling (or
      // re-choosing channels while enabled) is guarded here: at least one
      // selected channel must be able to deliver. Timing-only edits are not
      // blocked when a deployment change later makes channels unready.
      const selected = canonicalChannels(input.enabledChannels);
      const needsReadyChannel = input.enabled && selected.length > 0
        && (!previous.enabled || !sameChannels(selected, previous.enabledChannels));
      if (needsReadyChannel) {
        const status = readChannelStatus({ emailRecipient: input.emailRecipient || null });
        if (!selected.some((channel) => status[channel].readiness.ready)) {
          let coreErrors = {};
          try {
            validateReleaseNotificationPreferences(input);
          } catch (err) {
            if (!(err instanceof ReleaseNotificationSettingsValidationError)) throw err;
            coreErrors = err.errors;
          }
          return rerender({ ...mapCoreErrors(coreErrors, minutes), enabled: ENABLE_REQUIRES_READY_CHANNEL_MESSAGE });
        }
      }

      let result;
      try {
        result = releaseNotificationService.updateSettings(input);
      } catch (err) {
        if (err instanceof ReleaseNotificationSettingsValidationError) {
          return rerender(mapCoreErrors(err.errors, minutes));
        }
        throw err;
      }

      try {
        applicationLogger?.info?.({
          event: 'settings.release_notifications.updated',
          kind: 'activity',
          subsystem: 'settings',
          message: 'Release notification settings updated.',
          context: {
            enabled: result.settings.enabled,
            channels: result.settings.enabledChannels.join(','),
          },
        });
      } catch {
        // Activity logging must never alter a completed Settings mutation.
      }
      return res.redirect(`${RELEASE_NOTIFICATION_SETTINGS_PATH}?notice=saved`);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/channels/:channel/test', async (req, res, next) => {
    const { channel } = req.params;
    // Fixed allowlist: the path segment is never used to look anything up
    // dynamically.
    if (!RELEASE_NOTIFICATION_CHANNELS.includes(channel)) return next(createNotFound());

    try {
      const settings = releaseNotificationService.getSettings();
      const { readiness } = readChannelStatus({ emailRecipient: settings.emailRecipient })[channel];
      if (!readiness.ready) {
        return renderPage(res, {
          status: 409,
          settings,
          testFeedback: { channel, ...presentNotReadyTestFeedback(channel, readiness) },
        });
      }

      let outcome;
      try {
        outcome = await releaseNotificationRuntime.sendTest(channel);
      } catch {
        // Gateway errors may carry provider text; only a fixed code is kept.
        outcome = { outcome: 'permanent_failure', failureCode: 'unexpected_error' };
      }
      const entry = recentResultService.recordResult(channel, recentResultFromOutcome(outcome, {
        kind: 'test',
        at: now().toISOString(),
        nextRetryAt: outcome?.nextRetryAt ?? null,
      }));
      const clockFormat = res.locals.clockFormat === '12h' ? '12h' : '24h';
      return renderPage(res, {
        settings: releaseNotificationService.getSettings(),
        testFeedback: { channel, ...presentTestFeedback(channel, entry, clockFormat) },
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
