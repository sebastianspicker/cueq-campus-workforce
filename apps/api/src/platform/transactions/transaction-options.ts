/** Bulk work (closing, imports) scales with the population; Prisma's 5 s default is too short. */
export const LONG_TRANSACTION_OPTIONS = { timeout: 120_000, maxWait: 10_000 } as const;
