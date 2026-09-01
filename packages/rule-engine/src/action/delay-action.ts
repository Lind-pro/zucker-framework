import { Logger } from '@nestjs/common';

/**
 * Delay action — mirrors jetlinks DelayTaskExecutorProvider.
 *
 * Supports multiple pause types:
 * - fixed delay
 * - random delay
 * - upstream-specified delay (delayv)
 * - rate limiting
 */
export type DelayPauseType = 'delay' | 'delayv' | 'random' | 'rate';

export type DelayTimeUnit = 'milliseconds' | 'seconds' | 'minutes' | 'hours';

export interface DelayActionConfig {
  /** Type of delay behaviour. */
  pauseType: DelayPauseType;

  /** Fixed delay amount (for 'delay' type). */
  timeout?: number;
  /** Unit for timeout. */
  timeoutUnits?: DelayTimeUnit;

  /** Random delay lower bound (for 'random' type). */
  randomFirst?: number;
  /** Random delay upper bound (for 'random' type). */
  randomLast?: number;
  /** Unit for random delay. */
  randomUnits?: DelayTimeUnit;

  /** Rate limit: max events per window (for 'rate' type). */
  rate?: number;
  /** Rate window size. */
  nbRateUnits?: number;
  /** Rate window unit. */
  rateUnits?: DelayTimeUnit;
}

function toMs(value: number, unit: DelayTimeUnit): number {
  switch (unit) {
    case 'milliseconds': return value;
    case 'seconds': return value * 1000;
    case 'minutes': return value * 60_000;
    case 'hours': return value * 3_600_000;
    default: return value;
  }
}

export class DelayAction {
  private readonly logger = new Logger(DelayAction.name);

  /**
   * Execute the delay according to the configured pause type.
   * For 'delayv', the delay duration comes from `data.delay` (string parseable as ms).
   * Returns the data after the delay completes.
   */
  async execute(
    config: DelayActionConfig,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const delayMs = this.calculateDelay(config, data);

    if (delayMs > 0) {
      this.logger.debug(`Delaying execution for ${delayMs}ms (type=${config.pauseType})`);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }

    return data;
  }

  private calculateDelay(config: DelayActionConfig, data: Record<string, unknown>): number {
    switch (config.pauseType) {
      case 'delay':
        return toMs(config.timeout ?? 0, config.timeoutUnits ?? 'seconds');

      case 'delayv': {
        const raw = data['delay'];
        if (raw === undefined || raw === null) return 0;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : 0;
      }

      case 'random': {
        const min = toMs(config.randomFirst ?? 0, config.randomUnits ?? 'seconds');
        const max = toMs(config.randomLast ?? 0, config.randomUnits ?? 'seconds');
        return min + Math.random() * (max - min);
      }

      case 'rate':
        // Rate limiting is handled at the stream level, not per-message delay.
        // This is a no-op delay; rate limiting is applied by the engine.
        return 0;

      default:
        return 0;
    }
  }
}
