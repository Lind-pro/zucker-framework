import { describe, it, expect } from 'vitest';
import {
  EntityEventType,
  EntityEventPhase,
  createEntityEvent,
  getEntityEventName,
} from './entity-events';

describe('EntityEventType', () => {
  it('should have correct enum values', () => {
    expect(EntityEventType.CREATE).toBe('create');
    expect(EntityEventType.MODIFY).toBe('modify');
    expect(EntityEventType.DELETE).toBe('delete');
    expect(EntityEventType.SAVE).toBe('save');
    expect(EntityEventType.QUERY).toBe('query');
  });

  it('should alias UPDATE to MODIFY', () => {
    expect(EntityEventType.UPDATE).toBe(EntityEventType.MODIFY);
  });
});

describe('EntityEventPhase', () => {
  it('should have correct enum values', () => {
    expect(EntityEventPhase.PREPARE).toBe('prepare');
    expect(EntityEventPhase.BEFORE).toBe('before');
    expect(EntityEventPhase.AFTER).toBe('after');
  });
});

describe('createEntityEvent', () => {
  it('should create event with correct type and phase', () => {
    const event = createEntityEvent(
      EntityEventType.CREATE,
      EntityEventPhase.BEFORE,
      'user',
      { id: '1', name: 'Alice' },
    );
    expect(event.type).toBe(EntityEventType.CREATE);
    expect(event.phase).toBe(EntityEventPhase.BEFORE);
    expect(event.entityType).toBe('user');
    expect(event.entity).toEqual({ id: '1', name: 'Alice' });
  });

  it('should set timestamp', () => {
    const before = Date.now();
    const event = createEntityEvent(EntityEventType.CREATE, EntityEventPhase.BEFORE, 'user', {});
    const after = Date.now();
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);
  });

  it('should default cancelled to false', () => {
    const event = createEntityEvent(EntityEventType.DELETE, EntityEventPhase.BEFORE, 'order', {});
    expect(event.cancelled).toBe(false);
    expect(event.cancelReason).toBeUndefined();
  });

  it('should cancel event without reason', () => {
    const event = createEntityEvent(EntityEventType.MODIFY, EntityEventPhase.BEFORE, 'user', {});
    event.cancel();
    expect(event.cancelled).toBe(true);
    expect(event.cancelReason).toBeUndefined();
  });

  it('should cancel event with reason', () => {
    const event = createEntityEvent(EntityEventType.MODIFY, EntityEventPhase.BEFORE, 'user', {});
    event.cancel('not allowed');
    expect(event.cancelled).toBe(true);
    expect(event.cancelReason).toBe('not allowed');
  });

  it('should support batch entity (array)', () => {
    const entities = [{ id: '1' }, { id: '2' }];
    const event = createEntityEvent(EntityEventType.CREATE, EntityEventPhase.AFTER, 'item', entities);
    expect(event.entity).toEqual(entities);
    expect(Array.isArray(event.entity)).toBe(true);
  });

  it('should remain cancelled once cancelled', () => {
    const event = createEntityEvent(EntityEventType.DELETE, EntityEventPhase.BEFORE, 'user', {});
    event.cancel('first');
    event.cancel('second');
    expect(event.cancelled).toBe(true);
    expect(event.cancelReason).toBe('second');
  });

  it('should support all event type and phase combinations', () => {
    for (const type of [EntityEventType.CREATE, EntityEventType.MODIFY, EntityEventType.DELETE, EntityEventType.SAVE, EntityEventType.QUERY]) {
      for (const phase of [EntityEventPhase.PREPARE, EntityEventPhase.BEFORE, EntityEventPhase.AFTER]) {
        const event = createEntityEvent(type, phase, 'test', {});
        expect(event.type).toBe(type);
        expect(event.phase).toBe(phase);
      }
    }
  });
});

describe('getEntityEventName', () => {
  it('should generate correct event name', () => {
    expect(getEntityEventName('user', EntityEventType.CREATE, EntityEventPhase.BEFORE)).toBe(
      'entity/user/create/before',
    );
  });

  it('should generate name for all phases', () => {
    expect(getEntityEventName('order', EntityEventType.DELETE, EntityEventPhase.PREPARE)).toBe(
      'entity/order/delete/prepare',
    );
    expect(getEntityEventName('order', EntityEventType.DELETE, EntityEventPhase.AFTER)).toBe(
      'entity/order/delete/after',
    );
  });

  it('should use slash delimiter for wildcard compatibility', () => {
    const name = getEntityEventName('product', EntityEventType.SAVE, EntityEventPhase.BEFORE);
    const parts = name.split('/');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('entity');
    expect(parts[1]).toBe('product');
    expect(parts[2]).toBe('save');
    expect(parts[3]).toBe('before');
  });
});
