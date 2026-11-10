export enum NotifyChannel {
  EMAIL = 'EMAIL',
  SMS = 'SMS',
  WECHAT = 'WECHAT',
  DINGTALK = 'DINGTALK',
  WEBHOOK = 'WEBHOOK',
  VOICE = 'VOICE',
}

/**
 * Extensible notification type interface — mirrors jetlinks NotifyType.
 *
 * While NotifyChannel enum covers the built-in types, this interface allows
 * custom notification types to be registered at runtime. Implementations
 * provide an id and a human-readable name.
 *
 * @see DefaultNotifyType for the built-in enum implementation
 */
export interface NotifyType {
  /** Unique type identifier */
  getId(): string;
  /** Human-readable name */
  getName(): string;
}

/**
 * Default notification types — mirrors jetlinks DefaultNotifyType enum.
 *
 * Provides NotifyType implementations for each built-in NotifyChannel.
 */
export const DefaultNotifyType: Record<NotifyChannel, NotifyType> = {
  [NotifyChannel.SMS]: { getId: () => 'sms', getName: () => 'SMS' },
  [NotifyChannel.EMAIL]: { getId: () => 'email', getName: () => 'Email' },
  [NotifyChannel.VOICE]: { getId: () => 'voice', getName: () => 'Voice' },
  [NotifyChannel.DINGTALK]: { getId: () => 'dingTalk', getName: () => 'DingTalk' },
  [NotifyChannel.WECHAT]: { getId: () => 'weixin', getName: () => 'WeChat' },
  [NotifyChannel.WEBHOOK]: { getId: () => 'webhook', getName: () => 'WebHook' },
};

/**
 * Create a custom NotifyType at runtime.
 * Mirrors jetlinks NotifyType.of() factory pattern.
 */
export function createNotifyType(id: string, name: string): NotifyType {
  return { getId: () => id, getName: () => name };
}

/**
 * Service provider identifier — mirrors jetlinks Provider interface.
 *
 * Represents a notification service provider (e.g. aliyun, tencent).
 * Typically used as an enum-like value to identify which vendor
 * implementation is being used.
 */
export interface NotifyProvider {
  /** Unique provider identifier */
  getId(): string;
  /** Human-readable provider name */
  getName(): string;
}

/**
 * Create a NotifyProvider instance.
 */
export function createNotifyProvider(id: string, name: string): NotifyProvider {
  return { getId: () => id, getName: () => name };
}

/**
 * Notification variable business type constants.
 * Mirrors jetlinks NotifyVariableBusinessConstant.
 *
 * Used for classifying template variables by their business domain.
 */
export const NotifyVariableBusinessTypes = {
  /** User-related variable */
  USER: 'user',
  /** Organization/department-related variable */
  ORG: 'org',
  /** Tag-related variable */
  TAG: 'tag',
  /** File-related variable */
  FILE: 'file',
  /** Link/URL-related variable */
  LINK: 'link',
} as const;

export type NotifyVariableBusinessType =
  (typeof NotifyVariableBusinessTypes)[keyof typeof NotifyVariableBusinessTypes];

/**
 * File format constants for file-type variables.
 * Mirrors jetlinks Variable.FileFormat.
 */
export const VariableFileFormat = {
  IMAGE: 'image',
  VIDEO: 'video',
  ANY: 'any',
} as const;

/**
 * Number format constants for number-type variables.
 * Mirrors jetlinks Variable.NumberFormat.
 */
export const VariableNumberFormat = {
  /** Integer: no decimal places */
  INTEGER: '%.0f',
  /** One decimal place */
  ONE_PLACE: '%.1f',
  /** Two decimal places */
  TWO_PLACES: '%.2f',
} as const;

/**
 * Variable definition for notification templates.
 *
 * Mirrors jetlinks VariableDefinition: id, name, type, required, format,
 * defaultValue, and value conversion support.
 */
export interface VariableDefinition {
  /** Variable identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** Data type: string, number, date, boolean, file */
  type?: 'string' | 'number' | 'date' | 'boolean' | 'file';
  /** Whether this variable is required */
  required?: boolean;
  /** Format string (e.g. date format 'yyyy-MM-dd', number format '%.2f') */
  format?: string;
  /** Default value when not provided */
  defaultValue?: string;
  /** Additional metadata */
  expands?: Record<string, unknown>;
}

/**
 * Convert a variable value according to its definition.
 *
 * Mirrors jetlinks VariableDefinition.convertValue():
 * - Applies defaultValue when value is null/undefined
 * - Validates required fields
 * - Formats dates and numbers according to format string
 */
export function convertVariableValue(
  def: VariableDefinition,
  value: unknown,
): string {
  const val = value ?? def.defaultValue ?? undefined;

  if (def.required && (val === undefined || val === null || val === '')) {
    throw new Error(`Template variable '${def.id}' (${def.name}) is required`);
  }

  if (val === undefined || val === null) {
    return '';
  }

  const fmt = def.format;

  // Date formatting
  if (def.type === 'date') {
    const date = val instanceof Date ? val : new Date(String(val));
    if (isNaN(date.getTime())) {
      return String(val);
    }
    if (fmt === 'timestamp') {
      return String(date.getTime());
    }
    // Simple date format: yyyy-MM-dd HH:mm:ss
    const pattern = fmt ?? 'yyyy-MM-dd HH:mm:ss';
    return formatDate(date, pattern);
  }

  // Printf-style formatting — aligned with jetlinks String.format(fmt, val).
  // Supports numeric types explicitly and falls through for other types.
  if (fmt && fmt.includes('%')) {
    if (def.type === 'number' || typeof val === 'number') {
      const num = typeof val === 'number' ? val : parseFloat(String(val));
      if (!isNaN(num)) {
        const precisionMatch = fmt.match(/%\.(\d+)f/);
        if (precisionMatch) {
          return num.toFixed(parseInt(precisionMatch[1]));
        }
        // %d for integer formatting
        if (fmt.includes('%d')) {
          return String(Math.trunc(num));
        }
      }
    }
    // For non-number types, apply %s string formatting
    if (fmt.includes('%s')) {
      return fmt.replace('%s', String(val));
    }
  }

  // Collection handling: join values with comma (mirrors jetlinks Template.convert())
  if (Array.isArray(val)) {
    return val.map((item) => convertVariableValue(def, item)).join(',');
  }

  return String(val);
}

/**
 * Render a map of values through variable definitions.
 * Mirrors jetlinks Template.renderMap() — applies type conversion
 * and validation to all values in the context map.
 */
export function renderVariableMap(
  context: Record<string, unknown>,
  variableDefinitions: VariableDefinition[],
): Record<string, unknown> {
  const defMap = new Map(variableDefinitions.map((d) => [d.id, d]));
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(context)) {
    const def = defMap.get(key);
    if (def) {
      result[key] = convertVariableValue(def, value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function formatDate(date: Date, pattern: string): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return pattern
    .replace(/yyyy/g, String(date.getFullYear()))
    .replace(/MM/g, pad(date.getMonth() + 1))
    .replace(/dd/g, pad(date.getDate()))
    .replace(/HH/g, pad(date.getHours()))
    .replace(/mm/g, pad(date.getMinutes()))
    .replace(/ss/g, pad(date.getSeconds()));
}

/**
 * Notification template — mirrors jetlinks Template interface.
 *
 * Templates hold content and variable definitions. Different channels
 * implement different template structures.
 */
export interface NotifyTemplate {
  id: string;
  name: string;
  channel: NotifyChannel;
  /** Provider identifier (e.g. 'aliyun', 'tencent') */
  provider?: string;
  /** Template content (structure depends on channel) */
  content: string;
  /** Declared variable definitions with types and validation */
  variableDefinitions: VariableDefinition[];
  /** Description */
  description?: string;
  /** Associated notifier config ID */
  configId?: string;
}

export interface NotifyMessage {
  channel: NotifyChannel;
  templateId?: string;
  to: string | string[];
  variables: Record<string, unknown>;
  subject?: string;
  content?: string;
  /**
   * Recipient addresses for fallback channels. Addresses are channel-specific (an e-mail address
   * is not a phone number), so `CompositeNotifierService` only degrades to another channel when
   * the recipients for that channel are given here.
   */
  fallbackRecipients?: Partial<Record<NotifyChannel, string | string[]>>;
}

/**
 * Notification delivery result — tracks success/failure per recipient.
 */
export interface NotifyResult {
  success: boolean;
  /** Provider-assigned message ID */
  messageId?: string;
  /** Error details on failure */
  error?: string;
  /** Timestamp of the send attempt */
  timestamp: Date;
  /** Channel used for delivery */
  channel: NotifyChannel;
  /** Recipient */
  to: string;
}

/**
 * Notifier interface — mirrors jetlinks Notifier.
 *
 * A notifier is a configured instance of a notification channel that can
 * send messages. Supports lifecycle management (close) and identity.
 */
export interface Notifier {
  /** Unique notifier instance ID */
  readonly notifierId: string;
  /** Notification channel type */
  readonly channel: NotifyChannel;
  /** Provider identifier (e.g. 'aliyun') */
  readonly provider: string;

  /**
   * Send a notification message.
   * Returns a result indicating success/failure with tracking info.
   */
  send(message: NotifyMessage): Promise<NotifyResult>;

  /**
   * Close the notifier and release resources.
   * Mirrors jetlinks Notifier.close().
   */
  close(): Promise<void>;
}

/**
 * Notifier provider — mirrors jetlinks NotifierProvider.
 *
 * A provider is a factory that can create configured Notifier instances
 * for a specific channel and service provider combination.
 */
export interface NotifierProvider {
  /** Notification channel type */
  readonly channel: NotifyChannel;
  /** Provider identifier */
  readonly provider: string;

  /**
   * Create a notifier from configuration properties.
   * Mirrors jetlinks NotifierProvider.createNotifier().
   */
  createNotifier(config: NotifierConfig): Promise<Notifier>;

  /**
   * Get metadata describing what configuration this provider requires.
   * Mirrors jetlinks NotifierProvider.getNotifierConfigMetadata().
   */
  getConfigMetadata?(): ConfigMetadataItem[];
}

/**
 * Notifier configuration properties — mirrors jetlinks NotifierProperties.
 */
export interface NotifierConfig {
  /** Unique configuration ID */
  id: string;
  /** Human-readable name */
  name?: string;
  /** Channel type */
  channel: NotifyChannel;
  /** Provider identifier */
  provider: string;
  /** Provider-specific configuration */
  configuration: Record<string, unknown>;
}

/**
 * Configuration metadata item — describes a single config field.
 */
export interface ConfigMetadataItem {
  key: string;
  name: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'password';
  required?: boolean;
  defaultValue?: unknown;
}

/**
 * Legacy provider interface for backward compatibility.
 * Simple providers that just implement send() without lifecycle.
 */
export interface SimpleNotifierProvider {
  channel: NotifyChannel;
  send(message: NotifyMessage): Promise<void>;
}

export interface VariableSource {
  type: 'fixed' | 'upper' | 'relation';
  key: string;
  value: string;
}

/**
 * Thrown by a provider when only part of a multi-recipient send failed. `failedRecipients` lists the
 * recipients that did NOT receive the message so a fallback retries only those.
 */
export class PartialNotificationDeliveryError extends Error {
  readonly code = 'NOTIFICATION_PARTIAL_DELIVERY';

  constructor(
    message: string,
    readonly failedRecipients: string[],
    readonly deliveredCount: number,
  ) {
    super(message);
    this.name = 'PartialNotificationDeliveryError';
  }
}
