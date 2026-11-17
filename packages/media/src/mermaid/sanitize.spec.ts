import mermaid from 'mermaid';
import { describe, expect, it } from 'vitest';
import {
  detectMermaidDiagramType,
  getMermaidStructuralError,
  sanitizeMermaidCode,
} from './sanitize';

const onlineSequence = `sequenceDiagram
    participant A as 语义指纹生成器
    participant B as 接收模块
    participant C as 查询模块
    participant D as 更新模块
    participant E as 插入模块
    participant F as 淘汰模块
    participant G as 下游输出接口
    A->>B: 语义指纹fp 原文text_raw 嵌入向量emb
    B->>C: 传递语义指纹fp查询
    alt 查询命中
        C-->>D: 返回命中条目引用
        D->>D: 更新引用计数 最后访问时间 嵌入统计
        D-->>G: 输出规范文本和替换索引
        D->>F: 条目变更事件
    else 查询未命中
        C-->>E: 返回未命中状态
        E->>C: insert新条目
        E-->>G: 输出新替换索引和规范文本
        E->>F: 条目变更事件
    end
    F->>C: delete淘汰条目
    F-->>G: 引用失效信号`;

const parserCorpus = [
  onlineSequence,
  'flowchart TD\n  subgraph 双参数采集单元(1)\n    A[扭矩传感器(1-1)] -->|序列P("x,y")| B[输出]\n  end',
  'stateDiagram-v2\n  [*] --> Ready\n  Ready --> [*]',
  'classDiagram\n  class Codec\n  Codec : +compress()',
  'erDiagram\n  CODEBOOK ||--o{ ENTRY : contains',
];

describe('sanitizeMermaidCode', () => {
  it('escapes a prose semicolon in a sequence message instead of starting another statement', async () => {
    const source = 'sequenceDiagram\nM->>SG: Retain journal record; no deletion authority\nR->>R: Consult durable identity state';
    const normalized = sanitizeMermaidCode(source);
    expect(normalized).toContain('Retain journal record#59; no deletion authority');
    await expect(mermaid.parse(normalized)).resolves.toMatchObject({ diagramType: 'sequence' });
    expect(sanitizeMermaidCode(normalized)).toBe(normalized);
  });

  it('preserves inline sequence statements and already encoded label entities', async () => {
    const source = 'sequenceDiagram\nA->>B: first; B->>A: second\nA->>B: keep#59; preserve #amp; copy';
    const normalized = sanitizeMermaidCode(source);
    expect(normalized).toContain('first; B->>A: second');
    expect(normalized).toContain('keep#59; preserve #amp; copy');
    await expect(mermaid.parse(normalized)).resolves.toMatchObject({ diagramType: 'sequence' });
  });

  it('renders escaped line breaks in sequence text without rewriting identifiers or TeX escapes', () => {
    const normalized = sanitizeMermaidCode('sequenceDiagram\nS-->>G: 커밋 ACK\\ngatewayId, bootEpoch\nA->>B: $$\\nu$$\nA->>B: literal \\\\n');
    expect(normalized).toContain('커밋 ACK<br/>gatewayId, bootEpoch');
    expect(normalized).toContain('$$\\nu$$');
    expect(normalized).toContain('literal \\\\n');
    expect(sanitizeMermaidCode(normalized)).toBe(normalized);
  });

  it('renames actors whose ids are sequence keywords and keeps their displayed names', async () => {
    // Shape of a production figure: an "OPT" actor made every export of the draft fail.
    const source = [
      '%%{init: {\'theme\': \'neutral\'}}%%',
      'sequenceDiagram',
      '    participant OPT as 15d 寻优模块',
      '    participant MOD as 15a 建模模块',
      '    participant Loop',
      '    OPT->>MOD: 提交候选',
      '    MOD-->>OPT: 返回可行性',
      '    MOD->>+Loop: 激活',
      '    loop 按路径执行',
      '        Loop-->>-OPT: 反馈',
      '        break 状态异常',
      '            OPT->>OPT: 停止',
      '        end',
      '    end',
      '    Note over OPT,MOD: 慢环许可',
      '    activate OPT',
      '    deactivate OPT',
    ].join('\n');
    await expect(mermaid.parse(source)).rejects.toThrow();
    const sanitized = sanitizeMermaidCode(source);
    expect(sanitized).toContain('participant OPT_ as 15d 寻优模块');
    expect(sanitized).toContain('participant Loop_ as Loop');
    expect(sanitized).toContain('MOD-->>OPT_: 返回可行性');
    expect(sanitized).toContain('Loop_-->>-OPT_: 反馈');
    expect(sanitized).toContain('Note over OPT_,MOD: 慢环许可');
    expect(sanitized).toContain('loop 按路径执行');
    expect(sanitized).toContain('deactivate OPT_');
    await expect(mermaid.parse(sanitized)).resolves.toMatchObject({ diagramType: 'sequence' });
    expect(sanitizeMermaidCode(sanitized)).toBe(sanitized);
  });

  it.each(['opt', 'LOOP', 'Alt', 'end', 'par', 'and', 'break', 'critical', 'rect', 'box', 'note'])(
    'parses a message to an actor named %s', async (id) => {
      const sanitized = sanitizeMermaidCode(`sequenceDiagram\n    participant A\n    participant ${id}\n    A->>${id}: x\n    ${id}-->>A: y`);
      await expect(mermaid.parse(sanitized)).resolves.toMatchObject({ diagramType: 'sequence' });
    });

  it('preserves sequence alt/else/end and terminates the source', () => {
    const sanitized = sanitizeMermaidCode(onlineSequence);
    expect(sanitized).toContain('\n    end\n    F->>C');
    expect(sanitized.endsWith('\n')).toBe(true);
  });

  it('normalizes flowchart labels and balances subgraphs', () => {
    const sanitized = sanitizeMermaidCode(
      'flowchart TD\n  subgraph 采集(1)\n    A[传感器(1-1)] -->|P("x,y")| B[输出]',
    );
    expect(sanitized).toContain('subgraph "采集(1)"');
    expect(sanitized).toContain('A["传感器(1-1)"]');
    expect(sanitized).toContain('|"P(\'x,y\')"|');
    expect(sanitized.endsWith('\nend')).toBe(true);
  });

  it('keeps already safe subgraph forms stable', () => {
    const sanitized = sanitizeMermaidCode(
      'flowchart TD\n  subgraph "已引号(1)"\n  end\n  subgraph safe_id\n  end\n  subgraph sg[控制单元(2)]\n  end',
    );
    expect(sanitized).toContain('subgraph "已引号(1)"');
    expect(sanitized).toContain('subgraph safe_id');
    expect(sanitized).toContain('subgraph sg["控制单元(2)"]');
  });

  it('normalizes every edge label without treating node pipes as edges', () => {
    const sanitized = sanitizeMermaidCode('flowchart LR\n  A[输入 | 输出] -->|x(1)| B -->|y(2)| C');
    expect(sanitized).toContain('A["输入 | 输出"]');
    expect(sanitized).toContain('|"x(1)"|');
    expect(sanitized).toContain('|"y(2)"|');
  });

  it('drops sequence-only statements and unmatched end only in flowcharts', () => {
    const sanitized = sanitizeMermaidCode(
      'flowchart TD\n  participant A as 错误参与者\n  A[开始] --> B[结束]\n  end',
    );
    expect(sanitized).not.toContain('participant');
    expect(sanitized.match(/^\s*end\s*$/gm)).toBeNull();
  });

  it('normalizes common full-width connection symbols', () => {
    expect(sanitizeMermaidCode('flowchart TD\n  A－－>B：结果')).toContain('A-->B:结果');
  });

  it('unwraps complete Markdown fences before sanitizing', () => {
    expect(sanitizeMermaidCode('```mermaid\nflowchart TD\n  A[输入] --> B[输出]\n```')).toBe(
      'flowchart TD\n  A["输入"] --> B["输出"]',
    );
  });

  it('does not remove end statements from non-flowchart diagrams', () => {
    const code = 'sequenceDiagram\n  alt yes\n    A->>B: ok\n  end';
    const sanitized = sanitizeMermaidCode(code);
    expect(sanitized.match(/^\s*end\s*$/gm)).toHaveLength(1);
  });

  it('is idempotent across the regression corpus', () => {
    for (const code of parserCorpus) {
      const once = sanitizeMermaidCode(code);
      expect(sanitizeMermaidCode(once)).toBe(once);
      expect(detectMermaidDiagramType(once)).toBe(detectMermaidDiagramType(code));
    }
  });

  it('detects the stable diagram family', () => {
    expect(detectMermaidDiagramType(onlineSequence)).toBe('sequence');
    expect(detectMermaidDiagramType('flowchart LR\nA-->B')).toBe('flowchart');
    expect(detectMermaidDiagramType('stateDiagram-v2\nA-->B')).toBe('state');
    expect(detectMermaidDiagramType('mindmap\n  root((Document))')).toBe('mindmap');
    expect(detectMermaidDiagramType('block-beta\n  columns 1')).toBe('block');
    expect(detectMermaidDiagramType('architecture-beta\n  service api(server)')).toBe(
      'architecture',
    );
  });

  it('accepts supported non-structural diagram families', () => {
    expect(getMermaidStructuralError('gantt\n  title Plan')).toBeNull();
    expect(getMermaidStructuralError('pie\n  "A" : 1')).toBeNull();
    expect(getMermaidStructuralError('mindmap\n  root((Document))')).toBeNull();
    expect(getMermaidStructuralError('timeline\n  title History')).toBeNull();
    expect(getMermaidStructuralError('block-beta\n  columns 1')).toBeNull();
    expect(getMermaidStructuralError('architecture-beta\n  service api(server)[API]')).toBeNull();
  });

  it('detects missing and extra sequence block terminators', () => {
    expect(getMermaidStructuralError('sequenceDiagram\n  alt missing\n    A->>B: request')).toBe(
      'sequenceDiagram 缺少 1 个 end',
    );
    expect(getMermaidStructuralError('sequenceDiagram\n  end')).toBe(
      'sequenceDiagram 存在多余的 end',
    );
    expect(getMermaidStructuralError(onlineSequence)).toBeNull();
  });

  it.each(parserCorpus)('passes the pinned real Mermaid parser', async (code) => {
    await expect(mermaid.parse(sanitizeMermaidCode(code))).resolves.toBeDefined();
  });
});
