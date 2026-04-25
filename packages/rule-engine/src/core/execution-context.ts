import { Logger } from '@nestjs/common';
import { RuleData } from './rule-data';

/**
 * Mirrors jetlinks ExecutionContext — provides input/output channels,
 * logging, error handling, and event firing for a TaskExecutor.
 */
export interface ExecutionContext {
  /** The logger scoped to this execution context. */
  getLogger(): Logger;

  /** Create a new RuleData wrapping the given payload, inheriting context. */
  newRuleData(data: unknown): RuleData;

  /** Input channel — receives data from upstream nodes. */
  getInput(): InputChannel;

  /** Output channel — sends data to downstream nodes. */
  getOutput(): OutputChannel;

  /** Fire a named event (e.g. 'result', 'error', 'complete'). */
  fireEvent(event: string, data: RuleData): Promise<void>;

  /** Report an error that occurred during execution. */
  onError(error: Error, data: RuleData | null): Promise<void>;

  /** Job / node configuration. */
  getJob(): JobContext;
}

export interface InputChannel {
  /** Subscribe to incoming data. Returns an unsubscribe function. */
  accept(handler: (data: RuleData) => void | Promise<void>): () => void;
}

export interface OutputChannel {
  /** Write data to downstream nodes. */
  write(data: RuleData): Promise<void>;
}

export interface JobContext {
  /** The executor type identifier. */
  getExecutor(): string;

  /** Node-level configuration map. */
  getConfiguration(): Record<string, unknown>;

  /** Get a specific rule-level configuration value. */
  getRuleConfiguration(key: string): unknown | undefined;

  /** The node ID this job belongs to. */
  getNodeId(): string;

  /** The rule instance ID. */
  getRuleId(): string;
}
