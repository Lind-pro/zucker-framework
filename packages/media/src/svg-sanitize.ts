export const SVG_FORBIDDEN_TAGS = ['script', 'foreignObject', 'iframe', 'object', 'embed'] as const;

export const SVG_FORBIDDEN_ATTRIBUTES = [
  'onload',
  'onerror',
  'onclick',
  'onmouseover',
  'onfocus',
] as const;

export const SVG_PURIFY_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: [...SVG_FORBIDDEN_TAGS],
  FORBID_ATTR: [...SVG_FORBIDDEN_ATTRIBUTES],
};

export function sanitizeSvgMarkup(svg: string): string | null {
  // Plotting tools emit the standard SVG 1.1 external DTD. Remove that exact
  // declaration before parsing; never resolve a DTD or accept an internal subset.
  const trimmed = svg.trim().replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '').trim().replace(
    /^(<\?xml\s[\s\S]*?\?>\s*)?<!DOCTYPE\s+svg\s+PUBLIC\s+["']-\/\/W3C\/\/DTD SVG 1\.1\/\/EN["']\s+["']https?:\/\/www\.w3\.org\/Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd["']\s*>\s*/i,
    '$1',
  );
  if (!trimmed || !/^(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i.test(trimmed)) return null;
  if (/<!doctype\b|<!entity\b/i.test(trimmed)) return null;

  const sanitized = trimmed
    .replace(/<(script|foreignObject|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|foreignObject|iframe|object|embed)\b[^>]*\/\s*>/gi, '')
    .replace(/\son[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:xlink:href|href)\s*=\s*(["'])\s*(?:javascript:|data:text\/html)[\s\S]*?\1/gi, '')
    .replace(/\s(?:xlink:href|href)\s*=\s*(?:javascript:|data:text\/html)[^\s>]*/gi, '');
  return /<(script|foreignObject|iframe|object|embed)\b/i.test(sanitized) ? null : sanitized;
}
