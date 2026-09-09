import { Injectable, Logger } from '@nestjs/common';
import { NotFoundException } from '@zucker-framework/core';

/**
 * Base interface for a named strategy.
 */
export interface Strategy {
  /** Unique identifier for this strategy */
  id: string;
}

/**
 * Manager for registering and resolving named strategies.
 * @template S - The strategy type
 */
export interface StrategyManager<S extends Strategy> {
  register(strategy: S): void;
  unregister(id: string): void;
  get(id: string): S | undefined;
  /** Get a strategy by id; throws if not found. */
  getNow(id: string): S;
  getAll(): S[];
  /** Check if a strategy is registered. */
  has(id: string): boolean;
}

/**
 * Default strategy manager — mirrors Java StaticStrategyManager with
 * doWith helpers and onStrategyNotFound hook.
 */
@Injectable()
export class DefaultStrategyManager<S extends Strategy> implements StrategyManager<S> {
  private readonly logger = new Logger(DefaultStrategyManager.name);
  private strategies = new Map<string, S>();

  register(strategy: S): void {
    this.strategies.set(strategy.id, strategy);
    this.logger.log(`Strategy registered: ${strategy.id}`);
  }

  unregister(id: string): void {
    this.strategies.delete(id);
    this.logger.log(`Strategy unregistered: ${id}`);
  }

  get(id: string): S | undefined {
    return this.strategies.get(id);
  }

  /**
   * Get strategy by id; throws if not found.
   * Mirrors Java StaticStrategyManager's implicit throw behaviour via
   * switchIfEmpty + onStrategyNotFound.
   */
  getNow(id: string): S {
    const strategy = this.strategies.get(id);
    if (!strategy) {
      return this.onStrategyNotFound(id);
    }
    return strategy;
  }

  getAll(): S[] {
    return Array.from(this.strategies.values());
  }

  /**
   * Check if a strategy is registered.
   */
  has(id: string): boolean {
    return this.strategies.has(id);
  }

  /**
   * Execute an async function with a resolved strategy.
   * Mirrors Java StaticStrategyManager.doWithMono().
   */
  async doWith<T>(strategyId: string, executor: (strategy: S) => Promise<T>): Promise<T | undefined> {
    const strategy = this.get(strategyId);
    if (!strategy) {
      try {
        this.onStrategyNotFound(strategyId);
      } catch (err) {
        this.logger.debug(`Strategy not found (doWith): ${strategyId} — ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
      return undefined;
    }
    return executor(strategy);
  }

  /**
   * Execute an async function that returns an array with a resolved strategy.
   * Mirrors Java StaticStrategyManager.doWithFlux().
   */
  async doWithMany<T>(strategyId: string, executor: (strategy: S) => Promise<T[]>): Promise<T[]> {
    const strategy = this.get(strategyId);
    if (!strategy) {
      try {
        this.onStrategyNotFound(strategyId);
      } catch (err) {
        this.logger.debug(`Strategy not found (doWithMany): ${strategyId} — ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
      return [];
    }
    return executor(strategy);
  }

  /**
   * Called when a strategy is not found. By default throws an error.
   * Subclasses can override to return a fallback or silently return undefined.
   * Mirrors Java StaticStrategyManager.onStrategyNotFound().
   */
  protected onStrategyNotFound(strategyId: string): never {
    throw new NotFoundException(`Strategy not found: ${strategyId}`);
  }
}
