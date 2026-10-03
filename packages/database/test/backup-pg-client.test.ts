import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error JavaScript tooling has no declaration file.
import { createPgTools } from '../scripts/backup-restore/pg-client.mjs';

describe('backup PostgreSQL client credentials', () => {
  it('passes PGPASSWORD through the child environment and never Docker argv', () => {
    const execute = vi.fn();
    const tools = createPgTools({ execFileSync: execute, postgresClientImage: 'postgres:test' });
    const connection = {
      host: 'host.docker.internal',
      port: '5432',
      user: 'cueq',
      password: 'synthetic $ecret with spaces',
      database: 'cueq',
      schema: 'public',
      needsHostGateway: true,
    };

    tools.runPsql(connection, 'postgres', 'SELECT 1', '/private/tmp/backup-test');

    const [, args, options] = execute.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(args).toContain('PGPASSWORD');
    expect(args.join(' ')).not.toContain(connection.password);
    expect(options.env.PGPASSWORD).toBe(connection.password);
  });

  it('rethrows a bounded error without command arguments or secrets', () => {
    const execute = vi.fn(() => {
      throw new Error('Command failed with synthetic-secret');
    });
    const tools = createPgTools({ execFileSync: execute, postgresClientImage: 'postgres:test' });

    expect(() =>
      tools.runPsql(
        {
          host: 'database',
          port: '5432',
          user: 'cueq',
          password: 'synthetic-secret',
          database: 'cueq',
          schema: 'public',
          needsHostGateway: false,
        },
        'postgres',
        'SELECT 1',
        '/private/tmp/backup-test',
      ),
    ).toThrow('PostgreSQL client command failed.');
  });
});
