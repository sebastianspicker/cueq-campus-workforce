/** CLI entrypoint that emits a deterministic OpenAPI snapshot without starting the HTTP listener. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { buildOpenApiDocument } from '../openapi.js';

async function exportOpenApi(outputPath?: string): Promise<void> {
  // Document generation never serves requests; it only needs the mock provider to construct the app.
  process.env.NODE_ENV ??= 'development';
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    const document = buildOpenApiDocument(app);
    const resolvedOutput = resolve(
      process.cwd(),
      outputPath ?? 'contracts/openapi/openapi.generated.json',
    );

    await mkdir(dirname(resolvedOutput), { recursive: true });
    await writeFile(resolvedOutput, JSON.stringify(document, null, 2), 'utf8');
  } finally {
    await app.close();
  }
}

void exportOpenApi(process.argv[2]).catch((error: unknown) => {
  console.error('Failed to export OpenAPI document:', error);
  process.exitCode = 1;
});
