import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HttpAdapterHost } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { PrismaExceptionFilter } from './platform/http/filters/prisma-exception.filter.js';
import { ZodExceptionFilter } from './platform/http/filters/zod-exception.filter.js';
import { buildCorsOptions } from './platform/http/cors-options.js';
import { resolveDevelopmentListenHost } from './platform/http/development-listen-host.js';
import { assertWebhookSecretEncryptionKey } from './modules/integrations/public.js';
import { isDevelopmentOrTest } from './platform/runtime-environment.js';
import {
  DEFAULT_JSON_LIMIT,
  LARGE_JSON_LIMIT,
  matchesDefaultJsonBody,
  matchesLargeJsonBody,
} from './platform/http/json-body-limits.js';
import { buildOpenApiDocument } from './openapi.js';

async function bootstrap() {
  assertWebhookSecretEncryptionKey();
  // Only the bulk import routes get 3 MB (documented 2 MB imports); body-parser skips already-parsed
  // requests, so the large-route parser must be registered first.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser('json', { limit: LARGE_JSON_LIMIT, type: matchesLargeJsonBody });
  app.useBodyParser('json', { limit: DEFAULT_JSON_LIMIT, type: matchesDefaultJsonBody });
  app.use(helmet());
  app.enableCors(buildCorsOptions());
  const httpAdapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(new PrismaExceptionFilter(), new ZodExceptionFilter(httpAdapterHost));

  // Swagger routes bypass APP_GUARD, so documentation must only be mounted in development and test.
  if (isDevelopmentOrTest()) {
    const document = buildOpenApiDocument(app);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT ?? 3001;
  const host = resolveDevelopmentListenHost();
  if (host) {
    await app.listen(port, host);
  } else {
    await app.listen(port);
  }
  console.log(
    host ? `cueq API running on http://${host}:${port}` : `cueq API listening on port ${port}`,
  );
  if (isDevelopmentOrTest()) {
    console.log(`OpenAPI docs at http://${host}:${port}/api/docs`);
  }
}

bootstrap();
