import type {
  NotifierProvider,
  Notifier,
  NotifyChannel,
  NotifyMessage,
  NotifyResult,
  NotifierConfig,
  ConfigMetadataItem,
} from '../../notifier.interface';
import {
  AliyunSmsProvider,
  type AliyunSmsOptions,
} from './aliyun-sms.provider';
import {
  TencentSmsProvider,
  type TencentSmsOptions,
} from './tencent-sms.provider';
import type { SmsProvider } from './sms.interface';
import { SmsNotifierAdapter } from '../sms-notifier';

/**
 * SMS notifier provider factory — mirrors jetlinks AliyunSmsNotifierProvider / SmsProvider.
 *
 * Creates SMS Notifier instances from configuration, supporting multiple
 * SMS service providers (aliyun, tencent). The provider is determined by
 * the `smsProvider` field in the configuration.
 */
export class SmsNotifierProvider implements NotifierProvider {
  readonly channel = 'SMS' as NotifyChannel;
  readonly provider = 'sms';

  async createNotifier(config: NotifierConfig): Promise<Notifier> {
    const smsProviderType = (config.configuration.smsProvider as string) ?? 'aliyun';
    let smsProvider: SmsProvider;

    switch (smsProviderType) {
      case 'tencent':
        smsProvider = new TencentSmsProvider(config.configuration as unknown as TencentSmsOptions);
        break;
      case 'aliyun':
      default:
        smsProvider = new AliyunSmsProvider(config.configuration as unknown as AliyunSmsOptions);
        break;
    }

    const adapter = new SmsNotifierAdapter(smsProvider);

    return {
      notifierId: config.id,
      channel: this.channel,
      provider: smsProviderType,
      async send(message: NotifyMessage): Promise<NotifyResult> {
        const to = Array.isArray(message.to) ? message.to.join(',') : message.to;
        try {
          await adapter.send(message);
          return { success: true, timestamp: new Date(), channel: 'SMS' as NotifyChannel, to };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date(),
            channel: 'SMS' as NotifyChannel,
            to,
          };
        }
      },
      async close(): Promise<void> {
        await adapter.close();
      },
    };
  }

  getConfigMetadata(): ConfigMetadataItem[] {
    return [
      { key: 'smsProvider', name: 'SMS Provider', type: 'string', required: true, defaultValue: 'aliyun' },
      { key: 'accessKeyId', name: 'Access Key ID', type: 'string', required: true },
      { key: 'accessKeySecret', name: 'Access Key Secret', type: 'password', required: true },
      { key: 'signName', name: 'Sign Name', type: 'string', required: true },
    ];
  }
}
