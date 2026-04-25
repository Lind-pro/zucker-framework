import {
  AbstractTaskExecutor,
  RuleConstants,
  type TaskExecutionContext,
  type TaskExecutor,
  type TaskExecutorProvider,
} from '../core/task-executor';
import { createRuleData, type RuleData } from '../core/rule-data';

/**
 * 延迟/暂停类型 — 对齐 jetlinks DelayTaskExecutorProvider.PauseType
 *
 * - delay:   固定延迟
 * - delayv:  上游节点通过 data.delay 指定延迟
 * - random:  随机延迟
 * - rate:    速率限制（窗口内限制数量）
 */
export enum DelayPauseType {
  /** 固定延迟 */
  DELAY = 'delay',
  /** 上游数据指定延迟 */
  DELAY_VARIABLE = 'delayv',
  /** 随机延迟 */
  RANDOM = 'random',
  /** 速率限制 */
  RATE = 'rate',
}

/**
 * 时间单位 — 对齐 jetlinks ChronoUnit
 */
export enum TimeUnit {
  SECONDS = 'seconds',
  MINUTES = 'minutes',
  HOURS = 'hours',
  MILLIS = 'millis',
}

/**
 * 延迟执行器配置 — 对齐 jetlinks DelayTaskExecutorConfig
 */
export interface DelayExecutorConfig {
  /** 延迟类型 */
  pauseType: DelayPauseType;
  /** 固定延迟时间值 */
  timeout?: number;
  /** 固定延迟时间单位 */
  timeoutUnits?: TimeUnit;
  /** 速率限制：窗口内允许的最大数量 */
  rate?: number;
  /** 速率限制：窗口时间值 */
  nbRateUnits?: number;
  /** 速率限制：窗口时间单位 */
  rateUnits?: TimeUnit;
  /** 随机延迟最小值 */
  randomFirst?: number;
  /** 随机延迟最大值 */
  randomLast?: number;
  /** 随机延迟单位 */
  randomUnits?: TimeUnit;
  /** 丢弃被限流的消息时触发错误事件 — 对齐 jetlinks errorOnDrop */
  errorOnDrop?: boolean;
}

function toMs(value: number, unit: TimeUnit): number {
  switch (unit) {
    case TimeUnit.MILLIS:
      return value;
    case TimeUnit.SECONDS:
      return value * 1000;
    case TimeUnit.MINUTES:
      return value * 60 * 1000;
    case TimeUnit.HOURS:
      return value * 3600 * 1000;
    default:
      return value * 1000;
  }
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

/**
 * 延迟任务执行器 — 对齐 jetlinks DelayTaskExecutor
 */
class DelayTaskExecutor extends AbstractTaskExecutor {
  private config!: DelayExecutorConfig;
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];
  private rateWindowCount = 0;
  private rateWindowTimer?: ReturnType<typeof setInterval>;
  private inputCallback?: (data: RuleData) => void;

  constructor(context: TaskExecutionContext) {
    super(context);
    this.loadConfig();
  }

  getName(): string {
    return 'delay';
  }

  validate(): void {
    const cfg = this.context.getConfiguration() as unknown as DelayExecutorConfig;
    if (!cfg.pauseType) {
      throw new Error('Delay pause type is required');
    }
    if (cfg.pauseType === DelayPauseType.DELAY && (cfg.timeout == null || cfg.timeout <= 0)) {
      throw new Error('Delay timeout must be positive');
    }
    if (cfg.pauseType === DelayPauseType.RANDOM) {
      if (cfg.randomFirst == null || cfg.randomLast == null) {
        throw new Error('Random delay range is required');
      }
      if (cfg.randomFirst >= cfg.randomLast!) {
        throw new Error('Random delay first must be less than last');
      }
    }
    if (cfg.pauseType === DelayPauseType.RATE) {
      if (!cfg.rate || cfg.rate <= 0) {
        throw new Error('Rate limit must be positive');
      }
      if (!cfg.nbRateUnits || cfg.nbRateUnits <= 0) {
        throw new Error('Rate window duration must be positive');
      }
    }
  }

  protected async doStart(): Promise<(() => void) | undefined> {
    // The delay executor works as a pass-through with timing control.
    // It is designed to be fed data via the execute() method.
    return () => {
      this.clearTimers();
    };
  }

  /**
   * 处理传入数据 — 根据延迟类型进行延时转发
   */
  async execute(data: RuleData): Promise<void> {
    const handler = this.pauseTypeHandlers[this.config.pauseType];
    if (handler) {
      await handler(data);
    }
  }

  /** Strategy map for pause type handlers — replaces switch/case in execute. */
  private readonly pauseTypeHandlers: Record<string, (data: RuleData) => Promise<void>> = {
    [DelayPauseType.DELAY]: async (data) => {
      const ms = toMs(this.config.timeout ?? 1, this.config.timeoutUnits ?? TimeUnit.SECONDS);
      this.context.getLogger().debug(`Delay execution ${ms}ms`);
      await this.delayAndForward(data, ms);
    },
    [DelayPauseType.DELAY_VARIABLE]: async (data) => {
      const delayStr = (data.data as Record<string, unknown>)?.delay;
      if (delayStr == null) return;
      const ms = typeof delayStr === 'number' ? delayStr : parseInt(String(delayStr), 10);
      if (isNaN(ms) || ms <= 0) return;
      this.context.getLogger().debug(`Variable delay execution ${ms}ms`);
      await this.delayAndForward(data, ms);
    },
    [DelayPauseType.RANDOM]: async (data) => {
      const min = this.config.randomFirst ?? 0;
      const max = this.config.randomLast ?? 1;
      const value = randomInt(min, max);
      const ms = toMs(value, this.config.randomUnits ?? TimeUnit.SECONDS);
      this.context.getLogger().debug(`Random delay execution ${ms}ms`);
      await this.delayAndForward(data, ms);
    },
    [DelayPauseType.RATE]: async (data) => {
      this.handleRateLimit(data);
    },
  };

  reload(): void {
    this.clearTimers();
    this.loadConfig();
    super.reload();
  }

  private loadConfig(): void {
    this.config = this.context.getConfiguration() as unknown as DelayExecutorConfig;
  }

  private delayAndForward(data: RuleData, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(async () => {
        const idx = this.pendingTimers.indexOf(timer);
        if (idx >= 0) this.pendingTimers.splice(idx, 1);

        try {
          const newData = this.context.newRuleDataFrom(data, data.data);
          await this.context.fireEvent(RuleConstants.Event.result, newData);
        } catch (err) {
          await this.context.onError(
            err instanceof Error ? err : new Error(String(err)),
            data,
          );
        }
        resolve();
      }, ms);
      this.pendingTimers.push(timer);
    });
  }

  private handleRateLimit(data: RuleData): void {
    const windowMs = toMs(
      this.config.nbRateUnits ?? 1,
      this.config.rateUnits ?? TimeUnit.SECONDS,
    );
    const maxRate = this.config.rate ?? 1;

    // Initialize rate window timer if not running
    if (!this.rateWindowTimer) {
      this.rateWindowCount = 0;
      this.rateWindowTimer = setInterval(() => {
        this.rateWindowCount = 0;
      }, windowMs);
      this.pendingTimers.push(this.rateWindowTimer as unknown as ReturnType<typeof setTimeout>);
    }

    this.rateWindowCount++;

    if (this.rateWindowCount <= maxRate) {
      // Within rate limit — forward data
      const newData = this.context.newRuleDataFrom(data, data.data);
      this.context.fireEvent(RuleConstants.Event.result, newData).catch((err) => {
        this.context.onError(
          err instanceof Error ? err : new Error(String(err)),
          data,
        );
      });
    } else if (this.config.errorOnDrop) {
      // Exceeds rate limit and errorOnDrop is true — fire error event
      this.context.fireEvent(RuleConstants.Event.error, data).catch(() => {
        // Ignore error event publication failures
      });
    }
    // Otherwise silently drop
  }

  private clearTimers(): void {
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers = [];
    if (this.rateWindowTimer) {
      clearInterval(this.rateWindowTimer);
      this.rateWindowTimer = undefined;
    }
    this.rateWindowCount = 0;
  }
}

/**
 * 延迟任务执行器提供者 — 对齐 jetlinks DelayTaskExecutorProvider
 */
export class DelayTaskExecutorProvider implements TaskExecutorProvider {
  static readonly EXECUTOR = 'delay';

  getExecutor(): string {
    return DelayTaskExecutorProvider.EXECUTOR;
  }

  async createTask(context: TaskExecutionContext): Promise<TaskExecutor> {
    return new DelayTaskExecutor(context);
  }
}
