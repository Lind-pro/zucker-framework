import { describe, it, expect, beforeEach } from 'vitest';
import { TreeService } from './tree.service';
import { InMemoryAdapter } from './in-memory-adapter';
import { DynamicQueryService, DynamicQueryParamService } from './dynamic-query.service';
import {
  FilterOperatorFactory,
  EqualsOperator,
  NotEqualsOperator,
  LikeOperator,
  ContainsOperator,
  GtOperator,
  GteOperator,
  LtOperator,
  LteOperator,
  InOperator,
  NotInOperator,
  IsNullOperator,
  IsNotNullOperator,
  BetweenOperator,
  HasOperator,
  HasSomeOperator,
  NotLikeOperator,
  StartsWithOperator,
  EndsWithOperator,
  EmptyOperator,
  NotEmptyOperator,
} from './operators';
import type { TreeSortSupportEntity } from '@zucker-framework/core';

// ---------------------------------------------------------------------------
// Test entity type
// ---------------------------------------------------------------------------
interface TreeNode extends TreeSortSupportEntity {
  id: string;
  name: string;
  parentId?: string | null;
  path?: string;
  level?: number;
  sortIndex?: number;
  children?: TreeNode[];
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Concrete TreeService subclass for testing
// ---------------------------------------------------------------------------
class TestTreeService extends TreeService<TreeNode> {
  constructor(db: InMemoryAdapter, dynamicQuery: DynamicQueryService) {
    super(db, dynamicQuery, 'treeNode', undefined, undefined);
  }
}

// ---------------------------------------------------------------------------
// Helper: build dependencies (same pattern as base.service.spec.ts)
// ---------------------------------------------------------------------------
function buildDeps(db: InMemoryAdapter) {
  const operators = [
    new EqualsOperator(),
    new NotEqualsOperator(),
    new LikeOperator(),
    new ContainsOperator(),
    new GtOperator(),
    new GteOperator(),
    new LtOperator(),
    new LteOperator(),
    new InOperator(),
    new NotInOperator(),
    new IsNullOperator(),
    new IsNotNullOperator(),
    new BetweenOperator(),
    new HasOperator(),
    new HasSomeOperator(),
    new NotLikeOperator(),
    new StartsWithOperator(),
    new EndsWithOperator(),
    new EmptyOperator(),
    new NotEmptyOperator(),
  ];
  const factory = new FilterOperatorFactory(operators);
  const paramService = new DynamicQueryParamService(factory);
  const dynamicQuery = new DynamicQueryService(db, paramService);
  return { dynamicQuery };
}

// ---------------------------------------------------------------------------
// Helper: directly insert a node into InMemoryAdapter (bypassing service logic)
// ---------------------------------------------------------------------------
async function insertNode(db: InMemoryAdapter, node: Partial<TreeNode>): Promise<TreeNode> {
  return db.model('treeNode').create({ data: node }) as Promise<TreeNode>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('TreeService', () => {
  let db: InMemoryAdapter;
  let service: TestTreeService;

  beforeEach(() => {
    db = new InMemoryAdapter();
    const { dynamicQuery } = buildDeps(db);
    service = new TestTreeService(db, dynamicQuery);
  });

  // ======================== findAsTree ========================
  describe('findAsTree', () => {
    it('should build a tree structure from flat data', async () => {
      // Insert flat nodes
      await insertNode(db, { id: 'root1', name: 'Root 1', parentId: null, sortIndex: 1, path: 'root1', level: 0 });
      await insertNode(db, { id: 'child1', name: 'Child 1', parentId: 'root1', sortIndex: 1, path: 'root1/child1', level: 1 });
      await insertNode(db, { id: 'child2', name: 'Child 2', parentId: 'root1', sortIndex: 2, path: 'root1/child2', level: 1 });
      await insertNode(db, { id: 'grandchild1', name: 'Grandchild 1', parentId: 'child1', sortIndex: 1, path: 'root1/child1/grandchild1', level: 2 });

      const tree = await service.findAsTree();

      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe('root1');
      expect(tree[0].children).toHaveLength(2);
      expect(tree[0].children![0].id).toBe('child1');
      expect(tree[0].children![0].children).toHaveLength(1);
      expect(tree[0].children![0].children![0].id).toBe('grandchild1');
      expect(tree[0].children![1].id).toBe('child2');
    });

    it('should return empty array when no data', async () => {
      const tree = await service.findAsTree();
      expect(tree).toEqual([]);
    });

    it('should handle multiple root nodes', async () => {
      await insertNode(db, { id: 'r1', name: 'Root 1', parentId: null, sortIndex: 1, path: 'r1', level: 0 });
      await insertNode(db, { id: 'r2', name: 'Root 2', parentId: null, sortIndex: 2, path: 'r2', level: 0 });

      const tree = await service.findAsTree();
      expect(tree).toHaveLength(2);
    });
  });

  // ======================== create ========================
  describe('create', () => {
    it('should auto-calculate path and level for root node', async () => {
      const node = await service.create({ id: 'root1', name: 'Root 1' } as Partial<TreeNode>);

      expect(node.id).toBe('root1');
      expect(node.path).toBe('root1');
      expect(node.level).toBe(0);
    });

    it('should auto-calculate path and level for child node', async () => {
      await service.create({ id: 'root1', name: 'Root 1' } as Partial<TreeNode>);
      const child = await service.create({ id: 'child1', name: 'Child 1', parentId: 'root1' } as Partial<TreeNode>);

      expect(child.path).toBe('root1/child1');
      expect(child.level).toBe(1);
    });

    it('should auto-calculate sortIndex (max + 1 among siblings)', async () => {
      await service.create({ id: 'root1', name: 'Root 1' } as Partial<TreeNode>);
      const child1 = await service.create({ id: 'c1', name: 'C1', parentId: 'root1' } as Partial<TreeNode>);
      const child2 = await service.create({ id: 'c2', name: 'C2', parentId: 'root1' } as Partial<TreeNode>);

      expect(child1.sortIndex).toBe(1);
      expect(child2.sortIndex).toBe(2);
    });

    it('should respect explicit sortIndex', async () => {
      const node = await service.create({ id: 'root1', name: 'Root 1', sortIndex: 99 } as Partial<TreeNode>);
      expect(node.sortIndex).toBe(99);
    });
  });

  // ======================== delete ========================
  describe('delete', () => {
    it('should cascade delete child nodes via path prefix', async () => {
      await insertNode(db, { id: 'root1', name: 'Root', parentId: null, path: 'root1', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'child1', name: 'Child', parentId: 'root1', path: 'root1/child1', level: 1, sortIndex: 1 });
      await insertNode(db, { id: 'grandchild1', name: 'Grandchild', parentId: 'child1', path: 'root1/child1/grandchild1', level: 2, sortIndex: 1 });
      // Unrelated node should survive
      await insertNode(db, { id: 'other', name: 'Other', parentId: null, path: 'other', level: 0, sortIndex: 2 });

      await service.delete('root1');

      const remaining = await db.model('treeNode').findMany() as TreeNode[];
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('other');
    });

    it('should delete leaf node without affecting siblings', async () => {
      await insertNode(db, { id: 'root1', name: 'Root', parentId: null, path: 'root1', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'c1', name: 'C1', parentId: 'root1', path: 'root1/c1', level: 1, sortIndex: 1 });
      await insertNode(db, { id: 'c2', name: 'C2', parentId: 'root1', path: 'root1/c2', level: 1, sortIndex: 2 });

      await service.delete('c1');

      const remaining = await db.model('treeNode').findMany() as TreeNode[];
      expect(remaining).toHaveLength(2);
      expect(remaining.map(r => r.id).sort()).toEqual(['c2', 'root1']);
    });
  });

  // ======================== moveNode ========================
  describe('moveNode', () => {
    it('should move a node to a new parent and update path', async () => {
      await insertNode(db, { id: 'r1', name: 'R1', parentId: null, path: 'r1', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'r2', name: 'R2', parentId: null, path: 'r2', level: 0, sortIndex: 2 });
      await insertNode(db, { id: 'c1', name: 'C1', parentId: 'r1', path: 'r1/c1', level: 1, sortIndex: 1 });

      await service.moveNode('c1', 'r2');

      const moved = await service.findOne('c1');
      expect(moved.parentId).toBe('r2');
      expect(moved.path).toBe('r2/c1');
      expect(moved.level).toBe(1);
    });

    it('should detect cyclic dependency — moving parent under its child', async () => {
      await insertNode(db, { id: 'root', name: 'Root', parentId: null, path: 'root', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'child', name: 'Child', parentId: 'root', path: 'root/child', level: 1, sortIndex: 1 });
      await insertNode(db, { id: 'grandchild', name: 'Grandchild', parentId: 'child', path: 'root/child/grandchild', level: 2, sortIndex: 1 });

      await expect(service.moveNode('root', 'grandchild')).rejects.toThrow();
    });

    it('should detect self-reference as cyclic dependency', async () => {
      await insertNode(db, { id: 'node1', name: 'Node 1', parentId: null, path: 'node1', level: 0, sortIndex: 1 });

      await expect(service.moveNode('node1', 'node1')).rejects.toThrow();
    });

    it('should allow moving to root (null parent)', async () => {
      await insertNode(db, { id: 'root', name: 'Root', parentId: null, path: 'root', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'child', name: 'Child', parentId: 'root', path: 'root/child', level: 1, sortIndex: 1 });

      await service.moveNode('child', null);

      const moved = await service.findOne('child');
      expect(moved.parentId).toBeNull();
      expect(moved.path).toBe('child');
      expect(moved.level).toBe(0);
    });
  });

  // ======================== findChildren ========================
  describe('findChildren', () => {
    it('should return direct children of a parent', async () => {
      await insertNode(db, { id: 'root', name: 'Root', parentId: null, path: 'root', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'c1', name: 'C1', parentId: 'root', path: 'root/c1', level: 1, sortIndex: 1 });
      await insertNode(db, { id: 'c2', name: 'C2', parentId: 'root', path: 'root/c2', level: 1, sortIndex: 2 });
      await insertNode(db, { id: 'gc1', name: 'GC1', parentId: 'c1', path: 'root/c1/gc1', level: 2, sortIndex: 1 });

      const children = await service.findChildren('root');

      expect(children).toHaveLength(2);
      expect(children.map(c => c.id).sort()).toEqual(['c1', 'c2']);
    });

    it('should return empty array for leaf nodes', async () => {
      await insertNode(db, { id: 'leaf', name: 'Leaf', parentId: null, path: 'leaf', level: 0, sortIndex: 1 });

      const children = await service.findChildren('leaf');
      expect(children).toEqual([]);
    });
  });

  // ======================== findParents ========================
  describe('findParents', () => {
    it('should return all ancestor nodes', async () => {
      await insertNode(db, { id: 'root', name: 'Root', parentId: null, path: 'root', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'mid', name: 'Mid', parentId: 'root', path: 'root/mid', level: 1, sortIndex: 1 });
      await insertNode(db, { id: 'leaf', name: 'Leaf', parentId: 'mid', path: 'root/mid/leaf', level: 2, sortIndex: 1 });

      const parents = await service.findParents('leaf');

      expect(parents).toHaveLength(2);
      expect(parents.map(p => p.id).sort()).toEqual(['mid', 'root']);
    });

    it('should return empty array for root node', async () => {
      await insertNode(db, { id: 'root', name: 'Root', parentId: null, path: 'root', level: 0, sortIndex: 1 });

      const parents = await service.findParents('root');
      expect(parents).toEqual([]);
    });
  });

  // ======================== findSiblings ========================
  describe('findSiblings', () => {
    it('should return sibling nodes (same parent, excluding self)', async () => {
      await insertNode(db, { id: 'root', name: 'Root', parentId: null, path: 'root', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'c1', name: 'C1', parentId: 'root', path: 'root/c1', level: 1, sortIndex: 1 });
      await insertNode(db, { id: 'c2', name: 'C2', parentId: 'root', path: 'root/c2', level: 1, sortIndex: 2 });
      await insertNode(db, { id: 'c3', name: 'C3', parentId: 'root', path: 'root/c3', level: 1, sortIndex: 3 });

      const siblings = await service.findSiblings('c2');

      expect(siblings).toHaveLength(2);
      expect(siblings.map(s => s.id).sort()).toEqual(['c1', 'c3']);
    });

    it('should return root-level siblings', async () => {
      await insertNode(db, { id: 'r1', name: 'R1', parentId: null, path: 'r1', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'r2', name: 'R2', parentId: null, path: 'r2', level: 0, sortIndex: 2 });

      const siblings = await service.findSiblings('r1');
      expect(siblings).toHaveLength(1);
      expect(siblings[0].id).toBe('r2');
    });
  });

  // ======================== rebuildPath ========================
  describe('rebuildPath', () => {
    it('should recalculate path and level for all nodes', async () => {
      // Insert nodes with missing/wrong path
      await insertNode(db, { id: 'root', name: 'Root', parentId: null, path: 'wrong', level: 99, sortIndex: 1 });
      await insertNode(db, { id: 'child', name: 'Child', parentId: 'root', path: 'also-wrong', level: 77, sortIndex: 1 });
      await insertNode(db, { id: 'gc', name: 'GC', parentId: 'child', path: '', level: 0, sortIndex: 1 });

      await service.rebuildPath();

      const root = await service.findOne('root');
      expect(root.path).toBe('root');
      expect(root.level).toBe(0);

      const child = await service.findOne('child');
      expect(child.path).toBe('root/child');
      expect(child.level).toBe(1);

      const gc = await service.findOne('gc');
      expect(gc.path).toBe('root/child/gc');
      expect(gc.level).toBe(2);
    });
  });

  // ======================== findWithChildren ========================
  describe('findWithChildren', () => {
    it('should return the node and all descendants', async () => {
      await insertNode(db, { id: 'root', name: 'Root', parentId: null, path: 'root', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'c1', name: 'C1', parentId: 'root', path: 'root/c1', level: 1, sortIndex: 1 });
      await insertNode(db, { id: 'gc1', name: 'GC1', parentId: 'c1', path: 'root/c1/gc1', level: 2, sortIndex: 1 });
      await insertNode(db, { id: 'other', name: 'Other', parentId: null, path: 'other', level: 0, sortIndex: 2 });

      const result = await service.findWithChildren('root');

      expect(result).toHaveLength(3);
      expect(result.map(r => r.id).sort()).toEqual(['c1', 'gc1', 'root']);
    });
  });

  // ======================== isRootNode ========================
  describe('isRootNode', () => {
    it('should return true for nodes without parentId', () => {
      expect(service.isRootNode({ id: 'n1', parentId: null } as TreeNode)).toBe(true);
      expect(service.isRootNode({ id: 'n2', parentId: undefined } as unknown as TreeNode)).toBe(true);
      expect(service.isRootNode({ id: 'n3', parentId: '-1' } as TreeNode)).toBe(true);
    });

    it('should return false for child nodes', () => {
      expect(service.isRootNode({ id: 'n1', parentId: 'parent-id' } as TreeNode)).toBe(false);
    });
  });

  // ======================== checkCyclicDependency ========================
  describe('checkCyclicDependency', () => {
    it('should throw when setting parent to self', async () => {
      await insertNode(db, { id: 'n1', name: 'N1', parentId: null, path: 'n1', level: 0, sortIndex: 1 });

      await expect(service.checkCyclicDependency('n1', 'n1')).rejects.toThrow();
    });

    it('should throw when setting parent to a descendant', async () => {
      await insertNode(db, { id: 'root', name: 'Root', parentId: null, path: 'root', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'child', name: 'Child', parentId: 'root', path: 'root/child', level: 1, sortIndex: 1 });

      await expect(service.checkCyclicDependency('root', 'child')).rejects.toThrow();
    });

    it('should not throw for valid parent change', async () => {
      await insertNode(db, { id: 'a', name: 'A', parentId: null, path: 'a', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'b', name: 'B', parentId: null, path: 'b', level: 0, sortIndex: 2 });

      await expect(service.checkCyclicDependency('a', 'b')).resolves.toBeUndefined();
    });

    it('should allow setting parent to null', async () => {
      await insertNode(db, { id: 'n1', name: 'N1', parentId: 'p1', path: 'p1/n1', level: 1, sortIndex: 1 });

      await expect(service.checkCyclicDependency('n1', null)).resolves.toBeUndefined();
    });
  });

  // ======================== deleteBatch ========================
  describe('deleteBatch', () => {
    it('should cascade delete multiple nodes and their children', async () => {
      await insertNode(db, { id: 'r1', name: 'R1', parentId: null, path: 'r1', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'c1', name: 'C1', parentId: 'r1', path: 'r1/c1', level: 1, sortIndex: 1 });
      await insertNode(db, { id: 'r2', name: 'R2', parentId: null, path: 'r2', level: 0, sortIndex: 2 });
      await insertNode(db, { id: 'c2', name: 'C2', parentId: 'r2', path: 'r2/c2', level: 1, sortIndex: 1 });
      await insertNode(db, { id: 'r3', name: 'R3', parentId: null, path: 'r3', level: 0, sortIndex: 3 });

      const deleted = await service.deleteBatch(['r1', 'r2']);

      const remaining = await db.model('treeNode').findMany() as TreeNode[];
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('r3');
      expect(deleted).toBeGreaterThanOrEqual(4);
    });
  });

  // ======================== queryIncludeChildren ========================
  describe('queryIncludeChildren', () => {
    it('should return nodes and all their descendants', async () => {
      await insertNode(db, { id: 'r1', name: 'R1', parentId: null, path: 'r1', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'c1', name: 'C1', parentId: 'r1', path: 'r1/c1', level: 1, sortIndex: 1 });
      await insertNode(db, { id: 'gc1', name: 'GC1', parentId: 'c1', path: 'r1/c1/gc1', level: 2, sortIndex: 1 });
      await insertNode(db, { id: 'r2', name: 'R2', parentId: null, path: 'r2', level: 0, sortIndex: 2 });

      const result = await service.queryIncludeChildren(['r1']);

      expect(result).toHaveLength(3);
      expect(result.map(r => r.id).sort()).toEqual(['c1', 'gc1', 'r1']);
    });

    it('should return empty array for empty input', async () => {
      const result = await service.queryIncludeChildren([]);
      expect(result).toEqual([]);
    });
  });

  // ======================== queryIncludeParent ========================
  describe('queryIncludeParent', () => {
    it('should return nodes and all their ancestors', async () => {
      await insertNode(db, { id: 'root', name: 'Root', parentId: null, path: 'root', level: 0, sortIndex: 1 });
      await insertNode(db, { id: 'mid', name: 'Mid', parentId: 'root', path: 'root/mid', level: 1, sortIndex: 1 });
      await insertNode(db, { id: 'leaf', name: 'Leaf', parentId: 'mid', path: 'root/mid/leaf', level: 2, sortIndex: 1 });

      const result = await service.queryIncludeParent(['leaf']);

      expect(result).toHaveLength(3);
      expect(result.map(r => r.id).sort()).toEqual(['leaf', 'mid', 'root']);
    });
  });
});
