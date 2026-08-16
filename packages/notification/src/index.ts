export {
  NotifyChannel,
  DefaultNotifyType,
  NotifyVariableBusinessTypes,
  VariableFileFormat,
  VariableNumberFormat,
  convertVariableValue,
  renderVariableMap,
  createNotifyType,
  createNotifyProvider,
} from './notifier.interface';
export type {
  NotifyType,
  NotifyProvider,
  NotifyVariableBusinessType,
  NotifyTemplate,
  NotifyMessage,
  NotifyResult,
  Notifier,
  NotifierProvider,
  NotifierConfig,
  ConfigMetadataItem,
  SimpleNotifierProvider,
  VariableDefinition,
  VariableSource,
} from './notifier.interface';

export { NotifierEventDispatcher, NotifierEventTopics } from './notifier-event-dispatcher';
export type {
  NotificationEventBus,
  NotifierEvent,
} from './notifier-event-dispatcher';

export { EmailProvider, EmailNotifierProvider } from './providers/email';
export type { EmailProviderOptions } from './providers/email';
export { WebhookProvider, WebhookNotifierProvider } from './providers/webhook';
export { ResendEmailProvider, ResendEmailNotifierProvider } from './providers/resend-email';
export type { ResendEmailProviderOptions } from './providers/resend-email';
export type { WebhookProviderOptions } from './providers/webhook';

export type { SmsProvider, SmsMessage, SmsResult } from './providers/sms/sms.interface';
export { AliyunSmsProvider } from './providers/sms/aliyun-sms.provider';
export type { AliyunSmsOptions } from './providers/sms/aliyun-sms.provider';
export { TencentSmsProvider } from './providers/sms/tencent-sms.provider';
export type { TencentSmsOptions } from './providers/sms/tencent-sms.provider';
export { SmsNotifierAdapter } from './providers/sms-notifier';
export { SmsNotifierProvider } from './providers/sms/sms-notifier.provider';

export { TemplateService } from './template.service';
export type { TemplateProperties, TemplateProvider } from './template.service';

export { CompositeNotifierService } from './composite-notifier.service';
export type { FallbackStrategy } from './composite-notifier.service';

export { NotifierManagerService, CompositeNotifyConfigManager } from './notifier-manager.service';
export type { NotifyConfigManager } from './notifier-manager.service';
export { NOTIFY_CONFIG_MANAGER } from './notifier-manager.service';

export { NotifyHistoryService } from './notify-history.service';
export type {
  NotifyHistoryRecord,
  NotifyHistoryStore,
} from './notify-history.service';

export {
  ZuckerNotificationModule,
  NOTIFIER_PROVIDERS,
  NOTIFIER_PROVIDER_REGISTRY,
  TOPIC_EVENT_BUS_TOKEN,
} from './notification.module';
export type { NotificationModuleOptions, NotificationModuleAsyncOptions, NotificationModuleOptionsFactory, SmsProviderType } from './notification.module';

export { NotificationRetryService } from './retry/notification-retry.service';
export type { RetryPolicy } from './retry/notification-retry.service';

export { InMemoryNotificationDedup, NotificationPriority, PriorityNotificationQueue } from './dedup.service';
export type { NotificationDedup } from './dedup.service';

export { WebhookRegistry } from './webhook-registry';
export type { WebhookDefinition, DeliveryRecord, DeliveryStatus } from './webhook-registry';

export {
  DEFAULT_NOTIFICATION_RETRY_POLICY,
  NotificationDeliveryError,
  NotificationIdempotencyConflictError,
  NotificationLeaseLostError,
  classifyNotificationDeliveryError,
  notificationRetryDelayMs,
  validateNotificationDeliveryInput,
} from './durable-delivery';
export type {
  NotificationDeliveryClaim,
  NotificationDeliveryErrorClassifier,
  NotificationDeliveryFailure,
  NotificationDeliveryHandler,
  NotificationDeliveryInput,
  NotificationDeliveryRecord,
  NotificationDeliveryRepository,
  NotificationDeliveryStatus,
  NotificationRetryPolicy,
} from './durable-delivery';
export { InMemoryDurableNotificationRepository } from './in-memory-durable-delivery.repository';
export { DurableNotificationWorker } from './durable-notification-worker';
export type {
  DurableNotificationWorkerOptions,
  NotificationWorkerOutcome,
} from './durable-notification-worker';
