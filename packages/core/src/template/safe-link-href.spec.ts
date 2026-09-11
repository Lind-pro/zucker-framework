import { expect, it } from 'vitest';
import { safeHtmlLinkHref } from './safe-link-href';
it('retains template variables and safe schemes while escaping attribute delimiters', () => {
  expect(safeHtmlLinkHref('{{resetUrl}}')).toBe('{{resetUrl}}');
  expect(safeHtmlLinkHref('mailto:fixture@example.test')).toBe('mailto:fixture@example.test');
  expect(safeHtmlLinkHref('https://example.test/?a="value"&b=2')).toBe(
    'https://example.test/?a=&quot;value&quot;&amp;b=2',
  );
  expect(safeHtmlLinkHref('javascript:alert(1)')).toBe('#');
  expect(safeHtmlLinkHref('data:text/html,example')).toBe('#');
});
