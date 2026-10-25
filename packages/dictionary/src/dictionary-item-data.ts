import type { DictionaryItem } from './index';

/** Public aliases are accepted at the service boundary; storage uses text/ordinal/describe. */
export type DictionaryItemInput = {
  dictId: string;
  value: string;
  ordinal?: number;
  sortIndex?: number;
  parentId?: string;
  description?: string;
  status?: boolean;
  properties?: Record<string, unknown>;
  searchCode?: string;
  valueType?: string;
} & ({ text: string; name?: string } | { text?: string; name: string });

export type DictionaryItemUpdate = Partial<Omit<DictionaryItemInput, 'dictId' | 'parentId'>>;

export function dictionaryItemData(input: Partial<DictionaryItemInput>, existingProperties?: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of ['dictId', 'value', 'parentId', 'status', 'properties', 'searchCode'] as const)
    if (input[key] !== undefined) data[key] = input[key];
  if (input.text !== undefined || input.name !== undefined) data.text = input.text ?? input.name;
  if (input.ordinal !== undefined || input.sortIndex !== undefined) data.ordinal = input.ordinal ?? input.sortIndex;
  if (input.description !== undefined) data.describe = input.description;
  if (input.valueType !== undefined) data.properties = { ...(input.properties ?? existingProperties), valueType: input.valueType };
  return data;
}

export function dictionaryItemRecord(row: unknown): DictionaryItem {
  const item = row as DictionaryItem & { describe?: string | null };
  return {
    ...item,
    name: item.name ?? item.text,
    sortIndex: item.sortIndex ?? item.ordinal,
    description: item.description ?? item.describe ?? undefined,
    parentId: item.parentId ?? null,
    path: item.path ?? '',
    valueType: item.valueType ?? (typeof item.properties?.valueType === 'string' ? item.properties.valueType : undefined),
  };
}
