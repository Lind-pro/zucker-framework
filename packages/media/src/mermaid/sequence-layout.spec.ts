import { describe, expect, it } from 'vitest';
import { prepareSequenceLayout } from './sequence-layout';

describe('sequence print layout', () => {
  it('wraps Japanese names and messages without inserting hyphens or changing text', () => {
    const source =
      'sequenceDiagram\nparticipant A as 14 集約ウィンドウ管理部\nA->>B: イベント時刻30秒、イベントシーケンス番号3を送信\n';
    const output = prepareSequenceLayout(source);
    expect(output).toContain('<br/>');
    expect(output.replaceAll('<br/>', '').replace(/\s/gu, '')).toBe(source.replace(/\s/gu, ''));
    expect(output).not.toContain('-<br/>');
  });

  it('keeps manual breaks, entities, long Latin identifiers and unsupported syntax intact', () => {
    const source =
      'sequenceDiagram\nparticipant A as VeryLongRegisteredIdentifier\nA->>B: 入力<br/>出力 &amp; ACK\nA->>B: 確認済みレコード#59; 保持する\nNote over A: <b>説明文</b>\nA->>B: <b>別の説明文</b>\n';
    const output = prepareSequenceLayout(source);
    expect(output).toContain('VeryLongRegisteredIdentifier');
    expect(output).toContain('&amp;');
    expect(output).toContain('#59;');
    expect(output).toContain('Note over A: <b>説明文</b>');
    expect(output).toContain('A->>B: <b>別の説明文</b>');
    expect(prepareSequenceLayout(output)).toBe(output);
  });

  it('does not create whitespace-only measurement fragments when Mermaid wraps Korean messages again', () => {
    const source = [
      'sequenceDiagram',
      'A->>B: 센서 레코드 영속 로그 기록',
      'A->>B: 수신한 연속 커밋 워터마크 영속 기록',
      'A->>B: 동일한 bootEpoch의 워터마크 이하 로그 정리',
    ].join('\n');
    const output = prepareSequenceLayout(source);
    expect(output).toContain('<br/>');
    expect(output.replaceAll('<br/>', '').replace(/\s/gu, '')).toBe(source.replace(/\s/gu, ''));
    for (const line of output.split('\n').slice(1)) {
      // Mermaid wrapLabel splits on spaces before measuring each word's <br/> lines.
      const words = line.slice(line.indexOf(':') + 1).trim().split(/\s+/u);
      for (const word of words) {
        expect(word.split('<br/>').every(fragment => fragment.trim().length > 0)).toBe(true);
      }
    }
    expect(prepareSequenceLayout(output)).toBe(output);
  });

  it('wraps English aliases, self-messages and alternative conditions at word separators', () => {
    const source = [
      'sequenceDiagram',
      'participant R as Receiver identity deduplication and durable commitment module',
      'R->>R: Durably commit event and deduplication identity',
      'alt Event identity tuple already durably committed',
      'R->>R: Prevent duplicate logical processing',
      'else Event identity tuple new or not yet durably committed',
      'R->>R: Perform event handling path',
      'end',
    ].join('\n');
    const output = prepareSequenceLayout(source);
    expect(output).toContain('Receiver<br/>identity');
    expect(output).toContain('alt Event identity<br/>tuple already');
    expect(output).toContain('R->>R: Durably commit<br/>event and');
    expect(output).not.toMatch(/\s<br\/>|<br\/>\s/u);
    expect(output.replaceAll('<br/>', '').replace(/\s/gu, '')).toBe(source.replace(/\s/gu, ''));
    expect(prepareSequenceLayout(output)).toBe(output);
  });
});
