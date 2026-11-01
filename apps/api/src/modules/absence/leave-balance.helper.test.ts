import { DEFAULT_LEAVE_RULE } from '@cueq/policy';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedIdentity } from '../../platform/auth/auth.types.js';
import { LeaveBalanceHelper } from './leave-balance.helper.js';

describe('LeaveBalanceHelper', () => {
  it('charges only days up to the carry-over deadline to carry-over', async () => {
    const term = {
      id: 'term-1',
      effectiveFrom: null,
      effectiveTo: null,
      weeklyHours: 39.83,
      workTimeModel: null,
      workingDays: [1, 2, 3, 4, 5],
      holidayCalendar: { holidayDates: [] },
      employmentGroup: { leavePolicy: DEFAULT_LEAVE_RULE },
    };
    // Mon 30 Mar to Fri 3 Apr 2026 straddles the 31 March deadline: 2 days before, 3 after.
    const leave = {
      startDate: new Date('2026-03-30T00:00:00.000Z'),
      endDate: new Date('2026-04-03T00:00:00.000Z'),
    };
    const prisma = {
      employmentTerm: { findMany: vi.fn().mockResolvedValue([term]) },
      absence: {
        findMany: vi
          .fn()
          .mockImplementation(({ where }: { where: { startDate: { lte: Date } } }) =>
            Promise.resolve(where.startDate.lte.getUTCFullYear() === 2026 ? [leave] : []),
          ),
      },
      leaveAdjustment: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const helper = new LeaveBalanceHelper(
      prisma as never,
      { personForUser: vi.fn().mockResolvedValue({ id: 'person-1' }) } as never,
      {
        selectAssignment: vi.fn().mockResolvedValue({
          id: 'assignment-1',
          employmentStartDate: null,
          employmentEndDate: null,
        }),
      } as never,
    );

    const balance = await helper.leaveBalance(
      {
        subject: 's',
        email: 'a@example.test',
        role: 'EMPLOYEE',
        claims: {},
      } as AuthenticatedIdentity,
      2026,
      '2026-04-30',
    );

    expect(balance.used).toBe(5);
    expect(balance.carriedOverUsed).toBe(2);
  });
});
