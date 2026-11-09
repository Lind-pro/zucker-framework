import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { AppModule } from './app.module';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applicationCorsOptions, trustProxySetting } from './http-options';

async function bootstrap() {
  const startTime = performance.now();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  // Per-IP rate limits need the real client address behind a reverse proxy (see TRUST_PROXY).
  const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  else if (process.env.NODE_ENV === 'production')
    Logger.warn('TRUST_PROXY is not set: if this server runs behind a proxy or load balancer, all clients share its address and per-IP rate limits', 'Bootstrap');
  const bootstrapTime = performance.now() - startTime;
  Logger.log(`NestJS module init completed in ${bootstrapTime.toFixed(0)}ms`, 'Bootstrap');

  app.enableCors(applicationCorsOptions(process.env));
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new HttpExceptionFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      // NOTE: whitelist 和 forbidNonWhitelisted 需要 class-validator DTO 才有效。
      // 当前 controller 大多使用 inline interface，启用 whitelist 会导致 body 被清空。
      // TODO: 迁移到 DTO class 后重新启用 whitelist: true, forbidNonWhitelisted: true
      transform: true,
    }),
  );

  const port = process.env.PORT || 4200;
  await app.listen(port);

  // Account creation and role assignment are explicit setup operations, never startup side effects.

  const totalTime = performance.now() - startTime;
  Logger.log(
    `Server ready on http://localhost:${port} (total: ${totalTime.toFixed(0)}ms)`,
    'Bootstrap',
  );
}

bootstrap();
