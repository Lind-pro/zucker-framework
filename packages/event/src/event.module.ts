import { Module, DynamicModule, Global, Inject, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DefaultTopicEventBus, type TopicEventBus } from './topic-event-bus';
import { EntityEventListenerConfigure } from './entity-event-listener-configure';
import { type EntityEventListenerCustomizer, ENTITY_EVENT_LISTENER_CUSTOMIZER } from './entity-event-listener-customizer';

export const TOPIC_EVENT_BUS = 'TOPIC_EVENT_BUS';

@Global()
@Module({})
export class ZuckerEventModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    // Renamed from 'configure' to avoid collision with NestModule.configure(MiddlewareConsumer)
    private readonly listenerConfigure: EntityEventListenerConfigure,
    @Inject(TOPIC_EVENT_BUS)
    private readonly eventBus: TopicEventBus,
    @Optional()
    @Inject(ENTITY_EVENT_LISTENER_CUSTOMIZER)
    private readonly customizers?: EntityEventListenerCustomizer[],
  ) {}

  /**
   * 模块初始化时执行所有 EntityEventListenerCustomizer
   * 参考 hsweb 中通过 EntityEventListenerCustomizer 进行运行时配置
   */
  onModuleInit(): void {
    if (this.customizers) {
      for (const customizer of this.customizers) {
        customizer.customize(this.listenerConfigure);
      }
    }
  }

  onModuleDestroy(): void {
    // Clean up all event subscriptions to prevent memory leaks
    if (this.eventBus instanceof DefaultTopicEventBus) {
      this.eventBus.removeAllListeners();
    }
  }

  static forRoot(): DynamicModule {
    return {
      module: ZuckerEventModule,
      global: true,
      providers: [
        { provide: TOPIC_EVENT_BUS, useClass: DefaultTopicEventBus },
        EntityEventListenerConfigure,
      ],
      exports: [TOPIC_EVENT_BUS, EntityEventListenerConfigure],
    };
  }
}
