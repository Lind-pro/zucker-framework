import { useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { panelClass, secondaryButtonClass } from '@/features/billing/components';
import { creditCopy } from './copy';

export function AccountCreditsLink() {
  const text = creditCopy(useLocale());
  return <section className={`${panelClass} flex flex-wrap items-center justify-between gap-4`} aria-label={text.title}>
    <div><h2 className="text-xl font-semibold">{text.title}</h2><p className="mt-2 text-sm text-[var(--color-muted)]">{text.accountDescription}</p></div>
    <Link href="/account/credits" className={secondaryButtonClass}>{text.open}</Link>
  </section>;
}
