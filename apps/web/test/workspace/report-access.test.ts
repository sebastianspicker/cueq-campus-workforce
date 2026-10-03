import { describe, expect, it } from 'vitest';
import {
  canLoadExactOvertimeReport,
  canLoadSensitiveReportSummaries,
} from '../../src/app/[locale]/reports/report-access.js';

describe('report access hints', () => {
  it('loads exact overtime only for roles with individual time-account access', () => {
    expect(canLoadExactOvertimeReport('HR')).toBe(true);
    expect(canLoadExactOvertimeReport('ADMIN')).toBe(true);
    expect(canLoadExactOvertimeReport('TEAM_LEAD')).toBe(false);
    expect(canLoadExactOvertimeReport('DATA_PROTECTION')).toBe(false);
    expect(canLoadExactOvertimeReport('WORKS_COUNCIL')).toBe(false);
  });

  it('keeps non-overtime sensitive summaries available to their existing roles', () => {
    expect(canLoadSensitiveReportSummaries('DATA_PROTECTION')).toBe(true);
    expect(canLoadSensitiveReportSummaries('TEAM_LEAD')).toBe(false);
  });
});
