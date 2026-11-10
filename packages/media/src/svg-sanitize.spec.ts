import { describe, expect, it } from 'vitest';
import { sanitizeSvgMarkup } from './svg-sanitize';

describe('sanitizeSvgMarkup allow-list', () => {
  it('neutralizes known regex bypasses', () => {
    expect(sanitizeSvgMarkup('<svg/onload=alert(1)>')).toBeNull();
    expect(
      sanitizeSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"onclick="alert(1)"/></svg>'),
    ).toBe('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>');
    expect(sanitizeSvgMarkup('<svg><a href="&#106;avascript:alert(1)"><text>x</text></a></svg>'))
      .toBe('<svg><a><text>x</text></a></svg>');
    expect(sanitizeSvgMarkup('<svg><a href="java\tscript:alert(1)"><text>x</text></a></svg>'))
      .toBe('<svg><a><text>x</text></a></svg>');
    expect(sanitizeSvgMarkup('<svg><a xlink:href="java&#x09;script:x">y</a></svg>')).toBe('<svg><a>y</a></svg>');
    expect(
      sanitizeSvgMarkup('<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>'),
    ).toBe('<svg><a><text>x</text></a></svg>');
    expect(sanitizeSvgMarkup('<svg><set attributeName="onclick" to="alert(1)"/></svg>')).toBe('<svg></svg>');
  });

  it('removes external references', () => {
    expect(sanitizeSvgMarkup('<svg><image href="http://169.254.169.254/latest/meta-data/"/></svg>'))
      .toBe('<svg><image/></svg>');
    expect(sanitizeSvgMarkup('<svg><style>@import url(http://evil/x.css);</style><path/></svg>'))
      .toBe('<svg><path/></svg>');
    expect(sanitizeSvgMarkup('<svg><style>p{fill:\\75 rl(http://evil/x)}</style></svg>')).toBe('<svg></svg>');
    expect(sanitizeSvgMarkup('<svg><use href="data:image/svg+xml;base64,AAAA#x"/></svg>')).toBe('<svg><use/></svg>');
    expect(sanitizeSvgMarkup('<svg><rect style="fill:url(https://evil/x)" fill="url(#g)"/></svg>'))
      .toBe('<svg><rect fill="url(#g)"/></svg>');
  });

  it('keeps ordinary diagram markup', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" class="flowchart" role="graphics-document document" aria-roledescription="flowchart-v2">' +
      '<style>#m .node rect{fill:#eee;stroke:#333;} .a &gt; b{}</style>' +
      '<defs><marker id="arrow" refX="5" refY="5"><path d="M0,0L10,5"/></marker><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
      '<g transform="translate(1,1)" data-id="n1"><rect width="4" height="4" fill="url(#g)" marker-end="url(#arrow)"/>' +
      '<text x="1" y="2"><tspan dy="1">A &amp;#40; B</tspan></text><use xlink:href="#arrow"/>' +
      '<image href="data:image/png;base64,iVBORw0KGgo="/></g></svg>';
    expect(sanitizeSvgMarkup(svg)).toBe(svg);
  });

  it('drops unknown and metadata subtrees and refuses oversize input', () => {
    expect(sanitizeSvgMarkup('<svg><metadata><rdf:RDF><cc:Work/></rdf:RDF></metadata><path/></svg>'))
      .toBe('<svg><path/></svg>');
    expect(sanitizeSvgMarkup('<svg><foreignObject><div onclick="x">hi</div></foreignObject></svg>')).toBe('<svg></svg>');
    expect(sanitizeSvgMarkup('<svg><path/></svg>', { maxLength: 5 })).toBeNull();
    expect(sanitizeSvgMarkup('<svg></svg><script/>')).toBeNull();
  });

  it('runs in linear time on adversarial input', () => {
    for (const unit of ['<script', '<!--', '<a x="', '<g>', '</g>', 'aaaa']) {
      const input = `<svg>${unit.repeat(Math.ceil(300_000 / unit.length))}</svg>`;
      const started = performance.now();
      sanitizeSvgMarkup(input);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });
});
