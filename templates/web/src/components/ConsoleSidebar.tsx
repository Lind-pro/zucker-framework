'use client';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { AccountLink } from '@/components/AccountLink';
import { consoleNav, isConsoleNavActive } from '@/lib/site/console-nav';
import { DEFAULT_LOCALE, isLocale } from '@/lib/site/locales';

export function ConsoleSidebar() {
  const t = useTranslations('shell'),
    rawLocale = useLocale(),
    pathname = usePathname();
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  return (
    <nav aria-label={t('consoleNav')} className="lg:sticky lg:top-24" data-testid="console-nav">
      <ul className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
        {consoleNav.map((item) => {
          const active = isConsoleNavActive(item, pathname);
          const Icon = item.icon;
          return (
            <li key={item.id} className="shrink-0">
              <AccountLink
                href={item.href}
                data-console-nav={item.id}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap ${active ? 'bg-[var(--color-card)] font-medium text-primary-500' : 'text-[var(--color-muted)] hover:bg-[var(--color-card)]'}`}
              >
                {Icon && <Icon size={16} aria-hidden />}
                {item.label[locale]}
              </AccountLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
