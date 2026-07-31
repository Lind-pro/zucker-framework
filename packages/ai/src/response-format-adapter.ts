/** AI provider names supported by the structured-output compatibility layer. */
export type StructuredOutputProvider = 'OpenAI' | 'DeepSeek' | 'Claude' | 'Gemini';

export interface ProviderCapabilities {
  supportsJsonObject: boolean;
  supportsJsonSchema: boolean;
  supportsToolCalling: boolean;
  structuredOutputMethod: 'native' | 'tool' | 'prompt';
}

/** Central capability matrix used when negotiating structured output. */
export const PROVIDER_CAPABILITIES = {
  OpenAI: {
    supportsJsonObject: true,
    supportsJsonSchema: true,
    supportsToolCalling: true,
    structuredOutputMethod: 'native',
  },
  DeepSeek: {
    supportsJsonObject: true,
    supportsJsonSchema: false,
    supportsToolCalling: false,
    structuredOutputMethod: 'prompt',
  },
  Claude: {
    supportsJsonObject: false,
    supportsJsonSchema: false,
    supportsToolCalling: true,
    structuredOutputMethod: 'tool',
  },
  Gemini: {
    supportsJsonObject: true,
    supportsJsonSchema: false,
    supportsToolCalling: true,
    structuredOutputMethod: 'tool',
  },
} as const satisfies Record<StructuredOutputProvider, ProviderCapabilities>;

export type DesiredResponseFormat = 'json_object' | 'json_array' | 'text' | 'json_schema';

export interface JsonSchemaConfig {
  name?: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface AdaptedResponseFormat {
  responseFormat:
    | { type: 'json_object' }
    | { type: 'json_schema'; json_schema: JsonSchemaConfig }
    | undefined;
  requiresPostProcessing: boolean;
  fallbackMode: 'prompt' | 'tool' | 'none';
}

/** Negotiate a provider-specific response format, with an explicit fallback mode. */
export function adaptResponseFormat(
  provider: StructuredOutputProvider,
  desiredFormat: DesiredResponseFormat,
  jsonSchema?: JsonSchemaConfig,
): AdaptedResponseFormat {
  if (provider === 'OpenAI') {
    if (desiredFormat === 'json_schema' && jsonSchema) {
      return {
        responseFormat: { type: 'json_schema', json_schema: jsonSchema },
        requiresPostProcessing: false,
        fallbackMode: 'none',
      };
    }
    if (desiredFormat === 'json_object') {
      return nativeJsonObject();
    }
    return noResponseFormat();
  }

  if (provider === 'DeepSeek') {
    if (desiredFormat === 'json_schema') {
      return {
        responseFormat: { type: 'json_object' },
        requiresPostProcessing: true,
        fallbackMode: 'prompt',
      };
    }
    if (desiredFormat === 'json_object') {
      return nativeJsonObject();
    }
    return noResponseFormat();
  }

  if (provider === 'Claude') {
    if (desiredFormat === 'json_schema' || desiredFormat === 'json_object') {
      return toolFallback();
    }
    return noResponseFormat();
  }

  if (desiredFormat === 'json_schema') return toolFallback();
  if (desiredFormat === 'json_object') return nativeJsonObject();
  return noResponseFormat();
}

function nativeJsonObject(): AdaptedResponseFormat {
  return {
    responseFormat: { type: 'json_object' },
    requiresPostProcessing: false,
    fallbackMode: 'none',
  };
}

function toolFallback(): AdaptedResponseFormat {
  return {
    responseFormat: undefined,
    requiresPostProcessing: true,
    fallbackMode: 'tool',
  };
}

function noResponseFormat(): AdaptedResponseFormat {
  return {
    responseFormat: undefined,
    requiresPostProcessing: false,
    fallbackMode: 'none',
  };
}

/** Build schema instructions for providers that require prompt-based fallback. */
export function generateSchemaPrompt(jsonSchema?: JsonSchemaConfig): string {
  if (!jsonSchema?.schema) return '';

  const schema = jsonSchema.schema;
  const lines: string[] = ['\n📋 **严格的输出格式要求**：\n'];

  if (schema.type === 'object') {
    lines.push('返回 JSON 对象，包含以下字段：\n', '```json', '{');
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((field): field is string => typeof field === 'string')
      : [];

    Object.entries(properties).forEach(([key, rawProperty], index, entries) => {
      const property = isRecord(rawProperty) ? rawProperty : {};
      const type = typeof property.type === 'string' ? property.type : 'any';
      const description = typeof property.description === 'string' ? property.description : '';
      lines.push(
        `  "${key}": ${type}${required.includes(key) ? ' (必填)' : ' (可选)'}${description ? ` // ${description}` : ''}${index < entries.length - 1 ? ',' : ''}`,
      );
    });

    lines.push('}', '```\n');
    if (required.length > 0) lines.push(`**必填字段**: ${required.join(', ')}`);
    if (schema.additionalProperties === false) lines.push('**重要**: 不允许包含额外字段！');
  } else if (schema.type === 'array') {
    lines.push('返回 JSON 数组，格式如下：\n', '```json', '[');
    const items = isRecord(schema.items) ? schema.items : {};
    const properties = isRecord(items.properties) ? items.properties : {};
    if (Object.keys(properties).length > 0) {
      lines.push('  {');
      Object.entries(properties).forEach(([key, rawProperty], index, entries) => {
        const property = isRecord(rawProperty) ? rawProperty : {};
        const type = typeof property.type === 'string' ? property.type : 'any';
        const description = typeof property.description === 'string' ? property.description : '';
        lines.push(
          `    "${key}": ${type}${description ? ` // ${description}` : ''}${index < entries.length - 1 ? ',' : ''}`,
        );
      });
      lines.push('  }');
    }
    lines.push(']', '```\n');
    if (typeof schema.minItems === 'number') lines.push(`**最少元素数**: ${schema.minItems}`);
    if (typeof schema.maxItems === 'number') lines.push(`**最多元素数**: ${schema.maxItems}`);
  }

  lines.push('\n⚠️  **请严格按照上述格式返回，字段名必须完全一致！**');
  return lines.join('\n');
}

/** Perform lightweight post-validation without requiring a JSON Schema runtime. */
export function validateAgainstSchema(
  data: unknown,
  jsonSchema?: JsonSchemaConfig,
): { isValid: boolean; errors: string[] } {
  if (!jsonSchema?.schema) return { isValid: true, errors: [] };

  const schema = jsonSchema.schema;
  const errors: string[] = [];

  if (schema.type === 'object') {
    if (!isRecord(data)) {
      return { isValid: false, errors: [`期望类型 object，实际得到 ${jsonTypeOf(data)}`] };
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((field): field is string => typeof field === 'string')
      : [];

    for (const field of required) {
      if (!(field in data)) errors.push(`缺少必填字段: ${field}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!(key in properties)) errors.push(`不允许的额外字段: ${key}`);
      }
    }
    for (const [key, value] of Object.entries(data)) {
      const property = isRecord(properties[key]) ? properties[key] : undefined;
      const expectedType = typeof property?.type === 'string' ? property.type : undefined;
      if (expectedType && value !== null && expectedType !== jsonTypeOf(value)) {
        errors.push(`字段 ${key} 类型错误: 期望 ${expectedType}，实际 ${jsonTypeOf(value)}`);
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(data)) {
      return { isValid: false, errors: [`期望类型 array，实际得到 ${jsonTypeOf(data)}`] };
    }
    if (typeof schema.minItems === 'number' && data.length < schema.minItems) {
      errors.push(`数组元素过少: 至少需要 ${schema.minItems} 个，实际 ${data.length} 个`);
    }
    if (typeof schema.maxItems === 'number' && data.length > schema.maxItems) {
      errors.push(`数组元素过多: 最多允许 ${schema.maxItems} 个，实际 ${data.length} 个`);
    }
  }

  return { isValid: errors.length === 0, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonTypeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}
