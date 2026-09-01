/**
 * 内存物管理器 — 开发/测试用默认实现
 * 对应 jetlinks DefaultThingManager / InMemoryDeviceRegistry
 */
import { Injectable } from '@nestjs/common';
import type { ThingType, Thing, ThingManager } from './thing';
import { ThingState } from './thing';
import type { ThingMetadata } from './metadata';
import { mergeMetadata } from './metadata';

@Injectable()
export class InMemoryThingManager implements ThingManager {
  private readonly types = new Map<string, ThingType>();
  private readonly things = new Map<string, Thing>();

  async getThingType(typeId: string): Promise<ThingType | undefined> {
    return this.types.get(typeId);
  }

  async registerThingType(type: ThingType): Promise<void> {
    this.types.set(type.id, type);
  }

  async getThing(thingId: string): Promise<Thing | undefined> {
    return this.things.get(thingId);
  }

  async registerThing(thing: Thing): Promise<void> {
    const existing = this.things.get(thing.id);
    this.things.set(thing.id, {
      ...existing,
      ...thing,
      state: existing?.state ?? ThingState.INACTIVE,
    });
  }

  async unregisterThing(thingId: string): Promise<void> {
    this.things.delete(thingId);
  }

  async updateState(thingId: string, state: ThingState, timestamp?: number): Promise<void> {
    const thing = this.things.get(thingId);
    if (!thing) return;

    const update: Partial<Thing> = { state };
    if (state === ThingState.ONLINE) {
      update.onlineTime = timestamp ?? Date.now();
    } else if (state === ThingState.OFFLINE) {
      update.offlineTime = timestamp ?? Date.now();
    }
    this.things.set(thingId, { ...thing, ...update });
  }

  async getEffectiveMetadata(thingId: string): Promise<ThingMetadata | undefined> {
    const thing = this.things.get(thingId);
    if (!thing) return undefined;

    const type = this.types.get(thing.thingTypeId);
    if (!type) return undefined;

    if (!thing.metadataPatch) {
      return type.metadata;
    }
    return mergeMetadata(type.metadata, thing.metadataPatch);
  }

  /** 获取指定类型的所有实例 */
  getThingsByType(typeId: string): Thing[] {
    return Array.from(this.things.values()).filter((t) => t.thingTypeId === typeId);
  }

  /** 获取所有在线实例数量 */
  countOnline(): number {
    return Array.from(this.things.values()).filter(
      (t) => t.state === ThingState.ONLINE,
    ).length;
  }
}
