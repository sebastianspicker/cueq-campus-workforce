import {
  BookingSource,
  ClosingStatus,
  Role,
  TimeTypeCategory,
  WorkflowStatus,
  WorkflowType,
} from '@cueq/database';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { AuditHelper } from '../audit/public.js';
import type { AssignmentHelper, PersonHelper } from '../people/public.js';
import type { WorkflowRuntimePort } from '../../application/ports/workflow-runtime.port.js';
import { ClosingCorrectionHelper } from './closing-correction.helper.js';

describe('post-close appointment correction', () => {
  it('recalculates the selected appointment account from its bookings without drift', async () => {
    const workflowId = 'c00000000000000000000001';
    const personId = 'c00000000000000000000002';
    const assignmentId = 'c00000000000000000000003';
    const timeTypeId = 'c00000000000000000000004';
    const update = vi.fn(async () => undefined);
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'booking-1',
      ...data,
      source: BookingSource.CORRECTION,
      note: data.note as string,
    }));
    const appendAudit = vi.fn(async () => undefined);
    const tx = {
      $queryRaw: vi.fn(async () => [{ acquired: true }]),
      closingPeriod: {
        findUnique: vi.fn(async () => ({
          id: 'period-1',
          status: ClosingStatus.REVIEW,
          organizationUnitId: 'ou-1',
          periodStart: new Date('2026-03-01T00:00:00.000Z'),
          periodEnd: new Date('2026-03-31T23:59:59.000Z'),
        })),
      },
      workflowInstance: {
        findUnique: vi.fn(async () => ({
          id: workflowId,
          type: WorkflowType.POST_CLOSE_CORRECTION,
          status: WorkflowStatus.APPROVED,
          entityType: 'ClosingPeriod',
          entityId: 'period-1',
        })),
      },
      timeType: {
        findUnique: vi.fn(async () => ({ code: 'WORK', category: TimeTypeCategory.WORK })),
      },
      booking: {
        findFirst: vi.fn(async () => null),
        create,
        // An earlier 20-minute correction plus the one created now: 40 minutes = 0.67 h,
        // where two increments of 0.3333 h stored at two decimals would give 0.66 h.
        findMany: vi.fn(async () => [
          {
            startTime: new Date('2026-03-09T08:00:00.000Z'),
            endTime: new Date('2026-03-09T08:20:00.000Z'),
          },
          {
            startTime: new Date('2026-03-10T08:00:00.000Z'),
            endTime: new Date('2026-03-10T08:20:00.000Z'),
          },
        ]),
      },
      timeAccount: {
        findMany: vi.fn(async () => [
          {
            id: 'account-a',
            periodStart: new Date('2026-03-01T00:00:00.000Z'),
            periodEnd: new Date('2026-03-31T23:59:59.000Z'),
            targetHours: { toNumber: () => 8 },
          },
        ]),
        update,
      },
    };
    const prisma = {
      $transaction: async (callback: (transaction: typeof tx) => unknown) => callback(tx),
    } as unknown as PrismaService;
    const helper = new ClosingCorrectionHelper(
      prisma,
      {
        personForUser: async () => ({ id: 'actor-1', organizationUnitId: 'ou-actor' }),
      } as unknown as PersonHelper,
      {
        resolveInterval: async () => ({
          assignment: { id: assignmentId },
          organizationUnitId: 'ou-1',
        }),
      } as unknown as AssignmentHelper,
      { appendAudit } as unknown as AuditHelper,
      {} as WorkflowRuntimePort,
    );

    const result = await helper.applyPostCloseBookingCorrection(
      { subject: 'actor', email: 'actor@example.test', role: Role.HR, claims: {} },
      'period-1',
      {
        workflowId,
        personId,
        assignmentId,
        timeTypeId,
        startTime: '2026-03-10T08:00:00.000Z',
        endTime: '2026-03-10T08:20:00.000Z',
        reason: 'Approved correction reason',
      },
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ personId, assignmentId }),
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'account-a' },
      data: { actualHours: 0.67, balance: -7.33 },
    });
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({ assignmentId }),
      }),
      tx,
    );
    expect(tx.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          personId,
          assignmentId,
          startTime: { lt: new Date('2026-04-01T00:00:00.000Z') },
        }),
      }),
    );
    expect(result).toMatchObject({ assignmentId, durationHours: 0.3333 });
  });
});

describe('post-close correction request', () => {
  it('reports why the request is rejected in readable text, not as [object Object]', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ acquired: true }]),
      closingPeriod: {
        findUnique: vi.fn(async () => ({
          id: 'period-1',
          status: ClosingStatus.REVIEW,
          organizationUnitId: 'ou-1',
        })),
      },
    };
    const prisma = {
      $transaction: async (callback: (transaction: typeof tx) => unknown) => callback(tx),
    } as unknown as PrismaService;
    const helper = new ClosingCorrectionHelper(
      prisma,
      {
        personForUser: async () => ({ id: 'actor-1', organizationUnitId: 'ou-actor' }),
      } as unknown as PersonHelper,
      {} as AssignmentHelper,
      {} as AuditHelper,
      {} as WorkflowRuntimePort,
    );

    const rejection = await helper
      .postCloseCorrection(
        { subject: 'actor', email: 'actor@example.test', role: Role.HR, claims: {} },
        'period-1',
      )
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(BadRequestException);
    expect((rejection as BadRequestException).getResponse()).toMatchObject({
      message: 'Post-close correction is only valid for EXPORTED periods.',
    });
  });

  it('accepts a correction booking that ends exactly at the exclusive month end', async () => {
    const passedRangeCheck = new Error('range check passed');
    const tx = {
      closingPeriod: {
        findUnique: vi.fn(async () => ({
          id: 'period-1',
          status: ClosingStatus.REVIEW,
          periodStart: new Date('2026-10-01T00:00:00.000Z'),
          periodEnd: new Date('2026-10-31T23:59:59.000Z'),
        })),
      },
      workflowInstance: { findUnique: vi.fn(async () => Promise.reject(passedRangeCheck)) },
      timeType: { findUnique: vi.fn(async () => null) },
    };
    const helper = new ClosingCorrectionHelper(
      {} as PrismaService,
      {} as PersonHelper,
      { resolveInterval: vi.fn(async () => null) } as unknown as AssignmentHelper,
      {} as AuditHelper,
      {} as WorkflowRuntimePort,
    );
    const validate = (
      helper as unknown as {
        validateCorrectionRequest: (...args: unknown[]) => Promise<unknown>;
      }
    ).validateCorrectionRequest.bind(helper);

    await expect(
      validate(
        tx,
        'period-1',
        { workflowId: 'w', personId: 'p', timeTypeId: 't' },
        new Date('2026-10-31T16:00:00.000Z'),
        new Date('2026-11-01T00:00:00.000Z'),
      ),
    ).rejects.toBe(passedRangeCheck);
    await expect(
      validate(
        tx,
        'period-1',
        { workflowId: 'w', personId: 'p', timeTypeId: 't' },
        new Date('2026-10-31T16:00:00.000Z'),
        new Date('2026-11-01T00:00:01.000Z'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
