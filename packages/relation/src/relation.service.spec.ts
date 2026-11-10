import { describe, it, expect, beforeEach } from 'vitest';
import { RelationService, InMemoryRelationStore, generateRelationKey } from './relation.service';

describe('generateRelationKey', () => {
  it('should produce consistent MD5 hex hash', () => {
    const key1 = generateRelationKey('user', '1');
    const key2 = generateRelationKey('user', '1');
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(32); // MD5 hex
  });

  it('should produce different keys for different inputs', () => {
    expect(generateRelationKey('a', 'b')).not.toBe(generateRelationKey('c', 'd'));
  });
});

describe('RelationService with InMemoryRelationStore', () => {
  let service: RelationService;

  beforeEach(() => {
    service = new RelationService(new InMemoryRelationStore());
  });

  it('should bind a relation and retrieve it', async () => {
    await service.bind('user', 'u1', 'owns', 'device', 'd1');
    const related = await service.getRelated('user', 'u1');
    expect(related).toHaveLength(1);
    expect(related[0].targetId).toBe('d1');
    expect(related[0].relation).toBe('owns');
  });

  it('should retrieve related filtered by relation name', async () => {
    await service.bind('user', 'u1', 'owns', 'device', 'd1');
    await service.bind('user', 'u1', 'manages', 'device', 'd2');
    const owns = await service.getRelated('user', 'u1', 'owns');
    expect(owns).toHaveLength(1);
    expect(owns[0].targetId).toBe('d1');
  });

  it('should unbind a specific relation', async () => {
    await service.bind('user', 'u1', 'owns', 'device', 'd1');
    await service.unbind('user', 'u1', 'owns', 'device', 'd1');
    const related = await service.getRelated('user', 'u1');
    expect(related).toHaveLength(0);
  });

  it('should unbindAll relations for a source', async () => {
    await service.bind('user', 'u1', 'owns', 'device', 'd1');
    await service.bind('user', 'u1', 'manages', 'device', 'd2');
    await service.unbindAll('user', 'u1');
    const related = await service.getRelated('user', 'u1');
    expect(related).toHaveLength(0);
  });

  it('should deduplicate on bind (upsert)', async () => {
    await service.bind('user', 'u1', 'owns', 'device', 'd1', { note: 'first' });
    await service.bind('user', 'u1', 'owns', 'device', 'd1', { note: 'second' });
    const related = await service.getRelated('user', 'u1');
    expect(related).toHaveLength(1);
    expect(related[0].metadata).toEqual({ note: 'second' });
  });

  it('should support reverse relation lookup', async () => {
    await service.bind('user', 'u1', 'owns', 'device', 'd1');
    await service.bind('user', 'u2', 'owns', 'device', 'd1');
    const reverse = await service.getReverseRelated('device', 'd1');
    expect(reverse).toHaveLength(2);
  });

  it('should saveRelated (batch replace) for a relation+targetType', async () => {
    await service.bind('user', 'u1', 'follows', 'user', 'u2');
    await service.bind('user', 'u1', 'follows', 'user', 'u3');
    // Replace with new set
    await service.saveRelated('user', 'u1', 'follows', 'user', [
      { id: 'u4', name: 'User 4' },
      { id: 'u5', name: 'User 5' },
    ]);
    const related = await service.getRelated('user', 'u1', 'follows');
    expect(related).toHaveLength(2);
    const ids = related.map((r) => r.targetId).sort();
    expect(ids).toEqual(['u4', 'u5']);
  });

  it('should store targetName and metadata', async () => {
    await service.bind('user', 'u1', 'owns', 'device', 'd1', { key: 'val' }, 'Device One');
    const related = await service.getRelated('user', 'u1');
    expect(related[0].targetName).toBe('Device One');
    expect(related[0].metadata).toEqual({ key: 'val' });
  });

  it('should populate sourceKey and targetKey', async () => {
    await service.bind('user', 'u1', 'owns', 'device', 'd1');
    const related = await service.getRelated('user', 'u1');
    expect(related[0].sourceKey).toBe(generateRelationKey('user', 'u1'));
    expect(related[0].targetKey).toBe(generateRelationKey('device', 'd1'));
  });
});

describe('RelationService.saveRelated (review L9)', () => {
  it('uses the store\'s atomic replaceRelated when available', async () => {
    const store = new InMemoryRelationStore();
    const replaced: unknown[] = [];
    const atomic = Object.assign(store, {
      replaceRelated: async (_st: string, _si: string, _r: string, _tt: string, relations: unknown[]) => {
        replaced.push(...relations);
      },
    });
    const service = new RelationService(atomic);
    await service.saveRelated('user', 'u1', 'member', 'org', [{ id: 'o1', name: 'Org' }]);
    expect(replaced).toEqual([
      expect.objectContaining({ sourceId: 'u1', targetId: 'o1', targetName: 'Org', targetKey: generateRelationKey('org', 'o1') }),
    ]);
    expect(await store.findRelated('user', 'u1')).toHaveLength(0);
  });
});
