import { ClosingStatus, TimeTypeCategory } from '@cueq/database';
import { expect, it, vi } from 'vitest';
import { calculateClosingChecklistMetrics } from './closing-checklist-metrics.js';

it('assigns open corrections to the period of the corrected booking or requested start', async () => {
  const period = {
    id: 'period-1',
    status: ClosingStatus.OPEN,
    organizationUnitId: null,
    periodStart: new Date('2026-03-01T00:00:00.000Z'),
    periodEnd: new Date('2026-03-31T23:59:59.999Z'),
  };
  const workflowFindMany = vi.fn(async () => [
    // Filed in April for a booking on 28 March: belongs to March.
    { id: 'late', assignmentId: 'a1', entityId: 'march-booking', requestPayload: {} },
    // Filed in March for a February booking, keeping February times: not March.
    {
      id: 'february',
      assignmentId: 'a1',
      entityId: 'c00000000000000000000001',
      requestPayload: {
        bookingId: 'c00000000000000000000001',
        startTime: '2026-02-20T08:00:00.000Z',
      },
    },
    // A February booking moved into March: belongs to March.
    {
      id: 'moved',
      assignmentId: 'a1',
      entityId: 'c00000000000000000000002',
      requestPayload: {
        bookingId: 'c00000000000000000000002',
        startTime: '2026-03-05T08:00:00.000Z',
      },
    },
  ]);
  const db = {
    employmentAssignment: { findMany: async () => [{ id: 'a1', personId: 'p1' }] },
    booking: {
      findMany: async () => [
        {
          id: 'march-booking',
          personId: 'p1',
          assignmentId: 'a1',
          startTime: new Date('2026-03-28T08:00:00.000Z'),
          endTime: new Date('2026-03-28T12:00:00.000Z'),
          timeType: { category: TimeTypeCategory.WORK },
        },
      ],
    },
    absence: { findMany: async () => [] },
    workflowInstance: { findMany: workflowFindMany },
    roster: { findMany: async () => [] },
    timeAccount: { count: async () => 0 },
    person: { findMany: async () => [] },
  };

  const { metrics, findings } = await calculateClosingChecklistMetrics(
    db as never,
    period,
    async () => ({ dailyMaxMinutes: 600, minRestMinutes: 660 }),
    { listMissingForClosing: async () => [] },
  );

  expect(metrics.openCorrectionRequests).toBe(2);
  expect(findings.OPEN_CORRECTIONS?.map((finding) => finding.workflowId)).toEqual([
    'late',
    'moved',
  ]);
  expect(workflowFindMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.not.objectContaining({ createdAt: expect.anything() }),
    }),
  );
});
