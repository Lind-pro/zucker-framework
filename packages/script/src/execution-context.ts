/**
 * 脚本执行上下文 — 对齐 jetlinks ExecutionContext 设计
 * 支持多层属性查找（layered context resolution）和上下文组合
 */

export interface ExecutionContext {
  getAttribute(name: string): unknown;
  setAttribute(name: string, value: unknown): void;
  removeAttribute(name: string): unknown;
  hasAttribute(name: string): boolean;
  merge(other: ExecutionContext): ExecutionContext;
  toRecord(): Record<string, unknown>;
}

/**
 * 默认执行上下文：支持多层 Map 查找，先找到的优先
 * 最后一层为可写层（自动创建）
 */
export class DefaultExecutionContext implements ExecutionContext {
  private readonly layers: Array<Map<string, unknown> | Record<string, unknown>>;
  private selfLayer: Map<string, unknown>;

  constructor(...contexts: Array<Record<string, unknown>>) {
    this.layers = contexts.map((c) => c);
    this.selfLayer = new Map();
    // self layer is appended as last fallback for writes
  }

  getAttribute(name: string): unknown {
    // search through provided layers first
    for (const layer of this.layers) {
      if (layer instanceof Map) {
        if (layer.has(name)) return layer.get(name);
      } else {
        if (name in layer) return layer[name];
      }
    }
    // then self layer
    if (this.selfLayer.has(name)) return this.selfLayer.get(name);
    return undefined;
  }

  setAttribute(name: string, value: unknown): void {
    this.selfLayer.set(name, value);
  }

  removeAttribute(name: string): unknown {
    const existing = this.selfLayer.get(name);
    this.selfLayer.delete(name);
    return existing;
  }

  hasAttribute(name: string): boolean {
    for (const layer of this.layers) {
      if (layer instanceof Map) {
        if (layer.has(name)) return true;
      } else {
        if (name in layer) return true;
      }
    }
    return this.selfLayer.has(name);
  }

  merge(other: ExecutionContext): ExecutionContext {
    return new CompositeExecutionContext(this, other);
  }

  toRecord(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    // reverse order so earlier layers override later ones
    for (const entry of this.selfLayer.entries()) {
      result[entry[0]] = entry[1];
    }
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (layer instanceof Map) {
        for (const entry of layer.entries()) {
          result[entry[0]] = entry[1];
        }
      } else {
        Object.assign(result, layer);
      }
    }
    return result;
  }
}

/**
 * 组合执行上下文：合并多个 ExecutionContext，按顺序查找
 * 对齐 jetlinks CompositeExecutionContext
 */
export class CompositeExecutionContext implements ExecutionContext {
  private contexts: ExecutionContext[];

  constructor(...contexts: ExecutionContext[]) {
    this.contexts = [...contexts];
  }

  getAttribute(name: string): unknown {
    for (const ctx of this.contexts) {
      if (ctx.hasAttribute(name)) {
        return ctx.getAttribute(name);
      }
    }
    return undefined;
  }

  setAttribute(name: string, value: unknown): void {
    // write to the last context
    if (this.contexts.length > 0) {
      this.contexts[this.contexts.length - 1].setAttribute(name, value);
    }
  }

  removeAttribute(name: string): unknown {
    for (const ctx of this.contexts) {
      if (ctx.hasAttribute(name)) {
        return ctx.removeAttribute(name);
      }
    }
    return undefined;
  }

  hasAttribute(name: string): boolean {
    return this.contexts.some((ctx) => ctx.hasAttribute(name));
  }

  merge(other: ExecutionContext): ExecutionContext {
    this.contexts = [...this.contexts, other];
    return this;
  }

  toRecord(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    // reverse so earlier contexts take precedence
    for (let i = this.contexts.length - 1; i >= 0; i--) {
      Object.assign(result, this.contexts[i].toRecord());
    }
    return result;
  }
}

/**
 * 工厂方法
 */
export function createExecutionContext(
  ...contexts: Array<Record<string, unknown>>
): ExecutionContext {
  return new DefaultExecutionContext(...contexts);
}

export function composeContexts(
  ...contexts: ExecutionContext[]
): ExecutionContext {
  return new CompositeExecutionContext(...contexts);
}
