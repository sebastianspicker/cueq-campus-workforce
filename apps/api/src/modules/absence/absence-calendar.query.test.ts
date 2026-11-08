import { BadRequestException } from '@nestjs/common';
import { AbsenceStatus, Role } from '@cueq/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { teamCalendarDateRange, toTeamCalendarEntry } from './absence-calendar.query.js';

const absence = {
  id: 'absence-1',
  personId: 'person-1',
  assignmentId: 'assignment-1',
  type: 'SICK',
  startDate: new Date('2026-03-02T00:00:00.000Z'),
  endDate: new Date('2026-03-03T00:00:00.000Z'),
  status: AbsenceStatus.APPROVED,
  note: 'Rückfrage Arzt',
  person: { firstName: 'Ada', lastName: 'Lovelace' },
};

describe('toTeamCalendarEntry', () => {
  it.each([
    [Role.EMPLOYEE, { type: false, note: false }],
    [Role.SHIFT_PLANNER, { type: false, note: false }],
    [Role.TEAM_LEAD, { type: true, note: false }],
    [Role.HR, { type: true, note: true }],
  ])('%s sees type=%s and note=%s per role', (role, expected) => {
    const entry = toTeamCalendarEntry(absence, role);
    expect('type' in entry).toBe(expected.type);
    expect('note' in entry).toBe(expected.note);
  });
});

describe('teamCalendarDateRange', () => {
  it('accepts a 93-day range and rejects a longer one', () => {
    expect(() => teamCalendarDateRange('2026-01-01', '2026-04-03')).not.toThrow();
    expect(() => teamCalendarDateRange('2026-01-01', '2026-04-04')).toThrow(BadRequestException);
  });

  it('caps the range when only one bound is given', () => {
    expect(() => teamCalendarDateRange('0001-01-01', undefined)).toThrow(BadRequestException);
  });
});

describe('teamCalendarDateRange defaults', () => {
  afterEach(() => vi.useRealTimers());

  it('defaults to the Berlin month, not the UTC month, just after midnight on the 1st', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T23:30:00.000Z')); // 00:30 on 1 Nov in Berlin
    expect(teamCalendarDateRange()).toEqual({
      startDate: new Date('2026-11-01T00:00:00.000Z'),
      endDate: new Date('2026-11-30T23:59:59.999Z'),
    });
  });
});
