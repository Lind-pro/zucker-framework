/**
 * 抖动限制 — 对齐 jetlinks ShakeLimit
 *
 * 在单位时间内发生多次事件时，只触发一次回调。
 * 支持两种模式：
 *   - alarmFirst=true:  窗口内达到阈值后立即触发第一次
 *   - alarmFirst=false: 窗口结束后触发最后一次（含统计计数）
 */
export interface ShakeLimitConfig {
  /** 是否启用防抖 */
  enabled: boolean;
  /** 时间窗口（秒） — 对齐 jetlinks ShakeLimit.time */
  time: number;
  /** 触发阈值（次） — 对齐 jetlinks ShakeLimit.threshold */
  threshold: number;
  /** 是否第一次满足就触发 — 对齐 jetlinks ShakeLimit.alarmFirst */
  alarmFirst?: boolean;
}

/**
 * 抖动限制结果 — 对齐 jetlinks ShakeLimitResult
 */
export interface ShakeLimitResult<T> {
  /** 触发的数据 */
  data: T;
  /** 窗口内总计数 */
  total: number;
}

/**
 * 抖动限制器 — 对齐 jetlinks ShakeLimit.transfer()
 *
 * 使用基于时间窗口的方式限制事件触发频率。
 */
export class ShakeLimiter<T = unknown> {
  private config: ShakeLimitConfig;
  private windowData: T[] = [];
  private windowTimer?: ReturnType<typeof setTimeout>;
  private firstInWindow?: T;
  private triggered = false;
  private callback: (result: ShakeLimitResult<T>) => void;

  constructor(
    config: ShakeLimitConfig,
    callback: (result: ShakeLimitResult<T>) => void,
  ) {
    this.config = config;
    this.callback = callback;
  }

  /**
   * 接收数据 — 对齐 jetlinks ShakeLimit.transfer() 中的流处理逻辑
   *
   * 如果防抖未启用，立即触发回调。
   * 否则按窗口+阈值逻辑控制触发。
   */
  push(data: T): void {
    if (!this.config.enabled || this.config.time <= 0) {
      this.callback({ data, total: 1 });
      return;
    }

    // 记录第一条数据
    if (this.windowData.length === 0) {
      this.firstInWindow = data;
    }

    this.windowData.push(data);

    // 启动窗口定时器（如果尚未启动）
    if (!this.windowTimer) {
      this.triggered = false;
      this.windowTimer = setTimeout(() => {
        this.onWindowEnd();
      }, this.config.time * 1000);
    }

    const thresholdMet = this.windowData.length >= this.config.threshold;

    if (thresholdMet && this.config.alarmFirst && !this.triggered) {
      // alarmFirst 模式：达到阈值后立即触发第一条
      this.triggered = true;
      this.callback({
        data: this.firstInWindow!,
        total: this.windowData.length,
      });
    }
  }

  /**
   * 窗口结束处理
   */
  private onWindowEnd(): void {
    const total = this.windowData.length;
    const lastData = this.windowData[this.windowData.length - 1];
    const thresholdMet = total >= this.config.threshold;

    // alarmFirst=false 模式：窗口结束时触发最后一条
    if (thresholdMet && !this.config.alarmFirst && !this.triggered) {
      this.callback({
        data: lastData!,
        total,
      });
    }

    // 重置窗口
    this.windowData = [];
    this.firstInWindow = undefined;
    this.windowTimer = undefined;
    this.triggered = false;
  }

  /**
   * 停止防抖器
   */
  dispose(): void {
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = undefined;
    }
    this.windowData = [];
    this.firstInWindow = undefined;
    this.triggered = false;
  }

  /**
   * 获取当前窗口内的计数
   */
  getCurrentCount(): number {
    return this.windowData.length;
  }
}
