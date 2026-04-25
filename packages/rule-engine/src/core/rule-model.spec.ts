import { describe, it, expect } from 'vitest';
import { RuleModel } from './rule-model';
import type { RuleNodeModel } from './rule-model';

function makeNode(id: string, executor = 'noop'): RuleNodeModel {
  return { id, name: id, executor, configuration: {} };
}

describe('RuleModel', () => {
  it('should create a model with id, name, and type', () => {
    const model = new RuleModel('r1', 'Test Rule', 'scene');
    expect(model.id).toBe('r1');
    expect(model.name).toBe('Test Rule');
    expect(model.type).toBe('scene');
    expect(model.executionMode).toBe('serial');
  });

  it('should add nodes and retrieve them by id', () => {
    const model = new RuleModel('r1', 'test');
    const node = makeNode('n1');
    model.addNode(node);
    expect(model.getNode('n1')).toBe(node);
    expect(model.getNode('nonexistent')).toBeUndefined();
  });

  it('should create links between nodes', () => {
    const model = new RuleModel('r1', 'test');
    const a = makeNode('a');
    const b = makeNode('b');
    model.addNode(a);
    model.addNode(b);
    const link = model.link(a, b);
    expect(link.source).toBe('a');
    expect(link.target).toBe('b');
    expect(link.id).toBe('a->b');
    expect(model.links).toHaveLength(1);
    expect(a.outputs).toHaveLength(1);
    expect(b.inputs).toHaveLength(1);
  });

  it('should get downstream and upstream node ids', () => {
    const model = new RuleModel('r1', 'test');
    const a = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c');
    model.addNode(a);
    model.addNode(b);
    model.addNode(c);
    model.link(a, b);
    model.link(a, c);
    expect(model.getDownstream('a')).toEqual(['b', 'c']);
    expect(model.getUpstream('b')).toEqual(['a']);
  });

  it('should produce a valid topological sort for a DAG', () => {
    const model = new RuleModel('r1', 'test');
    const a = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c');
    model.addNode(a);
    model.addNode(b);
    model.addNode(c);
    model.link(a, b);
    model.link(b, c);
    const sorted = model.topologicalSort();
    expect(sorted).toEqual(['a', 'b', 'c']);
  });

  it('should detect cycles via topological sort (sorted.length < nodes.length)', () => {
    const model = new RuleModel('r1', 'test');
    const a = makeNode('a');
    const b = makeNode('b');
    model.addNode(a);
    model.addNode(b);
    model.link(a, b);
    model.link(b, a);
    const sorted = model.topologicalSort();
    expect(sorted.length).toBeLessThan(model.nodes.length);
  });

  it('should validate: no errors for a valid DAG', () => {
    const model = new RuleModel('r1', 'test');
    const a = makeNode('a');
    const b = makeNode('b');
    model.addNode(a);
    model.addNode(b);
    model.link(a, b);
    expect(model.validate()).toEqual([]);
  });

  it('should validate: report cycle error', () => {
    const model = new RuleModel('r1', 'test');
    const a = makeNode('a');
    const b = makeNode('b');
    model.addNode(a);
    model.addNode(b);
    model.link(a, b);
    model.link(b, a);
    const errors = model.validate();
    expect(errors).toContain('Rule model contains a cycle');
  });

  it('should validate: report unknown node references in links', () => {
    const model = new RuleModel('r1', 'test');
    const a = makeNode('a');
    model.addNode(a);
    // Manually add a link referencing a non-existent node
    model.links.push({ id: 'bad', source: 'a', target: 'z', type: 'output' });
    const errors = model.validate();
    expect(errors.some((e) => e.includes('unknown target node: z'))).toBe(true);
  });

  it('should handle diamond-shaped DAG in topological sort', () => {
    const model = new RuleModel('r1', 'test');
    const a = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c');
    const d = makeNode('d');
    model.addNode(a);
    model.addNode(b);
    model.addNode(c);
    model.addNode(d);
    model.link(a, b);
    model.link(a, c);
    model.link(b, d);
    model.link(c, d);
    const sorted = model.topologicalSort();
    expect(sorted).toHaveLength(4);
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('b'));
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('c'));
    expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('d'));
    expect(sorted.indexOf('c')).toBeLessThan(sorted.indexOf('d'));
  });
});
