/**
 * ClearDictionaryCacheEvent — typed event for dictionary cache invalidation.
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
   */
  static of(dictionaryId?: string): ClearDictionaryCacheEvent {
    return new ClearDictionaryCacheEvent(dictionaryId);
  }

  /**
   * Create an event to clear all dictionary caches.
   */
  static clearAll(): ClearDictionaryCacheEvent {
    return new ClearDictionaryCacheEvent();
  }
}
