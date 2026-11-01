import { describe, expect, it, vi } from 'vitest';
import { ClosingPeriodCreateService } from './closing-period-create.js';

const unitId = 'c000000000000000000000001';

function fixture(existing: unknown) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
    organizationUnit: { findUnique: vi.fn().mockResolvedValue({ id: unitId }) },
    closingPeriod: {
      findFirst: vi.fn().mockResolvedValue(existing),
      create: vi.fn(async ({ data }) => ({ id: 'p1', ...data })),
    },
  };
  const audit = { appendAudit: vi.fn() };
  const service = new ClosingPeriodCreateService(
    { $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx) } as never,
    { personForUser: vi.fn().mockResolvedValue({ id: 'actor' }) } as never,
    audit as never,
  );
  return { service, tx, audit };
}

describe('ClosingPeriodCreateService', () => {
  it('creates an OPEN global period for the month and audits it', async () => {
    const f = fixture(null);
    const created = await f.service.create({} as never, { month: '2026-07' });
    expect(created).toMatchObject({
      organizationUnitId: null,
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-07-31T23:59:59.000Z'),
      status: 'OPEN',
    });
    expect(f.audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CLOSING_PERIOD_CREATED', entityId: 'p1' }),
      f.tx,
    );
  });

  it('checks the same unit and the global period for a unit request', async () => {
    const f = fixture({ id: 'other' });
    await expect(
      f.service.create({} as never, { month: '2026-07', organizationUnitId: unitId }),
    ).rejects.toThrow('already exists');
    expect(f.tx.closingPeriod.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ organizationUnitId: unitId }, { organizationUnitId: null }],
        }),
      }),
    );
    expect(f.tx.closingPeriod.create).not.toHaveBeenCalled();
  });

  it('rejects a global request when any period of the month exists', async () => {
    const f = fixture({ id: 'unit-period' });
    await expect(f.service.create({} as never, { month: '2026-07' })).rejects.toThrow(
      'already exists',
    );
    expect(f.tx.closingPeriod.findFirst.mock.calls[0]?.[0].where).toEqual({
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
    });
  });
});
