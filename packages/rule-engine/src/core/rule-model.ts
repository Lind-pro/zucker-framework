/**
 * Graph-based rule model — mirrors jetlinks RuleModel / RuleNodeModel / RuleLink.
 *
 * A RuleModel is a directed acyclic graph (DAG) of RuleNodeModels connected
 * by RuleLinks. Each node has an executor type and configuration; links
 * may carry conditions that gate data flow.
 */

export interface ConditionSpec {
  type: string;
  configuration: Record<string, unknown>;
}

/**
 * A directed edge between two nodes in the rule graph.
 */
export interface RuleLink {
  /** Unique link id. */
  id: string;
  /** Source node id. */
  source: string;
  /** Target node id. */
  target: string;
  /** Link type (e.g. 'output', 'error'). */
  type: string;
  /** Optional condition that must evaluate to true for data to flow. */
  condition?: ConditionSpec;
}

/**
 * A single node in the rule graph.
 */
export interface RuleNodeModel {
  /** Unique node id within the model. */
  id: string;
  /** Human-readable node name. */
  name: string;
  /** Executor type identifier (e.g. 'timer', 'delay', 'script', 'notify'). */
  executor: string;
  /** Executor-specific configuration. */
  configuration: Record<string, unknown>;
  /** Input link descriptors (populated by the engine). */
  inputs?: RuleLink[];
  /** Output link descriptors (populated by the engine). */
  outputs?: RuleLink[];
}

export type ExecutionMode = 'parallel' | 'serial';

/**
 * The complete rule model — a DAG of nodes and links.
 */
export class RuleModel {
  id: string;
  name: string;
  type: string;

  /** All nodes in the graph. */
  readonly nodes: RuleNodeModel[] = [];

  /** All links in the graph. */
  readonly links: RuleLink[] = [];

  /** Default execution mode for action groups. */
  executionMode: ExecutionMode = 'serial';

  constructor(id: string, name: string, type = 'scene') {
    this.id = id;
    this.name = name;
    this.type = type;
  }

  /** Add a node to the model. */
  addNode(node: RuleNodeModel): void {
    this.nodes.push(node);
  }

  /** Create a link between two nodes and add it to the model. Returns the link. */
  link(source: RuleNodeModel, target: RuleNodeModel, type = 'output'): RuleLink {
    const link: RuleLink = {
      id: `${source.id}->${target.id}`,
      source: source.id,
      target: target.id,
      type,
    };
    this.links.push(link);

    source.outputs = source.outputs ?? [];
    source.outputs.push(link);
    target.inputs = target.inputs ?? [];
    target.inputs.push(link);

    return link;
  }

  /** Find a node by id. */
  getNode(id: string): RuleNodeModel | undefined {
    return this.nodes.find((n) => n.id === id);
  }

  /** Remove a node and all its connected links — mirrors jetlinks RuleModel management. */
  removeNode(nodeId: string): boolean {
    const idx = this.nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0) return false;
    this.nodes.splice(idx, 1);
    // Remove all links referencing this node
    for (let i = this.links.length - 1; i >= 0; i--) {
      if (this.links[i].source === nodeId || this.links[i].target === nodeId) {
        this.links.splice(i, 1);
      }
    }
    // Clean up input/output references on remaining nodes
    for (const node of this.nodes) {
      if (node.inputs) {
        node.inputs = node.inputs.filter((l) => l.source !== nodeId && l.target !== nodeId);
      }
      if (node.outputs) {
        node.outputs = node.outputs.filter((l) => l.source !== nodeId && l.target !== nodeId);
      }
    }
    return true;
  }

  /** Remove a specific link by id. */
  removeLink(linkId: string): boolean {
    const idx = this.links.findIndex((l) => l.id === linkId);
    if (idx < 0) return false;
    const link = this.links[idx];
    this.links.splice(idx, 1);
    // Clean up references on connected nodes
    const srcNode = this.getNode(link.source);
    if (srcNode?.outputs) {
      srcNode.outputs = srcNode.outputs.filter((l) => l.id !== linkId);
    }
    const tgtNode = this.getNode(link.target);
    if (tgtNode?.inputs) {
      tgtNode.inputs = tgtNode.inputs.filter((l) => l.id !== linkId);
    }
    return true;
  }

  /** Get all downstream node ids from a given node. */
  getDownstream(nodeId: string): string[] {
    return this.links
      .filter((l) => l.source === nodeId)
      .map((l) => l.target);
  }

  /** Get all upstream node ids from a given node. */
  getUpstream(nodeId: string): string[] {
    return this.links
      .filter((l) => l.target === nodeId)
      .map((l) => l.source);
  }

  /** Get topologically sorted node ids (for serial execution ordering). */
  topologicalSort(): string[] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const node of this.nodes) {
      inDegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }
    for (const link of this.links) {
      adjacency.get(link.source)?.push(link.target);
      inDegree.set(link.target, (inDegree.get(link.target) ?? 0) + 1);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);
      for (const next of adjacency.get(current) ?? []) {
        const newDeg = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }

    return sorted;
  }

  /** Validate the model (no cycles, all link targets exist). */
  validate(): string[] {
    const errors: string[] = [];
    const nodeIds = new Set(this.nodes.map((n) => n.id));

    for (const link of this.links) {
      if (!nodeIds.has(link.source)) {
        errors.push(`Link ${link.id} references unknown source node: ${link.source}`);
      }
      if (!nodeIds.has(link.target)) {
        errors.push(`Link ${link.id} references unknown target node: ${link.target}`);
      }
    }

    // Cycle detection
    const sorted = this.topologicalSort();
    if (sorted.length !== this.nodes.length) {
      errors.push('Rule model contains a cycle');
    }

    return errors;
  }
}
