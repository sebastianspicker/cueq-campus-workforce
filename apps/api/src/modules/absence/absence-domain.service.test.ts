import { ForbiddenException } from '@nestjs/common';
import { Role } from '@cueq/database';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedIdentity } from '../../platform/auth/auth.types.js';
import { AbsenceDomainService } from './absence-domain.service.js';

const ids = {
  actor: 'c00000000000000000000001',
  other: 'c00000000000000000000002',
  absence: 'c00000000000000000000003',
};

function user(role: Role): AuthenticatedIdentity {
  return { subject: 's', email: 'a@example.test', role, claims: {} };
}

function service(absence: unknown = null) {
  const assignmentHelper = { selectAssignment: vi.fn() };
  const prisma = { absence: { findUnique: vi.fn().mockResolvedValue(absence) } };
  const svc = new AbsenceDomainService(
    prisma as never,
    { personForUser: vi.fn().mockResolvedValue({ id: ids.actor }) } as never,
    assignmentHelper as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, assignmentHelper };
}

describe('AbsenceDomainService', () => {
  it('rejects an HR user adjusting their own leave balance', async () => {
    const { svc, assignmentHelper } = service();
    await expect(
      svc.createLeaveAdjustment(user(Role.HR), {
        personId: ids.actor,
        year: 2026,
        deltaDays: 30,
        reason: 'Self-service adjustment',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(assignmentHelper.selectAssignment).not.toHaveBeenCalled();
  });

  it('enforces ownership for roles without the cross-person privilege on read by id', async () => {
    const { svc } = service({ id: ids.absence, personId: ids.other });
    await expect(svc.getAbsenceById(user(Role.SHIFT_PLANNER), ids.absence)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('returns the note only to the absence owner and HR', async () => {
    const row = {
      id: ids.absence,
      personId: ids.other,
      assignmentId: 'c00000000000000000000004',
      type: 'VACATION',
      startDate: new Date('2026-03-02T00:00:00.000Z'),
      endDate: new Date('2026-03-03T00:00:00.000Z'),
      days: { toNumber: () => 2 },
      status: 'APPROVED',
      note: 'private',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const { svc } = service(row);
    const read = async (role: Role) =>
      ((await svc.getAbsenceById(user(role), ids.absence)) as { note: string | null }).note;
    expect(await read(Role.ADMIN)).toBeNull();
    expect(await read(Role.HR)).toBe('private');

    const own = service({ ...row, personId: ids.actor });
    const ownResult = (await own.svc.getAbsenceById(user(Role.EMPLOYEE), ids.absence)) as {
      note: string | null;
    };
    expect(ownResult.note).toBe('private');
  });
});
