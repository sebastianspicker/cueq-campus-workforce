import { describe, expect, it } from 'vitest';
import { CreateAbsenceSchema } from './absence.js';

const base = { personId: 'c00000000000000000000001', type: 'SICK' } as const;

describe('CreateAbsenceSchema range cap', () => {
  it('accepts 366 calendar days inclusive', () => {
    expect(
      CreateAbsenceSchema.safeParse({ ...base, startDate: '2026-01-01', endDate: '2027-01-01' })
        .success,
    ).toBe(true);
  });

  it('rejects 367 calendar days inclusive', () => {
    const result = CreateAbsenceSchema.safeParse({
      ...base,
      startDate: '2026-01-01',
      endDate: '2027-01-02',
    });
    expect(result.success).toBe(false);
  });
});
