import { escapeHtml } from '../template';

/**
 * HTML href for runtime mail/templates. Allows HTTP(S), mailto and a whole
 * unresolved {{variable}}; the URL is still attribute-escaped. Other protocols
 * become an inert anchor. It does not authorize an outbound server request.
 */
export function safeHtmlLinkHref(value: string): string {
  return /^(?:https?:\/\/|mailto:|\{\{\w+\}\}$)/i.test(value.trim()) ? escapeHtml(value) : '#';
}
