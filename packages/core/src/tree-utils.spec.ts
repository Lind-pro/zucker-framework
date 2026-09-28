import { describe, it, expect } from 'vitest';
import { list2tree, expandTree2List, ShortCodePathStrategy } from './tree-utils';

interface TestNode { id: string; parentId?: string | null; name: string; children?: TestNode[] }
interface CustomNode { uid: string; pid: string | null; name: string; kids?: CustomNode[] }

describe('list2tree', () => {
  it('should convert flat list to tree', () => {
    const list = [
      { id: '1', parentId: null, name: 'Root' },
      { id: '2', parentId: '1', name: 'Child 1' },
      { id: '3', parentId: '1', name: 'Child 2' },
      { id: '4', parentId: '2', name: 'Grandchild' },
    ];

    const tree = list2tree<TestNode>(list);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('Root');
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children?.[0].children).toHaveLength(1);
    expect(tree[0].children?.[0].children?.[0].name).toBe('Grandchild');
  });

  it('should handle empty list', () => {
    expect(list2tree([])).toEqual([]);
  });

  it('should handle all root nodes (no parent)', () => {
    const list = [
      { id: '1', parentId: null, name: 'A' },
      { id: '2', parentId: null, name: 'B' },
    ];
    const tree = list2tree<TestNode>(list);
    expect(tree).toHaveLength(2);
  });

  it('should treat orphan nodes as roots', () => {
    const list = [
      { id: '1', parentId: 'nonexistent', name: 'Orphan' },
    ];
    const tree = list2tree<TestNode>(list);
    expect(tree).toHaveLength(1);
  });

  it('should clean up empty children arrays', () => {
    const list = [
      { id: '1', parentId: null, name: 'Leaf' },
    ];
    const tree = list2tree<TestNode>(list);
    expect(tree[0].children).toBeUndefined();
  });

  it('should support custom field names', () => {
    const list = [
      { uid: '1', pid: null, name: 'Root' },
      { uid: '2', pid: '1', name: 'Child' },
    ];
    const tree = list2tree<CustomNode>(list, {
      idField: 'uid',
      parentIdField: 'pid',
      childrenField: 'kids',
    });
    expect(tree).toHaveLength(1);
    expect(tree[0].kids).toHaveLength(1);
  });

  it('should handle undefined parentId as root', () => {
    const list = [
      { id: '1', name: 'Root' },  // no parentId
      { id: '2', parentId: '1', name: 'Child' },
    ];
    const tree = list2tree<TestNode>(list);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
  });
});

describe('expandTree2List', () => {
  it('should flatten tree to list (DFS)', () => {
    const tree = [
      {
        id: '1',
        name: 'Root',
        children: [
          { id: '2', name: 'Child 1' },
          {
            id: '3',
            name: 'Child 2',
            children: [
              { id: '4', name: 'Grandchild' },
            ],
          },
        ],
      },
    ];
    const list = expandTree2List(tree);
    expect(list).toHaveLength(4);
    expect(list.map((n) => n.id)).toEqual(['1', '2', '3', '4']);
  });

  it('should remove children field by default', () => {
    const tree = [{ id: '1', children: [{ id: '2' }] }];
    const list = expandTree2List(tree);
    expect(list[0]).not.toHaveProperty('children');
  });

  it('should keep children when keepChildren is true', () => {
    const tree = [{ id: '1', children: [{ id: '2' }] }];
    const list = expandTree2List(tree, { keepChildren: true });
    expect(list[0]).toHaveProperty('children');
  });

  it('should handle empty tree', () => {
    expect(expandTree2List([])).toEqual([]);
  });

  it('should handle tree with no children', () => {
    const tree = [{ id: '1', name: 'Leaf' }];
    const list = expandTree2List(tree);
    expect(list).toHaveLength(1);
  });
});

describe('ShortCodePathStrategy', () => {
  it('should generate segments of specified length', () => {
    const strategy = new ShortCodePathStrategy(6);
    const segment = strategy.generateSegment();
    expect(segment).toHaveLength(6);
    expect(segment).toMatch(/^[a-z0-9]+$/);
  });

  it('should generate segments of default length 4', () => {
    const strategy = new ShortCodePathStrategy();
    const segment = strategy.generateSegment();
    expect(segment).toHaveLength(4);
  });

  it('should generate different segments on each call', () => {
    const strategy = new ShortCodePathStrategy(8);
    const segments = new Set(Array.from({ length: 50 }, () => strategy.generateSegment()));
    // With 8 chars from 36-char alphabet, collisions are extremely unlikely
    expect(segments.size).toBeGreaterThan(40);
  });
});
