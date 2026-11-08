import { describe, expect, it } from 'vitest';
import type { Prisma } from '@cueq/database';
import { ClosingLockHelper } from './closing-lock.helper.js';

function fakeTx(acquired: boolean) {
  const sql: string[] = [];
  const tx = {
    closingPeriod: {
      findMany: async () => [{ id: 'period-open' }],
      findFirst: async () => null,
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      sql.push(strings.join('?'));
      return [{ acquired }];
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, sql };
}

const helper = new ClosingLockHelper({} as never, {} as never);
const range = {
  organizationUnitId: null,
  from: new Date('2026-11-02T07:00:00Z'),
  to: new Date('2026-11-02T15:00:00Z'),
};

describe('closing-period write barrier for ordinary writers', () => {
  it('takes the shared lock so concurrent writers in an OPEN period do not conflict', async () => {
    const { tx, sql } = fakeTx(true);
    await helper.assertClosingPeriodUnlockedForRangeInTransaction(range, tx);
    await helper.assertClosingPeriodsUnlockedForRangesInTransaction(
      [{ ...range, actorId: 'a', attemptedAction: 'X', entityType: 'Booking', entityId: 'b' }],
      tx,
    );
    expect(sql).toHaveLength(2);
    for (const statement of sql) expect(statement).toContain('pg_try_advisory_xact_lock_shared');
  });

  it('fails fast with a retryable 409 while a closing transition holds the exclusive lock', async () => {
    const { tx } = fakeTx(false);
    await expect(
      helper.assertClosingPeriodUnlockedForRangeInTransaction(range, tx),
    ).rejects.toMatchObject({
      response: { code: 'CLOSING_PERIOD_WRITE_IN_PROGRESS', retryable: true },
    });
  });
});
