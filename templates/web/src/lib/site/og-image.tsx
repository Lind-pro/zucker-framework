import { ImageResponse } from 'next/og';

export const OG_IMAGE_SIZE = { width: 1200, height: 630 };
export const OG_IMAGE_CONTENT_TYPE = 'image/png';

/**
 * The bundled next/og font covers Latin scripts only, and for any other glyph next/og downloads a
 * font from Google Fonts at request time. To keep image rendering offline, text outside Latin
 * ranges is replaced as a whole by a Latin fallback the caller supplies. To render CJK, ship
 * a font file and pass it as `fonts` (then skip latinText) from a page-specific opengraph-image.
 */
export function latinText(value: string, fallback: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text && /^[\u0020-\u024F\u2010-\u2027]+$/.test(text) ? text : fallback;
}

/** Shared renderer: site name above a page title on the theme colours (globals.css). */
export function renderOgImage({
  siteName,
  title,
  fonts,
}: {
  siteName: string;
  title: string;
  fonts?: NonNullable<ConstructorParameters<typeof ImageResponse>[1]>['fonts'];
}): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%)',
          color: '#f8fafc',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ width: 20, height: 20, borderRadius: 6, background: '#6366f1' }} />
          <div style={{ fontSize: 40, fontWeight: 600, color: '#a5b4fc' }}>{siteName.slice(0, 60)}</div>
        </div>
        <div style={{ display: 'flex', fontSize: 72, fontWeight: 700, lineHeight: 1.1, maxWidth: 1040 }}>
          {title.slice(0, 120)}
        </div>
        <div style={{ display: 'flex', width: 160, height: 8, borderRadius: 4, background: '#6366f1' }} />
      </div>
    ),
    { ...OG_IMAGE_SIZE, ...(fonts ? { fonts } : {}) },
  );
}
