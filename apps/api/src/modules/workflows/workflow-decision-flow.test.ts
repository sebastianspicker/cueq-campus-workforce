import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role, WorkflowStatus, WorkflowType } from '@cueq/database';
import { transitionWorkflowDecision } from './workflow-decision-transition.helper.js';
import { decideWorkflowSubmission } from './workflow-domain-decision.js';

const baseWorkflow = {
  id: 'w1',
  type: WorkflowType.LEAVE_REQUEST,
  status: WorkflowStatus.PENDING,
  requesterId: 'requester',
  approverId: 'b',
  assignmentId: 'assignment-1',
  delegationTrail: ['a', 'b'],
};

describe('inline delegation depth', () => {
  it('rejects a delegation beyond the policy maxDelegationDepth', async () => {
    const tx = {
      workflowInstance: { findUnique: vi.fn(async () => baseWorkflow) },
      workflowPolicy: { findFirst: vi.fn(async () => ({ maxDelegationDepth: 2 })) },
    };
    const delegationCrud = { validateInlineDelegation: vi.fn() };

    await expect(
      transitionWorkflowDecision(
        {
          prisma: {} as never,
          auditHelper: { appendAudit: vi.fn() },
          delegationCrud,
          lockPersonWrites: vi.fn(),
        },
        {
          actor: { id: 'b', role: Role.TEAM_LEAD, organizationUnitId: 'unit-a' },
          command: { workflowId: 'w1', action: 'DELEGATE', delegateToId: 'c' },
          tx: tx as never,
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(delegationCrud.validateInlineDelegation).not.toHaveBeenCalled();
  });
});

describe('decision authorization order', () => {
  it('answers 403 for the requester before any closing guard or audit work runs', async () => {
    const tx = {
      workflowInstance: {
        findUnique: vi.fn(async () => ({ ...baseWorkflow, approverId: 'requester' })),
      },
    };
    const closingLockHelper = {
      assertClosingPeriodUnlockedForRangeInTransaction: vi.fn(),
      rethrowWithDurableClosingAudit: vi.fn(),
    };
    const sideEffectsHelper = { validatePreApproval: vi.fn() };
    const assignmentHelper = {
      resolveInterval: vi.fn(async () => ({ organizationUnitId: 'unit-a' })),
    };

    await expect(
      decideWorkflowSubmission(
        {
          prisma: { $transaction: async (run: (client: unknown) => unknown) => run(tx) },
          personHelper: { personForUser: vi.fn(async () => ({ id: 'requester' })) },
          assignmentHelper,
          workflowRuntimeService: { normalizeAction: () => 'APPROVE' },
          workflowDecisionService: { decide: vi.fn() },
          sideEffectsHelper,
          closingLockHelper,
        } as never,
        { role: Role.TEAM_LEAD } as never,
        'clh3am5gv0000qzr8w5n6x7y9',
        { action: 'APPROVE' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sideEffectsHelper.validatePreApproval).not.toHaveBeenCalled();
    expect(closingLockHelper.rethrowWithDurableClosingAudit).not.toHaveBeenCalled();
    expect(tx.workflowInstance.findUnique).toHaveBeenCalledTimes(1);
  });
});
