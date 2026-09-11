import { describe, expect, it } from 'vitest';
import { prepareStateLayout } from './state-layout';

describe('state diagram self-transition layout', () => {
  it('keeps every condition and action when parallel self transitions share an edge', () => {
    const source = [
      'stateDiagram-v2',
      '  [*] --> 未閉鎖',
      '  未閉鎖 --> 閉鎖済み: 水位線以前',
      '  閉鎖済み --> 閉鎖済み: 初期集約記録を一度だけ公開',
      '  閉鎖済み --> 閉鎖済み: 後着イベント／修正項目を追加',
      '  閉鎖済み --> 閉鎖済み: 再送イベント／重複排除',
      '  閉鎖済み --> 閉鎖済み: 修正再受信／再適用しない',
    ].join('\n');
    const result = prepareStateLayout(source);
    expect(result.hasSelfTransitions).toBe(true);
    expect(result.source.match(/閉鎖済み --> 閉鎖済み:/g)).toHaveLength(1);
    expect(result.source).toContain(
      '初期集約記録を一度だけ公開<br/>後着イベント／修正項目を追加<br/>再送イベント／重複排除<br/>修正再受信／再適用しない',
    );
    expect(result.source).toContain('未閉鎖 --> 閉鎖済み: 水位線以前');
  });

  it('keeps identically named states in different nested scopes separate', () => {
    const source =
      'stateDiagram-v2\nstate A {\nIdle --> Idle: first\n}\nstate B {\nIdle --> Idle: second\n}\n';
    expect(prepareStateLayout(source).source).toBe(source);
  });

  it('respects composite scope delimiters with trailing comments', () => {
    const source =
      'stateDiagram-v2\nstate First { %% first\nA --> A: first\n} %% close\nstate Second { %% second\nA --> A: second\n}\n';
    expect(prepareStateLayout(source).source).toBe(source);
  });

  it('keeps concurrent state regions separate', () => {
    const source = 'stateDiagram-v2\nstate Parent {\nA --> A: first\n--\nA --> A: second\n}\n';
    expect(prepareStateLayout(source).source).toBe(source);
  });

  it('never parses commands from within a multiline note', () => {
    const source =
      'stateDiagram-v2\nA --> A: real action\nnote right of A\nnote: explanation\nA --> A: quoted example\nend note\n';
    expect(prepareStateLayout(source).source).toBe(source);
  });

  it('does not append transition text after a Mermaid line comment', () => {
    const source = 'stateDiagram-v2\nA --> A: first %% comment\nA --> A: second\n';
    expect(prepareStateLayout(source).source).toBe(source);
  });

  it('does not interpret note text or start/end markers as duplicate states', () => {
    const source =
      'stateDiagram-v2\nnote right of A\nA --> A: quoted example\nend note\n[*] --> [*]: first\n[*] --> [*]: second\nA --> B: pass\n';
    expect(prepareStateLayout(source)).toEqual({ source, hasSelfTransitions: false });
  });

  it('is idempotent and preserves labels containing colons and manual line breaks', () => {
    const source = 'stateDiagram-v2\nA --> A: condition: first<br/>action\nA --> A: second';
    const result = prepareStateLayout(source);
    expect(prepareStateLayout(result.source)).toEqual(result);
    expect(result.source).toContain('condition: first<br/>action<br/>second');
  });
});
