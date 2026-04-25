import vm from 'node:vm';

export interface SandboxOptions {
  timeout: number;
  allowedModules: string[];
  name?: string;
}

export interface Sandbox {
  execute(code: string, context?: Record<string, unknown>): unknown;
}

/**
 * Dangerous global properties that must be blocked in the sandbox.
 * Prevents escaping via prototype chain (e.g. this.constructor.constructor('return process')()).
 */
const BLOCKED_GLOBALS = [
  'process', 'require', 'module', 'exports', '__filename', '__dirname',
  'globalThis', 'global', 'root', 'GLOBAL',
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',
  'queueMicrotask',
] as const;

export function createSandbox(options: SandboxOptions): Sandbox {
  return {
    execute(code: string, context: Record<string, unknown> = {}): unknown {
      const sandbox: Record<string, unknown> = {
        ...context,
        console: {
          log: (...args: unknown[]) => console.log('[sandbox]', ...args),
          warn: (...args: unknown[]) => console.warn('[sandbox]', ...args),
          error: (...args: unknown[]) => console.error('[sandbox]', ...args),
        },
        require: createRestrictedRequire(options.allowedModules),
      };

      // Explicitly block dangerous globals
      for (const key of BLOCKED_GLOBALS) {
        sandbox[key] = undefined;
      }

      const vmContext = vm.createContext(sandbox);

      // Guard against prototype chain escape:
      //   this.constructor.constructor('return process')()
      // By freezing the constructor chain within the sandbox context.
      vm.runInContext(
        `(function() {
          var ObjProto = Object.getPrototypeOf({});
          var FuncProto = Object.getPrototypeOf(function(){});
          Object.defineProperty(ObjProto, 'constructor', { value: undefined, writable: false, configurable: false });
          Object.defineProperty(FuncProto, 'constructor', { value: undefined, writable: false, configurable: false });
        })()`,
        vmContext,
        { timeout: 1000 },
      );

      // 包装为立即执行函数，支持 return
      const wrappedCode = `(function(__args) { ${code} })(typeof __args !== 'undefined' ? __args : [])`;

      return vm.runInContext(wrappedCode, vmContext, {
        timeout: options.timeout,
        filename: 'sandbox-script.js',
      });
    },
  };
}

function createRestrictedRequire(allowedModules: string[]) {
  if (allowedModules.length === 0) return undefined;

  return (moduleName: string) => {
    if (!allowedModules.includes(moduleName)) {
      throw new Error(`Module not allowed in sandbox: ${moduleName}`);
    }
    return require(moduleName);
  };
}
