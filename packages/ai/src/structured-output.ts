import type { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { deepStripNullBytes, stripNullBytes } from '@zucker-framework/core';

export interface StructuredOutputFailure {
  kind: 'truncated' | 'root_type' | 'empty_object' | 'missing_fields';
  paths: string[];
  rootType?: string;
}

export function validateStructuredOutput<T>(
  schema: z.ZodType<T>,
  value: unknown,
  arrayField?: string,
) {
  const direct = schema.safeParse(value);
  if (direct.success || !arrayField || !Array.isArray(value)) return direct;
  return schema.safeParse({ [arrayField]: value });
}

export function describeStructuredOutputFailure(
  value: unknown,
  issues: z.ZodIssue[],
  truncated: boolean,
): StructuredOutputFailure {
  const paths = [...new Set(issues.map((issue) => issue.path.join('.')).filter(Boolean))].slice(
    0,
    8,
  );
  if (truncated) return { kind: 'truncated', paths };
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { kind: 'root_type', paths, rootType: Array.isArray(value) ? 'array' : typeof value };
  if (Object.keys(value).length === 0) return { kind: 'empty_object', paths };
  return { kind: 'missing_fields', paths };
}

export class StructuredOutputValidationError extends Error {
  constructor(
    readonly failure: StructuredOutputFailure,
    readonly issues: z.ZodIssue[],
    readonly phase: 'direct' | 'repair' | 'text',
    options?: ErrorOptions,
  ) {
    super('Generated output did not match the supplied schema', options);
    this.name = 'StructuredOutputValidationError';
  }
}
export class StructuredOutputSyntaxError extends Error {
  constructor() {
    super('Generated output is not valid JSON');
    this.name = 'StructuredOutputSyntaxError';
  }
}
export class StructuredOutputEmptyError extends Error {
  constructor() {
    super('Structured output stream was empty');
    this.name = 'StructuredOutputEmptyError';
  }
}

/** Parse a text/fenced response, repair syntax once locally, then strictly validate. No provider call. */
export function parseSchemaResponseText<T>(schema: z.ZodType<T>, content: string): T {
  let parsed: unknown;
  try {
    const clean = stripNullBytes(content).trim();
    const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    parsed = JSON.parse(fenced ?? clean);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(stripNullBytes(content)));
    } catch {
      throw new StructuredOutputSyntaxError();
    }
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success)
    throw new StructuredOutputValidationError(
      describeStructuredOutputFailure(parsed, validated.error.issues, false),
      validated.error.issues,
      'text',
    );
  return deepStripNullBytes(validated.data);
}
