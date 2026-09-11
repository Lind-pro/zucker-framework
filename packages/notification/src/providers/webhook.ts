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
  /** Optional provider acknowledgement validation, within the same request timeout. */
  validateResponse?: (response: Response) => Promise<void>;
  fetch?: WebhookFetch;
  /** Keep normal fetch behavior unless the caller requires redirects to fail. */
  redirect?: RequestInit['redirect'];
}

export type WebhookFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export class WebhookDeliveryError extends Error {
  constructor(
    readonly reason: 'http' | 'timeout' | 'transport',
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WebhookDeliveryError';
  }
}

@Injectable()
export class WebhookProvider implements SimpleNotifierProvider {
  private readonly logger = new Logger(WebhookProvider.name);
  readonly channel = 'WEBHOOK' as NotifyChannel;
  private readonly defaultUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly method: string;
  private readonly validateResponse?: (response: Response) => Promise<void>;
  private readonly request: WebhookFetch;
  private readonly redirect?: RequestInit['redirect'];

  constructor(options: WebhookProviderOptions = {}) {
    this.defaultUrl = options.defaultUrl ?? '';
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.method = options.method ?? 'POST';
    this.validateResponse = options.validateResponse;
    this.request = options.fetch ?? ((input, init) => fetch(input, init));
    this.redirect = options.redirect;
  }

  async send(message: NotifyMessage): Promise<void> {
    const to = Array.isArray(message.to) ? message.to[0] : message.to;
    await this.sendPayload(
      {
        subject: message.subject,
        content: message.content,
        variables: message.variables,
        channel: message.channel,
        templateId: message.templateId,
      },
      to || this.defaultUrl,
    );
  }

  /** Deliver a provider-specific JSON envelope using the same timeout/status handling. */
  async sendPayload(payload: unknown, url = this.defaultUrl): Promise<void> {
    await this.sendPayloadWithResponse(payload, url);
  }

  /** Same delivery path, with the response available to probes and protocol adapters. */
  async sendPayloadWithResponse(payload: unknown, url = this.defaultUrl): Promise<Response> {
    if (!url) throw new Error('Webhook URL not configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.request(url, {
          method: this.method,
          headers: {
            'Content-Type': 'application/json',
            ...this.headers,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
          ...(this.redirect ? { redirect: this.redirect } : {}),
        });
      } catch (error) {
        throw new WebhookDeliveryError(
          controller.signal.aborted ? 'timeout' : 'transport',
          controller.signal.aborted
            ? 'Webhook timed out'
            : error instanceof Error
              ? error.message
              : String(error),
          undefined,
          { cause: error },
        );
      }

      if (!response.ok) {
        throw new WebhookDeliveryError(
          'http',
          `Webhook failed: ${response.status} ${response.statusText}`,
          response.status,
        );
      }

      await this.validateResponse?.(response);
      // Webhook URLs often contain bearer credentials; never write them to logs.
      this.logger.log('Webhook sent');
      return response;
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
