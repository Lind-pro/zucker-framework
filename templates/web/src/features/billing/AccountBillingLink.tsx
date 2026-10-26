import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { panelClass, secondaryButtonClass } from './components';

export function AccountBillingLink() {
  const t = useTranslations('billing');
  return <section className={`${panelClass} flex flex-wrap items-center justify-between gap-4`} aria-label={t('accountBillingTitle')}>
    <div><h2 className="text-xl font-semibold">{t('accountBillingTitle')}</h2><p className="mt-2 text-sm text-[var(--color-muted)]">{t('accountBillingDescription')}</p></div>
    <div className="flex flex-wrap gap-3"><Link href="/billing/orders" className={secondaryButtonClass}>{t('myOrders')}</Link>
      <Link href="/billing/subscriptions" className={secondaryButtonClass}>{t('mySubscriptions')}</Link></div>
  </section>;
}
