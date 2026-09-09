import { Logger } from '@nestjs/common';
import type { TopicEventBus, TopicPayload } from '@zucker-framework/event';

export interface EventTriggerConfig {
  topic: string;
}

export class EventTrigger {
  private readonly logger = new Logger(EventTrigger.name);
  private subscription?: { unsubscribe: () => void };

  start(
    config: EventTriggerConfig,
    eventBus: TopicEventBus,
    handler: (payload: unknown) => void | Promise<void>,
  ): void {
    this.logger.log(`Event trigger started: topic=${config.topic}`);
    this.subscription = eventBus.subscribe(config.topic, (msg: TopicPayload) => handler(msg.payload));
  }

  stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.logger.log('Event trigger stopped');
  }

  isRunning(): boolean {
    return this.subscription !== undefined;
  }
}
