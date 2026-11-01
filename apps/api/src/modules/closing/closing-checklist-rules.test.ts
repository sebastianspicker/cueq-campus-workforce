import { TimeTypeCategory } from '@cueq/database';
import { describe, expect, it } from 'vitest';
import {
  MAX_CHECKLIST_FINDINGS,
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
    id: `booking-${assignmentId}-${startTime}`,
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

  it('does not count the overnight gap between two working days', () => {
    const monday = booking('assignment-a', '2026-03-02T07:00:00.000Z', '2026-03-02T15:00:00.000Z');
    const tuesday = booking('assignment-a', '2026-03-03T07:00:00.000Z', '2026-03-03T15:00:00.000Z');

    const result = calculateClosingBookingMetrics(
      [monday, tuesday],
      [monday, tuesday],
      [],
      1,
      'period-1',
      periodStart,
      periodEnd,
      thresholds,
    );

    expect(result.bookingGaps).toBe(0);
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

  it('names open and oversized bookings, capped while the count stays exact', () => {
    const open = {
      ...booking('assignment-a', '2026-03-03T08:00:00.000Z', '2026-03-03T09:00:00.000Z'),
      endTime: null,
    };
    const oversized = booking(
      'assignment-a',
      '2020-01-01T00:00:00.000Z',
      '2030-01-01T00:00:00.000Z',
    );
    const all = [open, oversized];

    const result = calculateClosingBookingMetrics(
      all,
      all,
      [],
      1,
      'period-1',
      periodStart,
      periodEnd,
      thresholds,
      [{ personId: 'person-1', assignmentId: 'assignment-a' }],
    );

    expect(result.ruleViolations).toBeGreaterThan(MAX_CHECKLIST_FINDINGS);
    expect(result.findings.RULE_VIOLATIONS).toHaveLength(MAX_CHECKLIST_FINDINGS);
    expect(result.findings.RULE_VIOLATIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'OPEN_BOOKING',
          bookingId: open.id,
          personId: 'person-1',
          assignmentId: 'assignment-a',
        }),
        expect.objectContaining({ reason: 'OVERSIZED_BOOKING', bookingId: oversized.id }),
      ]),
    );
  });

  it('reports each policy violation with its code and message', () => {
    const long = booking('assignment-b', '2026-03-05T04:00:00.000Z', '2026-03-05T22:00:00.000Z');

    const result = calculateClosingBookingMetrics(
      [long],
      [long],
      [],
      1,
      'period-1',
      periodStart,
      periodEnd,
      thresholds,
    );

    expect(result.ruleViolations).toBeGreaterThan(0);
    expect(result.findings.RULE_VIOLATIONS).toHaveLength(result.ruleViolations);
    for (const finding of result.findings.RULE_VIOLATIONS) {
      expect(finding).toMatchObject({ personId: 'person-1' });
      expect(finding.reason).toMatch(/^[A-Z_]+$/);
      expect(finding.message.length).toBeGreaterThan(0);
    }
  });

  it('lists appointments without coverage and caps findings while counts stay exact', () => {
    const appointments = Array.from({ length: MAX_CHECKLIST_FINDINGS + 5 }, (_, index) => ({
      personId: `person-${index}`,
      assignmentId: `assignment-${index}`,
    }));

    const result = calculateClosingBookingMetrics(
      [],
      [],
      [{ assignmentId: 'assignment-0' }],
      appointments.length,
      'period-1',
      periodStart,
      periodEnd,
      thresholds,
      appointments,
    );

    expect(result.missingBookings).toBe(appointments.length - 1);
    expect(result.findings.MISSING_BOOKINGS).toHaveLength(MAX_CHECKLIST_FINDINGS);
    expect(result.findings.MISSING_BOOKINGS[0]).toMatchObject({
      reason: 'NO_BOOKING_OR_ABSENCE',
      personId: 'person-1',
      assignmentId: 'assignment-1',
    });
  });

  it("counts a person's bookings from other units but shows booking details only for this unit", () => {
    const otherUnit = {
      ...booking('assignment-other', '2026-03-03T08:00:00.000Z', '2026-03-03T12:00:00.000Z'),
      endTime: null,
    };

    const result = calculateClosingBookingMetrics(
      [otherUnit],
      [],
      [],
      1,
      'period-1',
      periodStart,
      periodEnd,
      thresholds,
      [{ personId: 'person-1', assignmentId: 'assignment-a' }],
    );

    expect(result.ruleViolations).toBe(1);
    expect(result.findings.RULE_VIOLATIONS).toEqual([]);
  });
});
