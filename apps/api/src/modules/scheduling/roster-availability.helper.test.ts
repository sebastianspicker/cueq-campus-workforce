import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { assertPersonAvailableForShift } from './roster-availability.helper.js';

const shift = {
  id: 'shift-new',
  shiftType: 'EARLY',
  startTime: new Date('2026-12-29T06:00:00.000Z'),
  endTime: new Date('2026-12-29T14:00:00.000Z'),
};

function neighbour(start: string, end: string) {
  return {
    shift: { id: 'other', shiftType: 'LATE', startTime: new Date(start), endTime: new Date(end) },
  };
}

const dayStart = (date: string) => new Date(`${date}T00:00:00.000Z`);
function absenceOn(startDate: string, endDate = startDate) {
  return { id: 'absence-1', startDate: dayStart(startDate), endDate: dayStart(endDate) };
}

function tx(options: {
  absence?: ReturnType<typeof absenceOn>;
  previousEnd?: string;
  nextStart?: string;
}) {
  return {
    absence: { findMany: vi.fn().mockResolvedValue(options.absence ? [options.absence] : []) },
    shiftAssignment: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(
          options.previousEnd ? neighbour('2026-12-28T14:00:00.000Z', options.previousEnd) : null,
        )
        .mockResolvedValueOnce(
          options.nextStart ? neighbour(options.nextStart, '2026-12-30T22:00:00.000Z') : null,
        ),
    },
  };
}

async function conflict(db: ReturnType<typeof tx>, target = shift) {
  const error = await assertPersonAvailableForShift(db as never, 'person-1', target).catch(
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(ConflictException);
  return (error as ConflictException).getResponse();
}

describe('assertPersonAvailableForShift', () => {
  it('rejects a shift overlapping an approved absence with ABSENCE_CONFLICT', async () => {
    const db = tx({ absence: absenceOn('2026-12-29') });
    expect(await conflict(db)).toMatchObject({ code: 'ABSENCE_CONFLICT', absenceId: 'absence-1' });
    expect(db.absence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'APPROVED', personId: 'person-1' }),
      }),
    );
  });

  it('treats absence days as Berlin days: 00:30 Berlin the day after is free, 22:00 before is not', async () => {
    const at = (start: string, end: string) => ({
      id: 'shift-new',
      shiftType: 'EARLY',
      startTime: new Date(start),
      endTime: new Date(end),
    });
    const absence = absenceOn('2026-12-28');
    // 2026-12-29T00:30 Berlin = 2026-12-28T23:30Z, after the absence's last Berlin day.
    await expect(
      assertPersonAvailableForShift(
        tx({ absence }) as never,
        'person-1',
        at('2026-12-28T23:30:00.000Z', '2026-12-29T07:30:00.000Z'),
      ),
    ).resolves.toBeUndefined();
    // 2026-12-28T22:00 Berlin = 21:00Z, still inside the absence.
    expect(
      await conflict(tx({ absence }), at('2026-12-28T21:00:00.000Z', '2026-12-29T05:00:00.000Z')),
    ).toMatchObject({ code: 'ABSENCE_CONFLICT' });
  });

  it('uses Berlin midnight on the DST day 2026-03-29', async () => {
    const absence = absenceOn('2026-03-29');
    const at = (start: string, end: string) => ({
      id: 'shift-new',
      shiftType: 'EARLY',
      startTime: new Date(start),
      endTime: new Date(end),
    });
    // Berlin midnight 2026-03-30 is 2026-03-29T22:00Z (CEST); 21:30Z is still the 29th.
    expect(
      await conflict(tx({ absence }), at('2026-03-29T21:30:00.000Z', '2026-03-30T05:00:00.000Z')),
    ).toMatchObject({ code: 'ABSENCE_CONFLICT' });
    await expect(
      assertPersonAvailableForShift(
        tx({ absence }) as never,
        'person-1',
        at('2026-03-29T22:00:00.000Z', '2026-03-30T06:00:00.000Z'),
      ),
    ).resolves.toBeUndefined();
  });

  it('does not apply the rest check between parts of one Berlin day', async () => {
    const split = {
      id: 'shift-new',
      shiftType: 'LATE',
      startTime: new Date('2026-12-29T15:00:00.000Z'),
      endTime: new Date('2026-12-29T19:00:00.000Z'),
    };
    const db = tx({});
    db.shiftAssignment.findFirst.mockReset();
    db.shiftAssignment.findFirst
      .mockResolvedValueOnce(neighbour('2026-12-29T07:00:00.000Z', '2026-12-29T11:00:00.000Z'))
      .mockResolvedValueOnce(null);
    await expect(
      assertPersonAvailableForShift(db as never, 'person-1', split),
    ).resolves.toBeUndefined();
  });

  it('still rejects 14:00-22:00 followed by 06:00-14:00 the next Berlin day', async () => {
    const db = tx({});
    db.shiftAssignment.findFirst.mockReset();
    db.shiftAssignment.findFirst
      .mockResolvedValueOnce(neighbour('2026-12-28T13:00:00.000Z', '2026-12-28T21:00:00.000Z'))
      .mockResolvedValueOnce(null);
    expect(
      await conflict(db, {
        id: 'shift-new',
        shiftType: 'EARLY',
        startTime: new Date('2026-12-29T05:00:00.000Z'),
        endTime: new Date('2026-12-29T13:00:00.000Z'),
      }),
    ).toMatchObject({ code: 'REST_PERIOD_VIOLATION' });
  });

  it('rejects 8 h of rest after the previous shift with REST_PERIOD_VIOLATION', async () => {
    expect(await conflict(tx({ previousEnd: '2026-12-28T22:00:00.000Z' }))).toMatchObject({
      code: 'REST_PERIOD_VIOLATION',
    });
  });

  it('rejects less than the minimum rest before the next shift', async () => {
    expect(await conflict(tx({ nextStart: '2026-12-30T00:00:00.000Z' }))).toMatchObject({
      code: 'REST_PERIOD_VIOLATION',
    });
  });

  it('accepts 11 h of rest on both sides and no absence', async () => {
    const db = tx({
      previousEnd: '2026-12-28T19:00:00.000Z',
      nextStart: '2026-12-30T01:00:00.000Z',
    });
    await expect(
      assertPersonAvailableForShift(db as never, 'person-1', shift),
    ).resolves.toBeUndefined();
  });
});
