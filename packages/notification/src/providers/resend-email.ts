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
import { notificationDeliveryLog } from '../delivery-log';
import {
  abortedMailResult,
  type MailProvider,
  type MailDeliveryContext,
  type SendMailOptions,
  type SendMailResult,
} from '../mail/mail-provider';

interface ResendClient {
  emails: {
    send(
      input: SendMailOptions & { from: string; to: string[] },
      context?: MailDeliveryContext,
    ): Promise<{
      data?: { id?: string } | null;
      error?: { message?: string } | null;
    }>;
  };
}

type ResendConstructor = new (apiKey: string) => ResendClient;

export interface ResendEmailProviderOptions {
  apiKey?: string;
  from: string;
}

/**
 * Resend 邮件 Provider — 基于 Resend API 发送邮件
 * SDK: resend
 */
@Injectable()
export class ResendEmailProvider implements SimpleNotifierProvider, MailProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);
  readonly channel = 'EMAIL' as NotifyChannel;
  readonly name = 'Resend';
  readonly supportsIdempotency = true;
  private clientPromise?: Promise<ResendClient>;
  private closed = false;
  private readonly from: string;

  constructor(private readonly options: ResendEmailProviderOptions) {
    this.from = options.from;
  }

  isConfigured(): boolean {
    return !!this.options.apiKey && !this.closed;
  }

  private client(): Promise<ResendClient> {
    return (this.clientPromise ??= (async () => {
      const mod = (await import('resend' as string)) as unknown as {
        Resend?: ResendConstructor;
        default?: ResendConstructor;
      };
      const Constructor = mod.Resend ?? mod.default;
      if (!Constructor) throw new Error('Resend constructor is unavailable');
      return new Constructor(this.options.apiKey!);
    })());
  }

  async deliver(options: SendMailOptions, context?: MailDeliveryContext): Promise<SendMailResult> {
    if (context?.signal?.aborted) return abortedMailResult();
    if (!this.isConfigured()) return { success: false, error: 'Resend 未配置' };
    try {
      const client = await this.client();
      if (context?.signal?.aborted || this.closed) return abortedMailResult();
      const result = await client.emails.send(
        {
          from: options.from || this.from,
          to: Array.isArray(options.to) ? options.to : [options.to],
          subject: options.subject,
          html: options.html,
          text: options.text,
          replyTo: options.replyTo,
          cc: options.cc,
          bcc: options.bcc,
          attachments: options.attachments?.map((attachment) => ({
            ...attachment,
            // The SDK maps field names but does not encode Buffer payloads.
            content: Buffer.isBuffer(attachment.content)
              ? attachment.content.toString('base64')
              : attachment.content,
          })),
        },
        context?.idempotencyKey || context?.signal
          ? {
              ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
              ...(context.signal ? { signal: context.signal } : {}),
            }
          : undefined,
      );
      if (result.error) {
        if (context?.signal?.aborted) return abortedMailResult();
        this.logger.error('Resend delivery failed');
        return { success: false, error: result.error.message ?? 'Resend delivery failed' };
      }
      this.logger.log(notificationDeliveryLog('EMAIL', 'resend', options.to));
      return { success: true, messageId: result.data?.id };
    } catch (error) {
      if (context?.signal?.aborted) return abortedMailResult();
      this.logger.error('Resend delivery failed');
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async send(message: NotifyMessage): Promise<void> {
    const result = await this.deliver({
      to: message.to,
      subject: message.subject ?? '',
      html: message.content ?? '',
    });
    if (!result.success) throw new Error(result.error);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clientPromise = undefined;
  }
}

/**
 * Resend Email Notifier Provider 工厂
 * 从配置创建 ResendEmailProvider 实例
 */
export class ResendEmailNotifierProvider implements NotifierProvider {
  readonly channel = 'EMAIL' as NotifyChannel;
  readonly provider = 'resend';

  async createNotifier(config: NotifierConfig): Promise<Notifier> {
    const cfg = config.configuration as unknown as ResendEmailProviderOptions;
    const resendProvider = new ResendEmailProvider(cfg);

    return {
      notifierId: config.id,
      channel: this.channel,
      provider: this.provider,
      async send(message: NotifyMessage): Promise<NotifyResult> {
        try {
          const delivered = await resendProvider.deliver({
            to: message.to,
            subject: message.subject ?? '',
            html: message.content ?? '',
          });
          if (!delivered.success) throw new Error(delivered.error);
          const to = Array.isArray(message.to) ? message.to.join(',') : message.to;
          return {
            success: true,
            messageId: delivered.messageId,
            timestamp: new Date(),
            channel: 'EMAIL' as NotifyChannel,
            to,
          };
        } catch (err) {
          const to = Array.isArray(message.to) ? message.to.join(',') : message.to;
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date(),
            channel: 'EMAIL' as NotifyChannel,
            to,
          };
        }
      },
      async close(): Promise<void> {
        await resendProvider.close();
      },
    };
  }

  getConfigMetadata(): ConfigMetadataItem[] {
    return [
      { key: 'apiKey', name: 'Resend API Key', type: 'password', required: true },
      { key: 'from', name: 'From Address', type: 'string', required: true },
    ];
  }
}
