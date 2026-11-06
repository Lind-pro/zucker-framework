// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { tagMailLinks } from './mail-links';

const params = { utm_source: 'email', utm_campaign: 'welcome' };

describe('tagging email links for visit attribution', () => {
  it('tags only links to the configured origins and keeps their query and fragment', () => {
    const html = [
      '<a href="https://example.com/write?draft=1&amp;tab=2#claims">Open</a>',
      "<a class='x' href='https://example.com/pricing'>Pricing</a>",
      '<a href="https://other.example/page">Elsewhere</a>',
      '<a href="mailto:help@example.com">Mail</a>',
      '<img src="https://example.com/logo.png">',
    ].join('');
    const tagged = tagMailLinks(html, ['https://example.com'], params);
    expect(tagged).toContain(
      'href="https://example.com/write?draft=1&amp;tab=2&amp;utm_source=email&amp;utm_campaign=welcome#claims"',
    );
    expect(tagged).toContain("href='https://example.com/pricing?utm_source=email&amp;utm_campaign=welcome'");
    expect(tagged).toContain('href="https://other.example/page"');
    expect(tagged).toContain('href="mailto:help@example.com"');
    expect(tagged).toContain('src="https://example.com/logo.png"');
  });

  it('keeps parameters a link already sets and leaves unparsable links alone', () => {
    const html = '<a href="https://example.com/?utm_campaign=manual">A</a><a href="{{url}}">B</a>';
    const tagged = tagMailLinks(html, ['https://example.com/'], params);
    expect(tagged).toContain('href="https://example.com/?utm_campaign=manual&amp;utm_source=email"');
    expect(tagged).toContain('href="{{url}}"');
  });
});
