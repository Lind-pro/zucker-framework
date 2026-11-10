export const SVG_FORBIDDEN_TAGS = ['script', 'foreignObject', 'iframe', 'object', 'embed'] as const;

export const SVG_FORBIDDEN_ATTRIBUTES = [
  'onload',
  'onerror',
  'onclick',
  'onmouseover',
  'onfocus',
] as const;

/**
 * DOMPurify profile for consumers that sanitize in a browser DOM. Prefer
 * `sanitizeSvgMarkup`, which applies the stricter allow-list below and also
 * removes external references.
 */
export const SVG_PURIFY_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: [...SVG_FORBIDDEN_TAGS],
  FORBID_ATTR: [...SVG_FORBIDDEN_ATTRIBUTES],
};

export interface SanitizeSvgOptions {
  /** Inputs longer than this many UTF-16 code units are refused. Default 10 MiB. */
  maxLength?: number;
}

export const SVG_SANITIZE_DEFAULT_MAX_LENGTH = 10 * 1024 * 1024;
const MAX_DEPTH = 256;

// Element and attribute names are compared lowercased; output keeps the source spelling.
const ALLOWED_ELEMENTS = new Set(
  [
    'svg', 'g', 'defs', 'desc', 'title', 'symbol', 'use', 'image', 'a', 'view', 'switch',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'textPath',
    'marker', 'pattern', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop', 'style',
    'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
    'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA',
    'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode',
    'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile',
    'feTurbulence',
    'animate', 'animateMotion', 'animateTransform', 'set', 'mpath',
  ].map((name) => name.toLowerCase()),
);

const ANIMATION_ELEMENTS = new Set(['animate', 'animatemotion', 'animatetransform', 'set']);

const ALLOWED_ATTRIBUTES = new Set(
  [
    // core, geometry, structure
    'id', 'class', 'style', 'lang', 'tabindex', 'role', 'focusable', 'title', 'media', 'type',
    'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'd', 'points',
    'width', 'height', 'viewBox', 'preserveAspectRatio', 'version', 'baseProfile', 'xmlns',
    'xml:space', 'xml:lang', 'href', 'xlink:href', 'xlink:title', 'target',
    'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'startOffset', 'method', 'spacing', 'side',
    'path', 'pathLength', 'offset', 'gradientUnits', 'gradientTransform', 'spreadMethod',
    'patternUnits', 'patternContentUnits', 'patternTransform', 'markerUnits', 'markerWidth',
    'markerHeight', 'refX', 'refY', 'orient', 'clipPathUnits', 'maskUnits', 'maskContentUnits',
    'filterUnits', 'primitiveUnits', 'filterRes', 'systemLanguage', 'requiredFeatures',
    'requiredExtensions', 'zoomAndPan',
    // filter primitives
    'in', 'in2', 'result', 'operator', 'k1', 'k2', 'k3', 'k4', 'stdDeviation', 'edgeMode', 'mode',
    'values', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'kernelMatrix',
    'kernelUnitLength', 'order', 'divisor', 'bias', 'targetX', 'targetY', 'preserveAlpha',
    'diffuseConstant', 'specularConstant', 'specularExponent', 'surfaceScale', 'azimuth',
    'elevation', 'pointsAtX', 'pointsAtY', 'pointsAtZ', 'limitingConeAngle', 'scale',
    'xChannelSelector', 'yChannelSelector', 'radius', 'baseFrequency', 'numOctaves', 'seed',
    'stitchTiles',
    // animation timing and values
    'attributeName', 'attributeType', 'begin', 'dur', 'end', 'min', 'max', 'restart', 'repeatCount',
    'repeatDur', 'calcMode', 'keyTimes', 'keySplines', 'keyPoints', 'from', 'to', 'by', 'additive',
    'accumulate',
    // presentation attributes
    'alignment-baseline', 'baseline-shift', 'clip', 'clip-path', 'clip-rule', 'color',
    'color-interpolation', 'color-interpolation-filters', 'color-profile', 'color-rendering',
    'cursor', 'direction', 'display', 'dominant-baseline', 'enable-background', 'fill',
    'fill-opacity', 'fill-rule', 'filter', 'flood-color', 'flood-opacity', 'font', 'font-family',
    'font-size', 'font-size-adjust', 'font-stretch', 'font-style', 'font-variant', 'font-weight',
    'glyph-orientation-horizontal', 'glyph-orientation-vertical', 'image-rendering', 'kerning',
    'letter-spacing', 'lighting-color', 'marker', 'marker-end', 'marker-mid', 'marker-start', 'mask',
    'mask-type', 'opacity', 'overflow', 'paint-order', 'pointer-events', 'shape-rendering',
    'stop-color', 'stop-opacity', 'stroke', 'stroke-dasharray', 'stroke-dashoffset',
    'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width',
    'text-anchor', 'text-decoration', 'text-rendering', 'transform', 'transform-origin',
    'unicode-bidi', 'vector-effect', 'visibility', 'word-spacing', 'writing-mode',
  ].map((name) => name.toLowerCase()),
);

const URL_ATTRIBUTES = new Set(['href', 'xlink:href']);
const RASTER_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]*$/;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const NAME_CHAR = /[A-Za-z0-9_:.-]/;
const EXACT_SVG11_DOCTYPE =
  /<!DOCTYPE[ \t\r\n]+svg[ \t\r\n]+PUBLIC[ \t\r\n]+["']-\/\/W3C\/\/DTD SVG 1\.1\/\/EN["'][ \t\r\n]+["']https?:\/\/www\.w3\.org\/Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd["'][ \t\r\n]*>/iy;

/** Decode XML character and predefined entity references. Unknown names stay literal. */
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{0,31});/gi, (match, body: string) => {
    if (body[0] === '#') {
      const point = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Lowercase and remove whitespace / control characters a browser ignores in URLs. */
function normalizeForCheck(value: string): string {
  return decodeEntities(value).replace(/[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/g, '').toLowerCase();
}

function isSafeReference(normalized: string, allowRaster: boolean): boolean {
  if (normalized.startsWith('#')) return true;
  return allowRaster && RASTER_DATA_URI.test(normalized);
}

/** Decode CSS escapes so `\75 rl(` cannot hide `url(` from the check. */
function decodeCssEscapes(value: string): string {
  if (!value.includes('\\')) return value;
  return value.replace(/\\([0-9a-f]{1,6})[ \t\r\n\f]?|\\([\s\S])/gi, (_, hex: string | undefined, char: string | undefined) => {
    if (hex) {
      const point = Number.parseInt(hex, 16);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }
    return char ?? '';
  });
}

/**
 * Attribute values and stylesheet text may only reference same-document
 * fragments (`url(#id)`) or inline raster images; scripts, imports and
 * external fetches make the value unsafe. Linear in the input length.
 */
function isSafeCssOrValue(raw: string): boolean {
  const value = normalizeForCheck(decodeCssEscapes(decodeEntities(raw)));
  if (
    value.includes('javascript:') ||
    value.includes('vbscript:') ||
    value.includes('data:text') ||
    value.includes('@import') ||
    value.includes('expression(') ||
    value.includes('-moz-binding') ||
    value.includes('behavior:')
  ) {
    return false;
  }
  let from = 0;
  for (;;) {
    const start = value.indexOf('url(', from);
    if (start < 0) return true;
    const end = value.indexOf(')', start + 4);
    if (end < 0) return false;
    const target = value.slice(start + 4, end).replace(/^["']|["']$/g, '');
    if (!isSafeReference(target, true)) return false;
    from = end + 1;
  }
}

/** Re-emit an attribute value as a double-quoted XML attribute. */
function encodeAttributeValue(raw: string): string {
  return raw
    .replace(/&(?!(?:#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{0,31});)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

interface ParsedAttribute {
  name: string;
  value: string | undefined;
}

interface ParsedTag {
  name: string;
  attributes: ParsedAttribute[];
  selfClosing: boolean;
  end: number;
}

const isSpace = (char: string | undefined) =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';

/** Parse `<name attr=...>` starting at `start` (which points at `<`). Returns null when malformed. */
function parseStartTag(input: string, start: number): ParsedTag | null {
  let index = start + 1;
  const nameStart = index;
  while (index < input.length && NAME_CHAR.test(input[index])) index += 1;
  if (index === nameStart) return null;
  const name = input.slice(nameStart, index);
  const attributes: ParsedAttribute[] = [];
  for (;;) {
    const before = index;
    while (isSpace(input[index])) index += 1;
    const char = input[index];
    if (char === undefined) return null;
    if (char === '>') return { name, attributes, selfClosing: false, end: index + 1 };
    if (char === '/') {
      if (input[index + 1] !== '>') return null;
      return { name, attributes, selfClosing: true, end: index + 2 };
    }
    // Attributes must be separated by whitespace, except right after a quoted value
    // (`r="1"onclick=...` is accepted by browsers, so it is parsed, not trusted).
    if (index === before && attributes.length > 0 && !/["']/.test(input[index - 1])) return null;
    const attrStart = index;
    while (index < input.length && !isSpace(input[index]) && !'=/>"\'<'.includes(input[index])) index += 1;
    if (index === attrStart) return null;
    const attrName = input.slice(attrStart, index);
    let cursor = index;
    while (isSpace(input[cursor])) cursor += 1;
    if (input[cursor] !== '=') {
      attributes.push({ name: attrName, value: undefined });
      continue;
    }
    cursor += 1;
    while (isSpace(input[cursor])) cursor += 1;
    const quote = input[cursor];
    if (quote === '"' || quote === "'") {
      const close = input.indexOf(quote, cursor + 1);
      if (close < 0) return null;
      attributes.push({ name: attrName, value: input.slice(cursor + 1, close) });
      index = close + 1;
    } else {
      const valueStart = cursor;
      while (cursor < input.length && !isSpace(input[cursor]) && input[cursor] !== '>') cursor += 1;
      if (cursor === valueStart) return null;
      attributes.push({ name: attrName, value: input.slice(valueStart, cursor) });
      index = cursor;
    }
  }
}

function filterAttributes(element: string, attributes: ParsedAttribute[]): string {
  let out = '';
  for (const { name, value } of attributes) {
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) continue;
    const allowed =
      ALLOWED_ATTRIBUTES.has(lower) ||
      lower.startsWith('data-') ||
      lower.startsWith('aria-') ||
      (lower.startsWith('xmlns:') && lower.length > 6);
    if (!allowed) continue;
    const raw = value ?? '';
    if (URL_ATTRIBUTES.has(lower)) {
      const allowRaster = element === 'image' || element === 'feimage';
      if (!isSafeReference(normalizeForCheck(raw), allowRaster)) continue;
    } else if (!isSafeCssOrValue(raw)) {
      continue;
    }
    out += ` ${name}="${encodeAttributeValue(raw)}"`;
  }
  return out;
}

function isDangerousAnimation(element: string, attributes: ParsedAttribute[]): boolean {
  if (!ANIMATION_ELEMENTS.has(element)) return false;
  const target = attributes.find((attr) => attr.name.toLowerCase() === 'attributename');
  if (!target) return element !== 'animatemotion' && element !== 'animatetransform';
  const name = normalizeForCheck(target.value ?? '');
  return name === 'href' || name.endsWith(':href') || name.startsWith('on') || name === 'style';
}

/**
 * Rebuild an SVG document from an element/attribute allow-list.
 *
 * - Returns `null` for non-SVG input, any DOCTYPE other than the standard SVG 1.1
 *   declaration, entity declarations, malformed tags, unbalanced nesting deeper than
 *   256 levels, or input longer than `maxLength`.
 * - Drops elements outside the allow-list with their content (script,
 *   foreignObject, iframe, object, embed, metadata, unknown namespaces), event
 *   handlers, unknown attributes, `href`s other than `#fragment` (inline raster
 *   `data:image/*;base64` is kept on `image`/`feImage`), CSS or attribute values
 *   with `@import`, script URLs or external `url(...)`, and animations that target
 *   `href`, `style` or an event handler.
 * - Text content is kept verbatim; comments and processing instructions are removed.
 *
 * Runs in a single forward pass, so the cost is linear in the input length.
 */
export function sanitizeSvgMarkup(svg: string, options: SanitizeSvgOptions = {}): string | null {
  const maxLength = options.maxLength ?? SVG_SANITIZE_DEFAULT_MAX_LENGTH;
  if (typeof svg !== 'string' || svg.length > maxLength) return null;
  const input = svg.trim().replace(/^\uFEFF/, '').trim();
  const out: string[] = [];
  let index = 0;

  // Prolog: an optional XML declaration (kept with the whitespace after it), then
  // comments, processing instructions and the standard SVG 1.1 DTD (removed).
  if (input.startsWith('<?xml') && isSpace(input[5])) {
    const end = input.indexOf('?>', 5);
    if (end < 0) return null;
    index = end + 2;
    let after = index;
    while (isSpace(input[after])) after += 1;
    out.push(input.slice(0, after));
    index = after;
  }
  for (;;) {
    while (isSpace(input[index])) index += 1;
    if (input.startsWith('<!--', index)) {
      const end = input.indexOf('-->', index + 4);
      if (end < 0) return null;
      index = end + 3;
    } else if (input.startsWith('<?', index)) {
      const end = input.indexOf('?>', index + 2);
      if (end < 0) return null;
      index = end + 2;
    } else if (input.startsWith('<!', index)) {
      EXACT_SVG11_DOCTYPE.lastIndex = index;
      if (!EXACT_SVG11_DOCTYPE.test(input)) return null;
      index = EXACT_SVG11_DOCTYPE.lastIndex;
    } else {
      break;
    }
  }

  // Element stack: lowercase name plus whether the subtree is being dropped.
  const stack: Array<{ name: string; source: string; dropped: boolean; styleStart: number }> = [];
  let dropDepth = 0;
  let sawRoot = false;
  let rootClosed = false;
  let styleText: string[] | null = null;

  const closeTop = () => {
    const top = stack.pop();
    if (!top) return;
    if (top.dropped) {
      dropDepth -= 1;
      return;
    }
    if (top.name === 'style' && styleText) {
      const css = styleText.join('');
      styleText = null;
      if (!isSafeCssOrValue(css)) {
        out.length = top.styleStart;
        return;
      }
    }
    out.push(`</${top.source}>`);
    if (stack.length === 0) rootClosed = true;
  };

  while (index < input.length) {
    const next = input.indexOf('<', index);
    const textEnd = next < 0 ? input.length : next;
    if (textEnd > index) {
      const text = input.slice(index, textEnd);
      if (stack.length === 0) {
        if (text.trim()) return null;
      } else if (dropDepth === 0) {
        out.push(text);
        if (styleText) styleText.push(text);
      }
      index = textEnd;
      if (next < 0) break;
    }

    if (input.startsWith('<!--', index)) {
      const end = input.indexOf('-->', index + 4);
      if (end < 0) return null;
      index = end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', index)) {
      const end = input.indexOf(']]>', index + 9);
      if (end < 0 || stack.length === 0) return null;
      if (dropDepth === 0) {
        const content = input.slice(index + 9, end);
        const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        out.push(escaped);
        if (styleText) styleText.push(content);
      }
      index = end + 3;
      continue;
    }
    if (input.startsWith('<!', index)) return null; // DOCTYPE / ENTITY / other declarations
    if (input.startsWith('<?', index)) {
      const end = input.indexOf('?>', index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }
    if (input[index + 1] === '/') {
      let cursor = index + 2;
      const nameStart = cursor;
      while (cursor < input.length && NAME_CHAR.test(input[cursor])) cursor += 1;
      const name = input.slice(nameStart, cursor).toLowerCase();
      while (isSpace(input[cursor])) cursor += 1;
      if (!name || input[cursor] !== '>') return null;
      index = cursor + 1;
      // Tolerate sloppy nesting: close up to the matching element, ignore strays.
      let match = stack.length - 1;
      while (match >= 0 && stack[match].name !== name) match -= 1;
      if (match < 0) continue;
      while (stack.length > match) closeTop();
      continue;
    }

    const tag = parseStartTag(input, index);
    if (!tag) return null;
    index = tag.end;
    if (rootClosed) return null;
    const lower = tag.name.toLowerCase();
    if (!sawRoot) {
      if (lower !== 'svg') return null;
      sawRoot = true;
    }
    if (stack.length >= MAX_DEPTH) return null;

    const dropped =
      dropDepth > 0 ||
      styleText !== null ||
      !ALLOWED_ELEMENTS.has(lower) ||
      isDangerousAnimation(lower, tag.attributes);
    if (dropped) {
      if (!tag.selfClosing) {
        stack.push({ name: lower, source: tag.name, dropped: true, styleStart: 0 });
        dropDepth += 1;
      }
      continue;
    }
    const styleStart = out.length;
    out.push(`<${tag.name}${filterAttributes(lower, tag.attributes)}${tag.selfClosing ? '/>' : '>'}`);
    if (tag.selfClosing) {
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    stack.push({ name: lower, source: tag.name, dropped: false, styleStart });
    if (lower === 'style') styleText = [];
  }

  if (!sawRoot) return null;
  while (stack.length) closeTop();
  return out.join('');
}
