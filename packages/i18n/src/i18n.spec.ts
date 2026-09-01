import { describe, it, expect, beforeEach } from 'vitest';
import { CompositeMessageSource, type MessageSource } from './message-source';

/**
 * MessageSource with nested parameter support for testing.
 * Supports messages like "Hello {0}, welcome to {1}" and nested
 * resolution patterns.
 */
class NestedParamMessageSource implements MessageSource {
  constructor(private readonly messages: Record<string, string>) {}

  getMessage(
    code: string,
    args?: unknown[],
    defaultMessage?: string,
    _locale?: string,
  ): string {
    const message = this.messages[code];
    if (message === undefined) {
      return defaultMessage ?? code;
    }
    return this.interpolate(message, args);
  }

  private interpolate(message: string, args?: unknown[]): string {
    if (!args || args.length === 0) return message;
    return message.replace(/\{(\d+)\}/g, (match, index) => {
      const idx = parseInt(index, 10);
      return idx < args.length ? String(args[idx]) : match;
    });
  }
}

describe('i18n nested parameter resolution', () => {
  let source: NestedParamMessageSource;

  beforeEach(() => {
    source = new NestedParamMessageSource({
      'welcome': 'Welcome {0} to {1}!',
      'farewell': 'Goodbye {0}!',
      'multi.args': '{0}, {1}, {2}',
      'no.args': 'Static message',
      'partial.args': 'Hello {0} and {2}',
      'nested.key': 'Outer: {0}',
      'error.validation': 'Field {0} is invalid: {1}',
      'with.special': 'Price: {0} (tax {1}%)',
    });
  });

  it('should resolve message with positional args', () => {
    expect(source.getMessage('welcome', ['Alice', 'Wonderland'])).toBe(
      'Welcome Alice to Wonderland!',
    );
  });

  it('should resolve message with single arg', () => {
    expect(source.getMessage('farewell', ['Bob'])).toBe('Goodbye Bob!');
  });

  it('should resolve message with three args', () => {
    expect(source.getMessage('multi.args', ['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('should return static message without args', () => {
    expect(source.getMessage('no.args')).toBe('Static message');
  });

  it('should preserve unmatched placeholders when args are insufficient', () => {
    expect(source.getMessage('partial.args', ['World'])).toBe('Hello World and {2}');
  });

  it('should resolve nested key with arg', () => {
    expect(source.getMessage('nested.key', ['inner value'])).toBe('Outer: inner value');
  });

  it('should handle validation error format', () => {
    expect(source.getMessage('error.validation', ['email', 'must be valid'])).toBe(
      'Field email is invalid: must be valid',
    );
  });

  it('should handle numeric args properly', () => {
    expect(source.getMessage('with.special', [99.99, 8.5])).toBe('Price: 99.99 (tax 8.5%)');
  });

  it('should return code when message not found', () => {
    expect(source.getMessage('missing.key')).toBe('missing.key');
  });

  it('should return default message for unknown code', () => {
    expect(source.getMessage('unknown', [], 'Default text')).toBe('Default text');
  });

  describe('CompositeMessageSource with nested params', () => {
    it('should resolve through composite with args', () => {
      const composite = new CompositeMessageSource([source]);
      expect(composite.getMessage('welcome', ['User', 'System'])).toBe(
        'Welcome User to System!',
      );
    });

    it('should fallback through sources with args', () => {
      const empty = new NestedParamMessageSource({});
      const composite = new CompositeMessageSource([empty, source]);
      expect(composite.getMessage('farewell', ['Charlie'])).toBe('Goodbye Charlie!');
    });
  });
});
