export const IMAGE_MIME_TYPES = [
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
] as const;

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
export type ImageExtension = 'svg' | 'png' | 'jpg' | 'gif' | 'webp' | 'bmp';

export type ParsedImageDataUri = {
  mimeType: ImageMimeType;
  base64: string;
};

const MIME_TO_EXTENSION: Record<ImageMimeType, ImageExtension> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

const DATA_URI_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i;

function isImageMimeType(value: string): value is ImageMimeType {
  return IMAGE_MIME_TYPES.includes(value.toLowerCase() as ImageMimeType);
}

export function parseImageDataUri(value: string): ParsedImageDataUri | null {
  const match = DATA_URI_PATTERN.exec(value.trim());
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  if (!isImageMimeType(mimeType)) return null;
  return { mimeType, base64: match[2].replace(/\s+/g, '') };
}

export function detectImageMimeFromBase64(value: string): ImageMimeType | null {
  const dataUri = parseImageDataUri(value);
  if (dataUri) return dataUri.mimeType;

  const base64 = value.trim().replace(/\s+/g, '');
  if (!base64) return null;
  if (
    base64.startsWith('PHN2') ||
    base64.startsWith('PD94') ||
    base64.startsWith('77u/PHN2') ||
    base64.startsWith('77u/PD94')
  ) {
    return 'image/svg+xml';
  }
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  if (base64.startsWith('Qk')) return 'image/bmp';
  return null;
}

export function detectImageMimeFromBytes(bytes: Uint8Array): ImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)).startsWith('GIF8')) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }

  const textPrefix = new TextDecoder().decode(bytes.subarray(0, 1024));
  return /<svg\b/i.test(textPrefix) ? 'image/svg+xml' : null;
}

export function imageExtensionForMime(mimeType: ImageMimeType): ImageExtension {
  return MIME_TO_EXTENSION[mimeType];
}

export function toImageDataUri(
  value: string,
  fallbackMimeType: ImageMimeType = 'image/png',
): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (parseImageDataUri(trimmed)) return trimmed;
  const mimeType = detectImageMimeFromBase64(trimmed) ?? fallbackMimeType;
  return `data:${mimeType};base64,${trimmed.replace(/\s+/g, '')}`;
}

export function resolveImageSource(input: {
  imageUrl?: string | null;
  imageBase64?: string | null;
  fallbackMimeType?: ImageMimeType;
}): string {
  const imageUrl = input.imageUrl?.trim();
  if (imageUrl) return imageUrl;
  const imageBase64 = input.imageBase64?.trim();
  return imageBase64 ? toImageDataUri(imageBase64, input.fallbackMimeType) : '';
}

export function decodeBase64Utf8(value: string): string {
  const parsed = parseImageDataUri(value);
  const base64 = (parsed?.base64 ?? value).replace(/\s+/g, '');
  const binary = globalThis.atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function extractInlineSvg(input: {
  svgContent?: string | null;
  imageBase64?: string | null;
}): string | null {
  const svgContent = input.svgContent?.trim();
  if (svgContent) return svgContent;

  const imageBase64 = input.imageBase64?.trim();
  if (!imageBase64 || detectImageMimeFromBase64(imageBase64) !== 'image/svg+xml') {
    return null;
  }
  try {
    return decodeBase64Utf8(imageBase64)
      .replace(/^\uFEFF/, '')
      .trim();
  } catch {
    return null;
  }
}

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
  const trimmed = svg.trim().replace(/^\uFEFF/, '');
  if (!trimmed || !/^(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i.test(trimmed)) return null;
  if (/<!doctype\b/i.test(trimmed)) return null;

  const sanitized = trimmed
    .replace(/<(script|foreignObject|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|foreignObject|iframe|object|embed)\b[^>]*\/\s*>/gi, '')
    .replace(/\son[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:xlink:href|href)\s*=\s*(["'])\s*(?:javascript:|data:text\/html)[\s\S]*?\1/gi, '')
    .replace(/\s(?:xlink:href|href)\s*=\s*(?:javascript:|data:text\/html)[^\s>]*/gi, '');
  return /<(script|foreignObject|iframe|object|embed)\b/i.test(sanitized) ? null : sanitized;
}

export {
  detectMermaidDiagramType,
  getMermaidStructuralError,
  sanitizeMermaidCode,
} from './mermaid/sanitize';
export type { MermaidDiagramType } from './mermaid/sanitize';
export { renderMermaidSvg } from './mermaid/render';
export type {
  MermaidRenderProfile,
  MermaidRenderOptions,
  MermaidRenderResult,
} from './mermaid/render';

export { requestSvgRender, SvgRenderRequestError } from './svg-render-client';
export type { SvgRenderRequest, SvgRenderResponse } from './svg-render-client';
export { requestKrokiSvg } from './kroki-render-client';
export type { KrokiSvgRequest } from './kroki-render-client';
export { renderSmilesSvg, RdkitLoadError, InvalidSmilesError } from './rdkit-svg-renderer';
export type { RdkitSvgModule, RdkitMolecule } from './rdkit-svg-renderer';
export { renderVegaLiteSvg, VegaSvgRenderError } from './vega-svg-renderer';
export type { VegaSvgModules, VegaSvgView } from './vega-svg-renderer';
