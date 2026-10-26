'use client';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { AccountLink } from '@/components/AccountLink';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import { AppearanceControl } from '@/features/site/SiteTheme';
import { localizedHref, type PublicSiteSettings } from '@/features/content/types';

export function Header({ site }: { site: PublicSiteSettings }) {
  const t = useTranslations('common'),
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
        <a href={`/${locale}`} className="text-xl font-bold text-primary-500 truncate">
          {site.name}
        </a>
        <nav
          aria-label={locale === 'zh' ? '主导航' : 'Main navigation'}
          className="hidden md:flex items-center gap-5"
        >
          {nav}
        </nav>
        <div className="hidden md:flex items-center gap-3">
          <AppearanceControl locale={locale} />
          <AccountLink href="/login" className="text-sm text-[var(--color-muted)]">
            {t('login')}
          </AccountLink>
          <AccountLink
            href="/register"
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm text-white"
          >
            {t('register')}
          </AccountLink>
        </div>
        <button
          className="md:hidden p-2"
          aria-expanded={menuOpen}
          aria-controls="mobile-navigation"
          aria-label={locale === 'zh' ? '切换导航菜单' : 'Toggle navigation'}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>
      {menuOpen && (
        <nav
          id="mobile-navigation"
          className="md:hidden space-y-4 border-t border-[var(--color-border)] p-6"
        >
          {nav}
          <div className="flex items-center gap-4">
            <AppearanceControl locale={locale} />
            <AccountLink href="/login">{t('login')}</AccountLink>
            <AccountLink href="/register">{t('register')}</AccountLink>
          </div>
        </nav>
      )}
    </header>
  );
}
