import { DEFAULT_LEAVE_RULE } from '@cueq/policy';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  afterEach(() => vi.useRealTimers());

  it('defaults year and as-of date to the Berlin date on New Year just after midnight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-31T23:30:00.000Z')); // 00:30 on 1 Jan 2027 in Berlin
    const selectAssignment = vi.fn().mockRejectedValue(new Error('stop after defaults'));
    const helper = new LeaveBalanceHelper(
      {} as never,
      { personForUser: vi.fn().mockResolvedValue({ id: 'person-1' }) } as never,
      { selectAssignment } as never,
    );
    await expect(
      helper.leaveBalance({ role: 'EMPLOYEE' } as AuthenticatedIdentity),
    ).rejects.toThrow('stop after defaults');
    expect(selectAssignment.mock.calls[0]?.[3]).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });
});
