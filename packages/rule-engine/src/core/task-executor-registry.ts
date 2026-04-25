import { Injectable, Logger } from '@nestjs/common';
import type { TaskExecutorProvider, TaskExecutor } from './task-executor';
import type { ExecutionContext } from './execution-context';

/**
 * 任务执行器注册表 — 对齐 jetlinks @Component 自动注册的 TaskExecutorProvider 集合
 * 在 NestJS 中通过 DI 手动注册 provider
 */
@Injectable()
export class TaskExecutorRegistry {
  private readonly logger = new Logger(TaskExecutorRegistry.name);
  private readonly providers = new Map<string, TaskExecutorProvider>();

  /**
   * 注册任务执行器提供者
   */
  register(provider: TaskExecutorProvider): void {
    const executor = provider.getExecutor();
    if (this.providers.has(executor)) {
      this.logger.warn(`Overriding existing task executor provider: ${executor}`);
    }
    this.providers.set(executor, provider);
    this.logger.log(`Registered task executor provider: ${executor}`);
  }

  /**
   * 注销任务执行器提供者
   */
  unregister(executorType: string): void {
    this.providers.delete(executorType);
  }

  /**
   * 根据执行器类型创建任务
   */
  async createTask(
    executorType: string,
    context: ExecutionContext,
  ): Promise<TaskExecutor> {
    const provider = this.providers.get(executorType);
    if (!provider) {
      throw new Error(`No task executor provider found for type: ${executorType}`);
    }
    return provider.createTask(context);
  }

  /**
   * 获取所有已注册的执行器类型
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * 检查是否存在指定类型的执行器
   */
  hasProvider(executorType: string): boolean {
    return this.providers.has(executorType);
  }
}
