import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../persistence/prisma.service.js';
import type { AuditHelper } from '../audit/public.js';
import type { AssignmentHelper, CapabilityHelper } from '../people/public.js';
import { DocumentCommandsService } from './document-commands.service.js';
import { DocumentQueryService } from './document-query.service.js';

function fixture() {
  const tx = {
    $queryRaw: vi.fn(async (): Promise<Array<{ id: string }>> => []),
    personnelDocument: { findUniqueOrThrow: vi.fn() },
    personnelDocumentVersion: { findMany: vi.fn(), findFirst: vi.fn() },
    documentAcknowledgement: { create: vi.fn(), findUnique: vi.fn() },
    documentUpload: { create: vi.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
  } as unknown as PrismaService;
  const audit = { appendAudit: vi.fn() };
  return {
    tx,
    queries: new DocumentQueryService(prisma),
    commands: new DocumentCommandsService(
      prisma,
      {} as AssignmentHelper,
      {} as CapabilityHelper,
      audit as unknown as AuditHelper,
    ),
    audit,
  };
}

describe('document authorization before metadata, objects and acknowledgements', () => {
  it('does not query restricted metadata or versions', async () => {
    const { tx, queries } = fixture();
    await expect(queries.detail('actor', 'restricted')).rejects.toMatchObject({ status: 403 });
    await expect(queries.versions('actor', 'restricted', {})).rejects.toMatchObject({
      status: 403,
    });
    expect(tx.personnelDocument.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(tx.personnelDocumentVersion.findMany).not.toHaveBeenCalled();
  });
  it('does not inspect objects, create acknowledgements or write audit effects without access', async () => {
    const { tx, commands, audit } = fixture();
    await expect(commands.download('actor', 'restricted', 'version')).rejects.toMatchObject({
      status: 403,
    });
    await expect(commands.acknowledge('actor', 'restricted', 'version')).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      commands.upload('actor', 'restricted', 0, Buffer.from('%PDF-1.7'), 'application/pdf'),
    ).rejects.toMatchObject({ status: 403 });
    expect(tx.personnelDocumentVersion.findFirst).not.toHaveBeenCalled();
    expect(tx.documentAcknowledgement.create).not.toHaveBeenCalled();
    expect(audit.appendAudit).not.toHaveBeenCalled();
  });

  it('rejects invalid bytes before creating a durable upload intent', async () => {
    const { tx, commands } = fixture();
    tx.$queryRaw.mockResolvedValueOnce([{ id: 'document-1' }]);
    vi.stubEnv('DOCUMENT_STORAGE_ROOT', '/private/tmp/cueq-document-test');
    vi.stubEnv('DOCUMENT_ACTIVE_KEY_ID', 'test-key');
    vi.stubEnv(
      'DOCUMENT_ENCRYPTION_KEYS',
      JSON.stringify({ 'test-key': Buffer.alloc(32).toString('base64') }),
    );

    await expect(
      commands.upload('actor', 'document-1', 0, Buffer.from('not-a-pdf'), 'application/pdf'),
    ).rejects.toMatchObject({ status: 400 });

    expect(tx.documentUpload.create).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
