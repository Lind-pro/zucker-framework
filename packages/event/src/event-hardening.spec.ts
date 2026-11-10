import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { DefaultTopicEventBus, matchesTopic } from './topic-event-bus';
import { vetoEvent, isEventVeto } from './event-veto';
import { UnifiedEventBus } from './unified-event-bus';
import { CreatorEventListener } from './entity-event-listener';
import { createEntityEvent, EntityEventPhase, EntityEventType, ENTITY_IS_NEW, markEntityIsNew, isNewSaveEntity } from './entity-events';
import { RedisReplayEventBus, type ReplayEventRedisClient } from './redis-replay-event-bus';

describe('DefaultTopicEventBus error policy', () => {
  it('propagates vetoed subscriber errors and stops dispatch', async () => {
    const bus = new DefaultTopicEventBus();
    const later = vi.fn();
    const error = new Error('invalid');
    bus.subscribe('t', () => { throw vetoEvent(error); }, 1);
    bus.subscribe('t', later, 2);
    await expect(bus.publish('t', {})).rejects.toBe(error);
    expect(isEventVeto(error)).toBe(true);
    expect(later).not.toHaveBeenCalled();
  });

  it('still isolates ordinary subscriber errors', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const bus = new DefaultTopicEventBus();
    const later = vi.fn();
    bus.subscribe('t', () => { throw new Error('sink down'); }, 1);
    bus.subscribe('t', later, 2);
    await expect(bus.publish('t', {})).resolves.toBeUndefined();
    expect(later).toHaveBeenCalled();
  });

  it('publishAndWait re-throws subscriber failures after all subscribers ran (L5)', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const local = new DefaultTopicEventBus();
    const unified = new UnifiedEventBus(local);
    const later = vi.fn();
    local.subscribe('t', () => { throw new Error('boom'); }, 1);
    local.subscribe('t', later, 2);
    await expect(unified.publishAndWait('t', {})).rejects.toThrow('boom');
    expect(later).toHaveBeenCalled();
  });

  it('matches patterns with several ** segments in polynomial time', () => {
    const pattern = Array.from({ length: 12 }, () => '**').join('/') + '/x';
    const topic = Array.from({ length: 40 }, (_, i) => `s${i}`).join('/');
    const started = Date.now();
    expect(matchesTopic(pattern, topic)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('CreatorEventListener (L6)', () => {
  const user = () => ({ id: 'me', name: 'Me' });

  it('overwrites client creator fields on create and strips them on modify', async () => {
    const listener = new CreatorEventListener(user);
    const created: Record<string, unknown> = { creatorId: 'victim', modifierId: 'victim' };
    await listener.onEvent(createEntityEvent(EntityEventType.CREATE, EntityEventPhase.PREPARE, 'row', created));
    expect(created).toMatchObject({ creatorId: 'me', creatorName: 'Me', modifierId: 'me' });

    const modified: Record<string, unknown> = { creatorId: 'victim', createdAt: new Date(0) };
    await listener.onEvent(createEntityEvent(EntityEventType.MODIFY, EntityEventPhase.PREPARE, 'row', modified));
    expect(modified).not.toHaveProperty('creatorId');
    expect(modified).not.toHaveProperty('createdAt');

    const saved: Record<string, unknown> = { id: 'existing' };
    await listener.onEvent(createEntityEvent(EntityEventType.SAVE, EntityEventPhase.PREPARE, 'row', [saved]));
    expect(saved).not.toHaveProperty('creatorId');
    expect(saved.modifierId).toBe('me');
  });

  it('keeps legacy behaviour with trustClientAuditFields', async () => {
    const listener = new CreatorEventListener(user, { trustClientAuditFields: true });
    const created: Record<string, unknown> = { creatorId: 'imported' };
    await listener.onEvent(createEntityEvent(EntityEventType.CREATE, EntityEventPhase.PREPARE, 'row', created));
    expect(created.creatorId).toBe('imported');
  });
});

describe('SAVE new-row marker (N-M9)', () => {
  const user = () => ({ id: 'me', name: 'Me' });
  const prepare = (entity: unknown) => createEntityEvent(EntityEventType.SAVE, EntityEventPhase.PREPARE, 'row', entity);

  it('markEntityIsNew is non-enumerable and isNewSaveEntity reads it, falling back to !id', () => {
    const entity: Record<string, unknown> = { id: 'client-id', name: 'a' };
    expect(isNewSaveEntity(entity)).toBe(false); // no marker, has an id: update
    expect(isNewSaveEntity({ name: 'b' })).toBe(true); // no marker, no id: create
    markEntityIsNew(entity, true);
    expect(isNewSaveEntity(entity)).toBe(true);
    expect(Object.keys(entity)).toEqual(['id', 'name']);
    expect(JSON.stringify(entity)).toBe('{"id":"client-id","name":"a"}');
    expect(Object.getOwnPropertySymbols(entity)).toEqual([ENTITY_IS_NEW]);
    markEntityIsNew(entity, false);
    expect(isNewSaveEntity(entity)).toBe(false);
    expect(ENTITY_IS_NEW).toBe(Symbol.for('zucker.entity.isNew'));
  });

  it('fills creator fields for a marked-new entity with a client-generated id and only modifier fields for existing rows', async () => {
    const listener = new CreatorEventListener(user);
    const fresh: Record<string, unknown> = { id: 'new', creatorId: 'victim' };
    const existing: Record<string, unknown> = { id: 'existing', creatorId: 'victim', createdAt: new Date(0) };
    markEntityIsNew(fresh, true);
    markEntityIsNew(existing, false);
    await listener.onEvent(prepare([fresh, existing]));

    expect(fresh).toMatchObject({ creatorId: 'me', creatorName: 'Me' });
    expect(fresh.createdAt).toBeInstanceOf(Date);
    expect(existing).not.toHaveProperty('creatorId');
    expect(existing).not.toHaveProperty('createdAt');
    expect(existing.modifierId).toBe('me');
  });

  it('without a marker an entity with an id is an update and one without an id is a create', async () => {
    const listener = new CreatorEventListener(user);
    const withId: Record<string, unknown> = { id: 'x' };
    const withoutId: Record<string, unknown> = {};
    await listener.onEvent(prepare([withId, withoutId]));
    expect(withId).not.toHaveProperty('creatorId');
    expect(withoutId.creatorId).toBe('me');
  });
});

describe('RedisReplayEventBus subscribe failure (runtime M12)', () => {
  it('errors streams that were handed out so clients reconnect', async () => {
    const subscriber = Object.assign(new EventEmitter(), {
      subscribe: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn(),
      quit: vi.fn().mockResolvedValue(undefined),
      duplicate: vi.fn(),
    });
    const publisher = Object.assign(new EventEmitter(), {
      publish: vi.fn().mockResolvedValue(1),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      quit: vi.fn().mockResolvedValue(undefined),
      duplicate: () => subscriber as unknown as ReplayEventRedisClient,
    });
    const bus = new RedisReplayEventBus<string, { value: number; done?: boolean }>({
      channel: (id) => `progress:${id}`,
      isTerminal: (p) => !!p.done,
      channelTtlMs: 1000,
      cleanupIntervalMs: 1000,
      createClient: () => publisher as unknown as ReplayEventRedisClient,
      parsePayload: (v) => v as { value: number },
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    bus.onModuleInit();
    const error = vi.fn();
    bus.stream('a').subscribe({ error });
    await new Promise((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalled();
    await bus.onModuleDestroy();
  });
});
