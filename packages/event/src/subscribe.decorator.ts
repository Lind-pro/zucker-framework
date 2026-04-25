export const SUBSCRIBE_KEY = 'zucker:event:subscribe';
export const SUBSCRIBE_METHODS_KEY = 'zucker:event:subscribeMethods';

/**
 * Subscription feature — controls message scope.
 * Mirrors jetlinks Subscription.Feature enum.
 */
export enum SubscribeFeature {
  /** Only subscribe to local process messages */
  LOCAL = 'local',
  /** Subscribe to messages from the entire cluster */
  CLUSTER = 'cluster',
  /** Subscribe to shared messages (load-balanced across instances) */
  SHARED = 'shared',
  /**
   * Broker mode — 参考 jetlinks Subscription.Feature.broker
   * Subscribe to messages forwarded by the event broker (cross-node communication).
   * In jetlinks, broker mode enables EventConnection-based inter-cluster event forwarding.
   */
  BROKER = 'broker',
}

export interface SubscribeOptions {
  /** Topic patterns to subscribe to (supports * and ** wildcards) */
  topics: string[];
  /** Subscriber ID — defaults to method name */
  id?: string;
  /** Subscription features — defaults to [LOCAL] */
  features?: SubscribeFeature[];
  /** Priority — lower value = higher priority. Defaults to Infinity */
  priority?: number;
}

/**
 * @Subscribe decorator — 参考 jetlinks @Subscribe 注解
 *
 * 用于方法上，声明式订阅 TopicEventBus 的消息。
 * 框架通过扫描带有此装饰器的方法，自动注册订阅。
 *
 * 用法：
 * ```typescript
 * @Subscribe({ topics: ['/device/ * / * /message'] })
 * async handleDeviceMessage(payload: DeviceMessage): Promise<void> { ... }
 *
 * // 简写：单个 topic
 * @Subscribe('/device/** ')
 * async handleAllDevice(payload: unknown): Promise<void> { ... }
 * ```
 */
export function Subscribe(topicsOrOptions: string | string[] | SubscribeOptions): MethodDecorator {
  let options: SubscribeOptions;

  if (typeof topicsOrOptions === 'string') {
    options = { topics: [topicsOrOptions] };
  } else if (Array.isArray(topicsOrOptions)) {
    options = { topics: topicsOrOptions };
  } else {
    options = topicsOrOptions;
  }

  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    // Set defaults — spread options first, then apply defaults for missing fields
    const metadata: SubscribeOptions = {
      ...options,
      id: options.id ?? String(propertyKey),
      features: options.features ?? [SubscribeFeature.LOCAL],
      priority: options.priority ?? Infinity,
    };

    // Store on the method
    Reflect.defineMetadata(SUBSCRIBE_KEY, metadata, target, propertyKey);

    // Collect all subscriptions on the class for scanning (separate key to avoid collision)
    const existing: Array<{ propertyKey: string; options: SubscribeOptions }> =
      Reflect.getMetadata(SUBSCRIBE_METHODS_KEY, target.constructor) ?? [];
    existing.push({ propertyKey: String(propertyKey), options: metadata });
    Reflect.defineMetadata(SUBSCRIBE_METHODS_KEY, existing, target.constructor);
  };
}

/**
 * Get all @Subscribe method entries from a class.
 */
export function getSubscriptions(
  target: Function,
): Array<{ propertyKey: string; options: SubscribeOptions }> {
  return Reflect.getMetadata(SUBSCRIBE_METHODS_KEY, target) ?? [];
}
