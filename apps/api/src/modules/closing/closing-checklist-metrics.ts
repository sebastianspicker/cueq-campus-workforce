/** Queries transaction-scoped data for deterministic closing-checklist metrics. */
import {
  AbsenceStatus,
  TimeTypeCategory,
  WorkflowStatus,
  WorkflowType,
  type ClosingStatus,
} from '@cueq/database';
import type { ChecklistFinding } from '@cueq/domain';
import { BookingCorrectionPayloadSchema } from '@cueq/contracts';
import type { PrismaService } from '../../persistence/prisma.service.js';
import {
  buildRosterPlanVsActualFromBookings,
  type PlanVsActualBooking,
  type RosterWithPlanShifts,
} from '../../application/roster/plan-vs-actual-coverage.js';
import {
  calculateClosingBookingMetrics,
  MAX_CHECKLIST_FINDINGS,
  type ClosingChecklistBooking,
  type ClosingTimeThresholds,
} from './closing-checklist-rules.js';
import { closingBalanceAnomalyHours } from './closing-config.js';
import type { TimeAccountsPort } from '../attendance/public.js';
import { TIME_TRACKED_ROLES } from '../people/public.js';

export type ClosingDb = Pick<
  PrismaService,
  | '$queryRaw'
  | 'closingPeriod'
  | 'employmentAssignment'
  | 'employmentTerm'
  | 'person'
  | 'booking'
  | 'absence'
  | 'workflowInstance'
  | 'roster'
  | 'timeAccount'
  | 'domainEventOutbox'
>;

export type ChecklistPeriod = {
  id: string;
  status: ClosingStatus;
  organizationUnitId: string | null;
  periodStart: Date;
  periodEnd: Date;
};

export async function calculateClosingChecklistMetrics(
  db: ClosingDb,
  period: ChecklistPeriod,
  getActiveThresholds: () => Promise<ClosingTimeThresholds>,
  timeAccounts: Pick<TimeAccountsPort, 'listMissingForClosing'>,
) {
  const [population, timeThresholds] = await Promise.all([
    closingPopulation(db, period),
    getActiveThresholds(),
  ]);
  const { ruleBookings, coverageBookings, approvedAbsences } = await closingBookingsAndAbsences(
    db,
    period,
    population,
  );
  const bookingMetrics = calculateClosingBookingMetrics(
    ruleBookings,
    coverageBookings,
    approvedAbsences,
    population.assignmentIds.length,
    period.id,
    period.periodStart,
    period.periodEnd,
    timeThresholds,
    population.appointments,
  );
  const { findings: bookingFindings, ...bookingCounts } = bookingMetrics;
  const [requests, rosterMismatches, balanceAnomalies, missingAccounts] = await Promise.all([
    openRequestCounts(db, period, population.appointments, ruleBookings),
    rosterMismatchCount(db, period),
    balanceAnomalyCount(db, period, population.assignmentIds),
    timeAccounts.listMissingForClosing(db, period),
  ]);
  const { openCorrectionFindings, ...requestCounts } = requests;
  const findings = await withPersonNames(db, {
    MISSING_TIME_ACCOUNTS: missingAccounts.slice(0, MAX_CHECKLIST_FINDINGS).map(
      (account): ChecklistFinding => ({
        reason: account.reason,
        message: MISSING_ACCOUNT_MESSAGES[account.reason],
        personId: account.personId,
        assignmentId: account.assignmentId,
        from: account.periodStart.toISOString(),
        to: account.periodEnd.toISOString(),
      }),
    ),
    MISSING_BOOKINGS: bookingFindings.MISSING_BOOKINGS,
    OPEN_CORRECTIONS: openCorrectionFindings,
    RULE_VIOLATIONS: bookingFindings.RULE_VIOLATIONS,
  });
  return {
    metrics: {
      ...bookingCounts,
      ...requestCounts,
      rosterMismatches,
      balanceAnomalies,
      missingTimeAccounts: missingAccounts.length,
    },
    findings,
  };
}

const MISSING_ACCOUNT_MESSAGES = {
  NO_ACCOUNT: 'No time account exists for this appointment interval.',
  OUTDATED_ACCOUNT: 'The stored time account no longer matches the recalculated hours.',
  INCOMPATIBLE_ACCOUNT:
    'An existing time account has boundaries incompatible with the appointment.',
} as const;

/** Adds `personName` to every finding with a person id using one batched person lookup. */
async function withPersonNames(
  db: ClosingDb,
  findings: Record<string, ChecklistFinding[]>,
): Promise<Record<string, ChecklistFinding[]>> {
  const personIds = [
    ...new Set(
      Object.values(findings).flatMap((list) =>
        list.flatMap((finding) => (finding.personId ? [finding.personId] : [])),
      ),
    ),
  ];
  if (personIds.length === 0) return findings;

  const people = await db.person.findMany({
    where: { id: { in: personIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const names = new Map(
    people.map((person) => [person.id, `${person.firstName} ${person.lastName}`]),
  );
  return Object.fromEntries(
    Object.entries(findings).map(([code, list]) => [
      code,
      list.map((finding) => {
        const personName = finding.personId ? names.get(finding.personId) : undefined;
        return personName ? { ...finding, personName } : finding;
      }),
    ]),
  );
}

/**
 * Loads the terms of many appointments in one query and resolves the organization unit of an
 * instant in memory, instead of one term query per booking or absence.
 */
async function organizationUnitResolver(
  db: ClosingDb,
  assignmentIds: Iterable<string>,
  from: Date,
  to: Date,
): Promise<(assignmentId: string, at: Date) => string | undefined> {
  const ids = [...new Set(assignmentIds)];
  const terms = ids.length
    ? await db.employmentTerm.findMany({
        where: {
          assignmentId: { in: ids },
          AND: [
            { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: to } }] },
            { OR: [{ effectiveTo: null }, { effectiveTo: { gt: from } }] },
          ],
        },
        select: {
          assignmentId: true,
          organizationUnitId: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      })
    : [];
  const byAssignment = new Map<string, typeof terms>();
  for (const term of terms) {
    const list = byAssignment.get(term.assignmentId) ?? [];
    list.push(term);
    byAssignment.set(term.assignmentId, list);
  }
  return (assignmentId, instant) => {
    // Records that start before the window count with the unit in effect at its start.
    const at = instant < from ? from : instant;
    return byAssignment
      .get(assignmentId)
      ?.find(
        (term) =>
          (!term.effectiveFrom || term.effectiveFrom <= at) &&
          (!term.effectiveTo || at < term.effectiveTo),
      )?.organizationUnitId;
  };
}

/** True when the appointment belongs to the period's unit at that instant (always for global periods). */
async function unitResolverForPeriod(
  db: ClosingDb,
  period: ChecklistPeriod,
  assignmentIds: string[],
): Promise<(assignmentId: string, at: Date) => boolean> {
  if (!period.organizationUnitId) return () => true;
  const unitAt = await organizationUnitResolver(
    db,
    assignmentIds,
    period.periodStart,
    period.periodEnd,
  );
  return (assignmentId, at) => unitAt(assignmentId, at) === period.organizationUnitId;
}

type ClosingPopulation = {
  personIds: string[];
  assignmentIds: string[];
  appointments: Array<{ personId: string; assignmentId: string }>;
};

async function closingPopulation(
  db: ClosingDb,
  period: ChecklistPeriod,
): Promise<ClosingPopulation> {
  const assignments = await db.employmentAssignment.findMany({
    where: {
      person: { role: { in: TIME_TRACKED_ROLES } },
      AND: [
        { OR: [{ employmentStartDate: null }, { employmentStartDate: { lte: period.periodEnd } }] },
        { OR: [{ employmentEndDate: null }, { employmentEndDate: { gte: period.periodStart } }] },
      ],
      terms: {
        some: {
          organizationUnitId: period.organizationUnitId ?? undefined,
          AND: [
            { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: period.periodEnd } }] },
            { OR: [{ effectiveTo: null }, { effectiveTo: { gt: period.periodStart } }] },
          ],
        },
      },
    },
    select: { id: true, personId: true },
    orderBy: [{ personId: 'asc' }, { id: 'asc' }],
  });
  return {
    assignmentIds: assignments.map((assignment) => assignment.id),
    personIds: [...new Set(assignments.map((assignment) => assignment.personId))],
    appointments: assignments.map((assignment) => ({
      personId: assignment.personId,
      assignmentId: assignment.id,
    })),
  };
}

async function closingBookingsAndAbsences(
  db: ClosingDb,
  period: ChecklistPeriod,
  population: ClosingPopulation,
): Promise<{
  ruleBookings: ClosingChecklistBooking[];
  coverageBookings: ClosingChecklistBooking[];
  approvedAbsences: Array<{ assignmentId: string }>;
}> {
  if (population.personIds.length === 0) {
    return { ruleBookings: [], coverageBookings: [], approvedAbsences: [] };
  }

  const [ruleBookings, absences] = await Promise.all([
    db.booking.findMany({
      where: {
        personId: { in: population.personIds },
        startTime: { lte: period.periodEnd },
        OR: [{ endTime: null }, { endTime: { gte: period.periodStart } }],
      },
      select: {
        id: true,
        personId: true,
        assignmentId: true,
        startTime: true,
        endTime: true,
        timeType: { select: { category: true } },
      },
      orderBy: [{ personId: 'asc' }, { startTime: 'asc' }],
    }),
    db.absence.findMany({
      where: {
        assignmentId: { in: population.assignmentIds },
        status: AbsenceStatus.APPROVED,
        startDate: { lte: period.periodEnd },
        endDate: { gte: period.periodStart },
      },
      select: { personId: true, assignmentId: true, startDate: true, endDate: true },
      orderBy: [{ personId: 'asc' }, { assignmentId: 'asc' }, { startDate: 'asc' }],
    }),
  ]);

  const assignmentIds = new Set(population.assignmentIds);
  const unitAt = await unitResolverForPeriod(db, period, population.assignmentIds);
  const coverageBookings = ruleBookings.filter(
    (booking) =>
      booking.endTime &&
      assignmentIds.has(booking.assignmentId) &&
      unitAt(booking.assignmentId, booking.startTime),
  );
  const approvedAbsences = absences
    .filter((absence) => unitAt(absence.assignmentId, absence.startDate))
    .map((absence) => ({ assignmentId: absence.assignmentId }));

  return { ruleBookings, coverageBookings, approvedAbsences };
}

async function openRequestCounts(
  db: ClosingDb,
  period: ChecklistPeriod,
  appointments: ClosingPopulation['appointments'],
  periodBookings: Array<{ id: string; assignmentId: string; startTime: Date }>,
) {
  const assignmentIds = appointments.map((appointment) => appointment.assignmentId);
  if (assignmentIds.length === 0) {
    return Promise.resolve({
      openCorrectionRequests: 0,
      openLeaveRequests: 0,
      openCorrectionFindings: [] as ChecklistFinding[],
    });
  }

  const [openCorrectionWorkflows, requestedAbsences] = await Promise.all([
    db.workflowInstance.findMany({
      where: {
        type: WorkflowType.BOOKING_CORRECTION,
        status: {
          in: [WorkflowStatus.SUBMITTED, WorkflowStatus.PENDING, WorkflowStatus.ESCALATED],
        },
        assignmentId: { in: assignmentIds },
      },
      select: { id: true, assignmentId: true, entityId: true, requestPayload: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    db.absence.findMany({
      where: {
        assignmentId: { in: assignmentIds },
        status: AbsenceStatus.REQUESTED,
        startDate: { lte: period.periodEnd },
        endDate: { gte: period.periodStart },
      },
      select: { personId: true, assignmentId: true, startDate: true, endDate: true },
    }),
  ]);
  const unitAt = await unitResolverForPeriod(db, period, assignmentIds);
  const openLeaveRequests = requestedAbsences.filter((absence) =>
    unitAt(absence.assignmentId, absence.startDate),
  ).length;
  // A correction belongs to the period of the booking it corrects or of its requested new start.
  const inPeriod = (instant: Date) => instant >= period.periodStart && instant <= period.periodEnd;
  const periodBookingIds = new Set(
    periodBookings.filter((booking) => inPeriod(booking.startTime)).map((booking) => booking.id),
  );
  const openCorrections = openCorrectionWorkflows.filter((workflow) => {
    if (periodBookingIds.has(workflow.entityId)) return true;
    const payload = BookingCorrectionPayloadSchema.safeParse(workflow.requestPayload);
    return Boolean(
      payload.success && payload.data.startTime && inPeriod(new Date(payload.data.startTime)),
    );
  });
  // The appointment owner, not the requester: HR may file corrections on someone's behalf.
  const ownerByAssignment = new Map(
    appointments.map((appointment) => [appointment.assignmentId, appointment.personId]),
  );
  const openCorrectionFindings = openCorrections.slice(0, MAX_CHECKLIST_FINDINGS).map(
    (workflow): ChecklistFinding => ({
      reason: 'OPEN_CORRECTION',
      message: 'Booking correction request is still open.',
      personId: workflow.assignmentId ? ownerByAssignment.get(workflow.assignmentId) : undefined,
      workflowId: workflow.id,
      bookingId: workflow.entityId,
    }),
  );
  return {
    openCorrectionRequests: openCorrections.length,
    openLeaveRequests,
    openCorrectionFindings,
  };
}

async function rosterMismatchCount(db: ClosingDb, period: ChecklistPeriod): Promise<number> {
  const rosters = await db.roster.findMany({
    where: {
      periodStart: { lte: period.periodEnd },
      periodEnd: { gte: period.periodStart },
      organizationUnitId: period.organizationUnitId ?? undefined,
    },
    include: { shifts: { include: { assignments: { select: { personId: true } } } } },
  });
  if (rosters.length === 0) return 0;

  const organizationUnitIds = [...new Set(rosters.map((roster) => roster.organizationUnitId))];
  const earliestRosterStart = new Date(
    Math.min(...rosters.map((roster) => roster.periodStart.getTime())),
  );
  const latestRosterEnd = new Date(
    Math.max(...rosters.map((roster) => roster.periodEnd.getTime())),
  );

  const bookings = await db.booking.findMany({
    where: {
      assignment: {
        terms: {
          some: {
            organizationUnitId: { in: organizationUnitIds },
            AND: [
              { OR: [{ effectiveFrom: null }, { effectiveFrom: { lt: latestRosterEnd } }] },
              { OR: [{ effectiveTo: null }, { effectiveTo: { gt: earliestRosterStart } }] },
            ],
          },
        },
      },
      timeType: {
        category: {
          in: [TimeTypeCategory.WORK, TimeTypeCategory.DEPLOYMENT],
        },
      },
      startTime: { lt: latestRosterEnd },
      OR: [
        { endTime: { gt: earliestRosterStart } },
        { endTime: null, startTime: { gte: earliestRosterStart } },
      ],
    },
    select: {
      personId: true,
      assignmentId: true,
      startTime: true,
      endTime: true,
      timeType: { select: { category: true } },
    },
  });
  const unitAt = await organizationUnitResolver(
    db,
    bookings.map((booking) => booking.assignmentId),
    earliestRosterStart,
    latestRosterEnd,
  );
  const bookingsByOrganizationUnit = new Map<string, PlanVsActualBooking[]>();
  for (const booking of bookings) {
    if (!booking.endTime) continue;
    const organizationUnitId = unitAt(booking.assignmentId, booking.startTime);
    if (!organizationUnitId) continue;
    const organizationBookings = bookingsByOrganizationUnit.get(organizationUnitId) ?? [];
    organizationBookings.push(booking);
    bookingsByOrganizationUnit.set(organizationUnitId, organizationBookings);
  }
  const coverage = rosters.map((roster) =>
    buildRosterPlanVsActualFromBookings(
      roster,
      (bookingsByOrganizationUnit.get(roster.organizationUnitId) ?? []).filter((booking) =>
        overlapsRosterPeriod(booking, roster),
      ),
    ),
  );
  return coverage.reduce((sum, entry) => sum + entry.mismatchedSlots, 0);
}

function overlapsRosterPeriod(booking: PlanVsActualBooking, roster: RosterWithPlanShifts): boolean {
  return (
    booking.startTime < roster.periodEnd &&
    (booking.endTime
      ? booking.endTime > roster.periodStart
      : booking.startTime >= roster.periodStart)
  );
}

function balanceAnomalyCount(
  db: ClosingDb,
  period: ChecklistPeriod,
  assignmentIds: string[],
): Promise<number> {
  if (assignmentIds.length === 0) return Promise.resolve(0);

  const threshold = closingBalanceAnomalyHours();
  return db.timeAccount.count({
    where: {
      assignmentId: { in: assignmentIds },
      periodStart: { gte: period.periodStart },
      periodEnd: { lte: period.periodEnd },
      OR: [{ balance: { gt: threshold } }, { balance: { lt: -threshold } }],
    },
  });
}
