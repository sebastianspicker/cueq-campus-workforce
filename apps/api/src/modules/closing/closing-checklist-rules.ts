/** Evaluates pure booking-derived metrics for the closing checklist. */
import { TimeTypeCategory } from '@cueq/database';
import { MAX_BOOKING_DURATION_MS } from '@cueq/contracts';
import { evaluateTimeRules } from '@cueq/domain';
import { DEFAULT_MAX_HOURS_RULE, DEFAULT_REST_RULE } from '@cueq/policy';
import { closingBookingGapMinutes } from './closing-config.js';

type ClosingRuleTimeType = 'WORK' | 'DEPLOYMENT' | 'PAUSE';

export type ClosingChecklistBooking = {
  personId: string;
  assignmentId: string;
  startTime: Date;
  endTime: Date | null;
  timeType: { category: TimeTypeCategory };
};

export type ClosingTimeThresholds = {
  dailyMaxMinutes: number;
  minRestMinutes: number;
};

type RuleBooking = {
  startTime: Date;
  endTime: Date;
  timeType: ClosingRuleTimeType;
};

function isClosingRuleTimeType(category: TimeTypeCategory): category is ClosingRuleTimeType {
  return (
    category === TimeTypeCategory.WORK ||
    category === TimeTypeCategory.DEPLOYMENT ||
    category === TimeTypeCategory.PAUSE
  );
}

function isCompletedWorkBooking(booking: ClosingChecklistBooking): boolean {
  return (
    booking.endTime !== null &&
    (booking.timeType.category === TimeTypeCategory.WORK ||
      booking.timeType.category === TimeTypeCategory.DEPLOYMENT)
  );
}

function policyIntervalType(timeType: ClosingRuleTimeType): 'WORK' | 'DEPLOYMENT' | 'PAUSE' {
  if (timeType === TimeTypeCategory.PAUSE) return 'PAUSE';
  return timeType === TimeTypeCategory.DEPLOYMENT ? 'DEPLOYMENT' : 'WORK';
}

function ruleBookingsByPerson(
  bookings: ClosingChecklistBooking[],
  periodStart: Date,
  periodEnd: Date,
): Map<string, RuleBooking[]> {
  const byPerson = new Map<string, RuleBooking[]>();
  for (const booking of bookings) {
    if (!booking.endTime || !isClosingRuleTimeType(booking.timeType.category)) continue;
    const entries = byPerson.get(booking.personId) ?? [];
    const isOversized =
      booking.endTime.getTime() - booking.startTime.getTime() > MAX_BOOKING_DURATION_MS;
    const startTime = isOversized
      ? new Date(Math.max(booking.startTime.getTime(), periodStart.getTime()))
      : booking.startTime;
    const endTime = isOversized
      ? new Date(Math.min(booking.endTime.getTime(), periodEnd.getTime()))
      : booking.endTime;
    if (startTime >= endTime) continue;
    entries.push({
      startTime,
      endTime,
      timeType: booking.timeType.category,
    });
    byPerson.set(booking.personId, entries);
  }
  return byPerson;
}

function bookingGapCount(bookingsByPerson: Map<string, RuleBooking[]>): number {
  let gaps = 0;
  for (const entries of bookingsByPerson.values()) {
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (
        previous &&
        current &&
        (current.startTime.getTime() - previous.endTime.getTime()) / 60000 >
          closingBookingGapMinutes()
      ) {
        gaps += 1;
      }
    }
  }
  return gaps;
}

function policyViolationCount(
  entries: RuleBooking[],
  periodId: string,
  timeThresholds: ClosingTimeThresholds,
): number {
  return evaluateTimeRules(
    {
      week: `closing-${periodId}`,
      targetHours: 0,
      timezone: 'Europe/Berlin',
      intervals: entries.map((entry) => ({
        start: entry.startTime.toISOString(),
        end: entry.endTime.toISOString(),
        type: policyIntervalType(entry.timeType),
      })),
    },
    {
      maxHoursRule: {
        ...DEFAULT_MAX_HOURS_RULE,
        maxDailyHoursExtended: timeThresholds.dailyMaxMinutes / 60,
        maxWeeklyHours: Number.MAX_SAFE_INTEGER,
      },
      restRule: { ...DEFAULT_REST_RULE, minRestHours: timeThresholds.minRestMinutes / 60 },
    },
  ).violations.length;
}

function ruleViolationCount(
  bookings: ClosingChecklistBooking[],
  bookingsByPerson: Map<string, RuleBooking[]>,
  periodId: string,
  timeThresholds: ClosingTimeThresholds,
): number {
  let violations = bookings.filter(
    (booking) =>
      booking.endTime === null ||
      booking.endTime.getTime() - booking.startTime.getTime() > MAX_BOOKING_DURATION_MS,
  ).length;
  for (const entries of bookingsByPerson.values()) {
    violations += policyViolationCount(entries, periodId, timeThresholds);
  }
  return violations;
}

export function calculateClosingBookingMetrics(
  ruleBookings: ClosingChecklistBooking[],
  coverageBookings: ClosingChecklistBooking[],
  approvedAbsences: Array<{ assignmentId: string }>,
  appointmentCount: number,
  periodId: string,
  periodStart: Date,
  periodEnd: Date,
  timeThresholds: ClosingTimeThresholds,
) {
  const coveredAssignmentIds = new Set([
    ...coverageBookings.filter(isCompletedWorkBooking).map((booking) => booking.assignmentId),
    ...approvedAbsences.map((absence) => absence.assignmentId),
  ]);
  const bookingsByPerson = ruleBookingsByPerson(ruleBookings, periodStart, periodEnd);
  return {
    missingBookings: Math.max(appointmentCount - coveredAssignmentIds.size, 0),
    bookingGaps: bookingGapCount(bookingsByPerson),
    ruleViolations: ruleViolationCount(ruleBookings, bookingsByPerson, periodId, timeThresholds),
  };
}
