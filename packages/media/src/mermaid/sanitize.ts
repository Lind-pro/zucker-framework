type ShapeToken = {
  open: string;
  close: string;
};

type DelimiterCounts = {
  square: number;
  round: number;
  curly: number;
};

export type MermaidDiagramType =
  | 'flowchart'
  | 'sequence'
  | 'state'
  | 'class'
  | 'er'
  | 'gantt'
  | 'pie'
  | 'mindmap'
  | 'timeline'
  | 'block'
  | 'architecture'
  | 'other';

const SHAPE_TOKENS: ShapeToken[] = [
  { open: '([', close: '])' },
  { open: '[(', close: ')]' },
  { open: '[[', close: ']]' },
  { open: '((', close: '))' },
  { open: '{{', close: '}}' },
  { open: '[', close: ']' },
  { open: '(', close: ')' },
  { open: '{', close: '}' },
];

const SEQUENCE_ONLY_LINE =
  /^\s*(note\s+(over|left of|right of)\b|participant\b|activate\b|deactivate\b|loop\b|alt\b|opt\b|par\b|autonumber\b)/i;

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_-]/.test(char);
}

function isBoundaryChar(char: string | undefined): boolean {
  return !char || /[\s\-=:;,.|&>#]/.test(char);
}

function createDelimiterCounts(token: string): DelimiterCounts {
  const counts: DelimiterCounts = { square: 0, round: 0, curly: 0 };
  for (const char of token) {
    if (char === '[') counts.square += 1;
    if (char === '(') counts.round += 1;
    if (char === '{') counts.curly += 1;
  }
  return counts;
}

function applyDelimiterChar(counts: DelimiterCounts, char: string): void {
  if (char === '[') counts.square += 1;
  if (char === ']') counts.square -= 1;
  if (char === '(') counts.round += 1;
  if (char === ')') counts.round -= 1;
  if (char === '{') counts.curly += 1;
  if (char === '}') counts.curly -= 1;
}

function isFullyClosed(counts: DelimiterCounts): boolean {
  return counts.square === 0 && counts.round === 0 && counts.curly === 0;
}

function findShapeCloseStart(line: string, contentStart: number, shape: ShapeToken): number {
  const counts = createDelimiterCounts(shape.open);

  for (let index = contentStart; index < line.length; index += 1) {
    applyDelimiterChar(counts, line[index]);
    if (!isFullyClosed(counts)) continue;

    const closeStart = index - shape.close.length + 1;
    if (closeStart < contentStart) continue;
    if (isBoundaryChar(line[index + 1])) return closeStart;
  }

  return -1;
}

function normalizeLabel(label: string): string {
  const trimmed = label.trim().replace(/\r?\n+/g, ' ');
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
      ? trimmed.slice(1, -1)
      : trimmed;
  return `"${unquoted.replace(/"/g, "'")}"`;
}

function normalizeFlowchartLine(line: string): string {
  let result = '';
  let index = 0;

  while (index < line.length) {
    const current = line[index];

    if (current === '|') {
      const close = line.indexOf('|', index + 1);
      if (close === -1) {
        result += current;
        index += 1;
        continue;
      }
      result += `|${normalizeLabel(line.slice(index + 1, close))}|`;
      index = close + 1;
      continue;
    }

    if (!isIdentifierStart(current)) {
      result += current;
      index += 1;
      continue;
    }

    if (index > 0 && isIdentifierChar(line[index - 1])) {
      result += current;
      index += 1;
      continue;
    }

    let idEnd = index + 1;
    while (idEnd < line.length && isIdentifierChar(line[idEnd])) idEnd += 1;

    const nodeId = line.slice(index, idEnd);
    const shape = SHAPE_TOKENS.find((token) => line.startsWith(token.open, idEnd));
    if (!shape) {
      result += nodeId;
      index = idEnd;
      continue;
    }

    const contentStart = idEnd + shape.open.length;
    const closeStart = findShapeCloseStart(line, contentStart, shape);
    if (closeStart === -1) {
      result += nodeId;
      index = idEnd;
      continue;
    }

    const label = line.slice(contentStart, closeStart);
    result += `${nodeId}${shape.open}${normalizeLabel(label)}${shape.close}`;
    index = closeStart + shape.close.length;
  }

  return result;
}

function normalizeSubgraphLine(line: string): string {
  const match = /^(\s*)subgraph[ \t]+(.*\S)\s*$/i.exec(line);
  if (!match) return line;
  const [, indent, rawTitle] = match;
  const title = rawTitle.trim();
  if (/^".*"$/.test(title)) return line;
  const bracket = /^([A-Za-z0-9_-]+)\[(.*)\]$/.exec(title);
  if (bracket) {
    const [, id, label] = bracket;
    return `${indent}subgraph ${id}[${normalizeLabel(label)}]`;
  }
  if (/^[A-Za-z0-9_-]+$/.test(title)) return line;
  return `${indent}subgraph ${normalizeLabel(title)}`;
}

function normalizeCommonSymbols(line: string): string {
  return line.replace(/：/g, ':').replace(/－－>/g, '-->').replace(/—>/g, '-->');
}

function normalizeSequenceLine(line: string): string {
  const message = /^(\s*[A-Za-z_][A-Za-z0-9_-]*?\s*(?:-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?[A-Za-z_][A-Za-z0-9_-]*\s*:\s*)(.*)$/u.exec(line);
  if (!message) return line;
  const [, prefix, text] = message;
  // A semicolon before another sequence statement is syntax, not label text.
  if (/;\s*(?:[A-Za-z_][A-Za-z0-9_-]*?\s*(?:-->>|->>|-->|->|--x|-x|--\)|-\))|(?:participant|actor|note|alt|else|loop|opt|par|and|end)\b)/iu.test(text)) return line;
  const escaped = text.replace(/#(?:\d+|[A-Za-z]+);|&(?:#\d+|#x[\da-f]+|[A-Za-z]+);|;/giu, (token, offset: number) => {
    if (token !== ';' || !text.slice(offset + 1).trim()) return token;
    return '#59;';
  });
  // Mermaid sequence labels use <br/> rather than the \n convention used by
  // generated labels. Keep escaped backslashes and TeX commands literal.
  const displayText = escaped.includes('$$') ? escaped : escaped.replace(/(?<!\\)\\n/gu, '<br/>');
  return prefix + displayText;
}

// Sequence keywords Mermaid's lexer matches case-insensitively, even where an
// actor id is expected: `A->>OPT: x` lexes OPT as the `opt` block and fails.
const SEQUENCE_KEYWORDS = new Set([
  'participant', 'actor', 'create', 'destroy', 'box', 'loop', 'rect', 'opt', 'alt', 'else', 'par', 'and',
  'critical', 'option', 'break', 'end', 'note', 'over', 'activate', 'deactivate', 'autonumber', 'title',
  'links', 'link', 'properties', 'details', 'off',
]);
const SEQUENCE_ID = '[A-Za-z_][A-Za-z0-9_-]*';
const SEQUENCE_ARROW = '(?:-->>|->>|-->|->|--x|-x|--\\)|-\\))';
const SEQUENCE_DECLARATION = new RegExp(`^(\\s*(?:create\\s+)?(?:participant|actor)\\s+)(${SEQUENCE_ID})(\\s+as\\s+.*)?\\s*$`, 'iu');
const SEQUENCE_MESSAGE = new RegExp(`^(\\s*)(${SEQUENCE_ID}?)(\\s*${SEQUENCE_ARROW}\\s*[+-]?)(${SEQUENCE_ID})(\\s*:.*)$`, 'u');
const SEQUENCE_NOTE = /^(\s*note\s+(?:over|left\s+of|right\s+of)\s+)([^:]+)(:.*)$/iu;
const SEQUENCE_TARGET = new RegExp(`^(\\s*(?:activate|deactivate|destroy)\\s+)(${SEQUENCE_ID})(\\s*)$`, 'iu');

/**
 * Give actors named like a sequence keyword (OPT, LOOP, END...) a safe id.
 * The displayed name is kept, so the rendered figure does not change.
 */
function renameKeywordSequenceActors(lines: string[]): string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    const declared = SEQUENCE_DECLARATION.exec(line);
    if (declared) ids.add(declared[2]);
    const message = SEQUENCE_MESSAGE.exec(line);
    if (message) { ids.add(message[2]); ids.add(message[4]); }
  }
  const renamed = new Map<string, string>();
  for (const id of ids) {
    if (!SEQUENCE_KEYWORDS.has(id.toLowerCase())) continue;
    let safe = `${id}_`;
    while (ids.has(safe) || [...renamed.values()].includes(safe)) safe += '_';
    renamed.set(id, safe);
  }
  if (!renamed.size) return lines;
  const rename = (id: string) => renamed.get(id) ?? id;
  return lines.map((line) => {
    const declared = SEQUENCE_DECLARATION.exec(line);
    if (declared) {
      const [, head, id, alias] = declared;
      return renamed.has(id) ? `${head}${rename(id)}${alias ?? ` as ${id}`}` : line;
    }
    const message = SEQUENCE_MESSAGE.exec(line);
    if (message) {
      const [, indent, from, arrow, to, rest] = message;
      return `${indent}${rename(from)}${arrow}${rename(to)}${rest}`;
    }
    const note = SEQUENCE_NOTE.exec(line);
    if (note) {
      const [, head, targets, rest] = note;
      return `${head}${targets.split(',').map((part) => part.replace(/^(\s*)(\S+)(\s*)$/u, (_, before: string, id: string, after: string) => `${before}${rename(id)}${after}`)).join(',')}${rest}`;
    }
    const target = SEQUENCE_TARGET.exec(line);
    return target ? `${target[1]}${rename(target[2])}${target[3]}` : line;
  });
}

function unwrapMermaidFence(code: string): string {
  const trimmed = code.trim();
  const fenced = /^```(?:mermaid)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : code;
}

export function detectMermaidDiagramType(code: string): MermaidDiagramType {
  const firstMeaningful = code
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('%%'));
  const keyword = firstMeaningful?.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (keyword === 'flowchart' || keyword === 'graph') return 'flowchart';
  if (keyword === 'sequencediagram') return 'sequence';
  if (keyword === 'statediagram' || keyword === 'statediagram-v2') return 'state';
  if (keyword === 'classdiagram') return 'class';
  if (keyword === 'erdiagram') return 'er';
  if (keyword === 'gantt') return 'gantt';
  if (keyword === 'pie') return 'pie';
  if (keyword === 'mindmap') return 'mindmap';
  if (keyword === 'timeline') return 'timeline';
  if (keyword === 'block-beta') return 'block';
  if (keyword === 'architecture-beta') return 'architecture';
  return 'other';
}

export function sanitizeMermaidCode(code: string): string {
  if (typeof code !== 'string' || code.trim() === '') return code;

  const source = unwrapMermaidFence(code);
  const diagramType = detectMermaidDiagramType(source);
  const lines = source.split('\n').map(normalizeCommonSymbols);

  if (diagramType !== 'flowchart') {
    const sanitized = (diagramType === 'sequence' ? renameKeywordSequenceActors(lines).map(normalizeSequenceLine) : lines).join('\n');
    return diagramType === 'sequence' ? `${sanitized.trimEnd()}\n` : sanitized;
  }

  const result: string[] = [];
  let subgraphDepth = 0;
  for (const line of lines) {
    if (SEQUENCE_ONLY_LINE.test(line)) continue;
    if (/^\s*subgraph\b/i.test(line)) {
      subgraphDepth += 1;
      result.push(normalizeSubgraphLine(line));
      continue;
    }
    if (/^\s*end\s*$/i.test(line)) {
      if (subgraphDepth > 0) {
        subgraphDepth -= 1;
        result.push(line);
      }
      continue;
    }
    result.push(normalizeFlowchartLine(line));
  }

  while (subgraphDepth > 0) {
    result.push('end');
    subgraphDepth -= 1;
  }
  return result.join('\n');
}

export function getMermaidStructuralError(code: string): string | null {
  const sanitized = sanitizeMermaidCode(code);
  const diagramType = detectMermaidDiagramType(sanitized);
  if (diagramType === 'other') return '无法识别 Mermaid 图表类型';
  if (diagramType !== 'sequence') return null;

  const blockStack: string[] = [];
  const blockStart = /^(alt|opt|loop|par|critical|break|rect)\b/i;
  for (const rawLine of sanitized.split('\n')) {
    const line = rawLine.trim();
    const start = blockStart.exec(line)?.[1];
    if (start) {
      blockStack.push(start.toLowerCase());
      continue;
    }
    if (/^end\s*$/i.test(line)) {
      if (blockStack.length === 0) return 'sequenceDiagram 存在多余的 end';
      blockStack.pop();
    }
  }
  if (blockStack.length > 0) {
    return `sequenceDiagram 缺少 ${blockStack.length} 个 end`;
  }
  return null;
}
