import { describe, expect, it } from 'vitest';
import {
  formatLocalDate,
  toLocalHourBucketStartUtc,
  toLocalHourLabelFromStoredUtc,
} from './localTimeService.js';

describe('toLocalHourLabelFromStoredUtc', () => {
  it('renders a stored UTC hour bucket as a local wall-clock label', () => {
    const label = toLocalHourLabelFromStoredUtc('2026-09-21 08:00:00');
    const instant = new Date('2026-09-21T08:00:00Z');
    const expectedHour = String(instant.getHours()).padStart(2, '0');
    expect(label).toBe(`${formatLocalDate(instant)} ${expectedHour}:00`);
  });

  it('round-trips the key written by the hourly aggregation', () => {
    // Whatever the machine's time zone, bucketing a 16:37 local instant and then
    // labelling that key must give back the 16:00 local hour. This is the axis'
    // contract: the site-trend chart prints the label verbatim.
    const localInstant = new Date(2026, 8, 21, 16, 37, 0);
    const storedKey = toLocalHourBucketStartUtc(localInstant);
    expect(storedKey).toBeTruthy();
    expect(toLocalHourLabelFromStoredUtc(storedKey)).toBe('2026-09-21 16:00');
  });

  it('does not print the raw UTC hour unless the machine runs on UTC', () => {
    // Guards the reported bug: the trend axis printed site_hour_usage's UTC key
    // verbatim, so the 16:00 local bucket ticked as "08".
    const label = toLocalHourLabelFromStoredUtc('2026-09-21 08:00:00');
    if (new Date(2026, 8, 21, 8, 0, 0).getTimezoneOffset() === 0) {
      expect(label).toBe('2026-09-21 08:00');
    } else {
      expect(label).not.toBe('2026-09-21 08:00');
    }
  });

  it('rejects empty and malformed input', () => {
    expect(toLocalHourLabelFromStoredUtc('')).toBeNull();
    expect(toLocalHourLabelFromStoredUtc(null)).toBeNull();
    expect(toLocalHourLabelFromStoredUtc('not-a-date')).toBeNull();
  });
});
