/** Escalates overdue workflows with fresh-state checks, compare-and-swap, and transaction-coupled audit. */
import { Logger } from '@nestjs/common';
import type { Prisma, WorkflowInstance, WorkflowPolicy } from '@cueq/database';
import { Role, WorkflowStatus } from '@cueq/database';
import { shouldEscalate, transitionWorkflow } from '@cueq/domain';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { AuditHelper } from '../audit/public.js';
import {
  ensureWorkflowPolicyInTransaction,
  listActiveWorkflowPolicies,
  WORKFLOW_ROUTING_LOCK_SCOPE,
} from './workflow-assignment-policy.js';
import { firstPersonByRoles } from './workflow-assignment-routing.js';
import { lockPolicyReadsShared } from '../../platform/transactions/transaction-lock.helper.js';
import { appendTrail, asRoleArray } from './workflow-persistence-normalization.js';
import { addHours, toIso } from './workflow-time.js';

type EscalationPrisma = Pick<PrismaService, '$transaction' | 'workflowInstance' | 'workflowPolicy'>;
type EscalationAudit = Pick<AuditHelper, 'appendAudit'>;
type EscalationCandidate = Pick<
  WorkflowInstance,
  'id' | 'type' | 'status' | 'dueAt' | 'escalationLevel'
>;
const logger = new Logger('WorkflowEscalation');
const ESCALATION_SCAN_BATCH_SIZE = 100;

function isFreshEscalationCandidate(
  workflow: WorkflowInstance | null,
  candidate: EscalationCandidate,
  now: Date,
): workflow is WorkflowInstance {
  return Boolean(
    workflow &&
    (workflow.status === WorkflowStatus.PENDING || workflow.status === WorkflowStatus.ESCALATED) &&
    workflow.escalationLevel === candidate.escalationLevel &&
    workflow.dueAt &&
    workflow.dueAt <= now,
  );
}

function shouldEscalateWorkflow(workflow: WorkflowInstance, now: Date): boolean {
  return shouldEscalate({
    currentStatus: workflow.status,
    submittedAt: toIso(workflow.submittedAt ?? workflow.createdAt),
    now: toIso(now),
    escalationDeadlineHours: 0,
  });
}

function escalationTransition(workflow: WorkflowInstance, now: Date) {
  return transitionWorkflow({
    workflowId: workflow.id,
    currentStatus: workflow.status,
    decision: 'ESCALATE',
    actorId: 'system:workflow-escalation',
    at: toIso(now),
  });
}

function escalationTargetRole(policy: WorkflowPolicy, escalationLevel: number): Role {
  const roles = asRoleArray(policy.escalationRoles);
  return roles[Math.min(escalationLevel, Math.max(0, roles.length - 1))] ?? Role.HR;
}

async function resolveEscalationApprover(
  tx: Prisma.TransactionClient,
  workflow: WorkflowInstance,
  policy: WorkflowPolicy,
): Promise<string | null> {
  const requester = await tx.person.findUnique({
    where: { id: workflow.requesterId },
    select: { organizationUnitId: true },
  });
  const role = escalationTargetRole(policy, workflow.escalationLevel);
  const inUnit = await firstPersonByRoles(
    [role],
    requester?.organizationUnitId,
    workflow.requesterId,
    tx,
  );
  // Only HR/ADMIN escalation targets may be resolved outside the requester's unit.
  const global =
    inUnit || (role !== Role.HR && role !== Role.ADMIN)
      ? null
      : await firstPersonByRoles([role], undefined, workflow.requesterId, tx);
  return inUnit ?? global ?? workflow.approverId;
}

async function updateEscalatedWorkflow(
  tx: Prisma.TransactionClient,
  workflow: WorkflowInstance,
  now: Date,
  nextStatus: WorkflowStatus,
  nextApproverId: string | null,
  nextDueAt: Date,
): Promise<boolean> {
  const delegationTrail = appendTrail(workflow.delegationTrail, nextApproverId);
  const result = await tx.workflowInstance.updateMany({
    where: {
      id: workflow.id,
      status: workflow.status,
      escalationLevel: workflow.escalationLevel,
      approverId: workflow.approverId,
      delegationTrail: { equals: workflow.delegationTrail ?? undefined },
      dueAt: { equals: workflow.dueAt, lte: now },
    },
    data: {
      status: nextStatus,
      approverId: nextApproverId,
      escalatedAt: now,
      dueAt: nextDueAt,
      escalationLevel: workflow.escalationLevel + 1,
      delegationTrail,
    },
  });
  return result.count > 0;
}

async function appendEscalationAudit(
  auditHelper: EscalationAudit,
  tx: Prisma.TransactionClient,
  workflow: WorkflowInstance,
  nextStatus: WorkflowStatus,
  nextApproverId: string | null,
): Promise<void> {
  await auditHelper.appendAudit(
    {
      actorId: 'system:workflow-escalation',
      action: 'WORKFLOW_ESCALATED',
      entityType: 'WorkflowInstance',
      entityId: workflow.id,
      before: {
        status: workflow.status,
        approverId: workflow.approverId,
        escalationLevel: workflow.escalationLevel,
      },
      after: {
        status: nextStatus,
        approverId: nextApproverId,
        escalationLevel: workflow.escalationLevel + 1,
      },
      reason: 'automatic escalation',
    },
    tx,
  );
}

async function escalateCandidate(
  prisma: EscalationPrisma,
  auditHelper: EscalationAudit,
  candidate: EscalationCandidate,
  now: Date,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockPolicyReadsShared(tx, WORKFLOW_ROUTING_LOCK_SCOPE);
    const workflow = await tx.workflowInstance.findUnique({ where: { id: candidate.id } });
    if (
      !isFreshEscalationCandidate(workflow, candidate, now) ||
      !shouldEscalateWorkflow(workflow, now)
    ) {
      return false;
    }

    const transition = escalationTransition(workflow, now);
    if (!transition.ok) {
      return false;
    }

    const policy = await ensureWorkflowPolicyInTransaction(tx, workflow.type);
    // Each level escalates once; ESCALATED items stop after the last configured role.
    if (
      workflow.status === WorkflowStatus.ESCALATED &&
      workflow.escalationLevel >= asRoleArray(policy.escalationRoles).length
    ) {
      return false;
    }
    const nextApproverId = await resolveEscalationApprover(tx, workflow, policy);
    const updated = await updateEscalatedWorkflow(
      tx,
      workflow,
      now,
      transition.nextStatus,
      nextApproverId,
      addHours(now, policy.escalationDeadlineHours),
    );
    if (!updated) {
      return false;
    }

    await appendEscalationAudit(auditHelper, tx, workflow, transition.nextStatus, nextApproverId);
    return true;
  });
}

export async function escalateOverdueWorkflows(
  prisma: EscalationPrisma,
  auditHelper: EscalationAudit,
  now = new Date(),
) {
  let escalated = 0;
  let skipped = 0;
  const policies = new Map(
    (await listActiveWorkflowPolicies(prisma)).map((policy) => [policy.type, policy]),
  );
  let cursor: { dueAt: Date; id: string } | undefined;

  while (true) {
    const pending = await prisma.workflowInstance.findMany({
      where: {
        status: { in: [WorkflowStatus.PENDING, WorkflowStatus.ESCALATED] },
        dueAt: { not: null, lte: now },
        ...(cursor
          ? {
              OR: [
                { dueAt: { gt: cursor.dueAt, lte: now } },
                { dueAt: cursor.dueAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      select: { id: true, type: true, status: true, dueAt: true, escalationLevel: true },
      take: ESCALATION_SCAN_BATCH_SIZE,
    });

    for (const candidate of pending) {
      // ESCALATED items at the last configured role never escalate again; skip without a transaction.
      const policy = policies.get(candidate.type);
      if (
        policy &&
        candidate.status === WorkflowStatus.ESCALATED &&
        candidate.escalationLevel >= asRoleArray(policy.escalationRoles).length
      ) {
        continue;
      }
      try {
        if (await escalateCandidate(prisma, auditHelper, candidate, now)) {
          escalated += 1;
        }
      } catch (error) {
        // One failing workflow must not abort the rest of the scan; the next run retries.
        logger.warn(
          `Escalation of workflow ${candidate.id} failed (${error instanceof Error ? error.constructor.name : 'unknown'}).`,
        );
        skipped += 1;
      }
    }

    const last = pending.at(-1);
    if (pending.length < ESCALATION_SCAN_BATCH_SIZE || !last?.dueAt) {
      break;
    }
    cursor = { dueAt: last.dueAt, id: last.id };
  }

  return { escalated, skipped };
}
