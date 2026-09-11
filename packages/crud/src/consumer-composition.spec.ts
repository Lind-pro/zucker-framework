// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { Inject, Injectable, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { CrudService } from './base.service';
import { BaseController } from './base.controller';
import type { DynamicQueryService } from './dynamic-query.service';

class Entity {
  id!: string;
}
@Injectable()
class Service extends CrudService<Entity> {
  constructor(
    @Inject('PRODUCT') readonly product: string,
    @Inject(DATABASE_ADAPTER) database: DatabaseAdapter,
  ) {
    super(database, {} as DynamicQueryService, 'records');
  }
}
describe('direct CRUD composition', () => {
  it('preserves a custom constructor layout without inherited parameter-token overrides', async () => {
    const record = { id: 'one' };
    const module = await NestFactory.createApplicationContext(
      {
        module: class TestCompositionModule {},
        providers: [
          Service,
          { provide: 'PRODUCT', useValue: 'product-setting' },
          {
            provide: DATABASE_ADAPTER,
            useValue: { model: () => ({ findUnique: vi.fn().mockResolvedValue(record) }) },
          },
        ],
      },
      { logger: false, abortOnError: false },
    );
    expect(module.get(Service).product).toBe('product-setting');
    expect(await module.get(Service).findOne('one')).toEqual(record);
    await module.close();
  });
  it('applies only configured routes and keeps independent factories unchanged', () => {
    const configured = BaseController(Entity, {
      only: ['findAll', 'update', 'saveOrUpdate'],
      routes: {
        update: { method: 'PATCH', path: ':id' },
        saveOrUpdate: { method: 'PATCH', path: 'save' },
      },
    });
    const defaults = BaseController(Entity);
    expect(Reflect.get(configured.prototype, 'create')).toBeUndefined();
    expect(Reflect.get(defaults.prototype, 'saveOrUpdate')).toBeUndefined();
    expect(Reflect.getMetadata(METHOD_METADATA, configured.prototype.update)).toBe(
      RequestMethod.PATCH,
    );
    expect(Reflect.getMetadata(PATH_METADATA, configured.prototype.saveOrUpdate)).toBe('save');
    expect(Reflect.getMetadata(METHOD_METADATA, defaults.prototype.update)).toBe(RequestMethod.PUT);
    const order = Object.getOwnPropertyNames(configured.prototype);
    expect(order.indexOf('saveOrUpdate')).toBeLessThan(order.indexOf('update'));
  });
});
