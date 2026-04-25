import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryThingManager } from './thing-manager';
import { ThingState } from './thing';
import type { ThingType, Thing } from './thing';
import { createMetadata } from './metadata';

const makeType = (id: string): ThingType => ({
  id,
  name: `Type-${id}`,
  metadata: createMetadata({
    properties: [{ id: 'temperature', name: 'Temperature', dataType: { id: 'float' } }],
  }),
});

const makeThing = (id: string, thingTypeId = 'sensor'): Thing => ({
  id,
  name: `Device-${id}`,
  thingTypeId,
  state: ThingState.INACTIVE,
});

describe('InMemoryThingManager', () => {
  let manager: InMemoryThingManager;

  beforeEach(() => {
    manager = new InMemoryThingManager();
  });

  describe('ThingType', () => {
    it('registers and retrieves a type', async () => {
      await manager.registerThingType(makeType('sensor'));
      const type = await manager.getThingType('sensor');
      expect(type?.id).toBe('sensor');
    });

    it('returns undefined for unknown type', async () => {
      expect(await manager.getThingType('unknown')).toBeUndefined();
    });
  });

  describe('Thing CRUD', () => {
    beforeEach(async () => {
      await manager.registerThingType(makeType('sensor'));
    });

    it('registers and retrieves a thing', async () => {
      await manager.registerThing(makeThing('d1'));
      const thing = await manager.getThing('d1');
      expect(thing?.id).toBe('d1');
    });

    it('preserves state when re-registering', async () => {
      await manager.registerThing(makeThing('d1'));
      await manager.updateState('d1', ThingState.ONLINE);
      // re-register same device (e.g. metadata update)
      await manager.registerThing({ ...makeThing('d1'), name: 'Updated' });
      const thing = await manager.getThing('d1');
      expect(thing?.name).toBe('Updated');
      expect(thing?.state).toBe(ThingState.ONLINE); // state preserved
    });

    it('unregisters a thing', async () => {
      await manager.registerThing(makeThing('d1'));
      await manager.unregisterThing('d1');
      expect(await manager.getThing('d1')).toBeUndefined();
    });
  });

  describe('updateState', () => {
    beforeEach(async () => {
      await manager.registerThingType(makeType('sensor'));
      await manager.registerThing(makeThing('d1'));
    });

    it('updates to ONLINE and records onlineTime', async () => {
      const before = Date.now();
      await manager.updateState('d1', ThingState.ONLINE);
      const thing = await manager.getThing('d1');
      expect(thing?.state).toBe(ThingState.ONLINE);
      expect(thing?.onlineTime).toBeGreaterThanOrEqual(before);
    });

    it('updates to OFFLINE and records offlineTime', async () => {
      await manager.updateState('d1', ThingState.ONLINE);
      await manager.updateState('d1', ThingState.OFFLINE);
      const thing = await manager.getThing('d1');
      expect(thing?.state).toBe(ThingState.OFFLINE);
      expect(thing?.offlineTime).toBeDefined();
    });

    it('silently ignores unknown thingId', async () => {
      await expect(manager.updateState('ghost', ThingState.ONLINE)).resolves.not.toThrow();
    });

    it('accepts custom timestamp', async () => {
      const ts = 1_700_000_000_000;
      await manager.updateState('d1', ThingState.ONLINE, ts);
      const thing = await manager.getThing('d1');
      expect(thing?.onlineTime).toBe(ts);
    });
  });

  describe('getEffectiveMetadata', () => {
    beforeEach(async () => {
      await manager.registerThingType(makeType('sensor'));
    });

    it('returns type metadata when no patch', async () => {
      await manager.registerThing(makeThing('d1'));
      const meta = await manager.getEffectiveMetadata('d1');
      expect(meta?.properties[0].id).toBe('temperature');
    });

    it('applies instance metadata patch', async () => {
      await manager.registerThing({
        ...makeThing('d1'),
        metadataPatch: {
          properties: [{ id: 'humidity', name: 'Humidity', dataType: { id: 'float' } }],
          functions: [],
          events: [],
        },
      });
      const meta = await manager.getEffectiveMetadata('d1');
      const ids = meta?.properties.map((p) => p.id);
      expect(ids).toContain('temperature');
      expect(ids).toContain('humidity');
    });

    it('returns undefined for unknown thing', async () => {
      expect(await manager.getEffectiveMetadata('ghost')).toBeUndefined();
    });

    it('returns undefined when type not registered', async () => {
      await manager.registerThing({ ...makeThing('d1'), thingTypeId: 'no-type' });
      expect(await manager.getEffectiveMetadata('d1')).toBeUndefined();
    });
  });

  describe('countOnline', () => {
    it('counts only ONLINE things', async () => {
      await manager.registerThingType(makeType('sensor'));
      await manager.registerThing(makeThing('d1'));
      await manager.registerThing(makeThing('d2'));
      await manager.registerThing(makeThing('d3'));
      await manager.updateState('d1', ThingState.ONLINE);
      await manager.updateState('d2', ThingState.ONLINE);
      expect(manager.countOnline()).toBe(2);
    });
  });
});
