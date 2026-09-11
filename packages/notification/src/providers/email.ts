import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
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
  MailProviderErrorCode,
  type MailProvider,
  type MailDeliveryContext,
  type SendMailOptions,
  type SendMailResult,
} from '../mail/mail-provider';

export interface EmailProviderOptions {
  enabled?: boolean;
  host: string;
  port: number;
  secure?: boolean;
  auth: {
    user: string;
    pass: string;
  };
  from: string;
}

/**
 * Email notifier — full lifecycle implementation.
 *
 * Supports connection verification, graceful close, and CC/BCC headers.
 */
@Injectable()
export class EmailProvider implements SimpleNotifierProvider, MailProvider {
  private readonly logger = new Logger(EmailProvider.name);
  readonly channel = 'EMAIL' as NotifyChannel;
  readonly name = 'SMTP';
  readonly supportsIdempotency = false;
  private readonly transporter: nodemailer.Transporter | null;
  private readonly from: string;
  private closed = false;

  constructor(options: EmailProviderOptions) {
    this.from = options.from;
    this.transporter =
      options.enabled === false || !options.host
        ? null
        : nodemailer.createTransport({
            host: options.host,
            port: options.port,
            secure: options.secure ?? false,
            auth: options.auth,
          });
    if (this.transporter) this.logger.log('Email service initialized');
  }

  isConfigured(): boolean {
    return this.transporter !== null && !this.closed;
  }

  async deliver(options: SendMailOptions, context?: MailDeliveryContext): Promise<SendMailResult> {
    if (context?.signal?.aborted) return abortedMailResult();
    if (context?.idempotencyKey)
      return {
        success: false,
        error: 'SMTP 不支持幂等投递',
        errorCode: MailProviderErrorCode.IDEMPOTENCY_UNSUPPORTED,
      };
    if (this.closed || !this.transporter) return { success: false, error: 'SMTP 未配置' };
    try {
      const result = await this.transporter.sendMail({
        from: options.from || this.from,
        to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
        cc: options.cc,
        bcc: options.bcc,
        attachments: options.attachments?.map(({ contentId, ...attachment }) => ({
          ...attachment,
          ...(contentId ? { cid: contentId } : {}),
        })),
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      });
      this.logger.log(notificationDeliveryLog('EMAIL', 'smtp', options.to));
      return { success: true, messageId: result.messageId };
    } catch (error) {
      this.logger.error('SMTP delivery failed');
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
    if (this.closed) return;
    this.closed = true;
    this.transporter?.close();
    this.logger.log('Email transporter closed');
  }

  /**
   * Verify SMTP connection is working.
   */
  async verify(): Promise<boolean> {
    try {
      if (this.closed || !this.transporter) return false;
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Email notifier provider factory — creates EmailProvider instances
 * from configuration. Mirrors jetlinks NotifierProvider pattern.
 */
export class EmailNotifierProvider implements NotifierProvider {
  readonly channel = 'EMAIL' as NotifyChannel;
  readonly provider = 'embedded';

  async createNotifier(config: NotifierConfig): Promise<Notifier> {
    const cfg = config.configuration as unknown as EmailProviderOptions;
    const emailProvider = new EmailProvider(cfg);

    return {
      notifierId: config.id,
      channel: this.channel,
      provider: this.provider,
      async send(message: NotifyMessage): Promise<NotifyResult> {
        try {
          const delivered = await emailProvider.deliver({
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
        await emailProvider.close();
      },
    };
  }

  getConfigMetadata(): ConfigMetadataItem[] {
    return [
      { key: 'host', name: 'SMTP Host', type: 'string', required: true },
      { key: 'port', name: 'SMTP Port', type: 'number', required: true, defaultValue: 587 },
      { key: 'secure', name: 'Use TLS', type: 'boolean', defaultValue: false },
      { key: 'auth.user', name: 'Username', type: 'string', required: true },
      { key: 'auth.pass', name: 'Password', type: 'password', required: true },
      { key: 'from', name: 'From Address', type: 'string', required: true },
    ];
  }
}
