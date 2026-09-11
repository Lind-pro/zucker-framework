import { describe, expect, it } from 'vitest';
import { stripNullBytes, deepStripNullBytes } from './null-byte-sanitizer';

const NUL = String.fromCharCode(0);

describe('sanitize-text.util', () => {
  describe('stripNullBytes', () => {
    it('剥离 NUL 字符', () => {
      expect(stripNullBytes(`a${NUL}b${NUL}c`)).toBe('abc');
    });

    it('保留 \\n \\t 等合法控制字符', () => {
      expect(stripNullBytes('line1\nline2\tend')).toBe('line1\nline2\tend');
    });

    it('无 NUL 时原样返回（不分配新串）', () => {
      const s = '正常文本';
      expect(stripNullBytes(s)).toBe(s);
    });
  });

  describe('deepStripNullBytes', () => {
    it('递归清洗嵌套对象/数组中的字符串', () => {
      const input = {
        title: `标题${NUL}`,
        drawings: [{ mermaidCode: `flowchart${NUL} TD` }, { mermaidCode: 'clean' }],
        meta: { note: `n${NUL}ote` },
      };
      const out = deepStripNullBytes(input);
      expect(out.title).toBe('标题');
      expect(out.drawings[0].mermaidCode).toBe('flowchart TD');
      expect(out.drawings[1].mermaidCode).toBe('clean');
      expect(out.meta.note).toBe('note');
    });

    it('非字符串/对象值原样返回', () => {
      expect(deepStripNullBytes(42)).toBe(42);
      expect(deepStripNullBytes(null)).toBeNull();
      expect(deepStripNullBytes(true)).toBe(true);
    });
  });
});
