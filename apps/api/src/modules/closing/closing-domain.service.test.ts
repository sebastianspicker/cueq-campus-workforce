import { Role } from '@cueq/database';
import { describe, expect, it, vi } from 'vitest';
import { ClosingDomainService } from './closing-domain.service.js';

describe('closing period list', () => {
  it('applies no date window when from and to are absent, so periods after 2030 stay listed', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new ClosingDomainService(
      { closingPeriod: { findMany } } as never,
      { personForUser: vi.fn().mockResolvedValue({ id: 'hr', organizationUnitId: 'ou' }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await service.listClosingPeriods({ role: Role.HR } as never);
    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where).not.toHaveProperty('periodStart');
    expect(where).not.toHaveProperty('periodEnd');
  });
});
