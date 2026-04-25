import { describe, it, expect } from 'vitest';
import { CASCADE_DELETE_KEY, CascadeDeleteStrategy } from './cascade-delete';
import type { CascadeAction, CascadeDeleteConfig } from './cascade-delete';

describe('CascadeDeleteConfig types', () => {
  it('should accept valid cascade actions', () => {
    const actions: CascadeAction[] = ['restrict', 'cascade', 'set-null', 'no-action'];
    for (const action of actions) {
      const config: CascadeDeleteConfig = { dataType: 'device', action };
      expect(config.action).toBe(action);
    }
  });

  it('should have correct CASCADE_DELETE_KEY value', () => {
    expect(CASCADE_DELETE_KEY).toBe('zucker:reference:cascadeDelete');
  });

  it('should create a config with restrict action', () => {
    const config: CascadeDeleteConfig = { dataType: 'user', action: 'restrict' };
    expect(config.dataType).toBe('user');
    expect(config.action).toBe('restrict');
  });

  it('should create a config with cascade action', () => {
    const config: CascadeDeleteConfig = { dataType: 'device', action: 'cascade' };
    expect(config.dataType).toBe('device');
    expect(config.action).toBe('cascade');
  });

  it('should create a config with set-null action', () => {
    const config: CascadeDeleteConfig = { dataType: 'relation', action: 'set-null' };
    expect(config.action).toBe('set-null');
  });

  it('should create a config with no-action', () => {
    const config: CascadeDeleteConfig = { dataType: 'log', action: 'no-action' };
    expect(config.action).toBe('no-action');
  });

  it('CascadeDeleteStrategy should return a decorator function', () => {
    const decorator = CascadeDeleteStrategy({ dataType: 'device', action: 'restrict' });
    expect(typeof decorator).toBe('function');
  });

  it('CascadeDeleteStrategy decorator should set metadata via SetMetadata', () => {
    const config: CascadeDeleteConfig = { dataType: 'device', action: 'cascade' };
    const decorator = CascadeDeleteStrategy(config);
    // SetMetadata returns a decorator, verify it is callable
    expect(typeof decorator).toBe('function');
    // When applied to a class, it should add metadata
    @(decorator as any)
    class TestTarget {}
    const metadata = Reflect.getMetadata(CASCADE_DELETE_KEY, TestTarget);
    expect(metadata).toEqual(config);
  });
});
