import {
  Injectable,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { type Observable, map } from 'rxjs';
import { EnumDictRegistry, type EnumDictItem, getWriteJSONObject } from './enum-dict';

/**
 * Dict serializer — enriches enum fields with {value, text} format in responses.
 *
 * Reference: hsweb EnumDict.getWriteJSONObject() serialization behavior
 */

export interface DictSerializedField {
  value: string | number;
  text: string;
}

/**
 * Serialize an enum value to {value, text} format.
 *
 * Supports an optional i18n text resolver for internationalization.
 *
 * Reference: hsweb EnumDict.getWriteJSONObject()
 */
export function serializeDictValue(
  dictId: string,
  value: string | number,
  textResolver?: (code: string) => string,
): DictSerializedField | undefined {
  const items = EnumDictRegistry.get(dictId);
  if (!items) return undefined;

  const item = items.find((i) => i.value === value);
  if (!item) return { value, text: String(value) };

  const obj = getWriteJSONObject(item, textResolver);
  return { value: obj.value as string | number, text: obj.text as string };
}

/**
 * Deserialize a {value, text} object back to a raw enum value.
 *
 * Handles multiple input formats:
 * - {value, text} object — value can be string or number (对齐 hsweb 5.x fix 75f416a67)
 * - raw string/number
 * - Map-like object with value key
 * - null/undefined returns undefined
 *
 * Reference: hsweb EnumDict.EnumDictJSONDeserializer
 *
 * hsweb 5.x fix (75f416a67): 修复反序列化时枚举实现了 EnumDict，但泛型不是 String 类型
 * 会抛异常的问题。当 value 节点是数字类型时，使用 numberValue() 而非 textValue()。
 * hsweb 5.x fix (4c3ce4914): 优化反序列化的空值判断，value 为 null 时安全处理。
 */
export function deserializeDictValue(
  input: DictSerializedField | string | number | null | undefined,
  dictId?: string,
): string | number | undefined {
  // 对齐 hsweb 5.x: null/undefined 安全处理
  if (input === null || input === undefined) return undefined;

  if (typeof input === 'object' && input !== null && 'value' in input) {
    // 对齐 hsweb 5.x fix (75f416a67): value 可能是 string 或 number
    // Java: if (valueNode.isTextual()) textValue(); else if (valueNode.isNumber()) numberValue();
    const val = input.value;
    if (val === null || val === undefined) return undefined;
    return val;
  }

  // If dictId provided, try to find by text as well (like hsweb deserializer)
  if (dictId && typeof input === 'string') {
    const item = EnumDictRegistry.findByValue(dictId, input)
      ?? EnumDictRegistry.findByText(dictId, input);
    if (item) return item.value;
  }

  return input;
}

/**
 * NestJS interceptor that transforms enum dict fields in response objects.
 *
 * Configure which fields map to which dictId via constructor options.
 *
 * Reference: hsweb EnumDict serialization behavior — when isWriteJSONObjectEnabled()
 * returns true, enum values are serialized as {value, text} objects.
 */
@Injectable()
export class DictSerializerInterceptor implements NestInterceptor {
  constructor(
    private readonly fieldMappings: Record<string, string>,
    private readonly textResolver?: (code: string) => string,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((data) => this.transformResponse(data)),
    );
  }

  private transformResponse(data: unknown): unknown {
    if (data === null || data === undefined) return data;

    if (Array.isArray(data)) {
      return data.map((item) => this.transformResponse(item));
    }

    if (typeof data === 'object') {
      const result: Record<string, unknown> = { ...(data as Record<string, unknown>) };
      for (const [field, dictId] of Object.entries(this.fieldMappings)) {
        if (field in result) {
          const serialized = serializeDictValue(
            dictId,
            result[field] as string | number,
            this.textResolver,
          );
          if (serialized) {
            result[field] = serialized;
          }
        }
      }
      return result;
    }

    return data;
  }
}
