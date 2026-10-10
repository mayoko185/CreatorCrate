import { describe, expect, it } from 'vitest';
import { browserLocalScheduleDefaults } from '../src/static/client/release-schedule-defaults.js';

describe('browserLocalScheduleDefaults', () => {
  it('adds one hour to the browser-local time and keeps canonical HH:mm', () => {
    expect(browserLocalScheduleDefaults(new Date(2026, 9, 10, 9, 5, 42))).toEqual({
      plannedDate: '2026-10-10',
      plannedTime: '10:05',
    });
    expect(browserLocalScheduleDefaults(new Date(2026, 9, 10, 12, 30))).toEqual({
      plannedDate: '2026-10-10',
      plannedTime: '13:30',
    });
  });

  it('derives date and time from the same future instant across midnight, month, and year rollover', () => {
    expect(browserLocalScheduleDefaults(new Date(2026, 9, 10, 23, 30))).toEqual({
      plannedDate: '2026-10-11',
      plannedTime: '00:30',
    });
    expect(browserLocalScheduleDefaults(new Date(2026, 1, 28, 23, 15))).toEqual({
      plannedDate: '2026-03-01',
      plannedTime: '00:15',
    });
    expect(browserLocalScheduleDefaults(new Date(2028, 1, 28, 23, 15))).toEqual({
      plannedDate: '2028-02-29',
      plannedTime: '00:15',
    });
    expect(browserLocalScheduleDefaults(new Date(2026, 11, 31, 23, 59))).toEqual({
      plannedDate: '2027-01-01',
      plannedTime: '00:59',
    });
  });

  it('uses the current time when called without an argument', () => {
    const before = browserLocalScheduleDefaults(new Date());
    const actual = browserLocalScheduleDefaults();
    expect(actual.plannedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(actual.plannedTime).toMatch(/^\d{2}:\d{2}$/);
    expect(actual.plannedDate >= before.plannedDate).toBe(true);
  });
});
