import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { MailEngagementService, type ResendEvent } from './mail-engagement.service';

export interface ResendWebhookOptions {
  signingSecret: string;
  suppressRecipients: (recipients: string[], reason: 'complained' | 'hard_bounce') => Promise<void>;
}
@Injectable()
export class ResendWebhookService {
  private readonly logger = new Logger(ResendWebhookService.name);
  constructor(
    private readonly options: ResendWebhookOptions,
    private readonly engagement: MailEngagementService,
  ) {}
  /** 校验 Svix 签名；未配置 secret 时拒绝（避免裸奔接收伪造事件） */
  verifySignature(rawBody: Buffer | string, headers: Record<string, string>): boolean {
    if (!this.options.signingSecret) {
      this.logger.error('Webhook signing secret is not configured');
      return false;
    }
    const id = headers['svix-id'];
    const timestamp = headers['svix-timestamp'];
    const signatureHeader = headers['svix-signature'];
    if (!id || !timestamp || !signatureHeader) return false;
    const timestampSeconds = Number(timestamp);
    if (!Number.isInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300)
      return false;

    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    // secret 形如 whsec_<base64>
    const secretB64 = this.options.signingSecret.replace(/^whsec_/, '');
    const secretBytes = Buffer.from(secretB64, 'base64');
    const signedContent = `${id}.${timestamp}.${body}`;
    const expected = crypto
      .createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64');

    // svix-signature: "v1,<sig> v1,<sig2> ..."；任一匹配即通过（常量时间比对）
    return signatureHeader.split(' ').some((part) => {
      const [version, sig = ''] = part.split(',');
      if (version !== 'v1') return false;
      try {
        return (
          sig.length === expected.length &&
          crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
        );
      } catch {
        return false;
      }
    });
  }

  async handleEvent(event: ResendEvent): Promise<void> {
    await this.engagement.record(event);
    if (event.type !== 'email.bounced' && event.type !== 'email.complained') return;
    const to = event.data?.to;
    const recipients = [
      ...new Set(
        (Array.isArray(to) ? to : [to])
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (!recipients.length) return;
    if (event.type === 'email.bounced') {
      const bounce = event.data?.bounce?.type;
      const kind = typeof bounce === 'string' ? bounce.toLowerCase() : '';
      // Only a bounce explicitly classified as permanent suppresses; missing/undetermined types do not.
      if (!/permanent|hard/.test(kind)) return;
      // The event lists every recipient of the message, not the one that bounced: suppressing all of
      // them would block valid addresses, so multi-recipient bounces are left to the operator.
      if (recipients.length > 1) {
        this.logger.warn(`Hard bounce on a ${recipients.length}-recipient message not suppressed automatically`);
        return;
      }
    }
    await this.options.suppressRecipients(
      recipients,
      event.type === 'email.complained' ? 'complained' : 'hard_bounce',
    );
  }
}
