import { describe, expect, it } from 'vitest';
import { prepareSequenceLayout } from './sequence-layout';

describe('sequence print layout', () => {
  it('wraps Japanese names and messages without inserting hyphens or changing text', () => {
    const source =
      'sequenceDiagram\nparticipant A as 14 集約ウィンドウ管理部\nA->>B: イベント時刻30秒、イベントシーケンス番号3を送信\n';
    const output = prepareSequenceLayout(source);
    expect(output).toContain('<br/>');
    expect(output.replaceAll('<br/>', '')).toBe(source);
    expect(output).not.toContain('-<br/>');
  });

  it('keeps manual breaks, entities, long Latin identifiers and unsupported syntax intact', () => {
    const source =
      'sequenceDiagram\nparticipant A as VeryLongRegisteredIdentifier\nA->>B: 入力<br/>出力 &amp; ACK\nNote over A: <b>説明文</b>\nA->>B: <b>別の説明文</b>\n';
    const output = prepareSequenceLayout(source);
    expect(output).toContain('VeryLongRegisteredIdentifier');
    expect(output).toContain('&amp;');
    expect(output).toContain('Note over A: <b>説明文</b>');
    expect(output).toContain('A->>B: <b>別の説明文</b>');
    expect(prepareSequenceLayout(output)).toBe(output);
  });
});
