export interface DictionaryItem {
  id: string;
  dictId: string;
  name: string;
  value: string;
  text: string;
  ordinal: number;
  parentId: string | null;
  path: string;
  sortIndex: number;
  /** Item description / comments */
  description?: string;
  /** Whether this item is enabled */
  status?: boolean;
  /** Extensible properties (JSON) — e.g. color, icon, extra metadata */
  properties?: Record<string, unknown>;
  /**
   * Quick search code for fuzzy lookup (e.g. pinyin abbreviation).
   */
  searchCode?: string;
  /**
   * Value type hint (e.g. 'string', 'number', 'boolean').
   */
  valueType?: string;
}

export interface Dictionary {
  id: string;
  /** Dictionary code — unique identifier */
  code?: string;
  name: string;
  classified: string;
  describe: string;
  /** Whether this dictionary is enabled */
  status?: boolean;
  /**
   * Record creation timestamp (epoch ms).
   */
  createTime?: number;
  /**
   * Creator user ID.
   */
  creatorId?: string;
  items: DictionaryItem[];
}

/**
 * Get the bitmask for a DictionaryItem based on its ordinal.
 *
 * @param item - Dictionary item with ordinal
 * @returns Bitmask value (1 << ordinal)
 */
export function getDictionaryItemMask(item: DictionaryItem): number {
  return 1 << item.ordinal;
}

/**
 * Generate a deterministic ID for a dictionary item from dictId + ordinal.
 *
 * — uses DigestUtils.md5Hex(dictId + "|" + ordinal)
 *
 * Uses a simple hash algorithm for portability. For production use with
 * Node.js crypto, use `md5` from `@zucker-framework/core` instead:
 *   `md5(\`${dictId}|${ordinal}\`)`
 *
 * @param dictId - The dictionary ID
 * @param ordinal - The item ordinal
 * @returns Hex hash string
 */
export function generateDictionaryItemId(dictId: string, ordinal: number): string {
  const str = `${dictId}|${ordinal}`;
  // FNV-1a 32-bit hash — fast, deterministic, good distribution
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) | 0;
  }
  // Convert to unsigned 32-bit, then to 8-char hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Serialize a DictionaryItem to the JSON object format used for API responses.
 *
 * — writes id, name, dictId, value, text, ordinal, sortIndex, parentId, path, mask, searchCode, status, describe
 */
export function dictionaryItemToJSON(item: DictionaryItem): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    dictId: item.dictId,
    value: item.value,
    text: item.text,
    ordinal: item.ordinal,
    sortIndex: item.sortIndex,
    parentId: item.parentId,
    path: item.path,
    mask: getDictionaryItemMask(item),
    searchCode: item.searchCode,
    status: item.status,
    describe: item.description,
  };
}

export { DictionaryService, DICT_CHANGED_EVENT, DICT_CHANGED_TOPIC } from './dictionary.service';
export type { DictChangePayload, DictionaryDetail } from './dictionary.service';
export { DictionaryItemService } from './dictionary-item.service';
export type { TreeNode } from './dictionary-item.service';
export { DictField, DICT_FIELD_KEY, DICT_FIELDS_KEY, getDictFields, getDictFieldOptions } from './dict-field.decorator';
export type { DictFieldOptions, DictFieldEntry } from './dict-field.decorator';
export { ZuckerDictionaryModule } from './dictionary.module';
export { BitMaskDictionary } from './bitmask-dictionary';
export {
  EnumDict,
  EnumDictRegistry,
  toDictItem,
  fromDictItem,
  enumDictEq,
  enumDictIn,
  getMask,
  toMask,
  getByMask,
  maskIn,
  maskInAny,
  getWriteJSONObject,
  createEnumDictItem,
  createI18nEnumDictItem,
} from './enum-dict';
export type { EnumDictItem, I18nEnumDictItem } from './enum-dict';
export {
  DictSerializerInterceptor,
  serializeDictValue,
  deserializeDictValue,
} from './dict-serializer';
export type { DictSerializedField } from './dict-serializer';
export {
  DictDefineRepository,
  CompositeDictDefineRepository,
  createDictDefine,
  createClassDictDefine,
} from './dict-define';
export type {
  DictDefine,
  ClassDictDefine,
  ItemDefine,
} from './dict-define';
export { ClearDictionaryCacheEvent } from './clear-dictionary-cache-event';
