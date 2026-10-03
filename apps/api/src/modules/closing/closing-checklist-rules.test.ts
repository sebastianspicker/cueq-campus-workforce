import { TimeTypeCategory } from '@cueq/database';
import { describe, expect, it } from 'vitest';
import {
  calculateClosingBookingMetrics,
  type ClosingChecklistBooking,
} from './closing-checklist-rules.js';

const thresholds = { dailyMaxMinutes: 16 * 60, minRestMinutes: 11 * 60 };
const periodStart = new Date('2026-03-01T00:00:00.000Z');
const periodEnd = new Date('2026-03-31T23:59:59.999Z');

function booking(
  assignmentId: string,
  startTime: string,
  endTime: string,
  category: TimeTypeCategory = TimeTypeCategory.WORK,
): ClosingChecklistBooking {
  return {
    personId: 'person-1',
    assignmentId,
    startTime: new Date(startTime),
    endTime: new Date(endTime),
    timeType: { category },
  };
}

describe('closing checklist appointment metrics', () => {
  it('does not use leave from one appointment as coverage for another', () => {
    const result = calculateClosingBookingMetrics(
      [],
      [],
      [{ assignmentId: 'assignment-b' }],
      2,
      'period-1',
      periodStart,
      periodEnd,
      thresholds,
    );

    expect(result.missingBookings).toBe(1);
  });

  it('evaluates rest and booking gaps across all appointments of one person', () => {
    const first = booking('assignment-a', '2026-03-02T08:00:00.000Z', '2026-03-02T12:00:00.000Z');
    const second = booking('assignment-b', '2026-03-02T17:00:00.000Z', '2026-03-02T20:00:00.000Z');

    const result = calculateClosingBookingMetrics(
      [first, second],
      [first, second],
      [],
      2,
      'period-1',
      periodStart,
      periodEnd,
      thresholds,
    );

    expect(result.missingBookings).toBe(0);
    expect(result.bookingGaps).toBe(1);
    expect(result.ruleViolations).toBeGreaterThan(0);
  });

  it('clips legacy oversized bookings to the closing period and flags the source record', () => {
    const oversized = booking(
      'assignment-a',
      '2020-01-01T00:00:00.000Z',
      '2030-01-01T00:00:00.000Z',
    );

    const result = calculateClosingBookingMetrics(
      [oversized],
      [oversized],
      [],
      1,
      'period-1',
      periodStart,
      periodEnd,
      thresholds,
    );

    expect(result.ruleViolations).toBeGreaterThan(0);
  });

  it('preserves the complete Berlin workday at a UTC month boundary', () => {
    const bookings = [
      booking('assignment-a', '2026-02-28T23:00:00.000Z', '2026-03-01T07:00:00.000Z'),
      booking(
        'assignment-a',
        '2026-03-01T07:00:00.000Z',
        '2026-03-01T07:45:00.000Z',
        TimeTypeCategory.PAUSE,
      ),
      booking('assignment-a', '2026-03-01T07:45:00.000Z', '2026-03-01T16:15:00.000Z'),
    ];

    const result = calculateClosingBookingMetrics(
      bookings,
      bookings,
      [],
      1,
      'period-1',
      periodStart,
      periodEnd,
      thresholds,
    );

    expect(result.ruleViolations).toBeGreaterThan(0);
  });
});
