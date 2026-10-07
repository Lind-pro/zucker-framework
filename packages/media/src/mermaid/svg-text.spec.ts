import { describe, expect, it } from 'vitest';
import { normalizeMermaidSvgText } from './svg-text';

function parse(svg: string) {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(document.querySelector('parsererror')).toBeNull();
  return document;
}

describe('Mermaid SVG text entity normalization', () => {
  it('shows escaped function parentheses, ampersands and comparisons as the intended text', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><text><tspan>clip&amp;#40;k&amp;#40;H*-H&amp;#41;,a,b&amp;#41; &amp;#38; x &amp;#60; 2</tspan><tspan> &#40;plain&#41; &amp; &lt; &amp;#x03A3;</tspan></text></svg>';
    const result = normalizeMermaidSvgText(source);
    expect(parse(result).querySelector('text')?.textContent).toBe('clip(k(H*-H),a,b) & x < 2 (plain) & < Σ');
    expect(result).toContain('&#60;');
    expect(result).not.toContain('&amp;#40;');
    expect(normalizeMermaidSvgText(result)).toBe(result);
  });

  it('keeps encoded markup as inert text and removes actual executable SVG', () => {
    const result = normalizeMermaidSvgText('<svg xmlns="http://www.w3.org/2000/svg" onload="run()"><script>run()</script><foreignObject><div>bad</div></foreignObject><text><tspan>&amp;#60;script&amp;#62;run()&amp;#60;/script&amp;#62;</tspan><tspan>&amp;#60;image &amp;#111;nload=run() /&amp;#62;</tspan></text><a href="javascript:run()"><text>link</text></a></svg>');
    const document = parse(result);
    expect(document.querySelector('script, foreignObject, image, [onload], [href]')).toBeNull();
    expect(document.querySelector('text')?.textContent).toBe('<script>run()</script><image onload=run() />');
  });

  it('restores references split by Mermaid line wrapping without replacing tspans', () => {
    const source = '<svg><text><tspan x="0">clip&amp;#</tspan><tspan x="0" dy="1em">40;x,a&amp;#41</tspan><tspan x="0" dy="2em">; &amp;#60; y</tspan></text></svg>';
    const result = normalizeMermaidSvgText(source);
    const document = parse(result);
    expect(document.querySelector('text')?.textContent).toBe('clip(x,a) < y');
    expect([...document.querySelectorAll('tspan')].map((node) => node.getAttribute('dy'))).toEqual([null, '1em', '2em']);
    expect(normalizeMermaidSvgText(result)).toBe(result);
  });

  it('does not decode attributes, styles, or invalid XML code points', () => {
    const source = '<svg><style>.x { content:"&amp;#40;" }</style><text data-note="&amp;#60;" x="2"><style>.nested { content:"&amp;#40;" }</style>ok &amp;#0; &amp;#xD800; &amp;#1114112;</text><path id="&amp;#40;"/></svg>';
    const result = normalizeMermaidSvgText(source);
    expect(result).toBe(source);
    expect(parse(result).querySelector('text')?.getAttribute('data-note')).toBe('&#60;');
  });
});
