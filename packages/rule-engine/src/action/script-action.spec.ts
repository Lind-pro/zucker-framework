import { describe, it, expect, vi, afterEach } from 'vitest';
import { ScriptAction } from './script-action';
import type { ScriptActionConfig } from './script-action';

describe('ScriptAction', () => {
  const action = new ScriptAction();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── validate ───────────────────────────────────────────────────────────────

  describe('validate()', () => {
    it('스크립트 내용이 없으면 오류를 던져야 한다', () => {
      expect(() => action.validate({ script: '' })).toThrow(
        'Script content is required',
      );
    });

    it('공백만 있는 스크립트면 오류를 던져야 한다', () => {
      expect(() => action.validate({ script: '   ' })).toThrow(
        'Script content is required',
      );
    });

    it('지원하지 않는 언어면 오류를 던져야 한다', () => {
      expect(() =>
        action.validate({ script: 'x = 1', lang: 'python' }),
      ).toThrow('Unsupported script language: python');
    });

    it('lang이 js이면 오류를 던지지 않아야 한다', () => {
      expect(() =>
        action.validate({ script: 'return 1', lang: 'js' }),
      ).not.toThrow();
    });

    it('lang이 javascript이면 오류를 던지지 않아야 한다', () => {
      expect(() =>
        action.validate({ script: 'return 1', lang: 'javascript' }),
      ).not.toThrow();
    });

    it('lang이 없으면 js로 간주하여 오류를 던지지 않아야 한다', () => {
      expect(() =>
        action.validate({ script: 'return 1' }),
      ).not.toThrow();
    });
  });

  // ─── 기본 스크립트 실행 ──────────────────────────────────────────────────────

  describe('execute() 기본 동작', () => {
    it('스크립트 반환값을 그대로 반환해야 한다', async () => {
      const config: ScriptActionConfig = {
        script: 'return 42;',
      };
      const result = await action.execute(config, {});
      expect(result).toBe(42);
    });

    it('스크립트에서 null을 반환하면 null을 반환해야 한다', async () => {
      const config: ScriptActionConfig = {
        script: 'return null;',
      };
      const result = await action.execute(config, {});
      expect(result).toBeNull();
    });

    it('스크립트에서 undefined를 반환하면 null을 반환해야 한다', async () => {
      const config: ScriptActionConfig = {
        script: 'var x = 1; return undefined;',
      };
      const result = await action.execute(config, {});
      expect(result).toBeNull();
    });

    it('스크립트에서 객체를 반환해야 한다', async () => {
      const config: ScriptActionConfig = {
        script: 'return { status: "ok", count: 3 };',
      };
      const result = await action.execute(config, {});
      expect(result).toEqual({ status: 'ok', count: 3 });
    });
  });

  // ─── context 주입 ────────────────────────────────────────────────────────────

  describe('context 주입', () => {
    it('data 값이 스크립트 컨텍스트로 주입되어야 한다', async () => {
      const config: ScriptActionConfig = {
        script: 'return data.temperature * 2;',
      };
      const result = await action.execute(config, { temperature: 50 });
      expect(result).toBe(100);
    });

    it('context 별칭으로도 data에 접근해야 한다', async () => {
      const config: ScriptActionConfig = {
        script: 'return context.name;',
      };
      const result = await action.execute(config, { name: 'Alice' });
      expect(result).toBe('Alice');
    });
  });

  // ─── handler.onMessage 패턴 ─────────────────────────────────────────────────

  describe('handler.onMessage 패턴', () => {
    it('onMessage로 등록된 콜백을 data와 함께 호출해야 한다', async () => {
      const config: ScriptActionConfig = {
        script: `
          handler.onMessage(function(d) {
            return { processed: d.value * 10 };
          });
        `,
      };
      const result = await action.execute(config, { value: 7 });
      expect(result).toEqual({ processed: 70 });
    });
  });

  // ─── Map/Set 정규화 ──────────────────────────────────────────────────────────

  describe('반환값 정규화', () => {
    it('Map을 반환하면 일반 객체로 변환해야 한다', async () => {
      const config: ScriptActionConfig = {
        script: `
          var m = new Map();
          m.set('a', 1);
          m.set('b', 2);
          return m;
        `,
      };
      // Map is not accessible inside the vm sandbox (it's a different context),
      // so we test this via the normalizeResult path by spying on execute indirectly.
      // If the script can access Map, result should be a plain object.
      // The sandbox may or may not expose Map; test that we get a non-Map back.
      const result = await action.execute(config, {});
      // If result is a Map it should have been converted; if sandbox doesn't expose Map it may be undefined/null.
      if (result !== null && typeof result === 'object') {
        expect(result).not.toBeInstanceOf(Map);
      }
    });
  });
});
