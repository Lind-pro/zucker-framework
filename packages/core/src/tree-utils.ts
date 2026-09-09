/**
 * 树结构工具函数 — 独立于 Service 实例，可在任何地方使用
 */

export interface TreeNode {
  id: string;
  parentId?: string | null;
  children?: TreeNode[];
}

/**
 * 将扁平列表转换为树形结构
 *
 * @param list 扁平列表，每个元素需有 id 和 parentId
 * @param options.idField ID 字段名，默认 'id'
 * @param options.parentIdField 父 ID 字段名，默认 'parentId'
 * @param options.childrenField 子节点字段名，默认 'children'
 * @param options.rootParentId 根节点的 parentId 值，默认 null/undefined
 * @returns 树形结构的根节点数组
 */
export function list2tree<T extends Record<string, any>>(
  list: T[],
  options?: {
    idField?: string;
    parentIdField?: string;
    childrenField?: string;
    rootParentId?: string | null;
  },
): T[] {
  if (!list || !Array.isArray(list) || list.length === 0) return [];

  const idField = options?.idField ?? 'id';
  const parentIdField = options?.parentIdField ?? 'parentId';
  const childrenField = options?.childrenField ?? 'children';
  const rootParentId = options?.rootParentId ?? null;

  const map = new Map<string, T & Record<string, any>>();
  const roots: T[] = [];

  // 第一轮：建立 id -> node 映射
  for (const item of list) {
    map.set(item[idField], { ...item, [childrenField]: [] });
  }

  // 第二轮：组装父子关系
  for (const item of list) {
    const node = map.get(item[idField])!;
    const pid = item[parentIdField] ?? null;

    if (pid === rootParentId || !map.has(pid)) {
      roots.push(node);
    } else {
      const parent = map.get(pid)!;
      parent[childrenField].push(node);
    }
  }

  // 清理空 children 数组
  for (const [, node] of map) {
    if (node[childrenField].length === 0) {
      delete node[childrenField];
    }
  }

  return roots;
}

/**
 * 将树形结构展开为扁平列表（深度优先）
 *
 * @param tree 树形结构的根节点数组
 * @param options.childrenField 子节点字段名，默认 'children'
 * @param options.keepChildren 是否保留 children 字段，默认 false
 * @returns 扁平列表
 */
export function expandTree2List<T extends Record<string, any>>(
  tree: T[],
  options?: {
    childrenField?: string;
    keepChildren?: boolean;
  },
): T[] {
  if (!tree || !Array.isArray(tree) || tree.length === 0) return [];

  const childrenField = options?.childrenField ?? 'children';
  const keepChildren = options?.keepChildren ?? false;
  const result: T[] = [];

  function traverse(nodes: T[]) {
    for (const node of nodes) {
      const children = node[childrenField] as T[] | undefined;
      if (keepChildren) {
        result.push(node);
      } else {
        const { [childrenField]: _, ...rest } = node;
        result.push(rest as T);
      }
      if (children && children.length > 0) {
        traverse(children);
      }
    }
  }

  traverse(tree);
  return result;
}

/**
 * 遍历树节点（广度优先），包含所有后代节点
 *
 * @param nodes 根节点集合
 * @param consumer 节点消费函数
 * @param options.childrenField 子节点字段名，默认 'children'
 */
export function forEachTree<T extends Record<string, any>>(
  nodes: T[],
  consumer: (node: T) => void,
  options?: { childrenField?: string },
): void {
  const childrenField = options?.childrenField ?? 'children';
  const queue: T[] = [...nodes];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    const identity = node;
    if (visited.has(identity)) continue;
    visited.add(identity);

    consumer(node);

    const children = node[childrenField] as T[] | undefined;
    if (children && children.length > 0) {
      queue.push(...children);
    }
  }
}

/**
 * 平铺树结构（广度优先），带消费回调
 *
 * @param nodeList 树结构节点列表
 * @param childrenGetter 子节点获取函数
 * @param handler 平铺节点接收函数
 */
export function flatTree<T>(
  nodeList: T[],
  childrenGetter: (node: T) => T[] | undefined,
  handler: (node: T) => void,
): void {
  const queue: T[] = [...nodeList];
  const visited = new Set<T>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);

    const children = childrenGetter(node);
    if (children && children.length > 0) {
      queue.push(...children);
    }

    handler(node);
  }
}

/**
 * 根据 path 获取父节点的 path
 *
 * @param path 当前节点的 path（使用 separator 分隔）
 * @param separator 路径分隔符，默认 '/'
 * @returns 父节点 path，如果是根节点则返回 null
 */
export function getParentPath(path: string | null | undefined, separator = '/'): string | null {
  if (!path) return null;
  const lastSep = path.lastIndexOf(separator);
  if (lastSep <= 0) return null;
  return path.substring(0, lastSep);
}

/**
 * 树路径生成策略接口
 */
export interface TreePathStrategy {
  /** 生成路径段 */
  generateSegment(): string;
}

/**
 * UUID 路径策略 — 使用完整 ID 作为路径段（当前默认行为）
 */
export class UuidPathStrategy implements TreePathStrategy {
  generateSegment(): string {
    // 路径段直接使用节点 ID，由调用方传入
    // 这里只是占位，实际使用时由 TreeService 调用
    return '';
  }
}

/**
 * 短码路径策略 — 使用 4 字符随机段
 */
export class ShortCodePathStrategy implements TreePathStrategy {
  private static readonly CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

  constructor(private readonly length: number = 4) {}

  generateSegment(): string {
    let result = '';
    for (let i = 0; i < this.length; i++) {
      result += ShortCodePathStrategy.CHARS[Math.floor(Math.random() * ShortCodePathStrategy.CHARS.length)];
    }
    return result;
  }
}
