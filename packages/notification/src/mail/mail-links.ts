export interface MailLinkTracking {
  /** Origins whose links are tagged, e.g. `https://example.com`. Other links stay untouched. */
  origins: string[];
  /**
   * Query parameters for one message, such as `utm_campaign`. Return null to send
   * the message unchanged. Parameters already present on a link are kept.
   */
  params: (context: { template?: string; campaignId?: string }) => Record<string, string> | null;
}

const ANCHOR_HREF = /(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gis;

/**
 * Adds query parameters to the anchors of an HTML email that point at the
 * given origins, so a visit opened from the email can be attributed to it.
 * Fragments, other parameters and links elsewhere are preserved.
 */
export function tagMailLinks(html: string, origins: string[], params: Record<string, string>): string {
  const allowed = new Set(origins.map((origin) => new URL(origin).origin));
  const entries = Object.entries(params).filter(([key, value]) => key && value);
  if (!allowed.size || !entries.length) return html;
  return html.replace(ANCHOR_HREF, (match, prefix: string, quote: string, raw: string) => {
    let url: URL;
    try {
      url = new URL(raw.replace(/&amp;/g, '&'));
    } catch {
      return match;
    }
    if (!allowed.has(url.origin)) return match;
    for (const [key, value] of entries) if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    return `${prefix}${quote}${url.toString().replace(/&/g, '&amp;')}${quote}`;
  });
}
