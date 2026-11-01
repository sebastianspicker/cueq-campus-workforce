/** Resolves base approvers and sequential delegation chains for workflow submissions. */
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@cueq/database';
import { Role, WorkflowStatus, WorkflowType } from '@cueq/database';
import { resolveDelegation, transitionWorkflow } from '@cueq/domain';
import type { PrismaService } from '../../persistence/prisma.service.js';
import {
  ensureWorkflowPolicyInTransaction,
  WORKFLOW_ROUTING_LOCK_SCOPE,
} from './workflow-assignment-policy.js';
import { lockPolicyReadsShared } from '../../platform/transactions/transaction-lock.helper.js';
import type { WorkflowAssignmentInput, WorkflowAssignmentResult } from './workflow-contracts.js';
import { appendTrail } from './workflow-persistence-normalization.js';
import { isRoleAllowedForType } from './workflow-routing-policy.js';
import { addHours, toIso } from './workflow-time.js';

type PersonStore = Pick<PrismaService, 'person'>;
type DelegationStore = Pick<PrismaService, 'person' | 'workflowDelegationRule'>;

// employmentEndDate is an inclusive date stored at UTC midnight, so the last day still counts all day.
function startOfUtcToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Oldest active person with one of the roles; an undefined unit searches globally, never as fallback. */
export async function firstPersonByRoles(
  roles: Role[],
  organizationUnitId: string | undefined,
  excludeId: string | undefined,
  db: PersonStore,
): Promise<string | null> {
  const person = await db.person.findFirst({
    where: {
      role: { in: roles },
      id: excludeId ? { not: excludeId } : undefined,
      organizationUnitId,
      OR: [{ employmentEndDate: null }, { employmentEndDate: { gte: startOfUtcToday() } }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  return person?.id ?? null;
}

async function isUsablePreferredApprover(
  input: WorkflowAssignmentInput,
  db: PersonStore,
): Promise<boolean> {
  if (!input.preferredApproverId || input.preferredApproverId === input.requesterId) {
    return false;
  }
  const preferred = await db.person.findUnique({
    where: { id: input.preferredApproverId },
    select: { role: true, employmentEndDate: true },
  });
  return Boolean(
    preferred &&
    isRoleAllowedForType(preferred.role, input.type) &&
    (!preferred.employmentEndDate || preferred.employmentEndDate >= startOfUtcToday()),
  );
}

async function resolveBaseApprover(
  input: WorkflowAssignmentInput,
  db: PersonStore,
): Promise<string | null> {
  if (await isUsablePreferredApprover(input, db)) {
    return input.preferredApproverId ?? null;
  }

  const unitId = input.requesterOrganizationUnitId;
  const hrRoles = [Role.HR, Role.ADMIN];
  if (input.type === WorkflowType.POST_CLOSE_CORRECTION) {
    return firstPersonByRoles(hrRoles, undefined, input.requesterId, db);
  }

  const leadRole = input.type === WorkflowType.SHIFT_SWAP ? Role.SHIFT_PLANNER : Role.TEAM_LEAD;
  return (
    (await firstPersonByRoles([leadRole], unitId, input.requesterId, db)) ??
    (await firstPersonByRoles(hrRoles, unitId, input.requesterId, db)) ??
    (await firstPersonByRoles(hrRoles, undefined, input.requesterId, db))
  );
}

async function delegationCandidates(
  input: {
    primaryApproverId: string;
    requesterId: string;
    workflowType: WorkflowType;
    organizationUnitId: string;
    at: Date;
    maxDepth: number;
  },
  db: DelegationStore,
) {
  const candidates: Array<{
    approverId: string;
    isAvailable: boolean;
    activeFrom?: string;
    activeTo?: string;
  }> = [];
  const visited = new Set<string>([input.primaryApproverId]);
  let currentDelegator = input.primaryApproverId;

  for (let depth = 0; depth < input.maxDepth; depth += 1) {
    const rules = await db.workflowDelegationRule.findMany({
      where: {
        delegatorId: currentDelegator,
        isActive: true,
        OR: [{ workflowType: null }, { workflowType: input.workflowType }],
        AND: [
          {
            OR: [{ organizationUnitId: null }, { organizationUnitId: input.organizationUnitId }],
          },
          {
            activeFrom: { lte: input.at },
          },
          {
            OR: [{ activeTo: null }, { activeTo: { gte: input.at } }],
          },
        ],
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });

    if (rules.length === 0) {
      break;
    }

    const delegateIds = [...new Set(rules.map((rule) => rule.delegateId))];
    const delegates = await db.person.findMany({
      where: { id: { in: delegateIds } },
      select: { id: true, role: true },
    });
    const delegateById = new Map(delegates.map((delegate) => [delegate.id, delegate]));

    const selectedRule = rules.find((rule) => {
      const delegate = delegateById.get(rule.delegateId);
      return delegate && delegate.id !== input.requesterId
        ? isRoleAllowedForType(delegate.role, input.workflowType)
        : false;
    });
    if (!selectedRule) {
      break;
    }

    candidates.push({
      approverId: selectedRule.delegateId,
      isAvailable: true,
      activeFrom: toIso(selectedRule.activeFrom),
      activeTo: selectedRule.activeTo ? toIso(selectedRule.activeTo) : undefined,
    });

    if (visited.has(selectedRule.delegateId)) {
      break;
    }

    visited.add(selectedRule.delegateId);
    currentDelegator = selectedRule.delegateId;
  }

  return candidates;
}

export async function buildWorkflowAssignmentInTransaction(
  tx: Prisma.TransactionClient,
  input: WorkflowAssignmentInput,
): Promise<WorkflowAssignmentResult> {
  await lockPolicyReadsShared(tx, WORKFLOW_ROUTING_LOCK_SCOPE);
  const policy = await ensureWorkflowPolicyInTransaction(tx, input.type);
  const requestedAt = input.requestedAt ?? new Date();
  const approver = await resolveBaseApprover(input, tx);
  const submittedAt = new Date(requestedAt);
  const dueAt = addHours(submittedAt, policy.escalationDeadlineHours);

  const toSubmitted = transitionWorkflow({
    workflowId: 'new',
    currentStatus: 'DRAFT',
    decision: 'SUBMIT',
    actorId: input.requesterId,
    at: toIso(requestedAt),
  });
  const toPending = transitionWorkflow({
    workflowId: 'new',
    currentStatus: toSubmitted.nextStatus,
    decision: 'SUBMIT',
    actorId: input.requesterId,
    at: toIso(requestedAt),
  });
  if (!toSubmitted.ok || !toPending.ok) {
    throw new BadRequestException('Failed to compute initial workflow transitions.');
  }

  if (!approver) {
    return {
      status: WorkflowStatus.PENDING,
      approverId: null,
      submittedAt,
      dueAt,
      escalationLevel: 0,
      delegationTrail: [],
      traversedApprovers: [],
      escalated: false,
      policy,
    };
  }

  const candidates = await delegationCandidates(
    {
      primaryApproverId: approver,
      requesterId: input.requesterId,
      workflowType: input.type,
      organizationUnitId: input.requesterOrganizationUnitId,
      at: requestedAt,
      maxDepth: Math.max(1, policy.maxDelegationDepth),
    },
    tx,
  );
  const delegated = resolveDelegation({
    requesterId: input.requesterId,
    primaryApproverId: approver,
    fallbackChain: candidates,
    at: toIso(requestedAt),
    maxDepth: policy.maxDelegationDepth,
  });

  return {
    status: WorkflowStatus.PENDING,
    approverId: delegated.approverId,
    submittedAt,
    dueAt,
    escalationLevel: 0,
    delegationTrail: appendTrail(null, delegated.approverId),
    traversedApprovers: delegated.traversed,
    escalated: delegated.escalated,
    policy,
  };
}
