import MarkdownIt from 'markdown-it';
import { safeSiteHref } from '@zucker-framework/fe-site/content';

/**
 * Assistant answers are untrusted text. Same rules as the content renderer (HTML disabled, links
 * through `safeSiteHref`), plus: images are disabled so an answer can never make the browser load
 * a remote URL, and links open in a new tab without referrer or opener.
 */
const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
md.disable(['image']);
const validateLink = md.validateLink.bind(md);
md.validateLink = (href) => Boolean(safeSiteHref(href)) && validateLink(href);
md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  tokens[index].attrSet('rel', 'noopener noreferrer nofollow');
  tokens[index].attrSet('target', '_blank');
  return self.renderToken(tokens, index, options);
};

export function renderChatMarkdown(source: string): string {
  return md.render(source);
}
