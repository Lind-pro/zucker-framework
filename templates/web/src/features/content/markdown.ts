import MarkdownIt from 'markdown-it';
import { safeSiteHref } from '@zucker-framework/fe-site/content';
import { localizedHref } from './types';

export function renderMarkdown(source: string, locale: string, prefix = 'section') {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const originalValidation = md.validateLink;
  md.validateLink = (href) => Boolean(safeSiteHref(href)) && originalValidation(href);
  const tokens = md.parse(source, {}),
    headings: { id: string; title: string; level: number }[] = [];
  const used = new Map<string, number>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'heading_open') {
      const title =
        tokens[index + 1]?.children
          ?.filter((child) => ['text', 'code_inline'].includes(child.type))
          .map((child) => child.content)
          .join('') || '';
      const base = `${prefix}-${
        title
          .toLocaleLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, '-')
          .replace(/^-|-$/g, '') || 'heading'
      }`;
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      const id = count ? `${base}-${count + 1}` : base;
      if (token.tag === 'h1') {
        token.tag = 'h2';
        if (tokens[index + 2]?.type === 'heading_close') tokens[index + 2].tag = 'h2';
      }
      token.attrSet('id', id);
      headings.push({ id, title, level: Number(token.tag.slice(1)) });
    }
    for (const child of token.children ?? []) {
      if (child.type === 'link_open') {
        const href = child.attrGet('href');
        if (typeof href === 'string') child.attrSet('href', localizedHref(href, locale));
        child.attrSet('rel', 'noopener noreferrer');
      }
      // Remote image URLs are validated by markdown-it; no executable HTML or MDX is evaluated.
      if (child.type === 'image') child.attrSet('loading', 'lazy');
    }
  }
  return { html: md.renderer.render(tokens, md.options, {}), headings };
}
