import { SITE_BLOCK_TYPES } from '@zucker-framework/fe-site/content';
import type { SiteBlockTheme, ThemeBlocks } from './types';

export interface ThemeDefinition {
  /** Registry name, `^[a-z][a-z0-9-]{0,63}$`; resolve stored names with fe-site `resolveSiteTheme`. */
  name: string;
  /** Components for the block types this theme overrides; missing types fall back to `default`. */
  blocks?: ThemeBlocks;
  /** CSS custom properties, for example `{ '--zb-accent': '#0f766e' }`. */
  tokens?: Record<string, string>;
}

const THEME_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const TOKEN_NAME = /^--[a-z][a-z0-9-]{0,63}$/;
// Token values become inline style declarations: refuse anything that could close or extend one.
const UNSAFE_TOKEN_VALUE = /[;{}<>\\\u0000-\u001f\u007f]/;

/**
 * Creates an immutable theme. Themes are code supplied by the application, never content, but they
 * are still checked so a typo cannot inject extra declarations or register an unknown block type.
 */
export function defineTheme(definition: ThemeDefinition): SiteBlockTheme {
  if (!THEME_NAME.test(definition.name)) throw new Error(`Invalid theme name: ${definition.name}`);
  const blocks: ThemeBlocks = {};
  for (const [type, component] of Object.entries(definition.blocks ?? {})) {
    if (!(SITE_BLOCK_TYPES as readonly string[]).includes(type))
      throw new Error(`Theme ${definition.name} registers unknown block type ${type}`);
    if (typeof component !== 'function')
      throw new Error(`Theme ${definition.name} block ${type} must be a component function`);
    (blocks as Record<string, unknown>)[type] = component;
  }
  const tokens: Record<string, string> = {};
  for (const [name, value] of Object.entries(definition.tokens ?? {})) {
    if (!TOKEN_NAME.test(name)) throw new Error(`Invalid theme token name: ${name}`);
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 200 ||
      UNSAFE_TOKEN_VALUE.test(value)
    )
      throw new Error(`Invalid value for theme token ${name}`);
    tokens[name] = value.trim();
  }
  return Object.freeze({
    name: definition.name,
    blocks: Object.freeze(blocks),
    tokens: Object.freeze(tokens),
  });
}
