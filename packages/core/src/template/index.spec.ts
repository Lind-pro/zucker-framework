import { describe, it, expect } from 'vitest';
import { parseTemplate } from './index';

describe('parseTemplate', () => {
  it('should substitute simple variables', () => {
    const result = parseTemplate('Hello, ${name}!', { name: 'Alice' });
    expect(result).toBe('Hello, Alice!');
  });

  it('should substitute multiple variables', () => {
    const result = parseTemplate('${greeting}, ${name}!', {
      greeting: 'Hi',
      name: 'Bob',
    });
    expect(result).toBe('Hi, Bob!');
  });

  it('should replace undefined variables with empty string', () => {
    const result = parseTemplate('Value: ${missing}', {});
    expect(result).toBe('Value: ');
  });

  it('should handle nested property access', () => {
    const result = parseTemplate('City: ${address.city}', {
      address: { city: 'Tokyo' },
    });
    expect(result).toBe('City: Tokyo');
  });

  it('should handle deeply nested property access', () => {
    const result = parseTemplate('${a.b.c}', {
      a: { b: { c: 'deep' } },
    });
    expect(result).toBe('deep');
  });

  it('should return empty for missing nested path', () => {
    const result = parseTemplate('${a.b.c}', { a: {} });
    expect(result).toBe('');
  });

  it('should convert non-string values to string', () => {
    const result = parseTemplate('Count: ${n}, Active: ${flag}', {
      n: 42,
      flag: true,
    });
    expect(result).toBe('Count: 42, Active: true');
  });

  it('should handle template with no variables', () => {
    const result = parseTemplate('No variables here', {});
    expect(result).toBe('No variables here');
  });

  it('should handle empty template', () => {
    const result = parseTemplate('', { x: 1 });
    expect(result).toBe('');
  });

  it('should process empty and special expressions like Java TemplateParser', () => {
    // Java TemplateParser processes all ${...} patterns, passing content to mapper.
    // ExpressionUtils: if (StringUtils.isEmpty(var)) return "";
    // ${} -> mapper("") -> looks up key "" -> 'nope'
    // ${ } -> mapper(" ") -> no match -> ''
    // ${-invalid} -> mapper("-invalid") -> no match -> ''
    const result = parseTemplate('${} ${ } ${-invalid}', { '': 'nope' });
    expect(result).toBe('nope  ');
  });

  it('should preserve unclosed placeholders', () => {
    // Unclosed ${... should be kept as-is (Java TemplateParser: 未闭合保留原样)
    const result = parseTemplate('hello ${unclosed', { unclosed: 'world' });
    expect(result).toBe('hello ${unclosed');
  });

  it('should escape HTML when option is set', () => {
    const result = parseTemplate('${content}', {
      content: '<script>alert("xss")</script>',
    }, { escapeHtml: true });
    expect(result).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('should escape ampersand in HTML mode', () => {
    const result = parseTemplate('${val}', { val: 'A & B' }, { escapeHtml: true });
    expect(result).toBe('A &amp; B');
  });

  it('should escape single quotes in HTML mode', () => {
    const result = parseTemplate('${val}', { val: "it's" }, { escapeHtml: true });
    expect(result).toBe('it&#39;s');
  });

  it('should not escape HTML by default', () => {
    const result = parseTemplate('${val}', { val: '<b>bold</b>' });
    expect(result).toBe('<b>bold</b>');
  });

  it('should handle same variable used multiple times', () => {
    const result = parseTemplate('${x} and ${x}', { x: 'same' });
    expect(result).toBe('same and same');
  });
});
