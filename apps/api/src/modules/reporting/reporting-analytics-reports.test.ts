import { Role } from '@cueq/database';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { AuditHelper } from '../audit/public.js';
import type { PersonHelper } from '../people/public.js';
import { reportOeOvertime, reportTeamAbsence } from './reporting-analytics-reports.helper.js';
import type { ReportingComplianceHelper } from './reporting-compliance.helper.js';

describe('reporting aggregation', () => {
  it('uses one effective-appointment aggregate and a distinct-person overtime population', async () => {
    const rawQueries: Array<{ sql: string; values: unknown[] }> = [];
    const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      rawQueries.push({ sql: strings.join('?'), values });
      return [
        {
          people: 6,
          totalBalanceHours: '30.03',
          totalOvertimeHours: '12.12',
          invalidAccounts: 0,
        },
      ];
    });
    const appendAudit = vi.fn(async () => undefined);

    const result = await reportOeOvertime(
      {
        prisma: { $queryRaw: queryRaw } as unknown as PrismaService,
        auditHelper: { appendAudit } as unknown as AuditHelper,
        personHelper: {
          personForUser: async () => ({ id: 'actor', organizationUnitId: 'ou-1' }),
        } as unknown as PersonHelper,
        complianceHelper: { minGroupSize: () => 5 } as ReportingComplianceHelper,
      },
      {
        subject: 'actor-user',
        email: 'actor@example.test',
        role: Role.HR,
        claims: {},
      },
      { from: '2026-01-01', to: '2026-01-31' },
    );

    expect(result).toMatchObject({
      suppression: { suppressed: false, population: 6 },
      totals: {
        people: 6,
        totalBalanceHours: 30.03,
        totalOvertimeHours: 12.12,
        avgBalanceHours: 5,
      },
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(rawQueries[0]?.sql).toContain('COUNT(DISTINCT "personId") FILTER (WHERE eligible)');
    expect(rawQueries[0]?.sql).toContain('FROM "employment_terms" AS term');
    expect(rawQueries[0]?.sql).toContain('term."effectiveTo" >= account."periodEnd"');
    expect(rawQueries[0]?.sql).not.toContain('person."organizationUnitId"');
    expect(rawQueries[0]?.values).toHaveLength(4);
    expect(appendAudit).toHaveBeenCalledTimes(1);
  });

  it('requires reconciliation instead of allocating one account across term boundaries', async () => {
    const queryRaw = vi.fn(async () => [
      {
        people: 0,
        totalBalanceHours: 0,
        totalOvertimeHours: 0,
        invalidAccounts: 1,
      },
    ]);
    const appendAudit = vi.fn(async () => undefined);

    await expect(
      reportOeOvertime(
        {
          prisma: { $queryRaw: queryRaw } as unknown as PrismaService,
          auditHelper: { appendAudit } as unknown as AuditHelper,
          personHelper: {
            personForUser: async () => ({ id: 'actor', organizationUnitId: 'ou-1' }),
          } as unknown as PersonHelper,
          complianceHelper: { minGroupSize: () => 5 } as ReportingComplianceHelper,
        },
        {
          subject: 'actor-user',
          email: 'actor@example.test',
          role: Role.HR,
          claims: {},
        },
        { from: '2026-01-01', to: '2026-01-31' },
      ),
    ).rejects.toMatchObject({
      response: { code: 'TIME_ACCOUNT_RECONCILIATION_REQUIRED' },
    });
    expect(appendAudit).not.toHaveBeenCalled();
  });

  const absenceRow = (
    personId: string,
    type: string,
    startDate: string,
    endDate: string,
    days: string,
  ) => ({
    personId,
    type,
    startDate: new Date(`${startDate}T00:00:00Z`),
    endDate: new Date(`${endDate}T00:00:00Z`),
    days,
    workingDays: [1, 2, 3, 4, 5],
    holidayDates: [],
  });

  async function teamAbsence(absences: ReturnType<typeof absenceRow>[], people = 5) {
    const rawQueries: Array<{ sql: string; values: unknown[] }> = [];
    const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      rawQueries.push({ sql, values });
      return sql.includes('COUNT(DISTINCT assignment."personId")') ? [{ people }] : absences;
    });
    const appendAudit = vi.fn(async () => undefined);
    const result = await reportTeamAbsence(
      {
        prisma: { $queryRaw: queryRaw } as unknown as PrismaService,
        auditHelper: { appendAudit } as unknown as AuditHelper,
        personHelper: {
          personForUser: async () => ({ id: 'actor', organizationUnitId: 'ou-1' }),
        } as unknown as PersonHelper,
        complianceHelper: { minGroupSize: () => 5 } as ReportingComplianceHelper,
      },
      { subject: 'actor-user', email: 'actor@example.test', role: Role.HR, claims: {} },
      { from: '2026-01-01', to: '2026-01-31' },
    );
    return { result, rawQueries, appendAudit };
  }

  it('uses distinct people for privacy and attributes absences through their appointment terms', async () => {
    const { result, rawQueries, appendAudit } = await teamAbsence([
      absenceRow('p1', 'SICK', '2026-01-05', '2026-01-05', '0.10'),
      absenceRow('p2', 'VACATION', '2026-01-12', '2026-01-14', '1.25'),
      absenceRow('p3', 'SICK', '2026-01-06', '2026-01-06', '0.20'),
      absenceRow('p4', 'SICK', '2026-01-19', '2026-01-19', '0.30'),
      absenceRow('p5', 'VACATION', '2026-01-20', '2026-01-20', '0.15'),
    ]);

    expect(result).toMatchObject({
      suppression: { suppressed: false, population: 5 },
      totals: { requests: 5, days: 2 },
      buckets: [
        { type: 'SICK', requests: 3, days: 0.6 },
        { type: 'VACATION', requests: 2, days: 1.4 },
      ],
    });
    expect(rawQueries[0]?.sql).toContain('COUNT(DISTINCT assignment."personId")');
    // Headcount uses the same time-tracked population as time accounts and closing.
    expect(rawQueries[0]?.values).toContainEqual(['EMPLOYEE', 'SHIFT_PLANNER']);
    expect(rawQueries[1]?.sql).toContain('term."assignmentId" = absence."assignmentId"');
    expect(rawQueries[1]?.sql).toContain('other_term."organizationUnitId" <>');
    expect(rawQueries[1]?.sql).toContain(`absence."status"::text = 'APPROVED'`);
    expect(appendAudit).toHaveBeenCalledTimes(1);
  });

  it('counts only working days inside the report window for a cross-month absence', async () => {
    // Thu 29 Jan - Tue 3 Feb: Thu and Fri fall in January.
    const rows = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) =>
      absenceRow(id, 'VACATION', '2026-01-29', '2026-02-03', '4'),
    );
    const { result } = await teamAbsence(rows);
    expect(result.totals).toEqual({ requests: 5, days: 10 });
    expect(result.buckets).toEqual([{ type: 'VACATION', requests: 5, days: 10 }]);
  });

  it('suppresses totals when fewer people than the minimum group contributed', async () => {
    const { result, appendAudit } = await teamAbsence(
      [absenceRow('p1', 'SICK', '2026-01-05', '2026-01-05', '1')],
      5,
    );
    expect(result.suppression).toMatchObject({ suppressed: true, population: 5 });
    expect(result.totals).toEqual({ requests: 0, days: 0 });
    expect(result.buckets).toEqual([]);
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ after: expect.objectContaining({ suppressed: true }) }),
    );
  });
});
