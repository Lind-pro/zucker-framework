import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  parseSchemaResponseText,
  StructuredOutputValidationError,
  validateStructuredOutput,
} from './structured-output';

describe('structured response processing', () => {
  it('repairs local syntax and applies transforms/defaults before sanitizing NUL data', () => {
    const schema = z.object({ text: z.string().trim(), count: z.number().default(1) });
    expect(parseSchemaResponseText(schema, "```json\n{text: ' ready '}\n```")).toEqual({
      text: 'ready',
      count: 1,
    });
    expect(parseSchemaResponseText(schema, '{"text":"a\\u0000b"}')).toEqual({
      text: 'ab',
      count: 1,
    });
  });
  it('fails strict schema validation rather than returning unvalidated repaired data', () => {
    expect(() =>
      parseSchemaResponseText(z.object({ amount: z.number() }), '{"amount":"wrong"}'),
    ).toThrow(StructuredOutputValidationError);
  });
  it('only uses a root array mapping explicitly requested by the consumer', () => {
    const schema = z.object({ items: z.array(z.string()) });
    expect(validateStructuredOutput(schema, ['one']).success).toBe(false);
    expect(validateStructuredOutput(schema, ['one'], 'items')).toMatchObject({
      success: true,
      data: { items: ['one'] },
    });
  });
});
