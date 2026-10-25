'use client';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link, useRouter } from '@/i18n/navigation';
import { httpClient } from '@/lib/http-client';
import { FormMessage, buttonClass, panelClass, secondaryButtonClass } from '@/features/billing/components';
import { creditCopy } from './copy';
import { creditTypes, type CreditBalance, type CreditLot, type CreditPage, type CreditTransaction } from './types';

export default function CreditsPage() {
  const query = useSearchParams(), locale = useLocale();
  const requested = Number(query.get('page') ?? 1), page = Number.isSafeInteger(requested) && requested >= 1 && requested <= 10000 ? requested : 1;
  const view = query.get('view') === 'lots' ? 'lots' : 'transactions', requestedType = query.get('type');
  const type = creditTypes.find(value => value === requestedType) ?? '';
  return <CreditRecords key={`${locale}:${view}:${type}:${page}`} page={page} view={view} type={type} />;
}
function CreditRecords({ page, view, type }: { page: number; view: 'transactions' | 'lots'; type: string }) {
  const locale = useLocale(), text = creditCopy(locale), router = useRouter();
  const [balance, setBalance] = useState<CreditBalance | null>(null), [result, setResult] = useState<CreditPage<CreditTransaction | CreditLot> | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.all([httpClient.get<CreditBalance>('/credits/balance'), httpClient.get<CreditPage<CreditTransaction | CreditLot>>(`/credits/${view}`,
      { page, pageSize: 20, ...(view === 'transactions' && type ? { type } : {}) })])
      .then(([current, records]) => { if (active) { setBalance(current); setResult(records); } })
      .catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [view, page, type, revision]);
  const date = (value: string | null) => value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : text.noDate;
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const pages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
  const href = (next: number) => ({ pathname: '/account/credits', query: { view, ...(view === 'transactions' && type ? { type } : {}), page: next } });
  return <div className="mx-auto max-w-6xl space-y-7 px-6 py-10">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] pb-6">
      <div><h1 className="text-3xl font-bold tracking-tight">{text.title}</h1><p className="mt-3 text-[var(--color-muted)]">{text.description}</p></div>
      <Link href="/pricing" className={secondaryButtonClass}>{text.plans}</Link>
    </header>
    {loading && <FormMessage message={text.loading} />}
    {error && <section className={`${panelClass} space-y-4`}><FormMessage message={text.failed} error /><button className={buttonClass} onClick={() => {
      setError(false); setLoading(true); setRevision(value => value + 1);
    }}>{text.retry}</button></section>}
    {balance && <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {([{ key: 'available', label: text.available, hint: text.availableHint }, { key: 'frozen', label: text.frozen, hint: text.frozenHint },
        { key: 'refundBlocked', label: text.refundBlocked, hint: text.refundBlockedHint },
        { key: 'expired', label: text.expired, hint: text.expiredHint }] as const).map(item => <div key={item.key} className={panelClass}>
        <dt className="text-sm text-[var(--color-muted)]">{item.label}</dt><dd className={`mt-3 text-4xl font-semibold tabular-nums ${item.key === 'available' ? 'text-primary-400' : ''}`}>{number(item.key === 'refundBlocked' ? balance.refundBlocked ?? 0 : balance[item.key])}</dd>
        <p className="mt-3 text-xs leading-relaxed text-[var(--color-muted)]">{item.hint}</p>
      </div>)}
    </dl>}
    <div className="flex flex-wrap items-center justify-between gap-4"><nav className="flex gap-2" aria-label={text.views}>
      {(['transactions', 'lots'] as const).map(tab => <Link key={tab} href={{ pathname: '/account/credits', query: { view: tab } }} aria-current={view === tab ? 'page' : undefined}
        className={`${secondaryButtonClass} ${view === tab ? 'border-primary-500 text-primary-400' : ''}`}>{text[tab]}</Link>)}
    </nav>{view === 'transactions' && <div className="flex items-center gap-3"><label htmlFor="credit-type" className="text-sm text-[var(--color-muted)]">{text.filter}</label>
      <select id="credit-type" className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm" value={type} onChange={event => {
        router.push({ pathname: '/account/credits', query: { view, ...(event.target.value ? { type: event.target.value } : {}) } });
      }}><option value="">{text.all}</option>{creditTypes.map(value => <option key={value} value={value}>{text.typeNames[value]}</option>)}</select>
    </div>}</div>
    {result && <>
      {result.data.length ? <>
        <div className="space-y-3 sm:hidden">{result.data.map(item => view === 'transactions' ? (() => {
          const row = item as CreditTransaction;
          return <article key={row.id} className={`${panelClass} space-y-3`}><div className="flex items-start justify-between gap-4">
            <div><h2 className="font-medium">{text.typeNames[row.type] ?? row.type}</h2><time className="mt-1 block text-xs text-[var(--color-muted)]" dateTime={row.createdAt}>{date(row.createdAt)}</time></div>
            <p className={`text-xl font-semibold tabular-nums ${row.amount > 0 ? 'text-emerald-400' : ''}`}>{row.amount > 0 ? '+' : ''}{number(row.amount)}</p></div>
            <p className="text-sm">{row.description || text.noDate}</p><p className="text-xs text-[var(--color-muted)]">{text.balance}: {number(row.balanceAfter ?? row.balance)}</p>
            {row.frozenBalanceBefore != null && row.frozenBalanceAfter != null && row.frozenBalanceBefore !== row.frozenBalanceAfter && <p className="text-xs text-[var(--color-muted)]">{text.frozen}: {number(row.frozenBalanceBefore)} → {number(row.frozenBalanceAfter)}</p>}
            {row.orderId && <Link className="inline-block text-sm text-primary-400" href={{ pathname: '/billing/return', query: { order: row.orderId } }}>{text.order}</Link>}
            {row.references.subscriptionId && <Link className="block text-sm text-primary-400" href={`/billing/subscriptions/${encodeURIComponent(row.references.subscriptionId)}`}>{text.subscription}</Link>}
            <p className="break-all font-mono text-[10px] text-[var(--color-muted)]">{row.id}</p></article>;
        })() : (() => {
          const row = item as CreditLot;
          return <article key={row.id} className={`${panelClass} space-y-4`}><div className="flex items-start justify-between gap-3"><h2 className="font-medium">{row.description || text.sourceNames[row.source] || row.source}</h2><span className="shrink-0 text-xs text-[var(--color-muted)]">{text.stateNames[row.status]}</span></div>
            <dl className="grid grid-cols-2 gap-4 text-sm"><div><dt className="text-xs text-[var(--color-muted)]">{text.issued}</dt><dd className="mt-1 font-semibold tabular-nums">{number(row.amount)}</dd></div>
              <div><dt className="text-xs text-[var(--color-muted)]">{text.available}</dt><dd className="mt-1 font-semibold tabular-nums">{number(row.availableAmount)}</dd></div>
              <div><dt className="text-xs text-[var(--color-muted)]">{text.frozen}</dt><dd className="mt-1 font-semibold tabular-nums">{number(row.frozenAmount ?? 0)}</dd></div>
              <div><dt className="text-xs text-[var(--color-muted)]">{text.refundBlocked}</dt><dd className="mt-1 font-semibold tabular-nums">{number(row.refundBlockedAmount ?? 0)}</dd></div>
              <div className="col-span-2"><dt className="text-xs text-[var(--color-muted)]">{text.expiresAt}</dt><dd className="mt-1">{row.expiresAt ? date(row.expiresAt) : text.never}</dd></div></dl>
            <p className="break-all font-mono text-[10px] text-[var(--color-muted)]">{row.id}</p></article>;
        })())}</div>
        <div className="hidden overflow-x-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] sm:block">
        <table className="w-full min-w-[700px] text-left text-sm"><caption className="sr-only">{text[view]}</caption>
          <thead className="border-b border-[var(--color-border)] text-xs text-[var(--color-muted)]"><tr>
            {(view === 'transactions' ? [text.time, text.type, text.change, text.balance, text.details] : [text.source, text.issued, text.available, text.frozen, text.refundBlocked, text.status, text.expiresAt]).map(label => <th key={label} scope="col" className="px-5 py-4 font-medium">{label}</th>)}
          </tr></thead><tbody className="divide-y divide-[var(--color-border)]">{result.data.map(item => view === 'transactions' ? (() => {
            const row = item as CreditTransaction;
            return <tr key={row.id}><td className="whitespace-nowrap px-5 py-4"><time dateTime={row.createdAt}>{date(row.createdAt)}</time></td>
              <td className="px-5 py-4">{text.typeNames[row.type] ?? row.type}</td><td className={`px-5 py-4 font-semibold tabular-nums ${row.amount > 0 ? 'text-emerald-400' : ''}`}>{row.amount > 0 ? '+' : ''}{number(row.amount)}</td>
              <td className="px-5 py-4 tabular-nums">{number(row.balanceAfter ?? row.balance)}
                {row.frozenBalanceBefore != null && row.frozenBalanceAfter != null && row.frozenBalanceBefore !== row.frozenBalanceAfter && <p className="mt-1 text-xs text-[var(--color-muted)]">{text.frozen}: {number(row.frozenBalanceBefore)} → {number(row.frozenBalanceAfter)}</p>}</td><td className="max-w-sm space-y-1 px-5 py-4"><p>{row.description || text.noDate}</p>
                {row.orderId && <Link className="block text-primary-400 hover:underline" href={{ pathname: '/billing/return', query: { order: row.orderId } }}>{text.order}</Link>}
                {row.references.subscriptionId && <Link className="block text-primary-400 hover:underline" href={`/billing/subscriptions/${encodeURIComponent(row.references.subscriptionId)}`}>{text.subscription}</Link>}
                <p className="break-all font-mono text-[10px] text-[var(--color-muted)]">{row.id}</p></td></tr>;
          })() : (() => {
            const row = item as CreditLot;
            return <tr key={row.id}><td className="max-w-sm px-5 py-4"><p>{row.description || text.sourceNames[row.source] || row.source}</p><p className="mt-1 break-all font-mono text-[10px] text-[var(--color-muted)]">{row.id}</p></td>
              <td className="px-5 py-4 tabular-nums">{number(row.amount)}</td><td className="px-5 py-4 font-semibold tabular-nums">{number(row.availableAmount)}</td><td className="px-5 py-4 tabular-nums">{number(row.frozenAmount ?? 0)}</td><td className="px-5 py-4 tabular-nums">{number(row.refundBlockedAmount ?? 0)}</td><td className="px-5 py-4">{text.stateNames[row.status]}</td>
              <td className="whitespace-nowrap px-5 py-4">{row.expiresAt ? <time dateTime={row.expiresAt}>{date(row.expiresAt)}</time> : text.never}</td></tr>;
          })())}</tbody>
        </table></div></> : <section className={`${panelClass} space-y-3`}><h2 className="text-xl font-semibold">{page > 1 ? text.emptyPage : view === 'transactions' ? text.noTransactions : text.noLots}</h2><p className="text-sm text-[var(--color-muted)]">{text.emptyDescription}</p></section>}
      <nav className="flex flex-wrap items-center justify-between gap-4" aria-label={text.pagination}>
        {page > 1 ? <Link href={href(page - 1)} className={secondaryButtonClass}>{text.previous}</Link> : <button disabled className={secondaryButtonClass}>{text.previous}</button>}
        <p className="text-sm text-[var(--color-muted)]">{text.pageLabel(result.page, pages, result.total)}</p>
        {page < pages ? <Link href={href(page + 1)} className={secondaryButtonClass}>{text.next}</Link> : <button disabled className={secondaryButtonClass}>{text.next}</button>}
      </nav>
    </>}
    <Link href="/account" className="inline-block text-sm text-primary-400 hover:underline">{text.back}</Link>
  </div>;
}
