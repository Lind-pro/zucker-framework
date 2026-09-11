import type { EventEmitter } from 'node:events';
import type { Observable } from 'rxjs';
import { ReplayEventBus, type ReplayEventBusOptions } from './replay-event-bus';

export interface ReplayEventRedisClient extends Pick<EventEmitter, 'on' | 'off'> {
  duplicate(): ReplayEventRedisClient;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface RedisReplayEventBusOptions<TContext, TPayload> extends ReplayEventBusOptions<
  TContext,
  TPayload
> {
  /** The bus owns this connection and its duplicate, and closes each exactly once. */
  createClient: () => ReplayEventRedisClient;
  /** Validate the deserialized wire payload at the application boundary. */
  parsePayload: (value: unknown) => TPayload;
  logger?: { error(message: string): void; warn(message: string): void };
}

/**
 * Redis Pub/Sub transport with process-local replay(1). Notifications published
 * before subscription are not persisted. Subscribe failures allow a later stream
 * call to try again; the Redis client owns network reconnect/retry configuration.
 */
export class RedisReplayEventBus<TContext, TPayload> extends ReplayEventBus<TContext, TPayload> {
  private publisher?: ReplayEventRedisClient;
  private subscriber?: ReplayEventRedisClient;
  private readonly subscriptions = new Map<string, object>();
  private closePromise?: Promise<void>;
  private readonly onPublisherError = () =>
    this.redisOptions.logger?.error('Redis event publisher connection failed');
  private readonly onSubscriberError = () =>
    this.redisOptions.logger?.error('Redis event subscriber connection failed');
  private readonly onMessage = (channel: string, message: string) => {
    if (this.closed || !this.subscriptions.has(channel) || !this.channels.has(channel)) return;
    try {
      const payload = this.redisOptions.parsePayload(JSON.parse(message));
      this.emitLocal(channel, payload);
    } catch {
      // Do not log wire data, which may contain private business content.
      this.redisOptions.logger?.warn('Invalid Redis progress event');
    }
  };

  constructor(private readonly redisOptions: RedisReplayEventBusOptions<TContext, TPayload>) {
    super(redisOptions);
  }

  onModuleInit(): void {
    if (this.closed || this.publisher) return;
    const publisher = this.redisOptions.createClient();
    publisher.on('error', this.onPublisherError);
    this.publisher = publisher;
    try {
      this.subscriber = publisher.duplicate();
      this.subscriber.on('error', this.onSubscriberError);
      this.subscriber.on('message', this.onMessage);
      for (const channel of this.channels.keys()) this.ensureSubscribed(channel);
    } catch (error) {
      void this.onModuleDestroy();
      throw error;
    }
  }

  override publish(context: TContext, payload: TPayload): void {
    if (this.closed || !this.publisher) return;
    this.options.beforePublish?.(context, payload);
    const channel = this.options.channel(context);
    const message = JSON.stringify(payload);
    void this.publisher.publish(channel, message).catch(() => {
      this.redisOptions.logger?.error('Redis event publish failed');
    });
  }

  override stream(context: TContext): Observable<TPayload> {
    const channel = this.options.channel(context);
    const stream = this.channelStream(channel);
    this.ensureSubscribed(channel);
    return stream;
  }

  protected override removeChannel(channel: string): void {
    // Unsubscribe before complete callbacks can open a fresh stream on this key.
    const subscribed = this.subscriptions.delete(channel);
    if (subscribed && this.subscriber) {
      void this.subscriber.unsubscribe(channel).catch(() => {
        this.redisOptions.logger?.warn('Redis event unsubscribe failed');
      });
    }
    super.removeChannel(channel);
  }

  override onModuleDestroy(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stop();
    this.subscriptions.clear();
    this.subscriber?.off('message', this.onMessage);
    const publisher = this.publisher;
    const subscriber = this.subscriber;
    this.closePromise = Promise.allSettled([
      Promise.resolve().then(() => subscriber?.quit()),
      Promise.resolve().then(() => publisher?.quit()),
    ]).then(() => {
      subscriber?.off('error', this.onSubscriberError);
      publisher?.off('error', this.onPublisherError);
      this.subscriber = undefined;
      this.publisher = undefined;
    });
    return this.closePromise;
  }

  private ensureSubscribed(channel: string): void {
    if (this.closed || !this.subscriber || this.subscriptions.has(channel)) return;
    const token = {};
    this.subscriptions.set(channel, token);
    void this.subscriber.subscribe(channel).catch(() => {
      if (this.subscriptions.get(channel) === token) this.subscriptions.delete(channel);
      this.redisOptions.logger?.error('Redis event subscribe failed');
    });
  }
}
