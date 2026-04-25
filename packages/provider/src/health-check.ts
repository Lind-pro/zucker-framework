import { Logger } from '@nestjs/common';
import type { Provider, ProviderRegistry } from './provider-registry';

/**
 * Provider 健康检查扩展
 *
 * 对标 Claude Code Plugin 系统的 manifest validation + health checks:
 * 对已注册的 Provider 进行周期性健康检查和条件激活。
 */

export interface HealthCheckable {
  /** 执行健康检查，返回 true 表示健康 */
  healthCheck(): Promise<boolean>;
}

export interface ConditionalProvider {
  /** 判断该 Provider 是否应该被激活 */
  shouldActivate(): boolean | Promise<boolean>;
}

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface ProviderHealthInfo {
  id: string;
  status: HealthStatus;
  lastChecked: number;
  consecutiveFailures: number;
  metadata?: Record<string, unknown>;
}

/**
 * Provider 健康检查管理器
 *
 * 用法:
 * ```ts
 * const healthManager = new ProviderHealthManager(registry);
 *
 * // 对所有支持健康检查的 Provider 执行检查
 * const results = await healthManager.checkAll();
 *
 * // 启动定期检查
 * healthManager.startPeriodicChecks({ intervalMs: 30_000 });
 *
 * // 停止检查
 * healthManager.stop();
 * ```
 */
export class ProviderHealthManager<T> {
  private readonly logger = new Logger(ProviderHealthManager.name);
  private readonly healthState = new Map<string, ProviderHealthInfo>();
  private intervalHandle?: ReturnType<typeof setInterval>;

  constructor(private readonly registry: ProviderRegistry<T>) {}

  /**
   * 对所有已注册的 Provider 执行健康检查
   */
  async checkAll(): Promise<ProviderHealthInfo[]> {
    const providers = this.registry.getAll();
    const results: ProviderHealthInfo[] = [];

    for (const provider of providers) {
      const info = await this.check(provider);
      results.push(info);
    }

    return results;
  }

  /**
   * 对单个 Provider 执行健康检查
   */
  async check(provider: Provider<T>): Promise<ProviderHealthInfo> {
    const existing = this.healthState.get(provider.id) ?? {
      id: provider.id,
      status: 'unknown' as HealthStatus,
      lastChecked: 0,
      consecutiveFailures: 0,
      metadata: provider.metadata,
    };

    const instance = provider.instance as unknown;
    if (!this.isHealthCheckable(instance)) {
      existing.status = 'unknown';
      existing.lastChecked = Date.now();
      this.healthState.set(provider.id, existing);
      return { ...existing };
    }

    try {
      const healthy = await instance.healthCheck();
      existing.status = healthy ? 'healthy' : 'unhealthy';
      existing.consecutiveFailures = healthy ? 0 : existing.consecutiveFailures + 1;
    } catch (error) {
      existing.status = 'unhealthy';
      existing.consecutiveFailures += 1;
      this.logger.warn(
        `Health check failed for provider "${provider.id}": ${error instanceof Error ? error.message : error}`,
      );
    }

    existing.lastChecked = Date.now();
    this.healthState.set(provider.id, existing);
    return { ...existing };
  }

  /**
   * 获取所有 Provider 的健康状态
   */
  getHealthStatus(): ProviderHealthInfo[] {
    return Array.from(this.healthState.values());
  }

  /**
   * 获取只包含健康 Provider 的列表
   */
  getHealthyProviders(): Provider<T>[] {
    return this.registry.getAll().filter((p) => {
      const info = this.healthState.get(p.id);
      return !info || info.status !== 'unhealthy';
    });
  }

  /**
   * 启动定期健康检查
   */
  startPeriodicChecks(options: { intervalMs: number }): void {
    this.stop();
    this.intervalHandle = setInterval(() => {
      this.checkAll().catch((err) => {
        this.logger.error(`Periodic health check failed: ${err}`);
      });
    }, options.intervalMs);
  }

  /**
   * 停止定期健康检查
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  /**
   * 检查 Provider 是否应该被激活（条件激活）
   */
  async shouldActivate(provider: Provider<T>): Promise<boolean> {
    const instance = provider.instance as unknown;
    if (!this.isConditional(instance)) return true;

    try {
      return await instance.shouldActivate();
    } catch {
      return false;
    }
  }

  private isHealthCheckable(instance: unknown): instance is HealthCheckable {
    return (
      typeof instance === 'object' &&
      instance !== null &&
      'healthCheck' in instance &&
      typeof (instance as HealthCheckable).healthCheck === 'function'
    );
  }

  private isConditional(instance: unknown): instance is ConditionalProvider {
    return (
      typeof instance === 'object' &&
      instance !== null &&
      'shouldActivate' in instance &&
      typeof (instance as ConditionalProvider).shouldActivate === 'function'
    );
  }
}
