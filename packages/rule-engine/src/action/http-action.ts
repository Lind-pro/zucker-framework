import { Logger } from '@nestjs/common';

export interface HttpActionConfig {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  /** 重试次数（默认 0 不重试） */
  retryCount?: number;
  /** 重试间隔（毫秒，默认 1000） */
  retryDelay?: number;
}

/**
 * HTTP 动作执行器 — 对齐 jetlinks 的数据推送能力
 *
 * 增强：
 * - 支持重试机制
 * - 模板表达式支持（在 URL、headers、body 中使用 ${variable}）
 * - 响应规范化
 */
export class HttpAction {
  private readonly logger = new Logger(HttpAction.name);

  async execute(
    config: HttpActionConfig,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    this.validate(config);

    const url = this.interpolate(config.url, data);
    const body = config.body
      ? JSON.parse(this.interpolate(JSON.stringify(config.body), data))
      : undefined;

    // 对 headers 也做模板插值
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.headers) {
      for (const [key, value] of Object.entries(config.headers)) {
        headers[key] = this.interpolate(value, data);
      }
    }

    this.logger.log(`HTTP action: ${config.method} ${url}`);

    const maxAttempts = (config.retryCount ?? 0) + 1;
    const retryDelay = config.retryDelay ?? 1000;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.doRequest(config, url, headers, body);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxAttempts) {
          this.logger.warn(
            `HTTP action attempt ${attempt} failed, retrying in ${retryDelay}ms: ${lastError.message}`,
          );
          await this.delay(retryDelay);
        }
      }
    }

    throw lastError ?? new Error('HTTP action failed');
  }

  /**
   * 验证配置有效性
   */
  validate(config: HttpActionConfig): void {
    if (!config.url || config.url.trim().length === 0) {
      throw new Error('HTTP action URL is required');
    }
    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    if (!validMethods.includes(config.method)) {
      throw new Error(`Invalid HTTP method: ${config.method}`);
    }
  }

  private async doRequest(
    config: HttpActionConfig,
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = config.timeout ?? 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: config.method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const responseData = await response.text();
      try {
        return JSON.parse(responseData);
      } catch {
        return responseData;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 模板插值 — 对齐 jetlinks TemplateParser / applyValueExpression
   * 支持 ${key} 和嵌套路径 ${a.b.c}
   */
  private interpolate(
    template: string,
    data: Record<string, unknown>,
  ): string {
    return template.replace(/\$\{([^}]+)}/g, (_, path: string) => {
      const value = this.getNestedValue(data, path.trim());
      return value !== undefined && value !== null ? String(value) : '';
    });
  }

  private getNestedValue(
    data: Record<string, unknown>,
    path: string,
  ): unknown {
    const parts = path.split('.');
    let current: unknown = data;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
