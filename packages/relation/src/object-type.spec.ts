import { describe, it, expect, beforeEach } from 'vitest';
import { ObjectTypeRegistry, CompositeObjectType, OBJECT_TYPE_IDS } from './object-type';
import type { ObjectType, RelationObjectProvider } from './object-type';

function makeObjectType(id: string, overrides?: Partial<ObjectType>): ObjectType {
  return {
    id,
    name: id,
    properties: [],
    relations: [],
    ...overrides,
  };
}

describe('ObjectTypeRegistry', () => {
  let registry: ObjectTypeRegistry;

  beforeEach(() => {
    registry = new ObjectTypeRegistry();
  });

  it('should register and retrieve an object type', () => {
    const type = makeObjectType('user');
    registry.register(type);
    expect(registry.get('user')).toBe(type);
  });

  it('should return undefined for unregistered type', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('should unregister an object type', () => {
    registry.register(makeObjectType('user'));
    registry.unregister('user');
    expect(registry.get('user')).toBeUndefined();
  });

  it('should return all registered types', () => {
    registry.register(makeObjectType('a'));
    registry.register(makeObjectType('b'));
    expect(registry.getAll()).toHaveLength(2);
  });

  it('should get relations for a type', () => {
    registry.register(
      makeObjectType('device', {
        relations: [
          { id: 'r1', name: 'owner', targetType: 'user', relationType: 'many-to-one', direction: 'forward' },
          { id: 'r2', name: 'group', targetType: 'group', relationType: 'many-to-one', direction: 'forward' },
        ],
      }),
    );
    expect(registry.getRelations('device')).toHaveLength(2);
    expect(registry.getRelations('unknown')).toEqual([]);
  });

  it('should filter relations by target type', () => {
    registry.register(
      makeObjectType('device', {
        relations: [
          { id: 'r1', name: 'owner', targetType: 'user', relationType: 'many-to-one', direction: 'forward' },
          { id: 'r2', name: 'group', targetType: 'group', relationType: 'many-to-one', direction: 'forward' },
        ],
      }),
    );
    const userRelations = registry.getRelationsForTarget('device', 'user');
    expect(userRelations).toHaveLength(1);
    expect(userRelations[0].name).toBe('owner');
  });

  it('should register and retrieve providers', () => {
    const provider: RelationObjectProvider = {
      getTypeId: () => 'device',
      getType: async () => makeObjectType('device'),
    };
    registry.registerProvider(provider);
    expect(registry.getProvider('device')).toBe(provider);
    expect(registry.getAllProviders()).toHaveLength(1);
  });

  it('should unregister providers', () => {
    const provider: RelationObjectProvider = {
      getTypeId: () => 'device',
      getType: async () => makeObjectType('device'),
    };
    registry.registerProvider(provider);
    registry.unregisterProvider('device');
    expect(registry.getProvider('device')).toBeUndefined();
  });
});

describe('CompositeObjectType', () => {
  it('should use main id and name', () => {
    const main = makeObjectType('main', { description: 'Main type' });
    const second = makeObjectType('second', { description: 'Second type' });
    const composite = new CompositeObjectType(main, second);
    expect(composite.id).toBe('main');
    expect(composite.name).toBe('main');
  });

  it('should fall back to second description when main has none', () => {
    const main = makeObjectType('main');
    const second = makeObjectType('second', { description: 'Fallback desc' });
    const composite = new CompositeObjectType(main, second);
    expect(composite.description).toBe('Fallback desc');
  });

  it('should merge properties from both types', () => {
    const main = makeObjectType('main', {
      properties: [{ key: 'a', name: 'A', type: 'string' }],
    });
    const second = makeObjectType('second', {
      properties: [{ key: 'b', name: 'B', type: 'number' }],
    });
    const composite = new CompositeObjectType(main, second);
    expect(composite.properties).toHaveLength(2);
  });

  it('should merge relations from both types', () => {
    const main = makeObjectType('main', {
      relations: [{ id: 'r1', name: 'rel1', targetType: 'x', relationType: 'one-to-one', direction: 'forward' }],
    });
    const second = makeObjectType('second', {
      relations: [{ id: 'r2', name: 'rel2', targetType: 'y', relationType: 'one-to-many', direction: 'reverse' }],
    });
    const composite = new CompositeObjectType(main, second);
    expect(composite.relations).toHaveLength(2);
  });

  it('should merge relatedTypes from both types', () => {
    const related1 = makeObjectType('r1');
    const related2 = makeObjectType('r2');
    const main = makeObjectType('main', { relatedTypes: [related1] });
    const second = makeObjectType('second', { relatedTypes: [related2] });
    const composite = new CompositeObjectType(main, second);
    expect(composite.relatedTypes).toHaveLength(2);
  });

  it('should merge expands with main taking precedence', () => {
    const main = makeObjectType('main', { expands: { a: 1, b: 2 } });
    const second = makeObjectType('second', { expands: { b: 99, c: 3 } });
    const composite = new CompositeObjectType(main, second);
    expect(composite.expands).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('should handle undefined relatedTypes gracefully', () => {
    const main = makeObjectType('main');
    const second = makeObjectType('second');
    const composite = new CompositeObjectType(main, second);
    expect(composite.relatedTypes).toEqual([]);
  });
});

describe('OBJECT_TYPE_IDS', () => {
  it('should have expected constant values', () => {
    expect(OBJECT_TYPE_IDS.USER).toBe('user');
    expect(OBJECT_TYPE_IDS.DEVICE).toBe('device');
  });
});
