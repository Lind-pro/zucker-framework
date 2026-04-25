/**
 * Notification module injection tokens.
 *
 * Extracted into a separate file to prevent circular dependencies between
 * notification.module.ts (which uses NotifierManagerService) and
 * notifier-manager.service.ts (which injects these tokens).
 */

/** Token for the registered array of NotifierProvider instances. */
export const NOTIFIER_PROVIDERS = 'NOTIFIER_PROVIDERS';

/** Token for the NotifierProvider registry used by NotifierManagerService. */
export const NOTIFIER_PROVIDER_REGISTRY = 'NOTIFIER_PROVIDER_REGISTRY';

/** Token for the optional NotifyConfigManager. */
export const NOTIFY_CONFIG_MANAGER = 'NOTIFY_CONFIG_MANAGER';

/**
 * Token for injecting TopicEventBus into the notification module.
 * Must match the token used when providing TopicEventBus in the host module.
 */
export const TOPIC_EVENT_BUS_TOKEN = 'ZUCKER_TOPIC_EVENT_BUS';
