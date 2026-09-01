import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocaleUtils } from './locale-utils';
import { LocaleContext } from './locale-context';
import type { MessageSource } from './message-source';

class MockMessageSource implements MessageSource {
  private readonly data: Record<string, Record<string, string>>;

  constructor(data: Record<string, Record<string, string>>) {
    this.data = data;
  }

  getMessage(
    code: string,
    args?: unknown[],
    defaultMessage?: string,
    locale?: string,
  ): string {
    const loc = locale ?? 'en';
    const messages = this.data[loc] ?? {};
    const message = messages[code];
    if (message === undefined) {
      return defaultMessage ?? code;
    }
    if (!args || args.length === 0) return message;
    return message.replace(/\{(\d+)\}/g, (match, index) => {
      const idx = parseInt(index, 10);
      return idx < args.length ? String(args[idx]) : match;
    });
  }
}

describe('LocaleUtils', () => {
  let mockSource: MockMessageSource;

  beforeEach(() => {
    mockSource = new MockMessageSource({
      en: {
        'greeting': 'Hello {0}!',
        'farewell': 'Goodbye!',
      },
      zh: {
        'greeting': '你好 {0}!',
        'farewell': '再见!',
      },
    });
    LocaleUtils.setMessageSource(mockSource);
  });

  afterEach(() => {
    LocaleUtils.setMessageSource(null as any);
    LocaleContext.setDefault('en');
  });

  describe('resolveMessage', () => {
    it('should resolve message using default locale', () => {
      const result = LocaleUtils.resolveMessage('greeting', 'World');
      expect(result).toBe('Hello World!');
    });

    it('should resolve message using current locale context', () => {
      const result = LocaleUtils.doWith('zh', () => {
        return LocaleUtils.resolveMessage('greeting', 'World');
      });
      expect(result).toBe('你好 World!');
    });

    it('should return code when message source is not set', () => {
      LocaleUtils.setMessageSource(null as any);
      expect(LocaleUtils.resolveMessage('greeting')).toBe('greeting');
    });

    it('should return code when message not found', () => {
      expect(LocaleUtils.resolveMessage('unknown.key')).toBe('unknown.key');
    });
  });

  describe('resolveMessageWithDefault', () => {
    it('should return default message when code not found', () => {
      const result = LocaleUtils.resolveMessageWithDefault(
        'missing',
        'Default text',
      );
      expect(result).toBe('Default text');
    });

    it('should return default when message source is null', () => {
      LocaleUtils.setMessageSource(null as any);
      expect(LocaleUtils.resolveMessageWithDefault('key', 'fallback')).toBe('fallback');
    });
  });

  describe('doWith', () => {
    it('should execute function within specified locale context', () => {
      const result = LocaleUtils.doWith('zh', () => {
        return LocaleUtils.resolveMessage('farewell');
      });
      expect(result).toBe('再见!');
    });

    it('should restore locale after execution', () => {
      LocaleUtils.doWith('zh', () => {
        // inside zh context
      });
      // After doWith, should be back to default 'en'
      expect(LocaleUtils.current()).toBe('en');
    });

    it('should support nested doWith calls', () => {
      const result = LocaleUtils.doWith('en', () => {
        const inner = LocaleUtils.doWith('zh', () => {
          return LocaleUtils.resolveMessage('greeting', 'Test');
        });
        return inner + ' | ' + LocaleUtils.resolveMessage('greeting', 'Test');
      });
      expect(result).toBe('你好 Test! | Hello Test!');
    });
  });

  describe('doWithAsync', () => {
    it('should execute async function within locale context', async () => {
      const result = await LocaleUtils.doWithAsync('zh', async () => {
        await new Promise((r) => setTimeout(r, 1));
        return LocaleUtils.resolveMessage('farewell');
      });
      expect(result).toBe('再见!');
    });
  });

  describe('resolveMessageForLocale', () => {
    it('should resolve for a specific locale ignoring context', () => {
      const result = LocaleUtils.resolveMessageForLocale('greeting', 'zh', undefined, 'User');
      expect(result).toBe('你好 User!');
    });

    it('should return default when source is null', () => {
      LocaleUtils.setMessageSource(null as any);
      expect(LocaleUtils.resolveMessageForLocale('key', 'en', 'fallback')).toBe('fallback');
    });
  });

  describe('resolveMessageFrom', () => {
    it('should resolve from specific source with current locale', () => {
      const customSource = new MockMessageSource({
        en: { 'custom.key': 'Custom value' },
      });
      const result = LocaleUtils.resolveMessageFrom(customSource, 'custom.key');
      expect(result).toBe('Custom value');
    });
  });

  describe('current', () => {
    it('should return default locale when no context is set', () => {
      expect(LocaleUtils.current()).toBe('en');
    });

    it('should return context locale when set', () => {
      LocaleUtils.doWith('zh', () => {
        expect(LocaleUtils.current()).toBe('zh');
      });
    });
  });

  describe('getMessageSource', () => {
    it('should return the configured message source', () => {
      expect(LocaleUtils.getMessageSource()).toBe(mockSource);
    });
  });
});
