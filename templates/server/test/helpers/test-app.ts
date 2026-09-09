/**
 * Factory for creating a lightweight NestJS application for e2e tests.
 *
 * Mounts:
 * - ZuckerCrudModule (in-memory adapter)
 * - ZuckerAuthModule (jwt secret = 'test-secret')
 * - AuthorizationController (POST /authorize/login, GET /authorize/me)
 *
 * The AUTHENTICATION_MANAGER is a mock that accepts a seeded user map so each
 * test can define its own credentials without sharing state.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerCrudModule } from '@zucker-framework/crud';
import {
  ZuckerAuthModule,
  AuthorizationController,
  AUTHENTICATION_MANAGER,
  JwtAuthGuard,
} from '@zucker-framework/auth';
import type { AuthenticationManagerLike, AuthUser } from '@zucker-framework/auth';
import { HttpExceptionFilter } from '@zucker-framework/common';
import { InMemoryDatabaseAdapter } from './in-memory-db';

export interface TestUser {
  id: string;
  username: string;
  password: string;
  [key: string]: unknown;
}

/**
 * Create and initialize a NestJS test application.
 *
 * @param users  Seed users available for login. Defaults to a single admin user.
 */
export async function createTestApp(
  users: TestUser[] = [
    { id: 'user-admin', username: 'admin', password: 'Admin@123' },
  ],
): Promise<INestApplication> {
  const authManager: AuthenticationManagerLike = {
    async authenticate(username: string, password: string): Promise<AuthUser | null> {
      const user = users.find(
        (u) => u.username === username && u.password === password,
      );
      return user ? { id: user.id, username: user.username } : null;
    },
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      EventEmitterModule.forRoot(),
      ZuckerCrudModule.forRoot({ adapterClass: InMemoryDatabaseAdapter }),
      ZuckerAuthModule.forRoot({ jwtSecret: 'test-secret' }),
    ],
    controllers: [AuthorizationController],
    providers: [
      { provide: AUTHENTICATION_MANAGER, useValue: authManager },
      { provide: APP_GUARD, useClass: JwtAuthGuard },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
}
