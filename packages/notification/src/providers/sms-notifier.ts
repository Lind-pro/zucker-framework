import { Injectable, Logger } from '@nestjs/common';
import type { SimpleNotifierProvider, NotifyChannel, NotifyMessage } from '../notifier.interface';
import type { SmsProvider } from './sms/sms.interface';

/**
 * SMS notification adapter.
 *
 * Adapts SmsProvider to the SimpleNotifierProvider interface for integration
 * into the unified notification pipeline. Supports batch sending.
 */
@Injectable()
export class SmsNotifierAdapter implements SimpleNotifierProvider {
  private readonly logger = new Logger(SmsNotifierAdapter.name);
  readonly channel = 'SMS' as NotifyChannel;

  constructor(private readonly smsProvider: SmsProvider) {}

  async send(message: NotifyMessage): Promise<void> {
    const phones = Array.isArray(message.to)
      ? message.to
      : message.to.split(',').map((p) => p.trim()).filter(Boolean);

    if (phones.length === 0) {
      throw new Error('No phone numbers provided');
    }

    // Use batch send for multiple recipients
    if (phones.length > 1) {
      const messages = phones.map((phone) => ({
        phone,
        templateId: message.templateId ?? '',
        templateParams: message.variables as Record<string, string>,
        signName: message.subject,
      }));

      const results = await this.smsProvider.sendBatch(messages);
      const failures = results.filter((r) => !r.success);
      if (failures.length > 0) {
        throw new Error(
          `SMS batch send: ${failures.length}/${results.length} failed. ` +
          `First error: ${failures[0].error}`,
        );
      }

      this.logger.log(`SMS batch sent: ${phones.length} recipients`);
      return;
    }

    // Single recipient
    const result = await this.smsProvider.send({
      phone: phones[0],
      templateId: message.templateId ?? '',
      templateParams: message.variables as Record<string, string>,
      signName: message.subject,
    });

    if (!result.success) {
      throw new Error(`SMS send failed: ${result.error}`);
    }

    this.logger.log(`SMS sent: phone=${phones[0]}`);
  }

  /**
   * Close underlying SMS provider resources if applicable.
   */
  async close(): Promise<void> {
    // SMS providers are typically stateless
  }
}
