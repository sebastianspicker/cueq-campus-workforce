import { BadRequestException } from '@nestjs/common';
import { WorkflowType } from '@cueq/database';
import { describe, expect, it, vi } from 'vitest';
import { upsertWorkflowPolicy } from './workflow-assignment-policy.js';

describe('workflow policy upsert', () => {
  it('rejects a future activeFrom instead of applying the policy immediately', async () => {
    const $transaction = vi.fn();
    await expect(
      upsertWorkflowPolicy({ $transaction } as never, {} as never, WorkflowType.LEAVE_REQUEST, {
        escalationDeadlineHours: 48,
        escalationRoles: [],
        maxDelegationDepth: 3,
        activeFrom: new Date(Date.now() + 86_400_000).toISOString(),
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect($transaction).not.toHaveBeenCalled();
  });
});
