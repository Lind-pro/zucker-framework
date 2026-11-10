import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Webhook 注册与投递（进程内）
 *
 * 支持事件注册、HMAC 签名验证、有限重试、投递状态追踪。
 * Registry and delivery log are in-memory only: deliveries are lost on restart and not shared between
 * replicas. Use the durable notification delivery repository for reliable delivery.
 *
 * 用法:
 * ```ts
 * const registry = new WebhookRegistry();
 *
 * // 注册 webhook
 * registry.register({
 *   id: 'wh-1',
 *   url: 'https://example.com/hook',
 *   events: ['user.created', 'user.updated'],
 *   secret: 'my-secret',
 * });
 *
 * // 触发投递
 * await registry.dispatch('user.created', { userId: '123' });
 * ```
 */

export interface WebhookDefinition {
  id: string;
  url: string;
  events: string[];
  secret?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export type DeliveryStatus = 'pending' | 'success' | 'failed' | 'retrying';

export interface DeliveryRecord {
  id: string;
  webhookId: string;
  event: string;
  payload: unknown;
  status: DeliveryStatus;
  attempts: number;
  lastAttemptAt?: number;
  statusCode?: number;
  error?: string;
  createdAt: number;
}

let deliveryIdCounter = 0;

@Injectable()
export class WebhookRegistry {
  private readonly logger = new Logger(WebhookRegistry.name);
  private readonly webhooks = new Map<string, WebhookDefinition>();
  private readonly deliveryLog: DeliveryRecord[] = [];
  private readonly maxLogSize: number;
  private readonly maxRetries: number;

  constructor(options?: { maxLogSize?: number; maxRetries?: number }) {
    this.maxLogSize = options?.maxLogSize ?? 1000;
    this.maxRetries = options?.maxRetries ?? 3;
  }

  /**
   * 注册 webhook
   */
  register(definition: WebhookDefinition): void {
    this.webhooks.set(definition.id, { enabled: true, ...definition });
  }

  /**
   * 注销 webhook
   */
  unregister(id: string): void {
    this.webhooks.delete(id);
  }

  /**
   * 启用/禁用
   */
  setEnabled(id: string, enabled: boolean): void {
    const wh = this.webhooks.get(id);
    if (wh) wh.enabled = enabled;
  }

  /**
   * 获取所有已注册的 webhook
   */
  getAll(): WebhookDefinition[] {
    return [...this.webhooks.values()];
  }

  /**
   * 获取指定事件的 webhook
   */
  getByEvent(event: string): WebhookDefinition[] {
    return [...this.webhooks.values()].filter(
      (wh) => wh.enabled !== false && this.matchesEvent(wh.events, event),
    );
  }

  /**
   * 分发事件到所有匹配的 webhook
   */
  async dispatch(event: string, payload: unknown): Promise<DeliveryRecord[]> {
    // Endpoints are delivered concurrently so one slow/failing endpoint's backoff does not delay others.
    return Promise.all(this.getByEvent(event).map((wh) => this.deliver(wh, event, payload)));
  }

  /**
   * 生成 HMAC 签名
   */
  static sign(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  /**
   * 验证入站 webhook 签名
   */
  static verify(payload: string, signature: string, secret: string): boolean {
    // Accepts the `X-Webhook-Signature` header value as sent (`sha256=<hex>`) or the bare hex digest.
    if (signature.startsWith('sha256=')) signature = signature.slice('sha256='.length);
    const expected = WebhookRegistry.sign(payload, secret);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const signatureBuf = Buffer.from(signature, 'utf8');
    if (expectedBuf.length !== signatureBuf.length) return false;
    return timingSafeEqual(expectedBuf, signatureBuf);
  }

  /**
   * 获取投递日志
   */
  getDeliveryLog(webhookId?: string): DeliveryRecord[] {
    if (webhookId) {
      return this.deliveryLog.filter((r) => r.webhookId === webhookId);
    }
    return [...this.deliveryLog];
  }

  private async deliver(
    wh: WebhookDefinition,
    event: string,
    payload: unknown,
  ): Promise<DeliveryRecord> {
    const record: DeliveryRecord = {
      id: `dlv_${Date.now()}_${++deliveryIdCounter}`,
      webhookId: wh.id,
      event,
      payload,
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
    };

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      record.attempts = attempt + 1;
      record.lastAttemptAt = Date.now();

      try {
        const body = JSON.stringify({ event, payload, timestamp: Date.now() });
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Webhook-Event': event,
          'X-Webhook-Id': wh.id,
          'X-Delivery-Id': record.id,
          ...(wh.headers ?? {}),
        };

        if (wh.secret) {
          headers['X-Webhook-Signature'] = `sha256=${WebhookRegistry.sign(body, wh.secret)}`;
        }

        const response = await fetch(wh.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });

        record.statusCode = response.status;

        if (response.ok) {
          record.status = 'success';
          break;
        }

        // 4xx 不重试（客户端错误），408/429 除外
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          record.status = 'failed';
          record.error = `HTTP ${response.status}`;
          break;
        }

        // 5xx 重试
        record.status = 'retrying';
        record.error = `HTTP ${response.status}`;
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err);
        record.status = attempt < this.maxRetries ? 'retrying' : 'failed';
      }

      if (attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }

    if (record.status === 'retrying') record.status = 'failed';

    this.appendDeliveryLog(record);
    return record;
  }

  private appendDeliveryLog(record: DeliveryRecord): void {
    this.deliveryLog.push(record);
    if (this.deliveryLog.length > this.maxLogSize) {
      this.deliveryLog.splice(0, this.deliveryLog.length - this.maxLogSize);
    }
  }

  private matchesEvent(patterns: string[], event: string): boolean {
    return patterns.some((pattern) => {
      if (pattern === '*') return true;
      if (pattern === event) return true;
      if (pattern.endsWith('.*')) {
        return event.startsWith(pattern.slice(0, -1));
      }
      return false;
    });
  }
}
