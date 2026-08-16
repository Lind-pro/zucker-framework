import {
  QueueEvents,
  type ConnectionOptions,
  type JobProgress as BullMqJobProgress,
  type QueueEventsOptions,
} from 'bullmq';

type QueueEventsFactory = (queueName: string, options: QueueEventsOptions) => QueueEvents;

export interface QueueCompletedEvent {
  queueName: string;
  jobId: string;
  returnvalue: string;
}

export interface QueueFailedEvent {
  queueName: string;
  jobId: string;
  failedReason: string;
}

export interface QueueProgressEvent {
  queueName: string;
  jobId: string;
  data: BullMqJobProgress;
}

export interface QueueStateEvent {
  queueName: string;
  jobId: string;
}

export interface QueueEventHandlers {
  completed?: (event: QueueCompletedEvent) => void;
  failed?: (event: QueueFailedEvent) => void;
  progress?: (event: QueueProgressEvent) => void;
  waiting?: (event: QueueStateEvent) => void;
  active?: (event: QueueStateEvent) => void;
}

export interface BullMqQueueEventsOptions {
  connection: ConnectionOptions;
  prefix?: string;
  onError?: (queueName: string, error: Error) => void;
  queueEventsFactory?: QueueEventsFactory;
}

export class BullMqQueueEvents {
  private readonly listeners = new Map<string, QueueEvents>();
  private readonly queueEventsFactory: QueueEventsFactory;

  constructor(private readonly options: BullMqQueueEventsOptions) {
    this.queueEventsFactory =
      options.queueEventsFactory ??
      ((queueName, queueOptions) => new QueueEvents(queueName, queueOptions));
  }

  listen(queueName: string, handlers: QueueEventHandlers): () => void {
    const queueEvents = this.getQueueEvents(queueName);
    const subscriptions: Array<() => void> = [];

    if (handlers.completed) {
      const handler = ({ jobId, returnvalue }: { jobId: string; returnvalue: string }) =>
        handlers.completed?.({ queueName, jobId, returnvalue });
      queueEvents.on('completed', handler);
      subscriptions.push(() => queueEvents.off('completed', handler));
    }
    if (handlers.failed) {
      const handler = ({ jobId, failedReason }: { jobId: string; failedReason: string }) =>
        handlers.failed?.({ queueName, jobId, failedReason });
      queueEvents.on('failed', handler);
      subscriptions.push(() => queueEvents.off('failed', handler));
    }
    if (handlers.progress) {
      const handler = ({ jobId, data }: { jobId: string; data: BullMqJobProgress }) =>
        handlers.progress?.({ queueName, jobId, data });
      queueEvents.on('progress', handler);
      subscriptions.push(() => queueEvents.off('progress', handler));
    }
    if (handlers.waiting) {
      const handler = ({ jobId }: { jobId: string }) => handlers.waiting?.({ queueName, jobId });
      queueEvents.on('waiting', handler);
      subscriptions.push(() => queueEvents.off('waiting', handler));
    }
    if (handlers.active) {
      const handler = ({ jobId }: { jobId: string }) => handlers.active?.({ queueName, jobId });
      queueEvents.on('active', handler);
      subscriptions.push(() => queueEvents.off('active', handler));
    }

    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }

  async waitUntilReady(): Promise<void> {
    await Promise.all([...this.listeners.values()].map((listener) => listener.waitUntilReady()));
  }

  async close(): Promise<void> {
    const listeners = [...this.listeners.values()];
    this.listeners.clear();
    await Promise.all(listeners.map((listener) => listener.close()));
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private getQueueEvents(queueName: string): QueueEvents {
    const existing = this.listeners.get(queueName);
    if (existing) return existing;

    const queueEvents = this.queueEventsFactory(queueName, {
      connection: this.options.connection,
      prefix: this.options.prefix,
    });
    queueEvents.on('error', (error) => this.options.onError?.(queueName, error));
    this.listeners.set(queueName, queueEvents);
    return queueEvents;
  }
}
