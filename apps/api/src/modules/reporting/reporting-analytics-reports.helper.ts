/** Executes role-scoped reporting queries with the provider's existing collaborators. */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Role, type ClosingStatus } from '@cueq/database';
import { countAssignmentWorkingDays } from '@cueq/domain';
import {
  ClosingCompletionQuerySchema,
  OeOvertimeQuerySchema,
  TeamAbsenceQuerySchema,
} from '@cueq/contracts';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { AuthenticatedIdentity } from '../../platform/auth/auth.types.js';
import type { AuditHelper } from '../audit/public.js';
import {
  closingCompletionTotalsFromGroups,
  databaseNumber,
  overtimeTotalsFromAggregate,
} from './reporting-analytics-aggregation.helper.js';
import { HR_LIKE_ROLES, TIME_TRACKED_ROLES, type PersonHelper } from '../people/public.js';
import type { ReportingComplianceHelper } from './reporting-compliance.helper.js';

type ReportingAnalyticsCollaborators = {
  prisma: PrismaService;
  auditHelper: AuditHelper;
  personHelper: PersonHelper;
  complianceHelper: ReportingComplianceHelper;
};

type TermAbsence = {
  personId: string;
  type: string;
  startDate: Date;
  endDate: Date;
  days: unknown;
  workingDays: number[];
  holidayDates: string[];
};

/** Only working days inside [from, to] count; fully contained absences keep their stored days. */
function absencesInWindow(absences: TermAbsence[], from: string, to: string) {
  const contributors = new Set<string>();
  const byType = new Map<string, { requests: number; days: number }>();
  for (const absence of absences) {
    const start = absence.startDate.toISOString().slice(0, 10);
    const end = absence.endDate.toISOString().slice(0, 10);
    const days =
      start >= from && end <= to
        ? databaseNumber(absence.days)
        : countAssignmentWorkingDays({
            startDate: start > from ? start : from,
            endDate: end < to ? end : to,
            workingDays: absence.workingDays,
            holidayDates: absence.holidayDates,
          });
    if (days <= 0) continue;
    contributors.add(absence.personId);
    const bucket = byType.get(absence.type) ?? { requests: 0, days: 0 };
    bucket.requests += 1;
    bucket.days += days;
    byType.set(absence.type, bucket);
  }
  return { contributors, byType };
}

export async function reportTeamAbsence(
  { prisma, auditHelper, personHelper, complianceHelper }: ReportingAnalyticsCollaborators,
  user: AuthenticatedIdentity,
  query: unknown,
) {
  const actor = await personHelper.personForUser(user);
  const parsed = TeamAbsenceQuerySchema.parse(query ?? {});
  const targetOuId = parsed.organizationUnitId ?? actor.organizationUnitId;

  if (user.role === Role.TEAM_LEAD && targetOuId !== actor.organizationUnitId) {
    throw new ForbiddenException('Team leads can only access reports for their own unit.');
  }

  const from = new Date(`${parsed.from}T00:00:00.000Z`);
  const to = new Date(`${parsed.to}T23:59:59.000Z`);
  const [populationRow] = await prisma.$queryRaw<Array<{ people: number | bigint }>>`
    SELECT COUNT(DISTINCT assignment."personId")::integer AS "people"
    FROM "employment_assignments" AS assignment
    INNER JOIN "persons" AS person ON person."id" = assignment."personId"
    WHERE person."role"::text = ANY(${TIME_TRACKED_ROLES})
      AND (assignment."employmentStartDate" IS NULL OR assignment."employmentStartDate" <= ${to})
      AND (assignment."employmentEndDate" IS NULL OR assignment."employmentEndDate" >= ${from})
      AND EXISTS (
        SELECT 1
        FROM "employment_terms" AS term
        WHERE term."assignmentId" = assignment."id"
          AND term."organizationUnitId" = ${targetOuId}
          AND (term."effectiveFrom" IS NULL OR term."effectiveFrom" <= ${to})
          AND (term."effectiveTo" IS NULL OR term."effectiveTo" > ${from})
      )
  `;
  const population = databaseNumber(populationRow?.people);
  const minGroupSize = complianceHelper.minGroupSize();
  let suppressed = population < minGroupSize;

  let totals = { requests: 0, days: 0 };
  let buckets: Array<{ type: string; requests: number; days: number }> = [];
  const canViewAbsenceTypeBuckets = HR_LIKE_ROLES.has(user.role);

  if (!suppressed) {
    const absences = await prisma.$queryRaw<TermAbsence[]>`
      SELECT absence."personId" AS "personId",
             absence."type"::text AS "type",
             absence."startDate" AS "startDate",
             absence."endDate" AS "endDate",
             absence."days" AS "days",
             term."workingDays" AS "workingDays",
             calendar."holidayDates" AS "holidayDates"
      FROM "absences" AS absence
      INNER JOIN "employment_terms" AS term
        ON term."assignmentId" = absence."assignmentId"
        AND term."organizationUnitId" = ${targetOuId}
        AND (term."effectiveFrom" IS NULL OR term."effectiveFrom" <= absence."startDate")
        AND (term."effectiveTo" IS NULL OR term."effectiveTo" > absence."startDate")
      INNER JOIN "holiday_calendars" AS calendar ON calendar."id" = term."holidayCalendarId"
      WHERE absence."status"::text = 'APPROVED'
        AND absence."startDate" <= ${to}
        AND absence."endDate" >= ${from}
        AND NOT EXISTS (
          SELECT 1
          FROM "employment_terms" AS other_term
          WHERE other_term."assignmentId" = absence."assignmentId"
            AND other_term."organizationUnitId" <> ${targetOuId}
            AND (other_term."effectiveFrom" IS NULL OR other_term."effectiveFrom" < absence."endDate" + INTERVAL '1 day')
            AND (other_term."effectiveTo" IS NULL OR other_term."effectiveTo" > absence."startDate")
        )
      ORDER BY absence."startDate" ASC, absence."type" ASC, absence."id" ASC
    `;
    const { contributors, byType } = absencesInWindow(absences, parsed.from, parsed.to);
    // Contributors, not headcount, decide whether a total could identify one person.
    suppressed = contributors.size < minGroupSize;
    if (!suppressed) {
      const groups = [...byType.entries()].map(([type, value]) => ({
        type,
        requests: value.requests,
        days: Number(value.days.toFixed(2)),
      }));
      totals = {
        requests: groups.reduce((sum, group) => sum + group.requests, 0),
        days: Number(groups.reduce((sum, group) => sum + group.days, 0).toFixed(2)),
      };
      if (canViewAbsenceTypeBuckets) buckets = groups;
    }
  }

  await auditHelper.appendAudit({
    actorId: actor.id,
    action: 'REPORT_ACCESSED',
    entityType: 'Report',
    entityId: `team-absence:${targetOuId}:${parsed.from}:${parsed.to}`,
    after: {
      report: 'team-absence',
      organizationUnitId: targetOuId,
      suppressed,
      absenceTypeBucketsVisible: canViewAbsenceTypeBuckets && !suppressed,
    },
  });

  return {
    organizationUnitId: targetOuId,
    from: parsed.from,
    to: parsed.to,
    suppression: { suppressed, minGroupSize, population },
    totals,
    buckets,
  };
}

export async function reportOeOvertime(
  { prisma, auditHelper, personHelper, complianceHelper }: ReportingAnalyticsCollaborators,
  user: AuthenticatedIdentity,
  query: unknown,
) {
  const actor = await personHelper.personForUser(user);
  const parsed = OeOvertimeQuerySchema.parse(query ?? {});
  const targetOuId = parsed.organizationUnitId ?? actor.organizationUnitId;

  if (user.role === Role.TEAM_LEAD && targetOuId !== actor.organizationUnitId) {
    throw new ForbiddenException('Team leads can only access reports for their own unit.');
  }

  const from = new Date(`${parsed.from}T00:00:00.000Z`);
  const to = new Date(`${parsed.to}T23:59:59.000Z`);
  const minGroupSize = complianceHelper.minGroupSize();
  const [aggregate] = await prisma.$queryRaw<
    Array<{
      people: number | bigint;
      totalBalanceHours: unknown;
      totalOvertimeHours: unknown;
      invalidAccounts: number | bigint;
    }>
  >`
    WITH candidate_accounts AS (
      SELECT account.*,
             EXISTS (
               SELECT 1
               FROM "employment_terms" AS term
               WHERE term."assignmentId" = account."assignmentId"
                 AND term."organizationUnitId" = ${targetOuId}
                 AND (term."effectiveFrom" IS NULL OR term."effectiveFrom" <= account."periodStart")
                 AND (term."effectiveTo" IS NULL OR term."effectiveTo" >= account."periodEnd")
             ) AS eligible
      FROM "time_accounts" AS account
      WHERE account."periodStart" <= ${to}
        AND account."periodEnd" >= ${from}
        AND EXISTS (
          SELECT 1
          FROM "employment_terms" AS term
          WHERE term."assignmentId" = account."assignmentId"
            AND term."organizationUnitId" = ${targetOuId}
            AND (term."effectiveFrom" IS NULL OR term."effectiveFrom" <= account."periodEnd")
            AND (term."effectiveTo" IS NULL OR term."effectiveTo" > account."periodStart")
        )
    )
    SELECT COUNT(DISTINCT "personId") FILTER (WHERE eligible)::integer AS "people",
           COALESCE(SUM("balance") FILTER (WHERE eligible), 0)::numeric AS "totalBalanceHours",
           COALESCE(SUM("overtimeHours") FILTER (WHERE eligible), 0)::numeric AS "totalOvertimeHours",
           COUNT(*) FILTER (WHERE NOT eligible)::integer AS "invalidAccounts"
    FROM candidate_accounts
  `;
  if (databaseNumber(aggregate?.invalidAccounts) > 0) {
    throw new ConflictException({
      code: 'TIME_ACCOUNT_RECONCILIATION_REQUIRED',
      message:
        'An appointment account crosses an effective-term boundary; split or reconcile it before reporting.',
    });
  }
  const population = databaseNumber(aggregate?.people);
  const suppressed = population < minGroupSize;
  const totals = overtimeTotalsFromAggregate(
    {
      totalBalanceHours: aggregate?.totalBalanceHours ?? 0,
      totalOvertimeHours: aggregate?.totalOvertimeHours ?? 0,
    },
    population,
    suppressed,
  );

  await auditHelper.appendAudit({
    actorId: actor.id,
    action: 'REPORT_ACCESSED',
    entityType: 'Report',
    entityId: `oe-overtime:${targetOuId}:${parsed.from}:${parsed.to}`,
    after: {
      report: 'oe-overtime',
      organizationUnitId: targetOuId,
      suppressed,
    },
  });

  return {
    organizationUnitId: targetOuId,
    from: parsed.from,
    to: parsed.to,
    suppression: { suppressed, minGroupSize, population },
    totals,
  };
}

export async function reportClosingCompletion(
  { prisma, auditHelper, personHelper }: ReportingAnalyticsCollaborators,
  user: AuthenticatedIdentity,
  query: unknown,
) {
  const actor = await personHelper.personForUser(user);
  const parsed = ClosingCompletionQuerySchema.parse(query ?? {});
  const from = new Date(`${parsed.from}T00:00:00.000Z`);
  const to = new Date(`${parsed.to}T23:59:59.000Z`);
  if (
    user.role === Role.TEAM_LEAD &&
    parsed.organizationUnitId &&
    parsed.organizationUnitId !== actor.organizationUnitId
  ) {
    throw new ForbiddenException('Team leads can only access reports for their own unit.');
  }
  const organizationUnitId =
    user.role === Role.TEAM_LEAD ? actor.organizationUnitId : (parsed.organizationUnitId ?? null);

  const periods = organizationUnitId
    ? await prisma.$queryRaw<Array<{ status: ClosingStatus; count: number | bigint }>>`
        SELECT period."status"::text AS "status", COUNT(*)::integer AS "count"
        FROM "closing_periods" AS period
        WHERE period."organizationUnitId" = ${organizationUnitId}
          AND period."periodStart" <= ${to}
          AND period."periodEnd" >= ${from}
        GROUP BY period."status"
        ORDER BY period."status" ASC
      `
    : await prisma.$queryRaw<Array<{ status: ClosingStatus; count: number | bigint }>>`
        SELECT period."status"::text AS "status", COUNT(*)::integer AS "count"
        FROM "closing_periods" AS period
        WHERE period."periodStart" <= ${to}
          AND period."periodEnd" >= ${from}
        GROUP BY period."status"
        ORDER BY period."status" ASC
      `;
  const totals = closingCompletionTotalsFromGroups(periods);

  await auditHelper.appendAudit({
    actorId: actor.id,
    action: 'REPORT_ACCESSED',
    entityType: 'Report',
    entityId: `closing-completion:${parsed.from}:${parsed.to}`,
    after: { report: 'closing-completion', organizationUnitId },
  });

  return { from: parsed.from, to: parsed.to, organizationUnitId, totals };
}
