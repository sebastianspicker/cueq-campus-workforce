import { describe, expect, it } from 'vitest';
import { roundToTwo } from '@cueq/domain';
import {
  actualHoursForInterval,
  targetHoursForBerlinDay,
  targetHoursForInterval,
} from './time-account-calculation.helper.js';

const schedule = {
  weeklyHours: 40,
  dailyTargetHours: 8,
  workingDays: [1, 2, 3, 4, 5],
  holidayCalendar: { holidayDates: ['2026-03-03'] },
};

describe('time-account schedule calculation', () => {
  it('uses UTC date-only account intervals and explicit holidays', () => {
    expect(
      targetHoursForInterval(
        schedule,
        new Date('2026-03-02T00:00:00.000Z'),
        new Date('2026-03-05T00:00:00.000Z'),
      ),
    ).toBe(16);
  });

  it('rejects partial-day target allocation without an explicit policy', () => {
    expect(() =>
      targetHoursForInterval(
        schedule,
        new Date('2026-03-02T12:00:00.000Z'),
        new Date('2026-03-03T00:00:00.000Z'),
      ),
    ).toThrow('Partial-day appointment boundaries');
  });

  it('prorates partial UTC accounting days only when the term explicitly enables it', () => {
    expect(
      targetHoursForInterval(
        { ...schedule, policyReferences: { timeAccountTargetProration: 'UTC_DAY_FRACTION' } },
        new Date('2026-03-02T12:00:00.000Z'),
        new Date('2026-03-04T06:00:00.000Z'),
      ),
    ).toBe(6);
  });

  it('uses the Berlin local date and weekday for the dashboard', () => {
    expect(targetHoursForBerlinDay(schedule, new Date('2026-03-29T12:00:00.000Z'))).toBe(0);
    expect(targetHoursForBerlinDay(schedule, new Date('2026-03-30T12:00:00.000Z'))).toBe(8);
  });

  it('lowers the target for approved absence days so a fully worked month balances', () => {
    const term = { ...schedule, dailyTargetHours: 7.8, holidayCalendar: { holidayDates: [] } };
    const from = new Date('2026-03-01T00:00:00.000Z');
    const to = new Date('2026-04-01T00:00:00.000Z');
    const vacation = [
      {
        startDate: new Date('2026-03-09T00:00:00.000Z'),
        endDate: new Date('2026-03-13T00:00:00.000Z'),
      },
    ];
    const bookings = Array.from({ length: 31 }, (_, index) => index + 1)
      .filter((day) => ![1, 7, 8, 14, 15, 21, 22, 28, 29].includes(day) && (day < 9 || day > 13))
      .map((day) => ({
        startTime: new Date(Date.UTC(2026, 2, day, 8)),
        endTime: new Date(Date.UTC(2026, 2, day, 15, 48)),
      }));
    expect(bookings).toHaveLength(17);

    const target = targetHoursForInterval(term, from, to, vacation);
    const actual = actualHoursForInterval(bookings, from, to);
    expect(target).toBe(132.6);
    expect(roundToTwo(actual - target)).toBe(0);
    // A holiday inside the vacation week is not subtracted twice.
    expect(
      targetHoursForInterval(
        { ...term, holidayCalendar: { holidayDates: ['2026-03-11'] } },
        from,
        to,
        vacation,
      ),
    ).toBe(132.6);
  });

  it('rounds half-hundredth ties up, as the domain does', () => {
    const start = new Date('2026-03-02T08:00:00.000Z');
    const bookings = [{ startTime: start, endTime: new Date(start.getTime() + 3618_000) }];
    expect(actualHoursForInterval(bookings, start, new Date('2026-03-03T00:00:00.000Z'))).toBe(
      1.01,
    );
  });
});
