import { describe, it, expect } from 'vitest';
import { TenantContext } from './tenant-context';
import { RowLevelIsolation, SchemaLevelIsolation } from './tenant-isolation';

describe('RowLevelIsolation', () => {
  const isolation = new RowLevelIsolation();

  it('has name "row-level"', () => {
    expect(isolation.name).toBe('row-level');
  });

  it('applyQueryFilter injects tenantId when in context', () => {
    TenantContext.runWithTenant('t1', () => {
      const result = isolation.applyQueryFilter({ status: 'active' });
      expect(result).toEqual({ status: 'active', tenantId: 't1' });
    });
  });

  it('applyQueryFilter returns unchanged when outside context', () => {
    const where = { status: 'active' };
    const result = isolation.applyQueryFilter(where);
    expect(result).toEqual(where);
  });

  it('applyCreateData injects tenantId when in context', () => {
    TenantContext.runWithTenant('t2', () => {
      const result = isolation.applyCreateData({ name: 'test' });
      expect(result).toEqual({ name: 'test', tenantId: 't2' });
    });
  });

  it('applyCreateData returns unchanged when outside context', () => {
    const data = { name: 'test' };
    const result = isolation.applyCreateData(data);
    expect(result).toEqual(data);
  });

  it('supports custom tenant field name', () => {
    const custom = new RowLevelIsolation('orgId');
    TenantContext.runWithTenant('org1', () => {
      const result = custom.applyQueryFilter({});
      expect(result).toEqual({ orgId: 'org1' });
    });
  });

  it('does not mutate the original where object', () => {
    const where = { status: 'active' };
    TenantContext.runWithTenant('t1', () => {
      const result = isolation.applyQueryFilter(where);
      expect(where).not.toHaveProperty('tenantId');
      expect(result).not.toBe(where);
    });
  });

  it('does not mutate the original data object', () => {
    const data = { name: 'x' };
    TenantContext.runWithTenant('t1', () => {
      const result = isolation.applyCreateData(data);
      expect(data).not.toHaveProperty('tenantId');
      expect(result).not.toBe(data);
    });
  });
});

describe('SchemaLevelIsolation', () => {
  const isolation = new SchemaLevelIsolation();

  it('has name "schema-level"', () => {
    expect(isolation.name).toBe('schema-level');
  });

  it('getSchemaName returns schema with default prefix', () => {
    TenantContext.runWithTenant('t1', () => {
      expect(isolation.getSchemaName()).toBe('tenant_t1');
    });
  });

  it('getSchemaName returns undefined outside context', () => {
    expect(isolation.getSchemaName()).toBeUndefined();
  });

  it('supports custom schema prefix', () => {
    const custom = new SchemaLevelIsolation('schema_');
    TenantContext.runWithTenant('abc', () => {
      expect(custom.getSchemaName()).toBe('schema_abc');
    });
  });

  it('applyQueryFilter returns where unchanged (no row filtering)', () => {
    TenantContext.runWithTenant('t1', () => {
      const where = { id: '1' };
      expect(isolation.applyQueryFilter(where)).toEqual(where);
    });
  });

  it('applyCreateData returns data unchanged (no row injection)', () => {
    TenantContext.runWithTenant('t1', () => {
      const data = { name: 'test' };
      expect(isolation.applyCreateData(data)).toEqual(data);
    });
  });

  it('applyQueryFilter returns where unchanged outside context', () => {
    const where = { id: '1' };
    expect(isolation.applyQueryFilter(where)).toEqual(where);
  });

  it('applyCreateData returns data unchanged outside context', () => {
    const data = { name: 'test' };
    expect(isolation.applyCreateData(data)).toEqual(data);
  });
});
