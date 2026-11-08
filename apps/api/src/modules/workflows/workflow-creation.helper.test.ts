import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowCreationHelper } from './workflow-creation.helper.js';

const ids = {
  person: 'c00000000000000000000001',
  assignment: 'c00000000000000000000002',
  account: 'c00000000000000000000003',
  open: 'c00000000000000000000004',
};

function helperWith(openWorkflows: Array<{ id: string; requestPayload: unknown }>) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
    timeAccount: { findFirst: vi.fn().mockResolvedValue({ id: ids.account }) },
    workflowInstance: { findMany: vi.fn().mockResolvedValue(openWorkflows) },
  };
  const runtime = { buildWorkflowAssignment: vi.fn().mockRejectedValue(new Error('not reached')) };
  const helper = new WorkflowCreationHelper(
    { $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)) } as never,
    { personForUser: vi.fn().mockResolvedValue({ id: ids.person }) } as never,
    {
      resolveInterval: vi.fn().mockResolvedValue({
        assignment: { id: ids.assignment },
        organizationUnitId: 'ou',
        supervisorId: null,
      }),
    } as never,
    {} as never,
    runtime as never,
  );
  return { helper, tx, runtime };
}

const request = {
  personId: ids.person,
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-10-31T23:59:59.000Z',
  overtimeHours: 2,
  reason: 'Exam supervision ran late',
};

describe('overtime approval creation', () => {
  it('rejects a second open request for the same account and period', async () => {
    // Same instants, written differently than the new request.
    const { helper, tx, runtime } = helperWith([
      {
        id: ids.open,
        requestPayload: { periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-10-31T23:59:59Z' },
      },
    ]);
    await expect(
      helper.createOvertimeApprovalWorkflow({ role: 'EMPLOYEE' } as never, request),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.workflowInstance.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityId: ids.account, type: 'OVERTIME_APPROVAL' }),
      }),
    );
    expect(runtime.buildWorkflowAssignment).not.toHaveBeenCalled();
  });

  it('allows a request for a different period of the same account', async () => {
    const { helper, runtime } = helperWith([
      {
        id: ids.open,
        requestPayload: { periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-10-15T00:00:00Z' },
      },
    ]);
    await expect(
      helper.createOvertimeApprovalWorkflow({ role: 'EMPLOYEE' } as never, request),
    ).rejects.toThrow('not reached');
    expect(runtime.buildWorkflowAssignment).toHaveBeenCalled();
  });
});
