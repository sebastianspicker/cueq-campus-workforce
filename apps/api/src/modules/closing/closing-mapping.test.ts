import { ClosingStatus } from '@cueq/database';
import { describe, expect, it } from 'vitest';
import { mapClosingPeriodResponse } from './closing-mapping.js';

describe('closing period response mapping', () => {
  it('allowlists export metadata and never serializes persisted artifacts', () => {
    const exportRun = {
      id: 'run-1',
      format: 'CSV_V2',
      recordCount: 2,
      checksum: 'checksum',
      exportedAt: new Date('2026-03-31T12:00:00.000Z'),
      artifact: 'personId,balance\np1,42',
      contentType: 'text/csv',
      exportedById: 'actor-1',
    };

    const result = mapClosingPeriodResponse({
      id: 'period-1',
      organizationUnitId: null,
      periodStart: new Date('2026-03-01T00:00:00.000Z'),
      periodEnd: new Date('2026-03-31T23:59:59.999Z'),
      status: ClosingStatus.EXPORTED,
      exportRuns: [exportRun],
      closedAt: null,
      closedById: null,
      leadApprovedAt: null,
      leadApprovedById: null,
      hrApprovedAt: null,
      hrApprovedById: null,
      lockedAt: null,
      lockSource: null,
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      updatedAt: new Date('2026-03-31T12:00:00.000Z'),
    });

    expect(result.exportRuns).toEqual([
      {
        id: 'run-1',
        format: 'CSV_V2',
        recordCount: 2,
        checksum: 'checksum',
        exportedAt: '2026-03-31T12:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('personId,balance');
  });
});
