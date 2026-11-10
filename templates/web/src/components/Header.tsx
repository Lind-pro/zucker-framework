'use client';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import { AppearanceControl } from '@/features/site/SiteTheme';
import { localizedHref, type PublicSiteSettings } from '@/features/content/types';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { SessionMenu } from '@/components/SessionMenu';
import { localizedPath } from '@/lib/site/url';
import { isLocale } from '@/lib/site/locales';

/**
 * Site header. Everything session-dependent lives in SessionMenu and is resolved in the browser,
 * so the server-rendered header is identical for every visitor.
 */
export function Header({ site, adminUrl }: { site: PublicSiteSettings; adminUrl: string | null }) {
  const t = useTranslations('shell'),
    locale = useLocale(),
    pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const nav = site.navigation.map((item, index) => (
    <a
      key={`${item.href}-${index}`}
      href={localizedHref(item.href, locale)}
      onClick={() => setMenuOpen(false)}
      className={`block text-sm font-medium hover:text-primary-500 ${pathname === item.href ? 'text-primary-500' : 'text-[var(--color-muted)]'}`}
    >
      {item.label}
    </a>
  ));
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--color-border)] bg-[var(--color-background)]/90 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-5">
        <a href={isLocale(locale) ? localizedPath(locale, '/') : '/'} className="text-xl font-bold text-primary-500 truncate">
          {site.name}
        </a>
        <nav aria-label={t('mainNav')} className="hidden md:flex items-center gap-5">
          {nav}
        </nav>
        <div className="hidden md:flex items-center gap-3">
          <LocaleSwitcher />
          <AppearanceControl locale={locale} />
          <SessionMenu adminUrl={adminUrl} />
        </div>
        <button
          className="md:hidden p-2"
          aria-expanded={menuOpen}
          aria-controls="mobile-navigation"
          aria-label={t('toggleNav')}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>
      {menuOpen && (
        <nav
          id="mobile-navigation"
          aria-label={t('mainNav')}
          className="md:hidden space-y-4 border-t border-[var(--color-border)] p-6"
        >
          {nav}
          <div className="flex flex-wrap items-center gap-4">
            <LocaleSwitcher />
            <AppearanceControl locale={locale} />
            <SessionMenu adminUrl={adminUrl} compact />
          </div>
        </nav>
      )}
    </header>
  );
}
