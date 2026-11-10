import { parseFragment } from 'parse5';
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

describe('sanitizeSvgMarkup round-2 hardening', () => {
  it('rejects XML declarations that smuggle markup (A1)', () => {
    expect(sanitizeSvgMarkup('<?xml x="><img src=x onerror=alert(1)>" ?><svg/>')).toBeNull();
    expect(
      sanitizeSvgMarkup('<?xml ><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe> ?><svg/>'),
    ).toBeNull();
    expect(sanitizeSvgMarkup('<?xml version="1.0" foo="bar"?><svg/>')).toBeNull();
    expect(sanitizeSvgMarkup('<?xml?><svg/>')).toBeNull();
  });

  it('re-emits a fixed XML declaration instead of copying the input', () => {
    expect(sanitizeSvgMarkup('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<svg/>')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg/>',
    );
    const single = sanitizeSvgMarkup("<?xml version='1.0'?><svg/>");
    expect(single).not.toBeNull();
    expect(single).toContain('<svg/>');
    expect(single).not.toContain("'");
  });

  it('neutralizes named and unterminated character references (A2)', () => {
    const attr = sanitizeSvgMarkup('<svg><rect style="background:url&lpar;http://evil/x&rpar;"/></svg>');
    expect(attr).toContain('&amp;lpar;');
    expect(attr).not.toContain('url&lpar;');
    const noSemi = sanitizeSvgMarkup("<svg><style>svg{background:url&#40//evil/x&#41}&#64import '//evil/y.css';</style></svg>");
    expect(noSemi).toContain('&amp;#40');
    expect(noSemi).not.toMatch(/&#40(?!;)(?<!&amp;#40)/);
    const named = sanitizeSvgMarkup("<svg><style>&commat;import '//evil/y.css';</style></svg>");
    expect(named).toContain('&amp;commat;import');
  });

  it('removes image-set() and friends from attributes and style text', () => {
    expect(sanitizeSvgMarkup('<svg><rect style="background-image:image-set(\'http://e/x.png\' 1x)"/></svg>')).toBe(
      '<svg><rect/></svg>',
    );
    expect(sanitizeSvgMarkup('<svg><rect style="background:-webkit-image-set(\'http://e/x.png\' 1x)"/></svg>')).toBe(
      '<svg><rect/></svg>',
    );
    expect(sanitizeSvgMarkup('<svg><style>svg{background:image-set("http://e/y" 1x)}</style></svg>')).toBe('<svg></svg>');
    expect(sanitizeSvgMarkup('<svg><style>svg{background:-webkit-image-set("http://e/y" 1x)}</style></svg>')).toBe(
      '<svg></svg>',
    );
    for (const fn of ['image(', 'src(', 'cross-fade(', 'element(', 'paint(']) {
      expect(sanitizeSvgMarkup(`<svg><rect style="background:${fn}http://e/x)"/></svg>`)).toBe('<svg><rect/></svg>');
    }
  });

  it('still round-trips legitimate references', () => {
    const svg =
      '<svg><rect fill="url(#g)"/><style>.a &gt; b{}</style><text>A &amp;#40; B</text></svg>';
    expect(sanitizeSvgMarkup(svg)).toBe(svg);
  });

  it('drops elements nested inside title and desc but keeps their text', () => {
    expect(sanitizeSvgMarkup('<svg><title>a<image href="#"/>b</title></svg>')).toBe('<svg><title>ab</title></svg>');
    const desc = sanitizeSvgMarkup('<svg><desc>x<a href="#" style="y"/>z</desc></svg>');
    expect(desc).not.toBeNull();
    expect(desc).not.toContain('<a');
    expect(desc).toContain('xz');
  });

  it('drops attributes whose name is not a plain XML name', () => {
    const out = sanitizeSvgMarkup('<svg><rect data-x\u00a0onload="alert(1)"/></svg>');
    expect(out).not.toBeNull();
    expect(out).not.toContain('onload');
    expect(out).not.toContain('alert');
  });

  it('handles ~9 MiB of stray closing tags in linear time', () => {
    const input = '<svg>' + '</x>'.repeat(Math.floor((9 * 1024 * 1024) / 4)) + '</svg>';
    const start = Date.now();
    sanitizeSvgMarkup(input, { maxLength: 16 * 1024 * 1024 });
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const ADVERSARIAL: Record<string, string> = {
 xmlDeclImg: `<?xml x="><img src=x onerror=alert(1)>" ?><svg ${NS}></svg>`,
 xmlDecl2: `<?xml ><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe> ?><svg ${NS}></svg>`,
 slashOnload: `<svg/onload=alert(1)>`,
 noSpace: `<svg ${NS}><circle r="1"onclick="alert(1)"/></svg>`,
 entHref: `<svg ${NS}><a href="&#106;avascript:alert(1)"><text>x</text></a></svg>`,
 tabHref: `<svg ${NS}><a href="java&#9;script:alert(1)">x</a></svg>`,
 animate: `<svg ${NS}><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>`,
 animateCase: `<svg ${NS}><a><animate ATTRIBUTENAME="href" values="javascript:alert(1)"/></a></svg>`,
 animateEnt: `<svg ${NS}><a><set attributeName="xlink:hre&#102;" to="javascript:alert(1)"/></a></svg>`,
 animateDup: `<svg ${NS}><a><animate attributeName="fill" attributeName="href" to="javascript:alert(1)" from="javascript:alert(1)"/></a></svg>`,
 animateNoAttr: `<svg ${NS}><a><animate values="javascript:alert(1)"/></a></svg>`,
 useExt: `<svg ${NS}><use href="data:image/svg+xml;base64,PHN2Zz4="/><use xlink:href="http://x/y.svg#a"/></svg>`,
 imgExt: `<svg ${NS}><image href="http://169.254.169.254/x"/><image href="data:image/svg+xml;base64,AAAA"/><image href="data:image/png;base64,AAAA"/></svg>`,
 foreign: `<svg ${NS}><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror="alert(1)"/></body></foreignObject></svg>`,
 nsScript: `<svg ${NS} xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>`,
 nsHtml: `<svg ${NS}><a xmlns="http://www.w3.org/1999/xhtml" href="javascript:alert(1)">x</a></svg>`,
 nsXlink: `<svg ${NS} xmlns:q="http://www.w3.org/1999/xlink"><a q:href="javascript:alert(1)">x</a></svg>`,
 cdata: `<svg ${NS}><text><![CDATA[<script>alert(1)</script>]]></text></svg>`,
 cdataStyle: `<svg ${NS}><style><![CDATA[@import url(http://evil/x.css);]]></style></svg>`,
 styleImport: `<svg ${NS}><style>@im<!-- -->port url(http://evil/x.css);</style></svg>`,
 styleEsc: `<svg ${NS}><style>*{background:\\75 rl(http://evil/x)}</style></svg>`,
 styleAttr: `<svg ${NS}><rect style="fill:url(http://evil/x)" fill="url(//evil)"/></svg>`,
 styleImageSet: `<svg ${NS} style="background-image:image-set('http://evil/x.png' 1x)"><style>svg{background:-webkit-image-set("http://evil/y" 1x)}</style></svg>`,
 styleNamedEnt: `<svg ${NS}><rect style="background:url&lpar;http://evil/x&rpar;"/></svg>`,
 styleNoSemi: `<svg ${NS}><style>svg{background:url&#40//evil/x&#41}&#64import '//evil/y.css';</style></svg>`,
 styleNamedEntText: `<svg ${NS}><style>&commat;import '//evil/y.css';svg{background:url&lpar;//evil/x&rpar;}</style></svg>`,
 entityDecl: `<!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]><svg ${NS}>&x;</svg>`,
 titleHtml: `<svg ${NS}><title><image src="x" href="#" onerror="alert(1)"/><style>a{}</style></title><desc><a href="#" style="x">y</a></desc></svg>`,
 dataAttr: `<svg ${NS}><rect data-x\u00a0onload="alert(1)" data-y=">" data-z='"><img src=x onerror=alert(1)>'/></svg>`,
 unquoted: `<svg ${NS}><rect fill=red"onload="alert(1) /></svg>`,
 pi: `<?xml-stylesheet href="http://evil/x.css"?><svg ${NS}><?xml-stylesheet href="http://evil/x.css"?></svg>`,
 scriptText: `<svg ${NS}><script>if(a<b){alert(1)}</script><rect/></svg>`,
 afterRoot: `<svg ${NS}></svg><img src=x onerror=alert(1)>`,
 ok: `<svg ${NS} viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect fill="url(#g)" width="5" height="5"/><a href="https://example.com"><text x="1" y="1">a &amp; b &lt; c</text></a></svg>`,
};

const ALLOWED_TAGS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'style', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'use', 'image', 'a', 'symbol', 'marker', 'pattern', 'clippath', 'mask', 'lineargradient',
  'radialgradient', 'stop', 'filter', 'switch', 'view', 'metadata', 'animate', 'set', 'animatetransform', 'animatemotion',
  'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix', 'fecomposite', 'feflood', 'femerge', 'femergenode',
  'fedropshadow', 'feturbulence', 'fedisplacementmap', 'femorphology', 'fecomponenttransfer', 'fefunca', 'fefuncr',
  'fefuncg', 'fefuncb', 'feimage', 'fetile', 'feconvolvematrix', 'fediffuselighting', 'fespecularlighting',
  'fedistantlight', 'fepointlight', 'fespotlight', 'mpath', 'tbreak', 'cursor',
]);
const FORBIDDEN_TAGS = new Set([
  'script', 'img', 'iframe', 'object', 'embed', 'foreignobject', 'body', 'link', 'meta', 'base', 'form', 'html', 'head',
]);

interface P5Node {
  tagName?: string;
  nodeName: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
  content?: P5Node;
  parentNode?: P5Node;
  value?: string;
}

function findDangerous(html: string): string[] {
  const bad: string[] = [];
  const walk = (n: P5Node): void => {
    if (n.tagName) {
      const t = n.tagName.toLowerCase();
      if (FORBIDDEN_TAGS.has(t)) bad.push(`<${t}>`);
      if (!ALLOWED_TAGS.has(t) && !FORBIDDEN_TAGS.has(t)) bad.push(`unexpected <${t}>`);
      for (const a of n.attrs ?? []) {
        const v = a.value.replace(/[\s\0]/g, '').toLowerCase();
        if (/^on/i.test(a.name)) bad.push(`${t}@${a.name}`);
        if (/javascript:|url\(|@import|image-set\(/.test(v) && !/url\(["']?#/.test(v)) bad.push(`${t}@${a.name}=${a.value}`);
        if (/href$/.test(a.name) && !v.startsWith('#') && !v.startsWith('data:image/png')) bad.push(`${t}@${a.name}=${a.value}`);
      }
    }
    if (n.nodeName === '#text' && n.parentNode?.tagName === 'style') {
      const v = (n.value ?? '').replace(/\s/g, '').toLowerCase();
      if (/url\((?!["']?#)|@import|image-set\(/.test(v)) bad.push(`style-text:${n.value}`);
    }
    for (const c of n.childNodes ?? []) walk(c);
    if (n.content) walk(n.content);
  };
  walk(parseFragment(html) as unknown as P5Node);
  return bad;
}

describe('sanitizeSvgMarkup adversarial corpus re-parsed with parse5', () => {
  for (const [name, input] of Object.entries(ADVERSARIAL)) {
    it(`leaves nothing dangerous for: ${name}`, () => {
      const out = sanitizeSvgMarkup(input);
      if (out === null) return;
      expect(findDangerous(out)).toEqual([]);
    });
  }

  it('keeps the benign corpus entry intact', () => {
    expect(sanitizeSvgMarkup(ADVERSARIAL.ok)).not.toBeNull();
  });
});
