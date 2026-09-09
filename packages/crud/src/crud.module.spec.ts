import { DATABASE_ADAPTER as CORE_DATABASE_ADAPTER } from '@zucker-framework/core';
import { DATABASE_ADAPTER as CRUD_DATABASE_ADAPTER } from './crud.module';

describe('DATABASE_ADAPTER compatibility export', () => {
  it('uses the shared core injection token', () => {
    expect(CRUD_DATABASE_ADAPTER).toBe(CORE_DATABASE_ADAPTER);
  });
});
