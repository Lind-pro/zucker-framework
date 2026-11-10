import { Observable, ReplaySubject } from 'rxjs';

export interface ReplayEventBusOptions<TContext, TPayload> {
  channel: (context: TContext) => string;
  isTerminal: (payload: TPayload) => boolean;
  channelTtlMs: number;
  cleanupIntervalMs: number;
  beforePublish?: (context: TContext, payload: TPayload) => void;
  /**
   * How long a completed (terminal) channel is retained so late subscribers still receive the
   * terminal event and completion. Default: `min(channelTtlMs, 30 000)`. `0` restores the
   * pre-1.0.19 behaviour (channel removed at the terminal event).
   *
   * When channel keys are reused across runs (e.g. keyed by document id), producers must call
   * {@link ReplayEventBus.begin} when a new run is accepted, or a subscriber of the new run that
   * connects before its first event receives the previous run's terminal replay.
   */
  terminalRetentionMs?: number;
  /**
   * Optional run id of a payload. A retained terminal entry is ignored by
   * `stream(context, { runId })` when its run id differs from the requested one.
   */
  runId?: (payload: TPayload) => string | undefined;
}

/** Default upper bound of terminal retention. */
export const DEFAULT_TERMINAL_RETENTION_MS = 30_000;

export interface ReplayStreamOptions {
  /** Only replay a retained terminal entry of this run; otherwise wait for new events. */
  runId?: string;
}

/**
 * Process-local progress notification with replay(1). Terminal events reach
 * existing subscribers before their channel completes. A completed channel is
 * retained for `terminalRetentionMs` so a subscriber that arrives just after the
 * terminal event receives it and completes instead of waiting forever; a later
 * event on that channel, or `begin(context)`, starts a fresh run. Stale channels expire
 * only when unobserved; slow work cannot evict an active stream.
 * This is reconstructable delivery state, not durable task state or a queue.
 */
export class ReplayEventBus<TContext, TPayload> {
  protected readonly channels = new Map<
    string,
    { subject: ReplaySubject<TPayload>; updatedAt: number; terminal?: boolean; runId?: string }
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

  stream(context: TContext, options?: ReplayStreamOptions): Observable<TPayload> {
    const channel = this.options.channel(context);
    this.dropStaleTerminal(channel, options?.runId);
    return this.channelStream(channel);
  }

  /**
   * Start a new run on `context`'s channel: drop a retained terminal entry of the previous run so
   * subscribers wait for the new run's events. Call it when the run is accepted (before the
   * client can subscribe). Alias: {@link reset}.
   */
  begin(context: TContext): void {
    this.dropRetainedTerminal(this.options.channel(context));
  }

  /** Alias of {@link begin}. */
  reset(context: TContext): void {
    this.begin(context);
  }

  /** Remove a retained (completed) channel; active channels are left untouched. */
  protected dropRetainedTerminal(channel: string): void {
    if (this.channels.get(channel)?.terminal) this.channels.delete(channel);
  }

  /** With a requested run id, a retained terminal entry of another run is dropped. */
  protected dropStaleTerminal(channel: string, runId: string | undefined): void {
    if (runId === undefined) return;
    const entry = this.channels.get(channel);
    if (entry?.terminal && entry.runId !== runId) this.channels.delete(channel);
  }

  protected terminalRetentionMs(): number {
    return this.options.terminalRetentionMs ?? Math.min(this.options.channelTtlMs, DEFAULT_TERMINAL_RETENTION_MS);
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
    const runId = this.options.runId?.(payload);
    if (runId !== undefined) entry.runId = runId;
    entry.subject.next(payload);
    if (this.options.isTerminal(payload)) this.finishChannel(channel);
  }

  /** Complete a channel after its terminal event; keep it briefly for late subscribers. */
  protected finishChannel(channel: string): void {
    const retention = this.terminalRetentionMs();
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
    const retention = this.terminalRetentionMs();
    for (const [channel, entry] of this.channels) {
      const ttl = entry.terminal ? retention : this.options.channelTtlMs;
      if (now - entry.updatedAt > ttl && !entry.subject.observed) {
        this.removeChannel(channel);
      }
    }
  }
}
