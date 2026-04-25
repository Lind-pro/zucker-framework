import { Injectable, Logger } from '@nestjs/common';
import type {
  SimpleNotifierProvider,
  NotifierProvider,
  Notifier,
  NotifyChannel,
  NotifyMessage,
  NotifyResult,
  NotifierConfig,
  ConfigMetadataItem,
} from '../notifier.interface';

export interface WebhookProviderOptions {
  defaultUrl?: string;
  headers?: Record<string, string>;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** HTTP method, defaults to POST */
  method?: 'POST' | 'PUT';
}

@Injectable()
export class WebhookProvider implements SimpleNotifierProvider {
  private readonly logger = new Logger(WebhookProvider.name);
  readonly channel = 'WEBHOOK' as NotifyChannel;
  private readonly defaultUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly method: string;

  constructor(options: WebhookProviderOptions = {}) {
    this.defaultUrl = options.defaultUrl ?? '';
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.method = options.method ?? 'POST';
  }

  async send(message: NotifyMessage): Promise<void> {
    const to = Array.isArray(message.to) ? message.to[0] : message.to;
    const url = to || this.defaultUrl;
    if (!url) throw new Error('Webhook URL not configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: this.method,
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify({
          subject: message.subject,
          content: message.content,
          variables: message.variables,
          channel: message.channel,
          templateId: message.templateId,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
      }

      this.logger.log(`Webhook sent: url=${url}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Webhook notifier provider factory.
 */
export class WebhookNotifierProvider implements NotifierProvider {
  readonly channel = 'WEBHOOK' as NotifyChannel;
  readonly provider = 'http';

  async createNotifier(config: NotifierConfig): Promise<Notifier> {
    const cfg = config.configuration as unknown as WebhookProviderOptions;
    const webhookProvider = new WebhookProvider(cfg);

    return {
      notifierId: config.id,
      channel: this.channel,
      provider: this.provider,
      async send(message: NotifyMessage): Promise<NotifyResult> {
        const to = Array.isArray(message.to) ? message.to[0] : message.to;
        try {
          await webhookProvider.send(message);
          return { success: true, timestamp: new Date(), channel: 'WEBHOOK' as NotifyChannel, to };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date(),
            channel: 'WEBHOOK' as NotifyChannel,
            to,
          };
        }
      },
      async close(): Promise<void> {
        // Webhook is stateless, no resources to release
      },
    };
  }

  getConfigMetadata(): ConfigMetadataItem[] {
    return [
      { key: 'defaultUrl', name: 'Default URL', type: 'string' },
      { key: 'timeoutMs', name: 'Timeout (ms)', type: 'number', defaultValue: 30000 },
      { key: 'method', name: 'HTTP Method', type: 'string', defaultValue: 'POST' },
    ];
  }
}
