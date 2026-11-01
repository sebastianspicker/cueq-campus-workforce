/** Attendance-owned time-account lifecycle used by closing orchestration. */
import type { Prisma } from '@cueq/database';

export const TIME_ACCOUNTS_PORT = Symbol('TIME_ACCOUNTS_PORT');

export type TimeAccountClosingPeriod = {
  id: string;
  organizationUnitId: string | null;
  periodStart: Date;
  periodEnd: Date;
};

export type TimeAccountReadClient = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'employmentAssignment' | 'booking' | 'absence' | 'timeAccount'
>;

type MissingTimeAccountReason = 'NO_ACCOUNT' | 'OUTDATED_ACCOUNT' | 'INCOMPATIBLE_ACCOUNT';

export type MissingTimeAccount = {
  reason: MissingTimeAccountReason;
  personId: string;
  assignmentId: string;
  periodStart: Date;
  periodEnd: Date;
};

export interface TimeAccountsPort {
  prepareClosingPeriod(
    actorId: string,
    closingPeriodId: string,
  ): Promise<{ closingPeriodId: string; created: number; existing: number }>;
  listMissingForClosing(
    tx: TimeAccountReadClient,
    period: TimeAccountClosingPeriod,
  ): Promise<MissingTimeAccount[]>;
  countMissingForClosing(
    tx: TimeAccountReadClient,
    period: TimeAccountClosingPeriod,
  ): Promise<number>;
  assertCompleteForClosing(
    tx: TimeAccountReadClient,
    period: TimeAccountClosingPeriod,
  ): Promise<void>;
}
