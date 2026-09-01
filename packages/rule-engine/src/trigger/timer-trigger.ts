import { Logger } from '@nestjs/common';

export interface TimerTriggerConfig {
  cron: string;
  timezone?: string;
  /** 执行次数限制（0 = 无限） */
  maxTimes?: number;
}

/**
 * 定时触发器 — 对齐 jetlinks TimerTaskExecutor
 * 增加执行次数追踪和验证
 */
export class TimerTrigger {
  private readonly logger = new Logger(TimerTrigger.name);
  private intervalId?: ReturnType<typeof setInterval>;
  private running = false;
  private executionCount = 0;
  private lastExecutionTime?: Date;
  private config?: TimerTriggerConfig;

  start(
    config: TimerTriggerConfig,
    handler: () => void | Promise<void>,
  ): void {
    this.validate(config);

    this.config = config;
    this.logger.log(`Timer trigger started: cron=${config.cron}`);
    const intervalMs = this.parseCronToInterval(config.cron);
    this.running = true;
    this.executionCount = 0;

    this.intervalId = setInterval(async () => {
      if (!this.running) return;

      // 检查执行次数限制
      if (config.maxTimes && config.maxTimes > 0 && this.executionCount >= config.maxTimes) {
        this.stop();
        return;
      }

      try {
        this.executionCount++;
        this.lastExecutionTime = new Date();
        await handler();
      } catch (error) {
        this.logger.error(`Timer trigger handler error: ${error}`);
      }
    }, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
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
    // 验证 cron 格式基本合法性
    const parts = cfg.cron.trim().split(/\s+/);
    if (parts.length < 5 || parts.length > 7) {
      throw new Error(
        `Invalid cron expression: expected 5-7 fields, got ${parts.length}`,
      );
    }
    // 尝试解析确保不会报错
    this.parseCronToInterval(cfg.cron);
  }

  private parseCronToInterval(cron: string): number {
    const parts = cron.trim().split(/\s+/);
    // 支持简单格式：秒级 (* * * * * *) 或分钟级 (* * * * *)
    if (parts.length >= 6) {
      // 秒级 cron
      const seconds = parts[0];
      if (seconds.startsWith('*/')) {
        const interval = parseInt(seconds.slice(2));
        if (isNaN(interval) || interval <= 0) {
          throw new Error(`Invalid cron second interval: ${seconds}`);
        }
        return interval * 1000;
      }
      return 1000; // 每秒
    }
    if (parts.length >= 5) {
      const minutes = parts[0];
      if (minutes.startsWith('*/')) {
        const interval = parseInt(minutes.slice(2));
        if (isNaN(interval) || interval <= 0) {
          throw new Error(`Invalid cron minute interval: ${minutes}`);
        }
        return interval * 60 * 1000;
      }
      return 60 * 1000; // 每分钟
    }
    return 60 * 1000; // 默认每分钟
  }
}
