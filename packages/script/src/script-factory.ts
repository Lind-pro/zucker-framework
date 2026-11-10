import { Injectable, Logger } from '@nestjs/common';
import { createSandbox, SandboxOptions } from './sandbox';
import { bindInterface } from './interface-binding';
import {
  ExecutionContext,
  createExecutionContext,
  composeContexts,
} from './execution-context';

export interface Script {
  id: string;
  name: string;
  content: string;
  language: string;
  /** 脚本的来源对象（可选，用于追踪） */
  source?: unknown;
}

export interface CompiledScript {
  call(...args: unknown[]): Promise<unknown>;
  callWithContext(
    context: Record<string, unknown>,
    ...args: unknown[]
  ): Promise<unknown>;
  /** 使用 ExecutionContext 执行（对齐 jetlinks CompiledScript.call(ExecutionContext)） */
  callWithExecutionContext(context: ExecutionContext): Promise<unknown>;
}

export interface ScriptFactory {
  compile(script: Script): Promise<CompiledScript>;
  compileExpose(
    script: Script,
    expose: Record<string, unknown>,
  ): Promise<CompiledScript>;
  bind(
    script: Script,
    context: Record<string, unknown>,
  ): Promise<CompiledScript>;
  /** 编译脚本并将其方法绑定到指定接口 */
  createProxy<T extends Record<string, (...args: unknown[]) => unknown>>(
    script: Script,
    interfaceKeys: string[],
  ): Promise<T>;
  /** 添加允许在沙箱中使用的模块 */
  allowModule(moduleName: string): void;
  /** 移除允许的模块 */
  denyModule(moduleName: string): void;
  /**
   * 将脚本返回值转换为纯 JS 类型。
   * 对齐 jetlinks ScriptFactory.convertToJavaType() — 确保 Map/Set 等
   * 非可序列化类型被转换为 POJO。
   */
  convertToJavaType(data: unknown): unknown;
}

/**
 * 类型访问控制列表 — 对齐 jetlinks AbstractScriptFactory 的 allows/denies
 * 在 TypeScript/Node.js 中主要用于模块级控制
 */
interface AccessControl {
  allowedModules: Set<string>;
  deniedPatterns: Set<string>;
  allowedPatterns: Set<string>;
}

@Injectable()
export class JavaScriptScriptFactory implements ScriptFactory {
  private readonly logger = new Logger(JavaScriptScriptFactory.name);
  private defaultOptions: SandboxOptions = {
    timeout: 5000,
    allowedModules: [],
  };
  private readonly accessControl: AccessControl = {
    allowedModules: new Set<string>(),
    deniedPatterns: new Set<string>(['*']),
    allowedPatterns: new Set<string>(),
  };

  setDefaultOptions(options: Partial<SandboxOptions>): void {
    this.defaultOptions = { ...this.defaultOptions, ...options };
  }

  /** 添加允许的模块 — 对齐 jetlinks allows() */
  allowModule(moduleName: string): void {
    this.accessControl.allowedModules.add(moduleName);
  }

  /** 移除允许的模块 — 对齐 jetlinks denies() */
  denyModule(moduleName: string): void {
    this.accessControl.allowedModules.delete(moduleName);
  }

  /** 添加允许的模式（正则） — 对齐 jetlinks allowsPattern() */
  allowPattern(pattern: string): void {
    this.accessControl.allowedPatterns.add(pattern);
  }

  /** 添加拒绝的模式（正则） — 对齐 jetlinks deniesPattern() */
  denyPattern(pattern: string): void {
    this.accessControl.deniedPatterns.add(pattern);
  }

  /** 检查模块是否被拒绝 — 对齐 jetlinks isDenied() */
  isDenied(moduleName: string): boolean {
    if (this.accessControl.allowedModules.has(moduleName)) {
      return false;
    }
    for (const pattern of this.accessControl.allowedPatterns) {
      if (new RegExp(pattern).test(moduleName)) {
        return false;
      }
    }
    if (this.accessControl.deniedPatterns.has('*')) {
      return true;
    }
    for (const pattern of this.accessControl.deniedPatterns) {
      if (new RegExp(pattern).test(moduleName)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 将脚本返回值转换为纯 JS 类型 — 对齐 jetlinks AbstractScriptFactory.convertToJavaType()。
   * 确保 Map、Set 等非 JSON 安全类型被转为 POJO/Array。
   */
  convertToJavaType(data: unknown): unknown {
    if (data === undefined || data === null) {
      return data;
    }
    if (data instanceof Map) {
      const obj: Record<string, unknown> = {};
      for (const [key, value] of data) {
        obj[String(key)] = this.convertToJavaType(value);
      }
      return obj;
    }
    if (data instanceof Set) {
      return Array.from(data).map((v) => this.convertToJavaType(v));
    }
    if (Array.isArray(data)) {
      return data.map((v) => this.convertToJavaType(v));
    }
    return data;
  }

  async compile(script: Script): Promise<CompiledScript> {
    return this.compileExpose(script, {});
  }

  async compileExpose(
    script: Script,
    expose: Record<string, unknown>,
  ): Promise<CompiledScript> {
    this.logger.debug(`Compiling script: ${script.name}`);

    const allowedModules = Array.from(this.accessControl.allowedModules);
    const sandboxOptions: SandboxOptions = {
      ...this.defaultOptions,
      name: script.name,
      allowedModules: [
        ...this.defaultOptions.allowedModules,
        ...allowedModules,
      ],
    };

    return {
      call: async (...args: unknown[]) => {
        const sandbox = createSandbox(sandboxOptions);
        return sandbox.executeAsync(script.content, { ...expose, __args: args });
      },
      callWithContext: async (
        context: Record<string, unknown>,
        ...args: unknown[]
      ) => {
        const sandbox = createSandbox(sandboxOptions);
        return sandbox.executeAsync(script.content, {
          ...expose,
          ...context,
          __args: args,
        });
      },
      callWithExecutionContext: async (execCtx: ExecutionContext) => {
        const sandbox = createSandbox(sandboxOptions);
        return sandbox.executeAsync(script.content, {
          ...expose,
          ...execCtx.toRecord(),
        });
      },
    };
  }

  async bind(
    script: Script,
    context: Record<string, unknown>,
  ): Promise<CompiledScript> {
    return this.compileExpose(script, context);
  }

  async createProxy<
    T extends Record<string, (...args: unknown[]) => unknown>,
  >(script: Script, interfaceKeys: string[]): Promise<T> {
    const compiled = await this.compile(script);
    return bindInterface<T>(compiled, interfaceKeys);
  }
}
