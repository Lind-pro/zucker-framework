import vm from 'node:vm';

export interface ExpressionCondition {
  expression: string;
}

/** Globals blocked in the expression sandbox to prevent escape */
const BLOCKED_GLOBALS = [
  'process', 'require', 'module', 'exports', '__filename', '__dirname',
  'globalThis', 'global', 'root', 'GLOBAL',
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',
  'queueMicrotask',
] as const;

/**
 * ExpressionEvaluator — simple expression evaluation for rule-engine conditions.
 *
 * SECURITY NOTE: Node.js `vm` module is NOT a secure sandbox. It provides
 * isolation from the host global scope but a determined attacker can escape.
 * This evaluator is intended ONLY for trusted / admin-authored expressions,
 * NOT for arbitrary user input from untrusted sources. Additional hardening
 * (Object.freeze, timeout, arguments restriction) reduces the attack surface
 * but does not eliminate all escape vectors.
 */
export class ExpressionEvaluator {
  /** Default timeout in milliseconds for expression evaluation */
  private static readonly EVAL_TIMEOUT_MS = 1000;

  evaluate(data: Record<string, unknown>, condition: ExpressionCondition): boolean {
    const sandbox: Record<string, unknown> = { ...data };

    // Block dangerous globals
    for (const key of BLOCKED_GLOBALS) {
      sandbox[key] = undefined;
    }

    const context = vm.createContext(sandbox);

    // Guard against prototype chain escape and harden the sandbox:
    // 1. Freeze Object.prototype to prevent property injection
    // 2. Neuter constructor access on both Object and Function prototypes
    // 3. Block arguments.callee (strict-mode escape vector)
    vm.runInContext(
      `(function() {
        'use strict';
        var ObjProto = Object.getPrototypeOf({});
        var FuncProto = Object.getPrototypeOf(function(){});
        Object.defineProperty(ObjProto, 'constructor', { value: undefined, writable: false, configurable: false });
        Object.defineProperty(FuncProto, 'constructor', { value: undefined, writable: false, configurable: false });
        Object.freeze(ObjProto);
        Object.freeze(FuncProto);
      })()`,
      context,
      { timeout: ExpressionEvaluator.EVAL_TIMEOUT_MS },
    );

    // Wrap in strict mode to disable arguments.callee and other legacy escape vectors
    const wrappedExpression = `'use strict'; (${condition.expression})`;
    const result = vm.runInContext(wrappedExpression, context, {
      timeout: ExpressionEvaluator.EVAL_TIMEOUT_MS,
      filename: 'expression-eval.js',
    });
    return Boolean(result);
  }
}
