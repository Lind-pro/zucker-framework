import { Observable, ReplaySubject } from 'rxjs';

export interface ReplayEventBusOptions<TContext, TPayload> {
  channel: (context: TContext) => string;
  isTerminal: (payload: TPayload) => boolean;
  channelTtlMs: number;
  cleanupIntervalMs: number;
  beforePublish?: (context: TContext, payload: TPayload) => void;
  /**
   * How long a completed (terminal) channel is retained so late subscribers still receive the
   * terminal event and completion. Default: `channelTtlMs`. `0` restores the old behaviour.
   */
  terminalRetentionMs?: number;
}

/**
 * Process-local progress notification with replay(1). Terminal events reach
 * existing subscribers before their channel completes. A completed channel is
 * retained for `terminalRetentionMs` so a subscriber that arrives just after the
 * terminal event receives it and completes instead of waiting forever; a later
 * non-terminal event on that channel starts a fresh run. Stale channels expire
 * only when unobserved; slow work cannot evict an active stream.
 * This is reconstructable delivery state, not durable task state or a queue.
 */
export class ReplayEventBus<TContext, TPayload> {
  protected readonly channels = new Map<
    string,
    { subject: ReplaySubject<TPayload>; updatedAt: number; terminal?: boolean }
  >();
  protected closed = false;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(protected readonly options: ReplayEventBusOptions<TContext, TPayload>) {
    this.cleanupTimer = setInterval(() => this.cleanupStaleChannels(), options.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  publish(context: TContext, payload: TPayload): void {
    if (this.closed) return;
    this.options.beforePublish?.(context, payload);
    this.emitLocal(this.options.channel(context), payload);
  }

  stream(context: TContext): Observable<TPayload> {
    return this.channelStream(this.options.channel(context));
  }

  protected channelStream(channel: string): Observable<TPayload> {
    if (this.closed) return new Observable<TPayload>((subscriber) => subscriber.complete());
    return this.getOrCreateChannel(channel).subject.asObservable();
  }

  protected emitLocal(channel: string, payload: TPayload): void {
    if (this.closed) return;
    // A new event after a retained terminal one belongs to a new run.
    if (this.channels.get(channel)?.terminal) this.channels.delete(channel);
    const entry = this.getOrCreateChannel(channel);
    entry.updatedAt = Date.now();
    entry.subject.next(payload);
    if (this.options.isTerminal(payload)) this.finishChannel(channel);
  }

  /** Complete a channel after its terminal event; keep it briefly for late subscribers. */
  protected finishChannel(channel: string): void {
    const retention = this.options.terminalRetentionMs ?? this.options.channelTtlMs;
    if (retention <= 0) {
      this.removeChannel(channel);
      return;
    }
    const entry = this.channels.get(channel);
    if (!entry) return;
    entry.terminal = true;
    entry.updatedAt = Date.now();
    this.onChannelFinished(channel);
    entry.subject.complete();
  }

  /** Hook for transports to release resources once a channel has reached its terminal event. */
  protected onChannelFinished(_channel: string): void {}

  protected isTerminalChannel(channel: string): boolean {
    return this.channels.get(channel)?.terminal === true;
  }

  protected removeChannel(channel: string): void {
    const entry = this.channels.get(channel);
    this.channels.delete(channel);
    entry?.subject.complete();
  }

  protected stop(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.cleanupTimer);
    for (const entry of this.channels.values()) entry.subject.complete();
    this.channels.clear();
  }

  async onModuleDestroy(): Promise<void> {
    this.stop();
  }

  private getOrCreateChannel(channel: string) {
    let entry = this.channels.get(channel);
    if (!entry) {
      entry = { subject: new ReplaySubject<TPayload>(1), updatedAt: Date.now() };
      this.channels.set(channel, entry);
    }
    return entry;
  }

  private cleanupStaleChannels(): void {
    const now = Date.now();
    const retention = this.options.terminalRetentionMs ?? this.options.channelTtlMs;
    for (const [channel, entry] of this.channels) {
      const ttl = entry.terminal ? retention : this.options.channelTtlMs;
      if (now - entry.updatedAt > ttl && !entry.subject.observed) {
        this.removeChannel(channel);
      }
    }
  }
}
