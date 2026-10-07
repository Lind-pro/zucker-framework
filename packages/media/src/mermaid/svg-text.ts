import { sanitizeSvgMarkup } from '../svg-sanitize';

/** Restore Mermaid entity escapes in SVG text without interpreting them as markup. */
export function normalizeMermaidSvgText(source: string): string {
  const svg = sanitizeSvgMarkup(source);
  if (!svg) throw new Error('Mermaid returned invalid SVG markup');
  // With htmlLabels:false, Mermaid can serialize #40; as &amp;#40;.
  // Restore just that extra layer inside text/tspan character data. Keep the
  // numeric reference encoded so even #60;script#62; stays text, never a tag.
  // Attribute values, URLs, styles and non-text SVG elements are untouched.
  return svg.replace(
    /(<text\b(?:[^<>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/text\s*>)/gi,
    (_, open: string, body: string, close: string) => {
      // Mermaid wrapping may split an entity across adjacent tspans. Match the
      // character stream while retaining every tag and its layout attributes.
      const parts = body.split(/(<(?:[^<>"']|"[^"]*"|'[^']*')*>)/g);
      let offset = 0;
      let nonTextDepth = 0;
      const segments = parts.flatMap((part, index) => {
        if (index % 2) {
          const tag = /^<(\/?)([\w:-]+)/.exec(part);
          if (tag && tag[2].toLowerCase() !== 'tspan' && !/\/\s*>$/.test(part)) {
            nonTextDepth = Math.max(0, nonTextDepth + (tag[1] ? -1 : 1));
          }
          return [];
        }
        if (nonTextDepth > 0) return [];
        const start = offset;
        offset += part.length;
        return [{ index, start, end: offset }];
      });
      const text = segments.map(({ index }) => parts[index]).join('');
      for (const match of [...text.matchAll(/&amp;#(x[\da-f]+|\d+);/gi)].reverse()) {
        const code = match[1];
        const point = /^x/i.test(code) ? Number.parseInt(code.slice(1), 16) : Number(code);
        const validXml = point === 9 || point === 10 || point === 13 ||
          (point >= 0x20 && point <= 0xd7ff) ||
          (point >= 0xe000 && point <= 0xfffd) ||
          (point >= 0x10000 && point <= 0x10ffff);
        if (!validXml) continue;
        const start = match.index;
        const end = start + match[0].length;
        for (const segment of segments) {
          if (segment.end <= start || segment.start >= end) continue;
          const part = parts[segment.index];
          const from = Math.max(0, start - segment.start);
          const to = Math.min(segment.end, end) - segment.start;
          const replacement = start >= segment.start ? `&#${code};` : '';
          parts[segment.index] = part.slice(0, from) + replacement + part.slice(to);
        }
      }
      return open + parts.join('') + close;
    },
  );
}
