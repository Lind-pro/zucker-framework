import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CAPABILITIES,
  adaptResponseFormat,
  generateSchemaPrompt,
  validateAgainstSchema,
  type JsonSchemaConfig,
} from './response-format-adapter';

const objectSchema: JsonSchemaConfig = {
  name: 'Result',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '名称' },
      score: { type: 'number' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

describe('structured output provider compatibility', () => {
  it('declares capabilities for every built-in provider', () => {
    expect(Object.keys(PROVIDER_CAPABILITIES)).toEqual(['OpenAI', 'DeepSeek', 'Claude', 'Gemini']);
    expect(PROVIDER_CAPABILITIES.OpenAI.supportsJsonSchema).toBe(true);
    expect(PROVIDER_CAPABILITIES.DeepSeek.structuredOutputMethod).toBe('prompt');
  });

  it('uses OpenAI native json_schema without post-processing', () => {
    expect(adaptResponseFormat('OpenAI', 'json_schema', objectSchema)).toEqual({
      responseFormat: { type: 'json_schema', json_schema: objectSchema },
      requiresPostProcessing: false,
      fallbackMode: 'none',
    });
  });

  it('downgrades DeepSeek json_schema to json_object plus prompt validation', () => {
    expect(adaptResponseFormat('DeepSeek', 'json_schema', objectSchema)).toEqual({
      responseFormat: { type: 'json_object' },
      requiresPostProcessing: true,
      fallbackMode: 'prompt',
    });
  });

  it('uses tool fallback for Claude structured output', () => {
    expect(adaptResponseFormat('Claude', 'json_object')).toEqual({
      responseFormat: undefined,
      requiresPostProcessing: true,
      fallbackMode: 'tool',
    });
  });

  it('keeps Gemini native json_object while using tools for json_schema', () => {
    expect(adaptResponseFormat('Gemini', 'json_object').responseFormat).toEqual({
      type: 'json_object',
    });
    expect(adaptResponseFormat('Gemini', 'json_schema').fallbackMode).toBe('tool');
  });

  it('renders object schema constraints into a fallback prompt', () => {
    const prompt = generateSchemaPrompt(objectSchema);
    expect(prompt).toContain('"name": string (必填) // 名称');
    expect(prompt).toContain('不允许包含额外字段');
  });

  it('reports missing, extra, and incorrectly typed object fields', () => {
    const result = validateAgainstSchema({ score: 'high', extra: true }, objectSchema);
    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual([
      '缺少必填字段: name',
      '不允许的额外字段: extra',
      '字段 score 类型错误: 期望 number，实际 string',
    ]);
  });

  it('rejects null and arrays when an object is required', () => {
    expect(validateAgainstSchema(null, objectSchema).isValid).toBe(false);
    expect(validateAgainstSchema([], objectSchema).isValid).toBe(false);
  });

  it('checks array size boundaries', () => {
    const schema: JsonSchemaConfig = {
      schema: { type: 'array', minItems: 2, maxItems: 3 },
    };
    expect(validateAgainstSchema([1], schema).errors).toEqual([
      '数组元素过少: 至少需要 2 个，实际 1 个',
    ]);
    expect(validateAgainstSchema([1, 2, 3, 4], schema).errors).toEqual([
      '数组元素过多: 最多允许 3 个，实际 4 个',
    ]);
  });
});
