import { describe, it, expect, vi } from 'vitest';
import { DefaultEntityFactory } from './entity-factory';

describe('DefaultEntityFactory', () => {
  it('should create entity with auto-generated id and timestamps', () => {
    const factory = new DefaultEntityFactory();
    const entity = factory.create({ name: 'Test' });

    expect(entity.id).toBeDefined();
    expect(typeof entity.id).toBe('string');
    expect(entity.name).toBe('Test');
    expect(entity.createdAt).toBeInstanceOf(Date);
    expect(entity.updatedAt).toBeInstanceOf(Date);
  });

  it('should not overwrite user-provided id', () => {
    const factory = new DefaultEntityFactory();
    const entity = factory.create({ id: 'custom-id', name: 'Test' });
    expect(entity.id).toBe('custom-id');
  });

  it('should not overwrite user-provided timestamps', () => {
    const factory = new DefaultEntityFactory();
    const customDate = new Date('2020-01-01');
    const entity = factory.create({ createdAt: customDate });
    expect(entity.createdAt).toBe(customDate);
  });

  it('should use custom id generator', () => {
    let counter = 0;
    const factory = new DefaultEntityFactory({
      idGenerator: () => `id-${++counter}`,
    });

    const e1 = factory.create({});
    const e2 = factory.create({});
    expect(e1.id).toBe('id-1');
    expect(e2.id).toBe('id-2');
  });

  it('should apply defaults', () => {
    const factory = new DefaultEntityFactory({
      defaults: { status: 'active', role: 'user' },
    });
    const entity = factory.create({ name: 'Alice' });
    expect(entity.status).toBe('active');
    expect(entity.role).toBe('user');
    expect(entity.name).toBe('Alice');
  });

  it('should let user data override defaults', () => {
    const factory = new DefaultEntityFactory({
      defaults: { status: 'active' },
    });
    const entity = factory.create({ status: 'inactive' });
    expect(entity.status).toBe('inactive');
  });

  it('should generate unique ids via generateId()', () => {
    const factory = new DefaultEntityFactory();
    const ids = new Set(Array.from({ length: 50 }, () => factory.generateId()));
    expect(ids.size).toBe(50);
  });
});
