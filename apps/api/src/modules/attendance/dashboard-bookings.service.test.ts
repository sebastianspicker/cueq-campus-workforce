import { expect, it, vi } from 'vitest';
import { DashboardBookingsService } from './dashboard-bookings.service.js';

it('returns a bounded first page with consistent Berlin-day bounds and authoritative work total', async () => {
  const count = vi.fn(async () => 51);
  const findFirst = vi.fn(async () => ({ id: 'existing' }));
  const now = new Date('2026-03-29T12:00:00Z');
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `booking-${i}`,
      personId: 'person',
      assignmentId: 'assignment',
      timeTypeId: 'work',
      timeType: { code: 'WORK', category: 'WORK' },
      startTime: now,
      endTime: now,
      source: 'WEB',
      note: null,
      shiftId: null,
      createdAt: now,
      updatedAt: now,
    }));
    const list = vi.fn(async () => rows);
    const transaction = vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries));
    const queryRaw = vi.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => [
      { milliseconds: 123_456 },
    ]);
    const prisma = {
      booking: { count, findFirst, findMany: list },
      timeAccount: { findFirst: async () => null },
      timeType: { findFirst: async () => null },
      absence: { findMany: async () => [] },
      $queryRaw: queryRaw,
      $transaction: transaction,
    };
    const people = { personForUser: async () => ({ id: 'person', workTimeModelId: null }) };
    const assignments = {
      resolveInterval: async () => ({
        assignment: { id: 'assignment' },
        term: {
          dailyTargetHours: 8,
          weeklyHours: 40,
          workingDays: [1, 2, 3, 4, 5],
          holidayCalendar: { holidayDates: [] },
          workTimeModel: { name: 'Full time' },
        },
      }),
    };
    const service = new DashboardBookingsService(
      prisma as never,
      people as never,
      assignments as never,
    );
    const result = await service.dashboard({} as never);
    expect(result).toMatchObject({
      todayBookingsCount: 51,
      assignmentId: 'assignment',
      hasFirstBooking: true,
      todayWorkedMilliseconds: 123_456,
      todayTargetHours: 0,
      dayStart: '2026-03-28T23:00:00.000Z',
      dayEnd: '2026-03-29T22:00:00.000Z',
      todayBookings: { items: expect.any(Array), nextCursor: expect.any(String) },
    });
    expect((result as { todayBookings: { items: unknown[] } }).todayBookings.items).toHaveLength(
      50,
    );
    expect(count).toHaveBeenCalledExactlyOnceWith({
      where: {
        personId: 'person',
        assignmentId: 'assignment',
        startTime: {
          gte: new Date('2026-03-28T23:00:00Z'),
          lt: new Date('2026-03-29T22:00:00Z'),
        },
      },
    });
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { personId: 'person', assignmentId: 'assignment' },
      select: { id: true },
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 51,
        where: {
          personId: 'person',
          assignmentId: 'assignment',
          startTime: {
            gte: new Date('2026-03-28T23:00:00Z'),
            lt: new Date('2026-03-29T22:00:00Z'),
          },
        },
      }),
    );
    expect(transaction).toHaveBeenCalledWith(expect.any(Array), {
      isolationLevel: 'RepeatableRead',
    });
    // Worked time counts only work categories and clips bookings to the Berlin day.
    const sql = queryRaw.mock.calls[0]?.[0].join('?') ?? '';
    expect(sql).toContain(`tt."category" IN ('WORK', 'DEPLOYMENT')`);
    expect(sql).toContain('LEAST(COALESCE(b."endTime", ?), ?) - GREATEST(b."startTime", ?)');
    expect(sql).toContain('b."startTime" < ? AND COALESCE(b."endTime", ?) > ?');
  } finally {
    vi.useRealTimers();
  }
});

it('shows no target on a working day covered by an approved absence', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-30T12:00:00Z'));
  try {
    const absenceFindMany = vi.fn(async () => [
      {
        startDate: new Date('2026-03-30T00:00:00.000Z'),
        endDate: new Date('2026-04-03T00:00:00.000Z'),
      },
    ]);
    const prisma = {
      booking: { count: async () => 0, findFirst: async () => null, findMany: async () => [] },
      timeAccount: { findFirst: async () => null },
      timeType: { findFirst: async () => null },
      absence: { findMany: absenceFindMany },
      $queryRaw: async () => [{ milliseconds: 0 }],
      $transaction: async (queries: Promise<unknown>[]) => Promise.all(queries),
    };
    const people = { personForUser: async () => ({ id: 'person' }) };
    const assignments = {
      resolveInterval: async () => ({
        assignment: { id: 'assignment' },
        term: {
          dailyTargetHours: 8,
          weeklyHours: 40,
          workingDays: [1, 2, 3, 4, 5],
          holidayCalendar: { holidayDates: [] },
        },
      }),
    };
    const service = new DashboardBookingsService(
      prisma as never,
      people as never,
      assignments as never,
    );

    await expect(service.dashboard({} as never)).resolves.toMatchObject({ todayTargetHours: 0 });
    expect(absenceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          personId: 'person',
          assignmentId: 'assignment',
          status: 'APPROVED',
          startDate: { lte: new Date('2026-03-30T00:00:00.000Z') },
          endDate: { gte: new Date('2026-03-30T00:00:00.000Z') },
        }),
      }),
    );
  } finally {
    vi.useRealTimers();
  }
});
