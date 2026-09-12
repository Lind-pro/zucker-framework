/** Add layout-only breaks without Mermaid's Western hyphenation of CJK names. */
function wrapSequenceLabel(label: string): string {
  if (label.includes('\\') || /[<>]/.test(label.replace(/<br\s*\/?\s*>/gi, ''))) return label;
  return label
    .split(/(<br\s*\/?\s*>)/gi)
    .map((part) => {
      if (/^<br/i.test(part)) return part;
      const tokens = part.match(/&(?:#\d+|#x[\da-f]+|[A-Za-z]+);|#(?:\d+|[A-Za-z]+);|[A-Za-z0-9_]+|[\s\S]/gu) ?? [];
      let width = 0;
      let line = '';
      const lines: string[] = [];
      for (const token of tokens) {
          const units = /^[&#].*;$/.test(token)
            ? 1
            : Array.from(token).reduce(
                (total, character) => total + (/[^\u0000-\u00ff]/.test(character) ? 2 : 1),
                0,
              );
          if (line.trim() && width + units > 16 && !/^\s/u.test(token)) {
            // A natural word separator becomes the visual line break. Keeping
            // that space beside <br/> creates zero-width fragments when Mermaid
            // measures a label again; forbidding the break prevents English wrap.
            lines.push(line.trim());
            line = '';
            width = 0;
          }
          line += token;
          width += units;
      }
      if (line.trim()) lines.push(line.trim());
      return lines.join('<br/>');
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
      const condition = /^(\s*(?:alt|else|loop|opt|par|and|critical|option|break)\s+)(.+)$/u.exec(line);
      const note = /^(\s*Note\s+(?:over|left of|right of)\s+[^:]+:\s*)(.+)$/iu.exec(line);
      const match = alias ?? message ?? condition ?? note;
      return match ? `${match[1]}${wrapSequenceLabel(match[2])}` : line;
    })
    .join('\n');
}
