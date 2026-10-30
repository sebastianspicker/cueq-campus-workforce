import { WorkflowType } from '@cueq/database';
import { describe, expect, it, vi } from 'vitest';
import { prepareDecisionGuards } from './workflow-decision-guards.helper.js';
import type { WorkflowDecisionGuardContext } from './workflow-decision-guards.helper.js';

const ids = {
  actor: 'c00000000000000000000001',
  booking: 'c00000000000000000000002',
  person: 'c00000000000000000000003',
  workflow: 'c00000000000000000000005',
  assignment: 'c00000000000000000000007',
  organizationUnit: 'c00000000000000000000008',
};
const booking = {
  personId: ids.person,
  assignmentId: ids.assignment,
  startTime: new Date('2026-10-01T08:00:00.000Z'),
  endTime: new Date('2026-10-01T12:00:00.000Z'),
};

describe('prepareDecisionGuards', () => {
  it('guards a booking-correction approval from the payload as stored at creation', async () => {
    // Same shape as WorkflowCreationHelper.createBookingCorrection stores: no reason field.
    const requestPayload = {
      bookingId: ids.booking,
      assignmentId: ids.assignment,
      startTime: '2026-10-01T07:30:00.000Z',
    };
    const tx = {
      workflowInstance: {
        findUnique: vi.fn().mockResolvedValue({
          assignmentId: ids.assignment,
          type: WorkflowType.BOOKING_CORRECTION,
          entityType: 'Booking',
          entityId: ids.booking,
          requestPayload,
        }),
      },
      booking: { findUnique: vi.fn().mockResolvedValue(booking) },
      $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
    };
    const closingLockHelper = {
      assertClosingPeriodUnlockedForRangeInTransaction: vi.fn().mockResolvedValue(undefined),
    };
    const assignmentHelper = {
      resolveInterval: vi.fn().mockResolvedValue({ organizationUnitId: ids.organizationUnit }),
      assertUnchanged: vi.fn().mockResolvedValue(undefined),
    };
    const recordBlockedAttempt = vi.fn();

    const attempt = await prepareDecisionGuards({
      tx: tx as unknown as WorkflowDecisionGuardContext['tx'],
      workflowId: ids.workflow,
      requestedAction: 'APPROVE',
      actorId: ids.actor,
      closingLockHelper,
      assignmentHelper:
        assignmentHelper as unknown as WorkflowDecisionGuardContext['assignmentHelper'],
      recordBlockedAttempt,
    });

    expect(attempt).toEqual(
      expect.objectContaining({ entityType: 'Booking', entityId: ids.booking }),
    );
    expect(closingLockHelper.assertClosingPeriodUnlockedForRangeInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationUnitId: ids.organizationUnit,
        from: new Date('2026-10-01T07:30:00.000Z'),
      }),
      tx,
    );
  });
});
