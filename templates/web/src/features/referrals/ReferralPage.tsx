'use client';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { FormMessage, buttonClass, panelClass } from '@/features/billing/components';
import { referralApi } from './api';
import { referralCopy } from './copy';
import type { ReferralView } from './types';

/** `/account/referrals`: the user's invitation link, a copy button, stats and recent invitations (no identities). */
export default function ReferralPage() {
  const locale = useLocale(), text = referralCopy(locale);
  const [view, setView] = useState<ReferralView | null>(null);
  const [error, setError] = useState(false), [revision, setRevision] = useState(0);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    let active = true;
    referralApi.me().then((value) => { if (active) setView(value); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [revision]);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value)) : '';
  async function copy(link: string) {
    try { await navigator.clipboard.writeText(link); setCopied('done'); } catch { setCopied('failed'); }
  }
  return <div className="mx-auto max-w-4xl space-y-7 px-6 py-10">
    <header className="border-b border-[var(--color-border)] pb-6">
      <h1 className="text-3xl font-bold tracking-tight">{text.title}</h1>
      <p className="mt-3 text-[var(--color-muted)]">{text.description}</p>
    </header>
    {!view && !error && <FormMessage message={text.loading} />}
    {error && <section className={`${panelClass} space-y-4`}><FormMessage message={text.failed} error />
      <button className={buttonClass} onClick={() => { setError(false); setRevision((value) => value + 1); }}>{text.retry}</button></section>}
    {view && !view.enabled && <section className={panelClass}><p className="text-[var(--color-muted)]">{text.disabled}</p></section>}
    {view?.enabled && <>
      <section className={`${panelClass} space-y-4`}>
        {!view.codeActive ? <FormMessage message={text.codeInactive} error /> : view.link ? <>
          <label htmlFor="referral-link" className="text-sm text-[var(--color-muted)]">{text.link}</label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input id="referral-link" readOnly value={view.link} onFocus={(event) => event.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5 font-mono text-sm" />
            <button type="button" className={buttonClass} onClick={() => void copy(view.link!)}>{copied === 'done' ? text.copied : text.copy}</button>
          </div>
          {copied === 'failed' && <FormMessage message={text.copyFailed} error />}
        </> : <p className="text-sm text-[var(--color-muted)]">{text.noLink}</p>}
        <p className="text-sm">{text.code}: <span className="font-mono font-semibold tracking-wider">{view.code}</span></p>
        <p className="text-xs leading-relaxed text-[var(--color-muted)]">{text.rules}</p>
      </section>
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {([[text.invited, view.stats.invited], [text.rewarded, view.stats.rewarded], [text.earned, view.stats.creditsEarned]] as const).map(([label, value]) =>
          <div key={label} className={panelClass}><dt className="text-sm text-[var(--color-muted)]">{label}</dt>
            <dd className="mt-3 text-3xl font-semibold tabular-nums">{number(value)}</dd></div>)}
      </dl>
      <section className={`${panelClass} space-y-3`}>
        <h2 className="font-medium">{text.recent}</h2>
        {view.recent.length ? <ul className="divide-y divide-[var(--color-border)]">
          {view.recent.map((item, index) => <li key={`${item.boundAt}:${index}`} className="flex items-center justify-between gap-4 py-3 text-sm">
            <span className="text-[var(--color-muted)]">{text.joined} <time dateTime={item.boundAt}>{date(item.boundAt)}</time></span>
            <span className={item.status === 'granted' ? 'text-emerald-400' : ''}>{text.statusNames[item.status]}</span>
          </li>)}
        </ul> : <p className="text-sm text-[var(--color-muted)]">{text.none}</p>}
      </section>
    </>}
  </div>;
}
