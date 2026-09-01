import { describe, it, expect } from 'vitest';
import {
  TenantContext,
  getCurrentTenantId,
  setCurrentTenantId,
} from './tenant-context';

describe('TenantContext', () => {
  it('getCurrentTenantId returns undefined outside context', () => {
    expect(TenantContext.getCurrentTenantId()).toBeUndefined();
  });

  it('getCurrentTenantId returns tenantId inside runWithTenant', () => {
    TenantContext.runWithTenant('t1', () => {
      expect(TenantContext.getCurrentTenantId()).toBe('t1');
    });
  });

  it('isInTenantContext returns false outside context', () => {
    expect(TenantContext.isInTenantContext()).toBe(false);
  });

  it('isInTenantContext returns true inside runWithTenant', () => {
    TenantContext.runWithTenant('t1', () => {
      expect(TenantContext.isInTenantContext()).toBe(true);
    });
  });

  it('runWithTenant returns the function result', () => {
    const result = TenantContext.runWithTenant('t1', () => 42);
    expect(result).toBe(42);
  });

  it('nested runWithTenant scopes correctly', () => {
    TenantContext.runWithTenant('outer', () => {
      expect(TenantContext.getCurrentTenantId()).toBe('outer');
      TenantContext.runWithTenant('inner', () => {
        expect(TenantContext.getCurrentTenantId()).toBe('inner');
      });
      expect(TenantContext.getCurrentTenantId()).toBe('outer');
    });
  });

  it('runWithTenantAsync resolves with tenant context', async () => {
    const result = await TenantContext.runWithTenantAsync('t2', async () => {
      expect(TenantContext.getCurrentTenantId()).toBe('t2');
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('setAttribute / getAttribute work inside context', () => {
    TenantContext.runWithTenant('t1', () => {
      TenantContext.setAttribute('dbUrl', 'postgres://t1');
      expect(TenantContext.getAttribute('dbUrl')).toBe('postgres://t1');
    });
  });

  it('setAttribute is no-op outside context', () => {
    TenantContext.setAttribute('key', 'value');
    expect(TenantContext.getAttribute('key')).toBeUndefined();
  });

  it('runWithTenantAndAttributes provides initial attributes', () => {
    TenantContext.runWithTenantAndAttributes(
      't1',
      { region: 'us-east' },
      () => {
        expect(TenantContext.getCurrentTenantId()).toBe('t1');
        expect(TenantContext.getAttribute('region')).toBe('us-east');
      },
    );
  });

  it('getAttribute returns undefined for missing key', () => {
    TenantContext.runWithTenant('t1', () => {
      expect(TenantContext.getAttribute('nonexistent')).toBeUndefined();
    });
  });

  // Shortcut functions
  it('getCurrentTenantId shortcut function works', () => {
    TenantContext.runWithTenant('t1', () => {
      expect(getCurrentTenantId()).toBe('t1');
    });
  });

  it('setCurrentTenantId shortcut function works', () => {
    const result = setCurrentTenantId('t3', () => {
      expect(getCurrentTenantId()).toBe('t3');
      return 'done';
    });
    expect(result).toBe('done');
  });
});
