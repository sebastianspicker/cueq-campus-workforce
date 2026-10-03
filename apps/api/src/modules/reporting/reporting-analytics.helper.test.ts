import { ForbiddenException } from '@nestjs/common';
import { Role } from '@cueq/database';
import { describe, expect, it, vi } from 'vitest';
import { ReportingAnalyticsHelper } from './reporting-analytics.helper.js';
import { customReportOptions } from './custom-report.helper.js';

describe('exact overtime report authorization', () => {
  it('omits overtime types and metrics from aggregate-only custom report options', () => {
    expect(customReportOptions(false)).toMatchObject({
      reportTypes: ['TEAM_ABSENCE', 'CLOSING_COMPLETION'],
      metrics: ['requests', 'days', 'completionRate', 'exported'],
    });
    expect(customReportOptions(true).reportTypes).toContain('OE_OVERTIME');
  });

  it('rejects aggregate-only roles before any database or person lookup', async () => {
    const prisma = { $queryRaw: vi.fn() };
    const personHelper = { personForUser: vi.fn() };
    const helper = new ReportingAnalyticsHelper(
      prisma as never,
      { appendAudit: vi.fn() } as never,
      personHelper as never,
      { minGroupSize: () => 5 } as never,
    );

    await expect(
      helper.reportOeOvertime(
        { subject: 'lead', email: 'lead@example.test', role: Role.TEAM_LEAD, claims: {} },
        { from: '2026-03-01', to: '2026-03-31' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(personHelper.personForUser).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
