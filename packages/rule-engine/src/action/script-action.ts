import { Logger } from '@nestjs/common';
import { createSandbox } from '@zucker-framework/script';

export interface ScriptActionConfig {
  script: string;
  /** 脚本语言（目前仅支持 js） — 对齐 jetlinks ScriptTaskExecutorProvider.Config.lang */
  lang?: string;
  timeout?: number;
}

/**
 * 脚本动作执行器 — 对齐 jetlinks ScriptTaskExecutorProvider
 *
 * SECURITY: scripts run in the hardened `@zucker-framework/script` sandbox (no host objects,
 * no code generation, timeout covering promise jobs and the onMessage handler). It is still a
 * `node:vm` realm without a memory cap: only let trusted operators author script actions.
 *
 * 增强：
 * - 支持 handler 模式（脚本中定义 onMessage 回调）
 * - 对脚本返回值进行规范化处理
 */
export class ScriptAction {
  private readonly logger = new Logger(ScriptAction.name);

  async execute(
    config: ScriptActionConfig,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    this.validate(config);
    this.logger.debug('Executing script action');

    const sandbox = createSandbox({
      timeout: config.timeout ?? 5000,
      allowedModules: [],
      name: 'rule-script',
    });

    // 注入 handler 对象，脚本可以通过 handler.onMessage(fn) 注册回调
    // 对齐 jetlinks ScriptTaskExecutorProvider.Handler
    // The registered callback is a sandbox callable: invoking it re-enters the sandbox under
    // the same timeout, so a handler cannot block the host event loop.
    let messageHandler: ((data: Record<string, unknown>) => unknown) | null = null;
    const handler = {
      onMessage(fn: unknown) {
        if (typeof fn !== 'function') {
          throw new TypeError('handler.onMessage expects a function');
        }
        messageHandler = fn as (data: Record<string, unknown>) => unknown;
      },
    };

    const result = await sandbox.executeAsync(config.script, {
      data,
      context: data,
      handler,
    });

    // 如果脚本注册了 onMessage handler，则使用它来处理数据
    if (messageHandler) {
      const handlerResult = await (messageHandler as (d: Record<string, unknown>) => unknown)(data);
      return this.normalizeResult(handlerResult);
    }

    return this.normalizeResult(result);
  }

  /**
   * 验证脚本配置 — 对齐 jetlinks executor validate()
   */
  validate(config: ScriptActionConfig): void {
    if (!config.script || config.script.trim().length === 0) {
      throw new Error('Script content is required');
    }
    const lang = config.lang ?? 'js';
    if (lang !== 'js' && lang !== 'javascript') {
      throw new Error(`Unsupported script language: ${lang}`);
    }
  }

  /**
   * 规范化脚本返回值 — 对齐 jetlinks convertToJavaType
   * 确保返回的是可序列化的纯对象
   */
  private normalizeResult(result: unknown): unknown {
    if (result === undefined || result === null) {
      return null;
    }
    if (typeof result === 'object' && result !== null) {
      // 确保 Map 类型转为普通对象
      if (result instanceof Map) {
        const obj: Record<string, unknown> = {};
        for (const [key, value] of result) {
          obj[String(key)] = this.normalizeResult(value);
        }
        return obj;
      }
      // 确保 Set 类型转为数组
      if (result instanceof Set) {
        return Array.from(result).map((v) => this.normalizeResult(v));
      }
    }
    return result;
  }
}
