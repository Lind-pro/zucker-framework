'use client';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { FormMessage, buttonClass, panelClass, secondaryButtonClass } from '@/features/billing/components';
import { AccountScopePending, useAccountScope } from '@/features/ai/useAccountScope';
import { feedbackApi } from './api';
import { feedbackCopy } from './copy';
import { FeedbackForm } from './FeedbackForm';
import { feedbackEnabled } from './form-state';
import type { FeedbackItem } from './types';

const PAGE_SIZE = 10;

/** `/account/feedback`: the form (hidden when the `feedback` policy is off) and the caller's own items with replies. */
export default function FeedbackPage() {
  const scope = useAccountScope();
  return scope === null ? <AccountScopePending /> : <FeedbackView key={scope} />;
}

function FeedbackView() {
  const locale = useLocale(),
    text = feedbackCopy(locale);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    feedbackApi.publicConfig().then(
      (config) => active && setEnabled(feedbackEnabled(config)),
      // The server enforces the switch; an unreadable config shows the form.
      () => active && setEnabled(true),
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    feedbackApi.mine({ page, pageSize: PAGE_SIZE }, controller.signal).then(
      (result) => {
        setItems(Array.isArray(result?.data) ? result.data : []);
        setTotal(typeof result?.total === 'number' ? result.total : 0);
        setState('ready');
      },
      () => !controller.signal.aborted && setState('failed'),
    );
    return () => controller.abort();
  }, [page, revision]);

  const date = (value: string | null) =>
    value && Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
      : '—';
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-7">
      <header className="border-b border-[var(--color-border)] pb-6">
        <h1 className="text-3xl font-bold tracking-tight">{text.title}</h1>
        <p className="mt-3 max-w-2xl text-[var(--color-muted)]">{text.description}</p>
      </header>
      {enabled === true && (
        <FeedbackForm
          onSent={() => {
            setPage(1);
            setRevision((value) => value + 1);
          }}
        />
      )}
      {enabled === false && <section className={`${panelClass} text-sm text-[var(--color-muted)]`}>{text.disabled}</section>}

      <section className="space-y-4" aria-labelledby="feedback-history">
        <h2 id="feedback-history" className="text-xl font-semibold">
          {text.history}
        </h2>
        {state === 'loading' && <FormMessage message={text.loading} />}
        {state === 'failed' && (
          <div className={`${panelClass} space-y-4`}>
            <FormMessage message={text.loadFailed} error />
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setState('loading');
                setRevision((value) => value + 1);
              }}
            >
              {text.retry}
            </button>
          </div>
        )}
        {state === 'ready' &&
          (items.length === 0 ? (
            <p className={`${panelClass} text-sm text-[var(--color-muted)]`}>{text.empty}</p>
          ) : (
            <ul className="space-y-3">
              {items.map((item) => (
                <li key={item.id} className={`${panelClass} space-y-3`} data-feedback-id={item.id}>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
                    <span className="rounded-full border border-[var(--color-border)] px-2.5 py-0.5 font-medium">{text.types[item.type] ?? item.type}</span>
                    <span className="rounded-full border border-[var(--color-border)] px-2.5 py-0.5">{text.status[item.status] ?? item.status}</span>
                    <span>
                      {text.sentOn} <time dateTime={item.createdAt}>{date(item.createdAt)}</time>
                    </span>
                  </div>
                  {/* Plain text only: user and staff text is never interpreted as HTML or markdown. */}
                  <p className="whitespace-pre-wrap break-words text-sm">{item.message}</p>
                  <div className="rounded-lg border border-[var(--color-border)] p-3 text-sm">
                    <p className="font-medium">{text.reply}</p>
                    {item.reply ? (
                      <>
                        <p className="mt-1 whitespace-pre-wrap break-words">{item.reply}</p>
                        <p className="mt-2 text-xs text-[var(--color-muted)]">
                          {text.repliedOn} <time dateTime={item.repliedAt ?? undefined}>{date(item.repliedAt)}</time>
                        </p>
                      </>
                    ) : (
                      <p className="mt-1 text-[var(--color-muted)]">{text.noReply}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ))}
        {state === 'ready' && pages > 1 && (
          <div className="flex items-center gap-3">
            <button type="button" className={secondaryButtonClass} disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
              {text.previous}
            </button>
            <span className="text-sm text-[var(--color-muted)]">
              {page} / {pages}
            </span>
            <button type="button" className={secondaryButtonClass} disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
              {text.next}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
