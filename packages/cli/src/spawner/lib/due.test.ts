import { describe, expect, it } from 'vitest';
import { makeTask } from '../test-utils.js';
import { isDue } from './due.js';

// Noon local time, so a same-day date-only comparison cannot straddle midnight
// in either direction.
const NOW = new Date(2026, 0, 15, 12, 0, 0);

describe('isDue', () => {
  it('takes a task with no due date', () => {
    expect(isDue(makeTask(), NOW)).toBe(true);
  });

  it('takes a task whose due field is null', () => {
    expect(isDue(makeTask({ due: null }), NOW)).toBe(true);
  });

  describe('date-only due dates', () => {
    it('takes a task due today from local midnight', () => {
      expect(isDue(makeTask({ due: { date: '2026-01-15' } }), NOW)).toBe(true);
    });

    it('takes a task due yesterday', () => {
      expect(isDue(makeTask({ due: { date: '2026-01-14' } }), NOW)).toBe(true);
    });

    it('defers a task due tomorrow', () => {
      expect(isDue(makeTask({ due: { date: '2026-01-16' } }), NOW)).toBe(false);
    });
  });

  describe('floating datetime due dates', () => {
    it('takes a task whose local time already passed', () => {
      expect(
        isDue(makeTask({ due: { date: '2026-01-15T11:59:00' } }), NOW),
      ).toBe(true);
    });

    it('defers a task whose local time is still ahead', () => {
      expect(
        isDue(makeTask({ due: { date: '2026-01-15T12:01:00' } }), NOW),
      ).toBe(false);
    });

    it('takes a passed local time carrying fractional seconds', () => {
      expect(
        isDue(makeTask({ due: { date: '2026-01-15T11:59:00.000000' } }), NOW),
      ).toBe(true);
    });

    it('defers an upcoming local time carrying fractional seconds', () => {
      expect(
        isDue(makeTask({ due: { date: '2026-01-15T12:01:00.000000' } }), NOW),
      ).toBe(false);
    });
  });

  describe('absolute (UTC) datetime due dates', () => {
    it('takes a task whose instant already passed', () => {
      const past = new Date(NOW.getTime() - 60_000).toISOString();
      expect(isDue(makeTask({ due: { date: past } }), NOW)).toBe(true);
    });

    it('defers a task whose instant is still ahead', () => {
      const future = new Date(NOW.getTime() + 60_000).toISOString();
      expect(isDue(makeTask({ due: { date: future } }), NOW)).toBe(false);
    });
  });

  it('takes a task whose due date cannot be parsed', () => {
    expect(isDue(makeTask({ due: { date: 'not a date' } }), NOW)).toBe(true);
  });
});
