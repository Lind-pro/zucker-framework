import { describe, it, expect, beforeEach } from 'vitest';
import { CompositeMessageSource, type MessageSource } from './message-source';

/** Simple in-memory message source for testing */
class InMemoryMessageSource implements MessageSource {
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

describe('CompositeMessageSource', () => {
  let source1: InMemoryMessageSource;
  let source2: InMemoryMessageSource;
  let composite: CompositeMessageSource;

  beforeEach(() => {
    source1 = new InMemoryMessageSource({
      'error.notFound': 'Resource not found',
      'greeting': 'Hello {0}',
    });
    source2 = new InMemoryMessageSource({
      'error.forbidden': 'Access denied',
      'greeting': 'Hi {0}', // duplicate key, should use source1's version
    });
    composite = new CompositeMessageSource([source1, source2]);
  });

  describe('resolve', () => {
    it('should resolve message from first source', () => {
      const result = composite.getMessage('error.notFound');
      expect(result).toBe('Resource not found');
    });

    it('should resolve message from second source when not in first', () => {
      const result = composite.getMessage('error.forbidden');
      expect(result).toBe('Access denied');
    });

    it('should return first source match when key exists in multiple sources', () => {
      const result = composite.getMessage('greeting', ['World']);
      expect(result).toBe('Hello World');
    });

    it('should return default message when code not found in any source', () => {
      const result = composite.getMessage('unknown.key', [], 'Fallback');
      expect(result).toBe('Fallback');
    });

    it('should return the code itself when no match and no default', () => {
      const result = composite.getMessage('missing.code');
      expect(result).toBe('missing.code');
    });

    it('should pass args through to the matching source', () => {
      const result = composite.getMessage('greeting', ['Alice']);
      expect(result).toBe('Hello Alice');
    });
  });

  describe('addSource', () => {
    it('should add a new source and resolve from it', () => {
      const source3 = new InMemoryMessageSource({
        'new.key': 'New message',
      });
      composite.addSource(source3);
      expect(composite.getMessage('new.key')).toBe('New message');
    });
  });

  describe('addSources', () => {
    it('should add multiple sources at once', () => {
      const s3 = new InMemoryMessageSource({ 'k1': 'v1' });
      const s4 = new InMemoryMessageSource({ 'k2': 'v2' });
      composite.addSources([s3, s4]);
      expect(composite.getMessage('k1')).toBe('v1');
      expect(composite.getMessage('k2')).toBe('v2');
    });
  });

  describe('getSourceCount', () => {
    it('should return the number of registered sources', () => {
      expect(composite.getSourceCount()).toBe(2);
      composite.addSource(new InMemoryMessageSource({}));
      expect(composite.getSourceCount()).toBe(3);
    });
  });

  describe('empty composite', () => {
    it('should return default message with no sources', () => {
      const empty = new CompositeMessageSource([]);
      expect(empty.getMessage('any.key', [], 'default')).toBe('default');
    });

    it('should return code when no sources and no default', () => {
      const empty = new CompositeMessageSource([]);
      expect(empty.getMessage('any.key')).toBe('any.key');
    });
  });
});
