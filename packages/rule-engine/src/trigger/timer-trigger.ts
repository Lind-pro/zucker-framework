import { Logger } from '@nestjs/common';
import { parseCron, type CronSchedule } from './cron';

export interface TimerTriggerConfig {
  /** 5-, 6- (leading seconds) or 7-field (trailing year) cron expression; see `parseCron`. */
  cron: string;
  /** IANA timezone used to evaluate the expression (default: process local time). */
  timezone?: string;
  /** 执行次数限制（0 = 无限） */
  maxTimes?: number;
}

/**
 * 定时触发器 — 对齐 jetlinks TimerTaskExecutor
 * 增加执行次数追踪和验证
 *
 * Fires at the actual cron occurrences (honouring `timezone`). A tick that arrives while the
 * previous handler run is still in flight is skipped, so slow handlers never stack up — also
 * across `reload()`/`start()`: a run started under the previous configuration still blocks
 * overlapping ticks of the new one.
 *
 * The trigger is process-local: in a cluster every node running the rule fires. Gate the handler
 * on `ClusterManager.isLeader()` (or take a distributed lock) when a run must happen once per
 * cluster.
 */
export class TimerTrigger {
  private readonly logger = new Logger(TimerTrigger.name);
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  /** The handler run in progress (kept across generations so a reload cannot overlap it). */
  private inFlight?: Promise<void>;
  private executionCount = 0;
  private lastExecutionTime?: Date;
  private config?: TimerTriggerConfig;
  private schedule?: CronSchedule;
  /** Incremented on every start/stop so callbacks from an older schedule are ignored. */
  private generation = 0;

  start(
    config: TimerTriggerConfig,
    handler: () => void | Promise<void>,
  ): void {
    this.validate(config);
    this.clearTimer();

    this.config = config;
    this.schedule = parseCron(config.cron, config.timezone);
    this.logger.log(
      `Timer trigger started: cron=${config.cron}${config.timezone ? ` tz=${config.timezone}` : ''}`,
    );
    this.running = true;
    this.executionCount = 0;
    const generation = ++this.generation;
    this.scheduleNext(generation, handler);
  }

  private scheduleNext(generation: number, handler: () => void | Promise<void>): void {
    if (!this.running || generation !== this.generation || !this.schedule) return;
    const next = this.schedule.next(new Date());
    if (!next) {
      this.logger.warn(`Cron expression has no future occurrence: ${this.schedule.expression}`);
      this.stop();
      return;
    }
    // setTimeout overflows above 2^31-1 ms; wake up early and re-plan in that case.
    const delay = Math.min(Math.max(0, next.getTime() - Date.now()), 2_147_483_647);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (Date.now() < next.getTime()) {
        this.scheduleNext(generation, handler);
        return;
      }
      this.fire(generation, handler);
      this.scheduleNext(generation, handler);
    }, delay);
    this.timer.unref?.();
  }

  private fire(generation: number, handler: () => void | Promise<void>): void {
    if (!this.running || generation !== this.generation) return;
    const config = this.config;
    // 检查执行次数限制
    if (config?.maxTimes && config.maxTimes > 0 && this.executionCount >= config.maxTimes) {
      this.stop();
      return;
    }
    if (this.inFlight) {
      this.logger.warn('Timer trigger tick skipped: previous run still in progress');
      return;
    }
    this.executionCount++;
    this.lastExecutionTime = new Date();
    let result: void | Promise<void>;
    try {
      result = handler();
    } catch (error) {
      this.logger.error(`Timer trigger handler error: ${error}`);
      this.afterRun(generation);
      return;
    }
    const run: Promise<void> = Promise.resolve(result)
      .catch((error: unknown) => {
        this.logger.error(`Timer trigger handler error: ${error}`);
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = undefined;
      });
    this.inFlight = run;
    this.afterRun(generation);
  }

  private afterRun(generation: number): void {
    const config = this.config;
    if (
      generation === this.generation &&
      config?.maxTimes &&
      config.maxTimes > 0 &&
      this.executionCount >= config.maxTimes
    ) {
      this.stop();
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.clearTimer();
    this.logger.log('Timer trigger stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 获取已执行次数 — 对齐 jetlinks TimerTaskExecutor 中的 times 传递 */
  getExecutionCount(): number {
    return this.executionCount;
  }

  /** 获取最后执行时间 */
  getLastExecutionTime(): Date | undefined {
    return this.lastExecutionTime;
  }

  /**
   * 重新加载配置 — 对齐 jetlinks TimerTaskExecutor.reload()
   */
  reload(config: TimerTriggerConfig, handler: () => void | Promise<void>): void {
    this.stop();
    this.start(config, handler);
  }

  /**
   * 验证配置 — 对齐 jetlinks TimerTaskExecutor.validate()
   */
  validate(config?: TimerTriggerConfig): void {
    const cfg = config ?? this.config;
    if (!cfg) {
      throw new Error('Timer trigger config is required');
    }
    if (!cfg.cron || cfg.cron.trim().length === 0) {
      throw new Error('Cron expression is required');
    }
    // Parses the full expression (and timezone); throws for unsupported syntax.
    parseCron(cfg.cron, cfg.timezone);
  }
}
