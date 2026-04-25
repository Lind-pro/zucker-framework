import { describe, it, expect } from 'vitest';
import { mergeMetadata, createMetadata } from './metadata';
import type { ThingMetadata, PropertyMetadata } from './metadata';

const prop = (id: string, name = id): PropertyMetadata => ({
  id,
  name,
  dataType: { id: 'string' },
});

describe('createMetadata', () => {
  it('returns empty arrays by default', () => {
    const m = createMetadata();
    expect(m.properties).toHaveLength(0);
    expect(m.functions).toHaveLength(0);
    expect(m.events).toHaveLength(0);
    expect(m.tags).toHaveLength(0);
  });

  it('uses provided partial', () => {
    const m = createMetadata({ properties: [prop('p1')] });
    expect(m.properties).toHaveLength(1);
    expect(m.properties[0].id).toBe('p1');
  });
});

describe('mergeMetadata', () => {
  it('keeps base when patch is empty', () => {
    const base: ThingMetadata = createMetadata({ properties: [prop('p1')] });
    const result = mergeMetadata(base, {});
    expect(result.properties).toHaveLength(1);
  });

  it('adds new items from patch', () => {
    const base = createMetadata({ properties: [prop('p1')] });
    const result = mergeMetadata(base, { properties: [prop('p2')] });
    expect(result.properties).toHaveLength(2);
    expect(result.properties.map((p) => p.id)).toContain('p1');
    expect(result.properties.map((p) => p.id)).toContain('p2');
  });

  it('patch overrides base item with same id', () => {
    const base = createMetadata({ properties: [prop('p1', 'Original')] });
    const result = mergeMetadata(base, { properties: [prop('p1', 'Updated')] });
    expect(result.properties).toHaveLength(1);
    expect(result.properties[0].name).toBe('Updated');
  });

  it('merges functions and events independently', () => {
    const base = createMetadata({
      functions: [{ id: 'f1', name: 'F1', inputs: [] }],
      events: [{ id: 'e1', name: 'E1', valueType: { id: 'string' } }],
    });
    const patch: Partial<ThingMetadata> = {
      functions: [{ id: 'f2', name: 'F2', inputs: [] }],
    };
    const result = mergeMetadata(base, patch);
    expect(result.functions).toHaveLength(2);
    expect(result.events).toHaveLength(1); // unchanged
  });
});
