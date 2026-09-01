import { describe, expect, it } from 'vitest';
import {
  detectImageMimeFromBase64,
  detectImageMimeFromBytes,
  extractInlineSvg,
  parseImageDataUri,
  resolveImageSource,
  sanitizeSvgMarkup,
  toImageDataUri,
} from './index';

describe('image media detection', () => {
  it('detects common base64 formats including BOM-prefixed SVG', () => {
    expect(detectImageMimeFromBase64('77u/PHN2Zy8+')).toBe('image/svg+xml');
    expect(detectImageMimeFromBase64('iVBORw0KGgo=')).toBe('image/png');
    expect(detectImageMimeFromBase64('/9j/4AAQSkZJRg==')).toBe('image/jpeg');
    expect(detectImageMimeFromBase64('UklGRiIAAABXRUJQVlA4')).toBe('image/webp');
  });

  it('detects bytes without generation-method assumptions', () => {
    expect(detectImageMimeFromBytes(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe(
      'image/png',
    );
    expect(detectImageMimeFromBytes(new TextEncoder().encode('\uFEFF<svg/>'))).toBe(
      'image/svg+xml',
    );
  });

  it('parses and preserves supported data URIs', () => {
    const source = 'data:image/svg+xml;base64,PHN2Zy8+';
    expect(parseImageDataUri(source)).toEqual({
      mimeType: 'image/svg+xml',
      base64: 'PHN2Zy8+',
    });
    expect(toImageDataUri(source)).toBe(source);
  });

  it('prefers a hydrated object-storage URL over legacy inline data', () => {
    expect(
      resolveImageSource({
        imageUrl: ' https://cdn.example.test/drawing.svg ',
        imageBase64: 'PHN2Zy8+',
      }),
    ).toBe('https://cdn.example.test/drawing.svg');
  });

  it('decodes UTF-8 SVG payloads', () => {
    const svg = '<svg><text>drawing</text></svg>';
    const base64 = btoa(svg);
    expect(extractInlineSvg({ imageBase64: base64 })).toBe(svg);
  });
});

describe('SVG security policy', () => {
  it('removes executable SVG content and event handlers', () => {
    expect(
      sanitizeSvgMarkup(
        '<svg onload="run()"><script>run()</script><iframe/><path onclick=x href=javascript:run() /></svg>',
      ),
    ).toBe('<svg><path /></svg>');
  });

  it('rejects non-SVG and doctype payloads', () => {
    expect(sanitizeSvgMarkup('<html></html>')).toBeNull();
    expect(sanitizeSvgMarkup('<!DOCTYPE svg><svg/>')).toBeNull();
  });
});
