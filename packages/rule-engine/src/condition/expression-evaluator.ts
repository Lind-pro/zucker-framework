import { createSandbox, type AsyncSandbox } from '@zucker-framework/script';

export interface ExpressionCondition {
  expression: string;
}

/**
 * ExpressionEvaluator — simple expression evaluation for rule-engine conditions.
 *
 * Expressions run in the hardened `@zucker-framework/script` sandbox: rule data is copied
 * into a separate realm (no host-realm objects are reachable, so the
 * `x.constructor.constructor('return process')()` family of escapes does not work), string
 * code generation is disabled and the timeout also bounds promise jobs. Rule data is copied as
 * data only: methods of class instances in the data are not callable (`exposeMethods: false`).
 *
 * SECURITY NOTE: `node:vm` is still NOT a security boundary (no memory limit, engine bugs).
 * Only trusted operators should author expressions; untrusted authors need an isolate or
 * process boundary.
 */
export class ExpressionEvaluator {
  /** Default timeout in milliseconds for expression evaluation */
  private static readonly EVAL_TIMEOUT_MS = 1000;

  private readonly sandbox: AsyncSandbox = createSandbox({
    timeout: ExpressionEvaluator.EVAL_TIMEOUT_MS,
    allowedModules: [],
    name: 'rule-expression',
    exposeMethods: false,
  });

  evaluate(data: Record<string, unknown>, condition: ExpressionCondition): boolean {
    if (typeof condition?.expression !== 'string' || condition.expression.trim() === '') {
      throw new Error('Expression is required');
    }
    // Strict mode disables arguments.callee and other legacy features.
    const result = this.sandbox.execute(
      `'use strict';\nreturn (\n${condition.expression}\n);`,
      data,
    );
    return Boolean(result);
  }
}
