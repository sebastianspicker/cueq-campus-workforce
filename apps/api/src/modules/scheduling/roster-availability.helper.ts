/** Blocks shift assignment to people on approved leave or without the minimum rest period. */
import { ConflictException } from '@nestjs/common';
import { AbsenceStatus, type Prisma } from '@cueq/database';
import { evaluateShiftCompliance } from '@cueq/domain';
import { berlinDayBounds } from '../attendance/public.js';

type ShiftWindow = { id: string; startTime: Date; endTime: Date; shiftType: string };

function restDeficit(shift: ShiftWindow, previousShiftEnd: Date) {
  return evaluateShiftCompliance({
    shift: {
      type: shift.shiftType,
      start: shift.startTime.toISOString(),
      end: shift.endTime.toISOString(),
    },
    previousShiftEnd: previousShiftEnd.toISOString(),
    recordedBreakMinutes: 0,
  }).violations.find((violation) => violation.code === 'REST_HOURS_DEFICIT');
}

const DAY_MS = 86_400_000;
// Absence dates are inclusive calendar days stored at UTC midnight; noon UTC lies inside the Berlin day.
const berlinDayOf = (date: Date) => berlinDayBounds(new Date(date.getTime() + DAY_MS / 2));
// ArbZG rest applies between working days, so parts of one Berlin day are not checked against each other.
const sameBerlinDay = (a: Date, b: Date) =>
  berlinDayBounds(a).dayStart.getTime() === berlinDayBounds(b).dayStart.getTime();

const NEIGHBOUR_SELECT = {
  shift: { select: { id: true, startTime: true, endTime: true, shiftType: true } },
} as const;

/**
 * Rejects a shift for a person with an APPROVED absence overlapping it, or whose rest to the
 * previous or next assigned shift is below the policy minimum. REQUESTED absences are not checked.
 */
export async function assertPersonAvailableForShift(
  tx: Pick<Prisma.TransactionClient, 'absence' | 'shiftAssignment'>,
  personId: string,
  shift: ShiftWindow,
): Promise<void> {
  // One query with 1 day of slack; the exact Berlin-day overlap is refined in memory.
  const candidates = await tx.absence.findMany({
    where: {
      personId,
      status: AbsenceStatus.APPROVED,
      startDate: { lt: new Date(shift.endTime.getTime() + DAY_MS) },
      endDate: { gt: new Date(shift.startTime.getTime() - 2 * DAY_MS) },
    },
    select: { id: true, startDate: true, endDate: true },
  });
  const absence = candidates.find(
    (candidate) =>
      berlinDayOf(candidate.startDate).dayStart < shift.endTime &&
      berlinDayOf(candidate.endDate).dayEnd > shift.startTime,
  );
  if (absence) {
    throw new ConflictException({
      code: 'ABSENCE_CONFLICT',
      message: 'Person has an approved absence during this shift.',
      absenceId: absence.id,
    });
  }

  const [previous, next] = await Promise.all([
    tx.shiftAssignment.findFirst({
      where: { personId, shift: { id: { not: shift.id }, endTime: { lte: shift.startTime } } },
      orderBy: { shift: { endTime: 'desc' } },
      select: NEIGHBOUR_SELECT,
    }),
    tx.shiftAssignment.findFirst({
      where: { personId, shift: { id: { not: shift.id }, startTime: { gte: shift.endTime } } },
      orderBy: { shift: { startTime: 'asc' } },
      select: NEIGHBOUR_SELECT,
    }),
  ]);
  const deficit =
    (previous &&
      !sameBerlinDay(previous.shift.startTime, shift.startTime) &&
      restDeficit(shift, previous.shift.endTime)) ||
    (next &&
      !sameBerlinDay(next.shift.startTime, shift.startTime) &&
      restDeficit(next.shift, shift.endTime));
  if (deficit) {
    throw new ConflictException({ code: 'REST_PERIOD_VIOLATION', message: deficit.message });
  }
}
