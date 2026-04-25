/**
 * Agent 编排接口 — 对标 LangGraph/LangChain Agent 概念。
 *
 * 提供抽象接口，不绑定任何具体框架。
 * 用户可通过适配器接入 LangChain、LangGraph 或自定义实现。
 */

/** AI 工具定义（对齐 LangChain Tool / OpenAI Function Calling） */
export interface AITool {
  name: string;
  description: string;
  /** JSON Schema 描述输入参数 */
  inputSchema?: Record<string, unknown>;
  /** 执行工具 */
  execute(input: Record<string, unknown>): Promise<unknown>;
}

/** Agent 执行步骤 */
export interface AgentStep {
  type: 'tool_call' | 'thought' | 'observation' | 'final_answer';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  timestamp: number;
}

/** Agent 执行结果 */
export interface AgentResult {
  answer: string;
  steps: AgentStep[];
  tokenUsage: { input: number; output: number; total: number };
  duration: number;
}

/**
 * Agent 执行器接口。
 * 对标 LangGraph 的 StateGraph + LangChain 的 AgentExecutor。
 *
 * 实现方可以自由选择底层框架：
 * - 直接调用 OpenAI/Claude API（零依赖）
 * - 适配 LangChain AgentExecutor
 * - 适配 LangGraph StateGraph
 * - 适配 Vercel AI SDK Agent
 */
export interface AgentExecutor {
  /** 执行 agent 任务 */
  execute(input: string, context?: AgentContext): Promise<AgentResult>;
  /** 流式执行（返回步骤流） */
  stream?(input: string, context?: AgentContext): AsyncIterable<AgentStep>;
  /** 获取已注册的工具列表 */
  getTools(): AITool[];
}

/** Agent 执行上下文 */
export interface AgentContext {
  userId?: string;
  sessionId?: string;
  /** 历史消息 */
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  /** 最大步骤数（防止无限循环） */
  maxSteps?: number;
  /** 自定义变量 */
  variables?: Record<string, unknown>;
}

/**
 * 工具注册表 — 集中管理可用工具。
 * 对标 LangChain ToolRegistry 概念。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AITool>();

  register(tool: AITool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): AITool | undefined {
    return this.tools.get(name);
  }

  getAll(): AITool[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get count(): number {
    return this.tools.size;
  }
}

/**
 * Chain 管道 — 链式调用多个处理步骤。
 * 对标 LangChain Chain / LCEL 概念。
 *
 * @example
 * const chain = new ChainPipeline<string, string>()
 *   .pipe(async (input) => `Translate: ${input}`)
 *   .pipe(async (prompt) => await llm.call(prompt))
 *   .pipe(async (result) => result.trim());
 * const output = await chain.invoke('Hello');
 */
export class ChainPipeline<TInput, TOutput> {
  private readonly steps: Array<(input: unknown) => Promise<unknown>> = [];

  pipe<TNext>(fn: (input: TOutput) => Promise<TNext>): ChainPipeline<TInput, TNext> {
    this.steps.push(fn as (input: unknown) => Promise<unknown>);
    return this as unknown as ChainPipeline<TInput, TNext>;
  }

  async invoke(input: TInput): Promise<TOutput> {
    let current: unknown = input;
    for (const step of this.steps) {
      current = await step(current);
    }
    return current as TOutput;
  }
}
