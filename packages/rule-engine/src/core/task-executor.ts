import { Logger } from '@nestjs/common';
import type { ExecutionContext } from './execution-context';
import type { RuleData } from './rule-data';

/**
 * Rule engine constants — mirrors jetlinks RuleConstants.
 */
export const RuleConstants = {
  Event: {
    result: 'result',
    error: 'error',
    complete: 'complete',
  },
} as const;

/**
 * Extended execution context for task executors — adds rule-engine specific
 * methods like data creation and event firing on top of the base ExecutionContext.
 *
 * Mirrors the combined capabilities of jetlinks ExecutionContext + RuleDataHelper.
 */
export interface TaskExecutionContext {
  /** The logger scoped to this execution context. */
  getLogger(): Logger;
  /** Node-level configuration map. */
  getConfiguration(): Record<string, unknown>;
  /** Create a new RuleData from an existing one with new payload data. */
  newRuleDataFrom(source: RuleData, data: unknown): RuleData;
  /** Fire a named event (e.g. 'result', 'error', 'complete'). */
  fireEvent(event: string, data: RuleData): Promise<void>;
  /** Report an error that occurred during execution. */
  onError(error: Error, data: RuleData | null): Promise<void>;
}

/**
 * TaskExecutor lifecycle — mirrors jetlinks AbstractTaskExecutor.
 *
 * Lifecycle: create -> init -> start -> (pause / reload / shutdown)
 */
export enum TaskState {
  IDLE = 'idle',
  RUNNING = 'running',
  PAUSED = 'paused',
  SHUTDOWN = 'shutdown',
}

export interface TaskExecutor {
  /** Human-readable name of this executor instance. */
  getName(): string;

  /** Current lifecycle state. */
  getState(): TaskState;

  /** Initialise from configuration (called once after creation). */
  init(): Promise<void> | void;

  /** Start (or resume) execution. */
  start(): Promise<void> | void;

  /** Pause execution without releasing resources. */
  pause(): Promise<void> | void;

  /** Reload configuration and restart. */
  reload(): Promise<void> | void;

  /** Permanently shut down and release all resources. */
  shutdown(): Promise<void> | void;

  /** Validate configuration before starting. Throws on invalid config. */
  validate(): void;
}

/**
 * Factory that creates TaskExecutor instances for a given executor type.
 * Mirrors jetlinks TaskExecutorProvider.
 */
export interface TaskExecutorProvider {
  /** The executor identifier (e.g. 'timer', 'delay', 'script'). */
  getExecutor(): string;

  /** Create a new TaskExecutor for the given execution context. */
  createTask(context: ExecutionContext): Promise<TaskExecutor>;
}

/**
 * Base class providing common lifecycle management for TaskExecutors.
 */
export abstract class AbstractTaskExecutor implements TaskExecutor {
  protected state: TaskState = TaskState.IDLE;
  protected disposables: Array<() => void> = [];

  constructor(protected readonly context: ExecutionContext) {}

  abstract getName(): string;

  getState(): TaskState {
    return this.state;
  }

  async init(): Promise<void> {
    // Subclasses override to parse configuration
  }

  async start(): Promise<void> {
    if (this.state === TaskState.SHUTDOWN) {
      throw new Error('Cannot start a shutdown executor');
    }
    this.state = TaskState.RUNNING;
    const cleanup = await this.doStart();
    if (typeof cleanup === 'function') {
      this.addDisposable(cleanup);
    }
  }

  protected abstract doStart(): Promise<(() => void) | void> | (() => void) | void;

  async pause(): Promise<void> {
    this.state = TaskState.PAUSED;
  }

  async reload(): Promise<void> {
    await this.shutdown();
    this.state = TaskState.IDLE;
    await this.init();
    await this.start();
  }

  async shutdown(): Promise<void> {
    this.state = TaskState.SHUTDOWN;
    for (const dispose of this.disposables) {
      try { dispose(); } catch { /* best-effort cleanup */ }
    }
    this.disposables = [];
  }

  validate(): void {
    // Subclasses override
  }

  /** Register a cleanup function to be called on shutdown. */
  protected addDisposable(fn: () => void): void {
    this.disposables.push(fn);
  }
}
