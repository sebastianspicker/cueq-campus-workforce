import { describe, expect, it } from 'vitest';
import { CreateClosingPeriodSchema } from './closing.js';

describe('CreateClosingPeriodSchema', () => {
  it('accepts a YYYY-MM month with an optional unit', () => {
    expect(CreateClosingPeriodSchema.parse({ month: '2026-07' })).toEqual({ month: '2026-07' });
  });

  it.each(['2026-7', '2026-13', '2026-00', '2026-07-01'])('rejects month %s', (month) => {
    expect(CreateClosingPeriodSchema.safeParse({ month }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(
      CreateClosingPeriodSchema.safeParse({ month: '2026-07', status: 'CLOSED' }).success,
    ).toBe(false);
  });
});
