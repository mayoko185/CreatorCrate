import { describe, expect, it } from 'vitest';
import { syncReleaseNotificationTiming } from '../src/static/client/settings-release-notifications.js';

function element() {
  const attributes = new Map();
  return {
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    get hidden() { return attributes.has('hidden'); },
  };
}

function makeForm(checked) {
  const details = { advance: element(), overdue: element(), repeat: element() };
  return {
    details,
    querySelector(selector) {
      const toggle = selector.match(/name="([^"]+)"/);
      if (toggle) return { checked: checked[toggle[1]] === true };
      const detail = selector.match(/data-release-notification-detail="([^"]+)"/);
      return detail ? details[detail[1]] : null;
    },
  };
}

describe('release notification timing dependencies', () => {
  it('shows sub-controls only for enabled reminders', () => {
    const form = makeForm({ advanceEnabled: true, overdueEnabled: false, repeatEnabled: false });
    syncReleaseNotificationTiming(form);

    expect(form.details.advance.hidden).toBe(false);
    expect(form.details.overdue.hidden).toBe(true);
    expect(form.details.repeat.hidden).toBe(true);
  });

  it('keeps the overdue block reachable while a repeat is still on', () => {
    const form = makeForm({ advanceEnabled: false, overdueEnabled: false, repeatEnabled: true });
    syncReleaseNotificationTiming(form);

    expect(form.details.advance.hidden).toBe(true);
    expect(form.details.overdue.hidden).toBe(false);
    expect(form.details.repeat.hidden).toBe(false);
  });
});
