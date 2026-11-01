import { describe, expect, it, vi } from 'vitest';
import { Role, WorkflowType } from '@cueq/database';
import type { Prisma } from '@cueq/database';
import { buildWorkflowAssignmentInTransaction } from './workflow-assignment-routing.js';

type FakePerson = {
  id: string;
  role: Role;
  organizationUnitId: string;
  createdAt: number;
  employmentEndDate: Date | null;
};

const PAST = new Date('2020-01-01T00:00:00Z');

function person(id: string, role: Role, unit: string, extra: Partial<FakePerson> = {}): FakePerson {
  return {
    id,
    role,
    organizationUnitId: unit,
    createdAt: Number(id.replace(/\D/g, '')) || 0,
    employmentEndDate: null,
    ...extra,
  };
}

function fakeTx(people: FakePerson[]) {
  const policy = {
    id: 'policy-1',
    type: WorkflowType.LEAVE_REQUEST,
    escalationDeadlineHours: 48,
    escalationRoles: [Role.HR, Role.ADMIN],
    maxDelegationDepth: 5,
    activeFrom: new Date('2026-01-01T00:00:00Z'),
    activeTo: null,
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    workflowPolicy: { findFirst: vi.fn(async () => policy) },
    workflowDelegationRule: { findMany: vi.fn(async () => []) },
    person: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        people.find((entry) => entry.id === where.id),
      ),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            role: { in: Role[] };
            id?: { not: string };
            organizationUnitId?: string;
            OR: Array<{ employmentEndDate: null | { gte: Date } }>;
          };
        }) =>
          people
            .filter(
              (entry) =>
                where.role.in.includes(entry.role) &&
                entry.id !== where.id?.not &&
                (where.organizationUnitId === undefined ||
                  entry.organizationUnitId === where.organizationUnitId) &&
                (!entry.employmentEndDate ||
                  entry.employmentEndDate >= (where.OR[1]?.employmentEndDate as { gte: Date }).gte),
            )
            .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null,
      ),
    },
  };
  return tx;
}

async function approverFor(people: FakePerson[], overrides: { preferredApproverId?: string } = {}) {
  const tx = fakeTx(people);
  const result = await buildWorkflowAssignmentInTransaction(
    tx as unknown as Prisma.TransactionClient,
    {
      type: WorkflowType.LEAVE_REQUEST,
      requesterId: 'p1',
      requesterOrganizationUnitId: 'unit-a',
      preferredApproverId: overrides.preferredApproverId,
    },
  );
  return { approverId: result.approverId, tx };
}

describe('workflow approver routing', () => {
  const requesterLead = person('p1', Role.TEAM_LEAD, 'unit-a');

  it('routes a unit without another team lead to HR in the unit, not a foreign lead', async () => {
    const people = [
      requesterLead,
      person('p2', Role.TEAM_LEAD, 'unit-b'),
      person('p3', Role.HR, 'unit-a'),
    ];
    expect((await approverFor(people)).approverId).toBe('p3');
  });

  it('falls back to global HR when the unit has no other approver', async () => {
    const people = [
      requesterLead,
      person('p2', Role.TEAM_LEAD, 'unit-b'),
      person('p4', Role.HR, 'unit-c'),
    ];
    expect((await approverFor(people)).approverId).toBe('p4');
  });

  it('never routes to the requester, even as the preferred approver', async () => {
    const people = [requesterLead, person('p5', Role.TEAM_LEAD, 'unit-a')];
    expect((await approverFor(people, { preferredApproverId: 'p1' })).approverId).toBe('p5');
  });

  it('ignores a preferred approver whose role may not decide this type', async () => {
    const people = [
      person('p1', Role.EMPLOYEE, 'unit-a'),
      person('p6', Role.EMPLOYEE, 'unit-a'),
      person('p7', Role.TEAM_LEAD, 'unit-a'),
    ];
    expect((await approverFor(people, { preferredApproverId: 'p6' })).approverId).toBe('p7');
  });

  it('skips team leads whose employment has ended', async () => {
    const people = [
      person('p1', Role.EMPLOYEE, 'unit-a'),
      person('p8', Role.TEAM_LEAD, 'unit-a', { employmentEndDate: PAST }),
      person('p9', Role.HR, 'unit-a'),
    ];
    expect((await approverFor(people)).approverId).toBe('p9');
  });

  it('keeps an approver on their inclusive last employment day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T15:00:00Z'));
    try {
      const lastDay = new Date('2026-09-10T00:00:00Z');
      const people = [
        requesterLead,
        person('p10', Role.TEAM_LEAD, 'unit-a', { employmentEndDate: lastDay }),
      ];
      expect((await approverFor(people)).approverId).toBe('p10');
      expect((await approverFor(people, { preferredApproverId: 'p10' })).approverId).toBe('p10');
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes a blocking shared advisory lock, never the try-lock', async () => {
    const { tx } = await approverFor([requesterLead, person('p3', Role.HR, 'unit-a')]);
    const sql = (tx.$queryRaw.mock.calls as unknown as Array<[TemplateStringsArray]>)
      .map(([strings]) => strings.join('?'))
      .join('\n');
    expect(sql).toContain('pg_advisory_xact_lock_shared');
    expect(sql).not.toContain('try');
  });
});
