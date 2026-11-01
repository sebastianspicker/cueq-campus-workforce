import { describe, expect, it } from 'vitest';
import { Role, WorkflowStatus, WorkflowType, type WorkflowInstance } from '@cueq/database';
import { availableWorkflowActions, mayViewWorkflowReason } from './workflow-action-visibility.js';

const workflow = {
  id: 'w1',
  type: WorkflowType.LEAVE_REQUEST,
  status: WorkflowStatus.PENDING,
  requesterId: 'u1',
  approverId: 'u1',
} as WorkflowInstance;

describe('workflow action visibility', () => {
  it('offers no approval to the requester even when they are the approver', () => {
    const actions = availableWorkflowActions(workflow, {
      id: 'u1',
      role: Role.TEAM_LEAD,
      organizationUnitId: 'unit-a',
    });
    expect(actions).toEqual(['CANCEL']);
  });

  it('offers approval to a distinct approver', () => {
    const actions = availableWorkflowActions(
      { ...workflow, approverId: 'u2' },
      { id: 'u2', role: Role.TEAM_LEAD, organizationUnitId: 'unit-a' },
    );
    expect(actions).toEqual(['APPROVE', 'REJECT', 'DELEGATE']);
  });

  it('does not expose reasons to arbitrary team leads', () => {
    const actor = { id: 'u3', role: Role.TEAM_LEAD, organizationUnitId: 'unit-b' };
    const other = { ...workflow, approverId: 'u2' };
    expect(mayViewWorkflowReason(other, actor)).toBe(false);
    expect(mayViewWorkflowReason(other, { ...actor, role: Role.HR })).toBe(true);
  });
});
