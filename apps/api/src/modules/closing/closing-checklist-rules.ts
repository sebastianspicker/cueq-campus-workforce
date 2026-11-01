/** Evaluates pure booking-derived metrics for the closing checklist. */
import { TimeTypeCategory } from '@cueq/database';
import { MAX_BOOKING_DURATION_MS } from '@cueq/contracts';
import { evaluateTimeRules, type ChecklistFinding } from '@cueq/domain';
import { DEFAULT_MAX_HOURS_RULE, DEFAULT_REST_RULE } from '@cueq/policy';
import { closingBookingGapMinutes } from './closing-config.js';

/** Maximum findings attached to one checklist item; counts stay uncapped. */
export const MAX_CHECKLIST_FINDINGS = 20;

type ClosingRuleTimeType = 'WORK' | 'DEPLOYMENT' | 'PAUSE';

export type ClosingChecklistBooking = {
  id: string;
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

const berlinDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Counts long gaps within one Europe/Berlin day; overnight and weekend gaps are not gaps. */
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
          closingBookingGapMinutes() &&
        berlinDate.format(previous.endTime) === berlinDate.format(current.startTime)
      ) {
        gaps += 1;
      }
    }
  }
  return gaps;
}

function policyViolations(
  entries: RuleBooking[],
  periodId: string,
  timeThresholds: ClosingTimeThresholds,
) {
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
  ).violations;
}

function ruleViolationFindings(
  bookings: ClosingChecklistBooking[],
  bookingsByPerson: Map<string, RuleBooking[]>,
  periodId: string,
  timeThresholds: ClosingTimeThresholds,
): ChecklistFinding[] {
  const findings: ChecklistFinding[] = [];
  for (const booking of bookings) {
    if (booking.endTime === null) {
      findings.push({
        reason: 'OPEN_BOOKING',
        message: 'Booking has no end time.',
        personId: booking.personId,
        assignmentId: booking.assignmentId,
        bookingId: booking.id,
        from: booking.startTime.toISOString(),
      });
    } else if (booking.endTime.getTime() - booking.startTime.getTime() > MAX_BOOKING_DURATION_MS) {
      findings.push({
        reason: 'OVERSIZED_BOOKING',
        message: 'Booking exceeds the maximum allowed duration.',
        personId: booking.personId,
        assignmentId: booking.assignmentId,
        bookingId: booking.id,
        from: booking.startTime.toISOString(),
        to: booking.endTime.toISOString(),
      });
    }
  }
  for (const [personId, entries] of bookingsByPerson) {
    for (const violation of policyViolations(entries, periodId, timeThresholds)) {
      findings.push({ reason: violation.code, message: violation.message, personId });
    }
  }
  return findings;
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
  appointments: Array<{ personId: string; assignmentId: string }> = [],
) {
  const coveredAssignmentIds = new Set([
    ...coverageBookings.filter(isCompletedWorkBooking).map((booking) => booking.assignmentId),
    ...approvedAbsences.map((absence) => absence.assignmentId),
  ]);
  const bookingsByPerson = ruleBookingsByPerson(ruleBookings, periodStart, periodEnd);
  const ruleFindings = ruleViolationFindings(
    ruleBookings,
    bookingsByPerson,
    periodId,
    timeThresholds,
  );
  // Rules count all of a person's bookings, but booking details are shown only for this unit's appointments.
  const appointmentIds = new Set(appointments.map((appointment) => appointment.assignmentId));
  const visibleRuleFindings = ruleFindings.filter(
    (finding) => !finding.assignmentId || appointmentIds.has(finding.assignmentId),
  );
  return {
    missingBookings: Math.max(appointmentCount - coveredAssignmentIds.size, 0),
    bookingGaps: bookingGapCount(bookingsByPerson),
    ruleViolations: ruleFindings.length,
    findings: {
      MISSING_BOOKINGS: appointments
        .filter((appointment) => !coveredAssignmentIds.has(appointment.assignmentId))
        .map(
          (appointment): ChecklistFinding => ({
            reason: 'NO_BOOKING_OR_ABSENCE',
            message: 'Appointment has no booking and no approved absence in the period.',
            personId: appointment.personId,
            assignmentId: appointment.assignmentId,
          }),
        )
        .slice(0, MAX_CHECKLIST_FINDINGS),
      RULE_VIOLATIONS: visibleRuleFindings.slice(0, MAX_CHECKLIST_FINDINGS),
    },
  };
}
