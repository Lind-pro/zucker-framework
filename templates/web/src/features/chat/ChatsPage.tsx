'use client';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { FormMessage, buttonClass, panelClass, secondaryButtonClass } from '@/features/billing/components';
import { aiFailureKind } from '@/features/ai/errors';
import { AccountScopePending, useAccountScope } from '@/features/ai/useAccountScope';
import { chatApi } from './api';
import { chatCopy } from './copy';
import type { ChatSummary } from './types';

/** Console list of the caller's chats (`GET /chat`, cursor pages) with delete. */
export default function ChatsPage() {
  const scope = useAccountScope();
  return scope === null ? <AccountScopePending /> : <ChatList key={scope} />;
}

function ChatList() {
  const locale = useLocale(),
    text = chatCopy(locale);
  const [items, setItems] = useState<ChatSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [revision, setRevision] = useState(0);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    chatApi.list({ limit: 30 }).then(
      (page) => {
        if (!active) return;
        setItems(page.items);
        setNext(page.next);
        setState('ready');
      },
      () => active && setState('failed'),
    );
    return () => {
      active = false;
    };
  }, [revision]);

  const date = (value: string) =>
    Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
      : '—';
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);

  async function remove(chatId: string) {
    setBusy(chatId);
    setError('');
    try {
      await chatApi.remove(chatId);
      setItems((previous) => previous.filter((item) => item.id !== chatId));
      setConfirm('');
    } catch (failure) {
      setError(aiFailureKind(failure) === 'busy' ? text.list.busy : text.list.deleteFailed);
    } finally {
      setBusy('');
    }
  }

  async function loadMore() {
    if (!next) return;
    try {
      const page = await chatApi.list({ limit: 30, before: next });
      setItems((previous) => [...previous, ...page.items.filter((item) => !previous.some((known) => known.id === item.id))]);
      setNext(page.next);
    } catch {
      setState('failed');
    }
  }

  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{text.list.title}</h1>
          <p className="mt-3 text-[var(--color-muted)]">{text.list.description}</p>
        </div>
        <Link href="/chat" className={secondaryButtonClass}>
          {text.list.start}
        </Link>
      </header>
      {state === 'loading' && <FormMessage message={text.loading} />}
      {state === 'failed' && (
        <section className={`${panelClass} space-y-4`}>
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
        </section>
      )}
      {error && <FormMessage message={error} error />}
      {state === 'ready' &&
        (items.length === 0 ? (
          <section className={`${panelClass} text-sm text-[var(--color-muted)]`}>{text.list.empty}</section>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id} className={`${panelClass} flex flex-wrap items-center justify-between gap-4`}>
                <div className="min-w-0">
                  <Link href={{ pathname: '/chat', query: { c: item.id } }} className="block truncate font-medium hover:underline">
                    {item.title || text.untitled}
                  </Link>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {item.model} · {text.list.messages(item.messageCount)} · {text.cost(number(item.cost))} · {text.list.updated}{' '}
                    <time dateTime={item.updatedAt}>{date(item.updatedAt)}</time>
                  </p>
                </div>
                <div className="flex gap-2">
                  <Link href={{ pathname: '/chat', query: { c: item.id } }} className={secondaryButtonClass}>
                    {text.list.open}
                  </Link>
                  {confirm === item.id ? (
                    <>
                      <button type="button" className={secondaryButtonClass} disabled={busy === item.id} onClick={() => setConfirm('')}>
                        {text.list.cancel}
                      </button>
                      <button
                        type="button"
                        className={`${secondaryButtonClass} border-red-500/40 text-red-300`}
                        disabled={busy === item.id}
                        onClick={() => void remove(item.id)}
                      >
                        {text.list.confirm}
                      </button>
                    </>
                  ) : (
                    <button type="button" className={secondaryButtonClass} onClick={() => setConfirm(item.id)}>
                      {text.list.delete}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ))}
      {state === 'ready' && next && (
        <button type="button" className={secondaryButtonClass} onClick={() => void loadMore()}>
          {text.loadMore}
        </button>
      )}
    </div>
  );
}
