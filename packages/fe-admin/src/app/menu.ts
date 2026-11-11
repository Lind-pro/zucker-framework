import type { Translate } from '../i18n/context';
import type { AdminMessageKey } from '../i18n/zh-CN';
import { zhCN } from '../i18n/zh-CN';
import type { AdminPageDefinition, LocalizedLabel } from './config';

/** Menu record as returned by `GET /menu/tree` and `GET /menu/all`. */
export interface BackendMenuItem {
  id: string;
  name: string;
  path?: string | null;
  icon?: string | null;
  parentId?: string | null;
  sortOrder: number;
  status: boolean;
  permissions: string[];
  properties?: Record<string, unknown> | null;
  children?: BackendMenuItem[];
}

export type PermissionCheck = (permission?: string | readonly string[]) => boolean;

/**
 * Exact path match, or a nested path below a registered page (e.g. a detail route). A `:param`
 * segment of a page path (`/reports/:id`) matches any one non-empty segment.
 */
export function matchesPath(pathname: string, path: string): boolean {
  if (pathname === path || pathname.startsWith(`${path}/`)) return true;
  if (!path.includes('/:')) return false;
  const pattern = path.split('/');
  const actual = pathname.split('/');
  return actual.length >= pattern.length
    && pattern.every((segment, index) => (segment.startsWith(':') ? actual[index] !== '' : segment === actual[index]));
}

/** The registered page for a location (longest matching path wins). */
export function findPage(pages: readonly AdminPageDefinition[], pathname: string): AdminPageDefinition | undefined {
  return pages
    .filter((page) => matchesPath(pathname, page.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * Keep enabled items whose path is a registered page the user may open. Groups without visible
 * children disappear; an item whose own page is hidden keeps its visible children as a group.
 * Menu visibility is a UX filter only; the API stays authoritative.
 */
export function visibleMenu(
  items: readonly BackendMenuItem[],
  pages: readonly AdminPageDefinition[],
  can: PermissionCheck,
): BackendMenuItem[] {
  const byPath = new Map(pages.map((page) => [page.path, page]));
  const walk = (list: readonly BackendMenuItem[]): BackendMenuItem[] =>
    [...list]
      .filter((item) => item.status !== false)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .flatMap((item) => {
        const children = walk(item.children ?? []);
        if (!item.path) return children.length ? [{ ...item, children }] : [];
        const page = byPath.get(item.path);
        if (!page || !can(page.permission)) return children.length ? [{ ...item, path: undefined, children }] : [];
        return [{ ...item, children }];
      });
  return walk(items);
}

/**
 * Localize only unchanged starter records (`starter:<key>` with their original zh-CN name);
 * customized names, paths and menu identities are user data and stay as stored.
 */
export function menuLabel(
  item: BackendMenuItem,
  pages: readonly AdminPageDefinition[],
  t: Translate,
  locale: string,
): string {
  if (!item.id.startsWith('starter:')) return item.name;
  const page = item.path ? pages.find((candidate) => candidate.path === item.path) : undefined;
  if (page) {
    const original = page.titleKey ? zhCN[page.titleKey] : pageTitle(page, 'zh-CN', t);
    return item.name === original ? pageTitle(page, locale, t) : item.name;
  }
  const groupKey = `menu.group.${item.id.slice('starter:'.length)}` as AdminMessageKey;
  if (!item.path && Object.hasOwn(zhCN, groupKey) && item.name === zhCN[groupKey]) return t(groupKey);
  return item.name;
}

/** Product text in a locale: the exact tag, then zh-CN, then the first translation. */
export function localizedText(value: LocalizedLabel | undefined, locale: string): string {
  if (typeof value === 'string') return value;
  if (!value) return '';
  return value[locale] ?? value['zh-CN'] ?? Object.values(value)[0] ?? '';
}

/** Title of a page definition in a locale. */
export function pageTitle(page: Pick<AdminPageDefinition, 'title' | 'titleKey'>, locale: string, t: Translate): string {
  if (page.titleKey) return t(page.titleKey);
  return localizedText(page.title, locale);
}

/**
 * Menu items from the root to the item for this location: the item with the longest matching path
 * (a deeper item wins a tie), so `/content/categories` selects that item and not `/content`, also
 * when both are siblings.
 */
export function menuTrail(items: readonly BackendMenuItem[], pathname: string): BackendMenuItem[] {
  let best: BackendMenuItem[] = [];
  const walk = (list: readonly BackendMenuItem[], trail: BackendMenuItem[]) => {
    for (const item of list) {
      const next = [...trail, item];
      if (item.path && matchesPath(pathname, item.path)) {
        const current = best[best.length - 1]?.path?.length ?? -1;
        if (item.path.length > current || (item.path.length === current && next.length > best.length)) best = next;
      }
      walk(item.children ?? [], next);
    }
  };
  walk(items, []);
  return best;
}
