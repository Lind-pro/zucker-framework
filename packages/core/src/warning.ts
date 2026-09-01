/**
 * Warning — 警告收集器
 * 参考: hsweb-framework Warning.java
 *
 * hsweb 使用 Reactor Context 收集警告信息，zucker 使用 ContextHolder 收集。
 * 在处理链中可以添加警告，最终统一返回给调用方（如放入响应体的 warnings 字段）。
 */

import { ContextKey, ContextHolder } from './context';

export class Warning {
  readonly code: string;
  readonly args: unknown[];

  constructor(code: string, ...args: unknown[]) {
    this.code = code;
    this.args = args;
  }

  /**
   * 向当前上下文添加警告
   * 参考 hsweb Warning.addWarnToContext
   */
  static add(warning: Warning): void {
    const warnings = ContextHolder.get(Warning.CONTEXT_KEY);
    if (warnings) {
      warnings.push(warning);
    }
  }

  /**
   * 便捷方法 — 创建并添加警告
   */
  static addWarning(code: string, ...args: unknown[]): void {
    Warning.add(new Warning(code, ...args));
  }

  /**
   * 获取当前上下文中的所有警告
   */
  static getWarnings(): Warning[] {
    return ContextHolder.get(Warning.CONTEXT_KEY) ?? [];
  }

  /**
   * 初始化上下文中的警告列表
   * 参考 hsweb Warning.createWarning — 确保 context 中存在警告列表
   */
  static initWarnings(): void {
    const ctx = ContextHolder.current();
    if (ctx && !ctx.has(Warning.CONTEXT_KEY)) {
      ctx.set(Warning.CONTEXT_KEY, []);
    }
  }

  /**
   * 捕获错误并转为警告（不阻断流程）
   * 参考 hsweb Warning.resumeMonoError / resumeFluxError
   *
   * @param error 错误对象
   * @param builder 错误转警告的构建函数，返回 null 则忽略该错误
   */
  static fromError(
    error: unknown,
    builder: (err: unknown) => Warning | null,
  ): void {
    const warning = builder(error);
    if (warning) {
      Warning.add(warning);
    }
  }

  /** 上下文键 */
  static readonly CONTEXT_KEY = ContextKey.of<Warning[]>('__warnings__');
}
