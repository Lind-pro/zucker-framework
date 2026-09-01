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
import { emailDeliveryLog } from './email-log';

export interface ResendEmailProviderOptions {
  apiKey: string;
  from: string;
}

/**
 * Resend 邮件 Provider — 基于 Resend API 发送邮件
 * SDK: resend
 */
@Injectable()
export class ResendEmailProvider implements SimpleNotifierProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);
  readonly channel = 'EMAIL' as NotifyChannel;
  private client: any;
  private readonly from: string;

  constructor(options: ResendEmailProviderOptions) {
    this.from = options.from;
    this.initClient(options.apiKey);
  }

  private async initClient(apiKey: string): Promise<void> {
    try {
      const mod = await import('resend' as string);
      const Resend = mod.Resend ?? mod.default;
      this.client = new Resend(apiKey);
      this.logger.log('Resend email service initialized');
    } catch {
      this.logger.error('resend package not installed. Run: npm install resend');
    }
  }

  async send(message: NotifyMessage): Promise<void> {
    if (!this.client) {
      throw new Error('Resend client not initialized');
    }

    const to = Array.isArray(message.to) ? message.to : [message.to];

    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      subject: message.subject ?? '',
      html: message.content ?? '',
    });

    if (error) {
      throw new Error(`Resend API error: ${error.message}`);
    }

    this.logger.log(emailDeliveryLog('resend', to));
  }

  async close(): Promise<void> {
    this.client = null;
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
          await resendProvider.send(message);
          const to = Array.isArray(message.to) ? message.to.join(',') : message.to;
          return { success: true, timestamp: new Date(), channel: 'EMAIL' as NotifyChannel, to };
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
