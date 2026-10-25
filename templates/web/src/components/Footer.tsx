import { localizedHref, type PublicSiteSettings } from '@/features/content/types';
export function Footer({ site, locale }: { site: PublicSiteSettings; locale: string }) {
  return (
    <footer className="border-t border-[var(--color-border)] py-10 px-6">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between gap-6">
        <div>
          <p className="font-semibold mb-2">{site.name}</p>
          <p className="max-w-md text-sm text-[var(--color-muted)]">{site.description}</p>
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            &copy; {new Date().getFullYear()} {site.name}
          </p>
        </div>
        <nav
          aria-label={locale === 'zh' ? '页脚导航' : 'Footer navigation'}
          className="flex flex-wrap gap-5 text-sm text-[var(--color-muted)]"
        >
          {site.footerLinks.map((link, index) => (
            <a
              className="hover:text-primary-500"
              key={index}
              href={localizedHref(link.href, locale)}
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
