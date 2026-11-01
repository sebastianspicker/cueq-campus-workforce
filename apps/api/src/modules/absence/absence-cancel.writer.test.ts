import { AbsenceStatus, WorkflowStatus } from '@cueq/database';
import { describe, expect, it, vi } from 'vitest';
import { writeAbsenceCancellation } from './absence-cancel.writer.js';

describe('writeAbsenceCancellation', () => {
  it('keeps the workflow approver and records the cancelling actor in the audit entry', async () => {
    const absence = {
      id: 'absence-1',
      personId: 'person-1',
      assignmentId: 'assignment-1',
      startDate: new Date('2026-03-02T00:00:00.000Z'),
      endDate: new Date('2026-03-03T00:00:00.000Z'),
    };
    const tx = {
      absence: {
        findUnique: vi.fn().mockResolvedValue({ ...absence, status: AbsenceStatus.APPROVED }),
        update: vi.fn().mockResolvedValue({ ...absence, status: AbsenceStatus.CANCELLED }),
      },
      workflowInstance: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
    };
    const auditHelper = { appendAudit: vi.fn().mockResolvedValue(undefined) };

    await writeAbsenceCancellation(tx as never, {
      actorId: 'actor-1',
      absence,
      resolved: {} as never,
      assignmentHelper: {
        assertUnchanged: vi.fn().mockResolvedValue({ assignment: { id: 'assignment-1' } }),
      },
      assertClosingUnlocked: vi.fn().mockResolvedValue(undefined),
      auditHelper,
    });

    const { data } = tx.workflowInstance.updateMany.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data.status).toBe(WorkflowStatus.CANCELLED);
    expect(data).not.toHaveProperty('approverId');
    expect(auditHelper.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ABSENCE_CANCELLED',
        after: expect.objectContaining({ cancelledBy: 'actor-1' }),
      }),
      tx,
    );
  });
});
