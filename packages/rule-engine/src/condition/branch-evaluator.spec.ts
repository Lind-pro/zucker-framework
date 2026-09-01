import { describe, it, expect, beforeEach } from 'vitest';
import { BranchEvaluator } from './branch-evaluator';
import type { Branch } from './branch-evaluator';

describe('BranchEvaluator', () => {
  let evaluator: BranchEvaluator;

  beforeEach(() => {
    evaluator = new BranchEvaluator();
  });

  it('should match the first branch whose terms condition is met', () => {
    const branches: Branch[] = [
      {
        when: [
          {
            type: 'terms',
            config: {
              terms: [{ column: 'status', termType: 'eq', value: 'online' }],
              type: 'and',
            },
          },
        ],
        then: [{ parallel: false, actions: [{ type: 'notify', config: {} }] }],
      },
    ];
    const results = evaluator.evaluate(branches, { status: 'online' });
    expect(results).toHaveLength(1);
    expect(results[0].matched).toBe(true);
    expect(results[0].branchIndex).toBe(0);
  });

  it('should not match branches whose conditions are not met', () => {
    const branches: Branch[] = [
      {
        when: [
          {
            type: 'terms',
            config: {
              terms: [{ column: 'status', termType: 'eq', value: 'online' }],
              type: 'and',
            },
          },
        ],
        then: [],
      },
    ];
    const results = evaluator.evaluate(branches, { status: 'offline' });
    expect(results).toHaveLength(0);
  });

  it('should implement if/else-if semantics — skip subsequent branches after a match', () => {
    const branches: Branch[] = [
      {
        when: [
          {
            type: 'terms',
            config: {
              terms: [{ column: 'v', termType: 'gt', value: 10 }],
              type: 'and',
            },
          },
        ],
        then: [{ parallel: false, actions: [{ type: 'a', config: {} }] }],
      },
      {
        when: [
          {
            type: 'terms',
            config: {
              terms: [{ column: 'v', termType: 'gt', value: 5 }],
              type: 'and',
            },
          },
        ],
        then: [{ parallel: false, actions: [{ type: 'b', config: {} }] }],
      },
    ];
    const results = evaluator.evaluate(branches, { v: 20 });
    expect(results).toHaveLength(1);
    expect(results[0].branchIndex).toBe(0);
  });

  it('should treat empty when conditions as else branch', () => {
    const branches: Branch[] = [
      {
        when: [
          {
            type: 'terms',
            config: {
              terms: [{ column: 'v', termType: 'eq', value: 999 }],
              type: 'and',
            },
          },
        ],
        then: [{ parallel: false, actions: [{ type: 'if', config: {} }] }],
      },
      {
        when: [],
        then: [{ parallel: false, actions: [{ type: 'else', config: {} }] }],
      },
    ];
    const results = evaluator.evaluate(branches, { v: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].actionGroups[0].actions[0].type).toBe('else');
  });

  it('should support executeAnyway branches that always run', () => {
    const branches: Branch[] = [
      {
        when: [
          {
            type: 'terms',
            config: {
              terms: [{ column: 'v', termType: 'eq', value: 1 }],
              type: 'and',
            },
          },
        ],
        then: [{ parallel: false, actions: [{ type: 'first', config: {} }] }],
      },
      {
        when: [
          {
            type: 'terms',
            config: {
              terms: [{ column: 'v', termType: 'eq', value: 1 }],
              type: 'and',
            },
          },
        ],
        then: [{ parallel: false, actions: [{ type: 'also', config: {} }] }],
        executeAnyway: true,
      },
    ];
    const results = evaluator.evaluate(branches, { v: 1 });
    expect(results).toHaveLength(2);
  });

  it('should return branchId when specified', () => {
    const branches: Branch[] = [
      {
        id: 'my-branch',
        when: [],
        then: [],
      },
    ];
    const results = evaluator.evaluate(branches, {});
    expect(results[0].branchId).toBe('my-branch');
  });

  it('should support expression-based conditions', () => {
    const branches: Branch[] = [
      {
        when: [
          {
            type: 'expression',
            config: { expression: 'temperature > 30' },
          },
        ],
        then: [{ parallel: false, actions: [{ type: 'alert', config: {} }] }],
      },
    ];
    expect(evaluator.evaluate(branches, { temperature: 35 })).toHaveLength(1);
    expect(evaluator.evaluate(branches, { temperature: 20 })).toHaveLength(0);
  });

  it('should support shake limit suppression', () => {
    const branches: Branch[] = [
      {
        when: [],
        then: [{ parallel: false, actions: [{ type: 'x', config: {} }] }],
        shakeLimit: { enabled: true, time: 60000, threshold: 1 },
      },
    ];
    // First call should pass
    const r1 = evaluator.evaluate(branches, {});
    expect(r1).toHaveLength(1);
    // Second call within same window should be suppressed
    const r2 = evaluator.evaluate(branches, {});
    expect(r2).toHaveLength(0);
  });

  it('should allow reset of shake limits', () => {
    const branches: Branch[] = [
      {
        when: [],
        then: [],
        shakeLimit: { enabled: true, time: 60000, threshold: 1 },
      },
    ];
    evaluator.evaluate(branches, {});
    evaluator.evaluate(branches, {}); // suppressed
    evaluator.resetShakeLimits();
    const results = evaluator.evaluate(branches, {});
    expect(results).toHaveLength(1);
  });
});
