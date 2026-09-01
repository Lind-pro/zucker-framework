import { Logger } from '@nestjs/common';
import type { TermCondition } from './terms-evaluator';
import { TermsEvaluator } from './terms-evaluator';
import type { ExpressionCondition } from './expression-evaluator';
import { ExpressionEvaluator } from './expression-evaluator';
import type { ShakeLimitConfig } from '../core/shake-limit';
import { createShakeLimit } from '../core/shake-limit';

/**
 * Branch condition evaluator — mirrors jetlinks SceneConditionAction.
 *
 * Supports if/else-if/else branching with:
 * - Term-based conditions (field comparisons)
 * - Expression-based conditions (JS expressions)
 * - executeAnyway flag (always-run branches, like 'also' in addition to if/else)
 * - Shake-limit (debounce) per branch
 * - Parallel or serial action groups within each branch
 */

export interface BranchActionGroup {
  /** Whether actions in this group execute in parallel. */
  parallel: boolean;
  /** Action definitions to execute. */
  actions: BranchAction[];
}

export interface BranchAction {
  /** Action type identifier. */
  type: string;
  /** Action-specific configuration. */
  config: Record<string, unknown>;
}

export interface BranchCondition {
  /** Condition type: 'terms' or 'expression'. */
  type: 'terms' | 'expression';
  /** Condition configuration. */
  config: TermCondition | ExpressionCondition;
}

export interface Branch {
  /** Unique branch identifier. */
  id?: string;
  /** Conditions to evaluate — if empty, acts as 'else'. */
  when: BranchCondition[];
  /** Action groups to execute when conditions are met. */
  then: BranchActionGroup[];
  /** Whether to execute this branch regardless of previous matches (default: false). */
  executeAnyway?: boolean;
  /** Optional shake-limit (debounce) configuration for this branch. */
  shakeLimit?: ShakeLimitConfig;
}

export interface BranchEvaluationResult {
  /** Index of the matched branch (or -1 if none matched). */
  branchIndex: number;
  /** Branch id if specified. */
  branchId?: string;
  /** Whether the branch conditions were met. */
  matched: boolean;
  /** Action groups to execute. */
  actionGroups: BranchActionGroup[];
}

export class BranchEvaluator {
  private readonly logger = new Logger(BranchEvaluator.name);
  private readonly termsEvaluator = new TermsEvaluator();
  private readonly expressionEvaluator = new ExpressionEvaluator();
  private readonly shakeLimitMap = new Map<number, ReturnType<typeof createShakeLimit>>();

  /**
   * Evaluate branches against data.
   * Implements if/else-if/else semantics with executeAnyway support.
   *
   * Returns all branches that should fire (respecting executeAnyway and
   * if/else-if ordering).
   */
  evaluate(
    branches: Branch[],
    data: Record<string, unknown>,
  ): BranchEvaluationResult[] {
    const results: BranchEvaluationResult[] = [];
    let previousMatched = false;

    for (let i = 0; i < branches.length; i++) {
      const branch = branches[i];

      // If a previous branch matched and this one is not executeAnyway, skip
      if (previousMatched && !branch.executeAnyway) {
        continue;
      }

      const conditionsMet = this.evaluateConditions(branch.when, data);

      if (conditionsMet) {
        // Check shake limit
        if (branch.shakeLimit?.enabled) {
          if (!this.shakeLimitMap.has(i)) {
            this.shakeLimitMap.set(i, createShakeLimit(branch.shakeLimit));
          }
          const limiter = this.shakeLimitMap.get(i)!;
          if (!limiter.tryAcquire()) {
            this.logger.debug(`Branch ${i} suppressed by shake limit`);
            continue;
          }
        }

        results.push({
          branchIndex: i,
          branchId: branch.id,
          matched: true,
          actionGroups: branch.then,
        });
        previousMatched = true;
      }
    }

    return results;
  }

  private evaluateConditions(
    conditions: BranchCondition[],
    data: Record<string, unknown>,
  ): boolean {
    // Empty conditions = else branch (always matches if reached)
    if (!conditions || conditions.length === 0) {
      return true;
    }

    return conditions.every((condition) => {
      if (condition.type === 'terms') {
        return this.termsEvaluator.evaluate(
          data,
          condition.config as TermCondition,
        );
      }
      if (condition.type === 'expression') {
        return this.expressionEvaluator.evaluate(
          data,
          condition.config as ExpressionCondition,
        );
      }
      return false;
    });
  }

  /** Reset all shake limiters. */
  resetShakeLimits(): void {
    for (const limiter of this.shakeLimitMap.values()) {
      limiter.reset();
    }
  }
}
