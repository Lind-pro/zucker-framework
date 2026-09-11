/** Add layout-only breaks without Mermaid's Western hyphenation of CJK names. */
function wrapSequenceLabel(label: string): string {
  if (label.includes('\\') || /[<>]/.test(label.replace(/<br\s*\/?\s*>/gi, ''))) return label;
  return label
    .split(/(<br\s*\/?\s*>)/gi)
    .map((part) => {
      if (/^<br/i.test(part)) return part;
      const tokens = part.match(/&(?:#\d+|#x[\da-f]+|[A-Za-z]+);|[A-Za-z0-9_]+|[\s\S]/gu) ?? [];
      let width = 0;
      return tokens
        .map((token) => {
          const units = /^&.*;$/.test(token)
            ? 1
            : Array.from(token).reduce(
                (total, character) => total + (/[^\u0000-\u00ff]/.test(character) ? 2 : 1),
                0,
              );
          const newline = width > 0 && width + units > 16;
          width = (newline ? 0 : width) + units;
          return `${newline ? '<br/>' : ''}${token}`;
        })
        .join('');
    })
    .join('');
}

export function prepareSequenceLayout(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const alias = /^(\s*(?:participant|actor)\s+[A-Za-z_][A-Za-z0-9_-]*\s+as\s+)(.+)$/.exec(line);
      const message =
        /^(\s*[A-Za-z_][A-Za-z0-9_-]*?\s*(?:-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?[A-Za-z_][A-Za-z0-9_-]*\s*:\s*)(.+)$/.exec(
          line,
        );
      const match = alias ?? message;
      return match ? `${match[1]}${wrapSequenceLabel(match[2])}` : line;
    })
    .join('\n');
}
