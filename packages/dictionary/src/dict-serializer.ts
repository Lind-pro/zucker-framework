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
 */

export interface DictSerializedField {
  value: string | number;
  text: string;
}

/**
 * Serialize an enum value to {value, text} format.
 *
 * Supports an optional i18n text resolver for internationalization.
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
 * - {value, text} object — value can be string or number
 * - raw string/number
 * - Map-like object with value key
 * - null/undefined returns undefined
 *
 * 保留 value 的字符串或数字类型；value 为 null/undefined 时返回 undefined。
 */
export function deserializeDictValue(
  input: DictSerializedField | string | number | null | undefined,
  dictId?: string,
): string | number | undefined {
  // null/undefined 安全处理
  if (input === null || input === undefined) return undefined;

  if (typeof input === 'object' && input !== null && 'value' in input) {
    // value 可能是 string 或 number
    const val = input.value;
    if (val === null || val === undefined) return undefined;
    return val;
  }

  // If dictId provided, try to find by text as well
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
 * Configured enum fields are serialized as {value, text} objects.
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
