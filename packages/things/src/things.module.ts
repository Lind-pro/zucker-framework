import { Module } from '@nestjs/common';
import { InMemoryThingManager } from './thing-manager';

/**
 * ThingsModule — 物模型 NestJS 模块
 *
 * 默认使用内存实现。生产环境可覆盖 ThingManager 提供者。
 */
@Module({
  providers: [InMemoryThingManager],
  exports: [InMemoryThingManager],
})
export class ThingsModule {}
