import { describe, expect, it, vi } from 'vitest';
import { Role, WorkflowStatus, WorkflowType } from '@cueq/database';
import type { PrismaService } from '../../persistence/prisma.service.js';
import { escalateOverdueWorkflows } from './workflow-assignment-escalation.js';

describe('workflow escalation scanning', () => {
  it('reads overdue candidates in bounded keyset pages and retains fresh per-item checks', async () => {
    const dueAt = new Date('2026-09-01T00:00:00.000Z');
    const candidates = Array.from({ length: 205 }, (_, index) => ({
      id: `workflow-${String(index).padStart(3, '0')}`,
      type: WorkflowType.LEAVE_REQUEST,
      status: WorkflowStatus.PENDING,
      dueAt,
      escalationLevel: 0,
    }));
    let offset = 0;
    const findMany = vi.fn(async (_args: unknown) => {
      const page = candidates.slice(offset, offset + 100);
      offset += page.length;
      return page;
    });
    const findUnique = vi.fn(async () => null);
    const prisma = {
      workflowInstance: { findMany },
      workflowPolicy: { findMany: vi.fn(async () => []) },
      $transaction: async <T>(operation: (tx: unknown) => Promise<T>) =>
        operation({
          $queryRaw: async () => [{ acquired: true }],
          workflowInstance: { findUnique },
        }),
    } as unknown as Pick<PrismaService, '$transaction' | 'workflowInstance' | 'workflowPolicy'>;

    await expect(
      escalateOverdueWorkflows(prisma, { appendAudit: vi.fn() }, new Date('2026-09-02T00:00:00Z')),
    ).resolves.toEqual({ escalated: 0, skipped: 0 });

    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      select: { id: true, type: true, status: true, dueAt: true, escalationLevel: true },
      take: 100,
    });
    expect(findMany.mock.calls[1]?.[0]).toMatchObject({
      where: { OR: [{ dueAt: { gt: dueAt } }, { dueAt, id: { gt: 'workflow-099' } }] },
    });
    expect(findUnique).toHaveBeenCalledTimes(205);
  });
});

type FakeWorkflow = {
  id: string;
  type: WorkflowType;
  status: WorkflowStatus;
  requesterId: string;
  approverId: string | null;
  escalationLevel: number;
  delegationTrail: string[];
  submittedAt: Date;
  createdAt: Date;
  dueAt: Date;
};

const HOUR = 3_600_000;
const people = [
  { id: 'requester', role: Role.EMPLOYEE },
  { id: 'hr', role: Role.HR },
  { id: 'admin', role: Role.ADMIN },
];

function escalationHarness(workflows: FakeWorkflow[]) {
  const rows = new Map(workflows.map((row) => [row.id, row]));
  const policy = {
    escalationDeadlineHours: 48,
    escalationRoles: [Role.HR, Role.ADMIN],
    maxDelegationDepth: 5,
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ acquired: true }]),
    workflowPolicy: { findFirst: vi.fn(async () => policy) },
    person: {
      findUnique: vi.fn(async () => ({ organizationUnitId: 'unit-a' })),
      findFirst: vi.fn(
        async ({ where }: { where: { role: { in: Role[] } } }) =>
          people.find((entry) => where.role.in.includes(entry.role)) ?? null,
      ),
    },
    workflowInstance: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: WorkflowStatus };
          data: object;
        }) => {
          const row = rows.get(where.id);
          if (!row || row.status !== where.status) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
  };
  const prisma = {
    $transaction: vi.fn(async <T>(operation: (client: unknown) => Promise<T>) => operation(tx)),
    workflowPolicy: {
      findMany: vi.fn(async () => [{ type: WorkflowType.LEAVE_REQUEST, ...policy }]),
    },
    workflowInstance: {
      findMany: vi.fn(async () =>
        [...rows.values()].filter(
          (row) =>
            (row.status === WorkflowStatus.PENDING || row.status === WorkflowStatus.ESCALATED) &&
            row.dueAt <= clock.now,
        ),
      ),
    },
  } as unknown as Pick<PrismaService, '$transaction' | 'workflowInstance' | 'workflowPolicy'>;
  const clock = { now: new Date('2026-09-10T00:00:00Z') };
  return { rows, prisma, tx, clock };
}

function pendingWorkflow(id: string, overrides: Partial<FakeWorkflow> = {}): FakeWorkflow {
  return {
    id,
    type: WorkflowType.LEAVE_REQUEST,
    status: WorkflowStatus.PENDING,
    requesterId: 'requester',
    approverId: 'lead',
    escalationLevel: 0,
    delegationTrail: ['lead'],
    submittedAt: new Date('2026-09-01T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    dueAt: new Date('2026-09-03T00:00:00Z'),
    ...overrides,
  };
}

describe('workflow escalation levels', () => {
  it('reaches the second role once and then stops', async () => {
    const { rows, prisma, clock } = escalationHarness([pendingWorkflow('w1')]);
    const audit = { appendAudit: vi.fn() };

    await expect(escalateOverdueWorkflows(prisma, audit, clock.now)).resolves.toEqual({
      escalated: 1,
      skipped: 0,
    });
    const row = rows.get('w1');
    expect(row).toMatchObject({ status: 'ESCALATED', escalationLevel: 1, approverId: 'hr' });
    expect(row?.dueAt.getTime()).toBe(clock.now.getTime() + 48 * HOUR);

    clock.now = new Date(clock.now.getTime() + 49 * HOUR);
    await expect(escalateOverdueWorkflows(prisma, audit, clock.now)).resolves.toMatchObject({
      escalated: 1,
    });
    expect(rows.get('w1')).toMatchObject({ escalationLevel: 2, approverId: 'admin' });

    clock.now = new Date(clock.now.getTime() + 49 * HOUR);
    await expect(escalateOverdueWorkflows(prisma, audit, clock.now)).resolves.toMatchObject({
      escalated: 0,
    });
    expect(rows.get('w1')?.escalationLevel).toBe(2);
  });

  it('skips ESCALATED items at the last level without opening a transaction', async () => {
    const { prisma } = escalationHarness([
      pendingWorkflow('w1', { status: WorkflowStatus.ESCALATED, escalationLevel: 2 }),
    ]);
    await expect(
      escalateOverdueWorkflows(prisma, { appendAudit: vi.fn() }, new Date('2026-09-10T00:00:00Z')),
    ).resolves.toEqual({ escalated: 0, skipped: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips a candidate that throws and still escalates the next one', async () => {
    const { rows, prisma } = escalationHarness([
      pendingWorkflow('w1'),
      pendingWorkflow('w2'),
      pendingWorkflow('w3'),
    ]);
    const audit = {
      appendAudit: vi.fn(async (entry: { entityId: string }) => {
        if (entry.entityId === 'w2') throw new Error('storage');
      }),
    };

    await expect(
      escalateOverdueWorkflows(prisma, audit, new Date('2026-09-10T00:00:00Z')),
    ).resolves.toEqual({ escalated: 2, skipped: 1 });
    expect(rows.get('w3')?.status).toBe('ESCALATED');
  });
});
