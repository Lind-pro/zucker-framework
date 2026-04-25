/**
 * ClearDictionaryCacheEvent — typed event for dictionary cache invalidation.
 *
 * Reference: hsweb ClearDictionaryCacheEvent
 *
 * When dictionaryId is provided, only that dictionary's cache is evicted.
 * When dictionaryId is undefined/null, all dictionary caches are cleared.
 */
export class ClearDictionaryCacheEvent {
  readonly dictionaryId?: string;

  private constructor(dictionaryId?: string) {
    this.dictionaryId = dictionaryId;
  }

  /**
   * Create an event to clear a specific dictionary's cache.
   *
   * Reference: hsweb ClearDictionaryCacheEvent.of(dictionaryId)
   */
  static of(dictionaryId?: string): ClearDictionaryCacheEvent {
    return new ClearDictionaryCacheEvent(dictionaryId);
  }

  /**
   * Create an event to clear all dictionary caches.
   *
   * Reference: hsweb ClearDictionaryCacheEvent.of()
   */
  static clearAll(): ClearDictionaryCacheEvent {
    return new ClearDictionaryCacheEvent();
  }
}
