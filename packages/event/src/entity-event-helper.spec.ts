import { describe, it, expect, vi } from 'vitest';
import {
  isDoFireEvent,
  withoutFireEvent,
  withFireEvent,
  tryFireEvent,
  createSingleEntityEvent,
  createBatchEntityEvent,
} from './entity-event-helper';
import { EntityEventType, EntityEventPhase } from './entity-events';

describe('isDoFireEvent', () => {
  it('should return true by default (no context set)', () => {
    expect(isDoFireEvent()).toBe(true);
  });

  it('should return provided default when no context set', () => {
    expect(isDoFireEvent(false)).toBe(false);
    expect(isDoFireEvent(true)).toBe(true);
  });
});

describe('withoutFireEvent', () => {
  it('should disable fire event within callback', async () => {
    await withoutFireEvent(async () => {
      expect(isDoFireEvent()).toBe(false);
    });
  });

  it('should restore context after callback completes', async () => {
    await withoutFireEvent(async () => {
      expect(isDoFireEvent()).toBe(false);
    });
    expect(isDoFireEvent()).toBe(true);
  });

  it('should return the result of the callback', async () => {
    const result = await withoutFireEvent(async () => 42);
    expect(result).toBe(42);
  });

  it('should propagate errors from callback', async () => {
    await expect(
      withoutFireEvent(async () => {
        throw new Error('test error');
      }),
    ).rejects.toThrow('test error');
  });
});

describe('withFireEvent', () => {
  it('should enable fire event within callback', async () => {
    await withoutFireEvent(async () => {
      await withFireEvent(async () => {
        expect(isDoFireEvent()).toBe(true);
      });
    });
  });

  it('should support nested context switches', async () => {
    await withoutFireEvent(async () => {
      expect(isDoFireEvent()).toBe(false);
      await withFireEvent(async () => {
        expect(isDoFireEvent()).toBe(true);
      });
      expect(isDoFireEvent()).toBe(false);
    });
  });
});

describe('tryFireEvent', () => {
  it('should execute task when fire event is enabled (default)', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    await tryFireEvent(task);
    expect(task).toHaveBeenCalledOnce();
  });

  it('should skip task when fire event is disabled', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    await withoutFireEvent(async () => {
      await tryFireEvent(task);
    });
    expect(task).not.toHaveBeenCalled();
  });

  it('should propagate task errors', async () => {
    await expect(
      tryFireEvent(async () => {
        throw new Error('task error');
      }),
    ).rejects.toThrow('task error');
  });
});

describe('createSingleEntityEvent', () => {
  it('should create event with single entity', () => {
    const entity = { id: '1', name: 'Test' };
    const event = createSingleEntityEvent(
      EntityEventType.CREATE,
      EntityEventPhase.BEFORE,
      'user',
      entity,
    );
    expect(event.entity).toEqual(entity);
    expect(event.entityType).toBe('user');
    expect(event.type).toBe(EntityEventType.CREATE);
  });
});

describe('createBatchEntityEvent', () => {
  it('should create event with batch entities', () => {
    const entities = [{ id: '1' }, { id: '2' }, { id: '3' }];
    const event = createBatchEntityEvent(
      EntityEventType.DELETE,
      EntityEventPhase.AFTER,
      'item',
      entities,
    );
    expect(event.entity).toEqual(entities);
    expect(Array.isArray(event.entity)).toBe(true);
    expect(event.type).toBe(EntityEventType.DELETE);
    expect(event.phase).toBe(EntityEventPhase.AFTER);
  });
});
