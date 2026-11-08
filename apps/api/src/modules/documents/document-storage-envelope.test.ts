import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentObjectStorage } from '@cueq/database';

const MAGIC = 'CUEQDOC1\n';
const roots: string[] = [];

afterEach(async () => {
  // Only directories created by mkdtemp under the OS temp dir are removed.
  for (const root of roots.splice(0)) {
    if (root.startsWith(await realpath(tmpdir()))) await rm(root, { recursive: true, force: true });
  }
});

describe('document object envelope', () => {
  it('rejects an envelope whose GCM tag was truncated, even with a matching checksum', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cueq-doc-')));
    roots.push(root);
    const storage = new DocumentObjectStorage({
      root,
      activeKeyId: 'k1',
      keys: { k1: randomBytes(32).toString('base64') },
    });
    const manifest = await storage.write(Buffer.from('%PDF-1.7 test'), 'application/pdf');
    const path = join(root, manifest.objectKey);
    const envelope = await readFile(path);
    const end = envelope.indexOf(10, MAGIC.length);
    const header = JSON.parse(envelope.subarray(MAGIC.length, end).toString('utf8')) as {
      tag: string;
    };
    header.tag = Buffer.from(header.tag, 'base64').subarray(0, 4).toString('base64');
    const forged = Buffer.concat([
      Buffer.from(MAGIC + JSON.stringify(header) + '\n'),
      envelope.subarray(end + 1),
    ]);
    await writeFile(path, forged);

    await expect(
      storage.read({
        ...manifest,
        encryptedChecksum: createHash('sha256').update(forged).digest('hex'),
      }),
    ).rejects.toThrow();
  });
});
