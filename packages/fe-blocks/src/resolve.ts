import type { SiteBlock, SiteBlockType, SiteDocument } from '@zucker-framework/fe-site/content';
import { defaultTheme } from './default-theme';
import type { BlockComponent, BlockRenderIssue, SiteBlockTheme } from './types';

export interface ResolvedThemeBlock {
  component: BlockComponent<SiteBlockType>;
  /** The theme that actually renders the block. */
  themeName: string;
  usedFallback: boolean;
}

/** Theme → default theme. `null` means no renderer exists for this type (skip and report it). */
export function resolveThemeBlock(
  theme: SiteBlockTheme,
  type: string,
  fallback: SiteBlockTheme = defaultTheme,
): ResolvedThemeBlock | null {
  const own = Object.hasOwn(theme.blocks, type)
    ? (theme.blocks as Record<string, BlockComponent<SiteBlockType>>)[type]
    : undefined;
  if (own) return { component: own, themeName: theme.name, usedFallback: false };
  const shared = Object.hasOwn(fallback.blocks, type)
    ? (fallback.blocks as Record<string, BlockComponent<SiteBlockType>>)[type]
    : undefined;
  if (shared)
    return { component: shared, themeName: fallback.name, usedFallback: theme !== fallback };
  return null;
}

export interface PlannedBlock {
  block: SiteBlock;
  resolved: ResolvedThemeBlock;
}
/**
 * Pure resolution step of `BlockRenderer`: enabled blocks in order with their components, plus
 * `unknown-block` / `theme-fallback` issues. Disabled blocks are dropped silently. Useful for an
 * editor that wants the issue list without rendering (render-time issues such as `missing-slot`
 * are reported only by `BlockRenderer`).
 */
export function planBlocks(
  document: Pick<SiteDocument, 'blocks'>,
  theme: SiteBlockTheme = defaultTheme,
): { blocks: PlannedBlock[]; issues: BlockRenderIssue[] } {
  const blocks: PlannedBlock[] = [];
  const issues: BlockRenderIssue[] = [];
  for (const block of document.blocks) {
    if (!block || block.enabled === false) continue;
    const type = String((block as { type?: unknown }).type);
    const blockId = String((block as { id?: unknown }).id);
    const resolved = resolveThemeBlock(theme, type);
    if (!resolved) {
      issues.push({ code: 'unknown-block', blockId, blockType: type, theme: theme.name });
      continue;
    }
    if (resolved.usedFallback)
      issues.push({ code: 'theme-fallback', blockId, blockType: type, theme: theme.name });
    blocks.push({ block, resolved });
  }
  return { blocks, issues };
}
