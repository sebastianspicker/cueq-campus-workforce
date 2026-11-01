import { BadRequestException } from '@nestjs/common';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { recordTerminalHeartbeat } from './terminal-heartbeat.js';

const dependencies = { prisma: { $transaction: vi.fn() }, auditHelper: {} } as never;
const token = 'dev-terminal-token';

describe('terminal heartbeat validation', () => {
  it('rejects an observedAt more than five minutes in the future', async () => {
    const observedAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await expect(
      recordTerminalHeartbeat(dependencies, token, { terminalId: 't1', observedAt }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects oversized details', async () => {
    await expect(
      recordTerminalHeartbeat(dependencies, token, {
        terminalId: 't1',
        observedAt: new Date().toISOString(),
        details: { blob: 'x'.repeat(5_000) },
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('measures details in UTF-8 bytes, not characters', async () => {
    await expect(
      recordTerminalHeartbeat(dependencies, token, {
        terminalId: 't1',
        observedAt: new Date().toISOString(),
        details: 'ü'.repeat(2_500),
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it.each(['bufferedRecords', 'errorCount'])('rejects %s above PostgreSQL int4', async (field) => {
    await expect(
      recordTerminalHeartbeat(dependencies, token, {
        terminalId: 't1',
        observedAt: new Date().toISOString(),
        [field]: 2_147_483_648,
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
