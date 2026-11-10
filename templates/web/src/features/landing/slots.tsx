import 'server-only';
import type { BlockSlots, BlogListSlotProps, ChangelogSlotProps, PricingSlotProps } from '@zucker-framework/fe-blocks';
import { PricingView } from '@/features/billing/PricingView';
import { readEntitlementCatalog, readPricingCatalog } from '@/features/billing/pricing-server';
import { contentCopy } from '@/features/content/copy';
import { readEntries } from '@/features/content/server';
import { contentPath, localizedHref, type Entry } from '@/features/content/types';

/**
 * Server-only data slots for CMS blocks. The block package stays fetch-free; these components read
 * the public APIs through the Next data cache (tagged, so a revalidate notification refreshes them).
 * A failing read renders the block without its list instead of failing the whole page.
 */

async function PricingSlot({ plans, showCreditPacks, locale }: PricingSlotProps) {
  const [catalog, entitlements] = await Promise.all([readPricingCatalog(locale), readEntitlementCatalog()]);
  return (
    <div className="space-y-6">
      <PricingView
        locale={locale}
        initial={catalog}
        entitlements={entitlements}
        plans={plans === 'all' ? 'all' : [...plans]}
        showPacks={showCreditPacks}
      />
      <p className="text-center">
        <a href={localizedHref('/pricing', locale)} className="text-sm font-medium text-primary-500 hover:underline">
          {contentCopy(locale).pricing} →
        </a>
      </p>
    </div>
  );
}

async function recentEntries(kind: 'post' | 'log', locale: string, limit: number, category?: string): Promise<Entry[]> {
  try {
    return (await readEntries(kind, locale, '1', category)).data.slice(0, limit);
  } catch {
    // Includes an unknown category (404): the block then shows only its heading and link.
    return [];
  }
}

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(locale, { timeZone: 'UTC' });
}

async function BlogListSlot({ limit, category, locale }: BlogListSlotProps) {
  const entries = await recentEntries('post', locale, limit, category);
  const copy = contentCopy(locale);
  return (
    <div className="space-y-6">
      {entries.length > 0 && (
        <div className="grid gap-5 md:grid-cols-3">
          {entries.map((entry) => (
            <a
              key={entry.id}
              href={localizedHref(contentPath('post', entry.slug), locale)}
              className="flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-6 transition-colors hover:border-primary-500"
            >
              <time dateTime={entry.publishedAt} className="text-xs text-[var(--color-muted)]">
                {formatDate(entry.publishedAt, locale)}
              </time>
              <h3 className="mt-2 text-lg font-semibold">{entry.title}</h3>
              {entry.description && <p className="mt-2 text-sm text-[var(--color-muted)]">{entry.description}</p>}
            </a>
          ))}
        </div>
      )}
      <a
        href={localizedHref(category ? `/blog/category/${category}` : '/blog', locale)}
        className="inline-block text-sm font-medium text-primary-500 hover:underline"
      >
        {copy.viewAllPosts} →
      </a>
    </div>
  );
}

async function ChangelogSlot({ limit, locale }: ChangelogSlotProps) {
  const entries = await recentEntries('log', locale, limit);
  const copy = contentCopy(locale);
  return (
    <div className="space-y-6">
      {entries.length > 0 && (
        <ol className="space-y-4 border-l border-[var(--color-border)] pl-6">
          {entries.map((entry) => (
            <li key={entry.id}>
              <time dateTime={entry.publishedAt} className="text-xs text-[var(--color-muted)]">
                {formatDate(entry.publishedAt, locale)}
              </time>
              <a
                href={localizedHref(contentPath('log', entry.slug), locale)}
                className="block font-semibold hover:text-primary-500"
              >
                {entry.title}
              </a>
              {entry.description && <p className="text-sm text-[var(--color-muted)]">{entry.description}</p>}
            </li>
          ))}
        </ol>
      )}
      <a
        href={localizedHref('/changelog', locale)}
        className="inline-block text-sm font-medium text-primary-500 hover:underline"
      >
        {copy.viewChangelog} →
      </a>
    </div>
  );
}

export const landingSlots: BlockSlots = {
  pricing: (props) => <PricingSlot {...props} />,
  blogList: (props) => <BlogListSlot {...props} />,
  changelog: (props) => <ChangelogSlot {...props} />,
};
