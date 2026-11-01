import { BadRequestException } from '@nestjs/common';
import { Role, type Prisma } from '@cueq/database';
import { describe, expect, it, vi } from 'vitest';
import { reconcileHrImportRows } from './hr-import-reconciliation.helper.js';
import type { ValidatedHrImportRow } from './hr-import-validation.js';

function rows(count: number): ValidatedHrImportRow[] {
  return Array.from({ length: count }, (_, index) => ({
    externalId: `person-${index}`,
    firstName: 'Test',
    lastName: String(index),
    email: `person-${index}@example.test`,
    role: Role.EMPLOYEE,
    organizationUnit: 'Test Unit',
    workTimeModel: 'Test Model',
    weeklyHours: '40',
    dailyTargetHours: '8',
    supervisorExternalId: index === 0 ? undefined : 'person-0',
    parsedRole: Role.EMPLOYEE,
    parsedWeeklyHours: 40,
    parsedDailyTargetHours: 8,
    organizationUnitId: 'ou_test',
    workTimeModelId: 'wtm_test',
    parsedEmploymentStartDate: null,
    parsedEmploymentEndDate: null,
  }));
}

describe('API HR import reconciliation batching', () => {
  it('writes 1,001 new people and supervisor links in batches of at most 500', async () => {
    const createBatchSizes: number[] = [];
    const createdPeople: Array<Record<string, unknown>> = [];
    const executeRaw = vi.fn(async () => 1);
    const transaction = {
      person: {
        findMany: vi.fn(async () => []),
        createManyAndReturn: vi.fn(async ({ data }: { data: Array<{ externalId: string }> }) => {
          createBatchSizes.push(data.length);
          createdPeople.push(...data);
          return data.map((person) => ({ id: `id-${person.externalId}`, ...person }));
        }),
      },
      $executeRaw: executeRaw,
      $queryRaw: vi.fn(async (query: { strings?: readonly string[] }) =>
        (Array.isArray(query) ? query.join('') : query.strings?.join(''))?.includes(
          'pg_try_advisory_xact_lock',
        )
          ? [{ acquired: true }]
          : [],
      ),
    } as unknown as Prisma.TransactionClient;

    const inputRows = rows(1_001);
    inputRows[0]!.employmentStartDate = '2026-09-08';
    inputRows[0]!.parsedEmploymentStartDate = new Date('2026-09-08T00:00:00.000Z');
    await expect(reconcileHrImportRows(transaction, inputRows)).resolves.toMatchObject({
      createdRows: 1_001,
      updatedRows: 0,
    });

    expect(createBatchSizes).toEqual([500, 500, 1]);
    expect(executeRaw).toHaveBeenCalledTimes(11);
    expect(transaction.person.findMany).toHaveBeenCalledTimes(1);
    expect(createdPeople[0]).toMatchObject({
      employmentStartDate: new Date('2026-09-08T00:00:00.000Z'),
      employmentEndDate: null,
    });
  });

  it('rejects a provided date that would rewrite existing employment history', async () => {
    const input = rows(1);
    input[0]!.employmentStartDate = '2026-09-08';
    input[0]!.parsedEmploymentStartDate = new Date('2026-09-08T00:00:00.000Z');
    const transaction = {
      person: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'person-id',
            externalId: 'person-0',
            email: 'person-0@example.test',
            employmentStartDate: new Date('2026-09-07T00:00:00.000Z'),
            employmentEndDate: null,
          },
        ]),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
      $executeRaw: vi.fn(),
    } as unknown as Prisma.TransactionClient;

    await expect(reconcileHrImportRows(transaction, input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(transaction.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('API HR import identity and unspecified fields', () => {
  function existingTransaction(people: object[]) {
    return {
      person: { findMany: vi.fn().mockResolvedValue(people) },
      $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
      $executeRaw: vi.fn().mockResolvedValue(1),
    } as unknown as Prisma.TransactionClient;
  }
  const stored = (externalId: string | null, email: string) => ({
    id: `id-${email}`,
    externalId,
    email,
    employmentStartDate: null,
    employmentEndDate: null,
  });

  it('keeps stored role, unit and model when the columns are absent', async () => {
    const [row] = rows(1);
    delete row!.role;
    delete row!.organizationUnit;
    delete row!.workTimeModel;
    const transaction = existingTransaction([stored('person-0', 'person-0@example.test')]);

    // The legacy employment step needs real tables; the writes under test happen before it.
    await reconcileHrImportRows(transaction, [row!]).catch(() => undefined);

    const calls = vi.mocked(transaction.$executeRaw).mock.calls as unknown as Array<
      [{ strings: string[]; values: unknown[] }]
    >;
    const update = calls.find(([query]) => query.strings.join('').includes('UPDATE "persons"'))![0];
    expect(update.strings.join('')).toContain(`COALESCE(data.role::"Role", person."role")`);
    expect(update.values.slice(5, 8)).toEqual([null, null, null]);
    // No unit/model rows are upserted for an existing person that names none.
    expect(
      calls.filter(([query]) => /organization_units|work_time_models/.test(query.strings.join(''))),
    ).toEqual([]);
  });

  it('does not reset a named model when the hours columns are absent', async () => {
    const [row] = rows(1);
    delete row!.weeklyHours;
    delete row!.dailyTargetHours;
    const transaction = existingTransaction([stored('person-0', 'person-0@example.test')]);

    await reconcileHrImportRows(transaction, [row!]).catch(() => undefined);

    const calls = vi.mocked(transaction.$executeRaw).mock.calls as unknown as Array<
      [{ strings: string[]; values: unknown[] }]
    >;
    const modelWrites = calls
      .map(([query]) => query.strings.join(''))
      .filter((sql) => sql.includes('work_time_models'));
    expect(modelWrites).toHaveLength(1);
    expect(modelWrites[0]).toContain('DO NOTHING');
  });

  it('rejects an email held by a person with another externalId', async () => {
    const transaction = existingTransaction([stored('leaver', 'person-0@example.test')]);

    await expect(reconcileHrImportRows(transaction, rows(1))).rejects.toThrow(
      /belongs to another externalId/,
    );
    expect(transaction.$executeRaw).not.toHaveBeenCalled();
  });
});
