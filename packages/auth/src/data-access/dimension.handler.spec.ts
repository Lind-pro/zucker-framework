import { describe, expect, it } from 'vitest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DimensionDataAccessHandler } from './dimension.handler';
import { DimensionService } from '../services/dimension.service';
import { DATABASE_ADAPTER } from '../guards/data-permission.guard';
import { DefaultDataAccessType } from './data-access-config';
import type { AuthorizingContext } from './data-access-handler';

const config = { type: DefaultDataAccessType.DIMENSION_SCOPE, action: 'query' } as never;
const ctx = { authentication: { getUser: () => ({ id: 'u1' }) }, request: { params: {} }, dataType: 'orders' } as unknown as AuthorizingContext;

describe('DimensionDataAccessHandler (H1)', () => {
  it('receives DimensionService through Nest DI and denies users without dimensions', async () => {
    @Module({ providers: [{ provide: DATABASE_ADAPTER, useValue: {} }, DimensionService, DimensionDataAccessHandler] })
    class TestModule {}
    const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
    try {
      const handler = app.get(DimensionDataAccessHandler);
      expect((handler as unknown as { dimensionService?: unknown }).dimensionService).toBeInstanceOf(DimensionService);
      expect((await handler.handle(config, ctx)).allowed).toBe(false);
    } finally { await app.close(); }
  });

  it('fails closed when no DimensionService is available', async () => {
    const handler = new DimensionDataAccessHandler({} as never, undefined);
    expect((await handler.handle(config, ctx)).allowed).toBe(false);
  });
});
