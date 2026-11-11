'use client';
import { useEffect, useReducer, useState } from 'react';
import { useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { FormMessage, buttonClass, panelClass, secondaryButtonClass } from '@/features/billing/components';
import { AccountScopePending, useAccountScope } from '@/features/ai/useAccountScope';
import { inboxApi } from './api';
import { describeNotification, inboxCopy } from './copy';
import { INBOX_CHANGED_EVENT, INBOX_PAGE_SIZE, inboxReducer, initialInboxState, pageCount, safeHref } from './inbox-state';
import type { InboxItem } from './types';

const announce = () => window.dispatchEvent(new Event(INBOX_CHANGED_EVENT));

/** `/account/notifications`: the caller's notifications with unread filter, read, read-all and archive. */
export default function InboxPage() {
  const scope = useAccountScope();
  return scope === null ? <AccountScopePending /> : <InboxList key={scope} />;
}

function InboxList() {
  const locale = useLocale(),
    text = inboxCopy(locale);
  const [state, dispatch] = useReducer(inboxReducer, initialInboxState);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const pages = pageCount(state);

  useEffect(() => {
    let active = true;
    inboxApi.list({ page: state.page, pageSize: INBOX_PAGE_SIZE, unread: state.unreadOnly }).then(
      (page) => active && dispatch({ type: 'loaded', page }),
      () => active && dispatch({ type: 'failed' }),
    );
    return () => {
      active = false;
    };
  }, [state.page, state.unreadOnly, revision]);

  const date = (value: string) =>
    Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
      : '—';

  async function act(key: string, work: () => Promise<void>) {
    setBusy(key);
    setError('');
    try {
      await work();
      announce();
    } catch {
      setError(text.actionFailed);
    } finally {
      setBusy('');
    }
  }

  const markRead = (item: InboxItem) =>
    act(item.id, async () => {
      const updated = await inboxApi.read(item.id);
      dispatch({ type: 'read', id: item.id, readAt: updated.readAt ?? new Date().toISOString() });
    });
  const archive = (item: InboxItem) =>
    act(item.id, async () => {
      await inboxApi.archive(item.id);
      dispatch({ type: 'archived', id: item.id });
      // The last row of a later page went away: show the previous page instead of an empty one.
      if (state.items.length === 1 && state.page > 1) dispatch({ type: 'load', page: state.page - 1, unreadOnly: state.unreadOnly });
    });
  const readAll = () =>
    act('all', async () => {
      await inboxApi.readAll();
      dispatch({ type: 'readAll', readAt: new Date().toISOString() });
    });
  const filter = (unreadOnly: boolean) => {
    if (unreadOnly !== state.unreadOnly) dispatch({ type: 'load', page: 1, unreadOnly });
  };

  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{text.title}</h1>
          <p className="mt-3 text-[var(--color-muted)]">{text.description}</p>
        </div>
        <button type="button" className={secondaryButtonClass} disabled={busy !== '' || state.unreadCount === 0} onClick={readAll}
          data-testid="inbox-read-all">
          {text.markAllRead}
        </button>
      </header>
      <div role="group" className="flex gap-2">
        {[false, true].map((unreadOnly) => (
          <button key={String(unreadOnly)} type="button" aria-pressed={state.unreadOnly === unreadOnly} onClick={() => filter(unreadOnly)}
            className={`rounded-lg border px-3 py-1.5 text-sm ${state.unreadOnly === unreadOnly
              ? 'border-primary-600 bg-primary-600 text-white' : 'border-[var(--color-border)] hover:bg-[var(--color-card)]'}`}>
            {unreadOnly ? `${text.unread}${state.unreadCount ? ` (${state.unreadCount})` : ''}` : text.all}
          </button>
        ))}
      </div>
      {state.status === 'loading' && <FormMessage message={text.loading} />}
      {state.status === 'failed' && (
        <section className={`${panelClass} space-y-4`}>
          <FormMessage message={text.loadFailed} error />
          <button type="button" className={buttonClass} onClick={() => {
            dispatch({ type: 'load', page: state.page, unreadOnly: state.unreadOnly });
            setRevision((value) => value + 1);
          }}>
            {text.retry}
          </button>
        </section>
      )}
      {error && <FormMessage message={error} error />}
      {state.status === 'ready' &&
        (state.items.length === 0 ? (
          <section className={`${panelClass} text-sm text-[var(--color-muted)]`}>{state.unreadOnly ? text.emptyUnread : text.empty}</section>
        ) : (
          <ul className="space-y-3" data-testid="inbox-list">
            {state.items.map((item) => {
              const line = describeNotification(locale, item.type, item.params);
              const href = safeHref(item.href);
              return (
                <li key={item.id} data-read={item.isRead ? 'true' : 'false'}
                  className={`${panelClass} flex flex-wrap items-start justify-between gap-4 ${item.isRead ? 'opacity-75' : ''}`}>
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      {!item.isRead && (
                        <span className="rounded-full bg-primary-600 px-2 py-0.5 text-[11px] font-semibold text-white">{text.unreadBadge}</span>
                      )}
                      {line.title}
                    </p>
                    <p className="mt-1 text-sm text-[var(--color-muted)]">{line.body}</p>
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      <time dateTime={item.createdAt}>{date(item.createdAt)}</time>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {href && (
                      <Link href={href} className={secondaryButtonClass} onClick={() => { if (!item.isRead) void markRead(item); }}>
                        {text.open}
                      </Link>
                    )}
                    {!item.isRead && (
                      <button type="button" className={secondaryButtonClass} disabled={busy !== ''} onClick={() => markRead(item)}>
                        {text.markRead}
                      </button>
                    )}
                    <button type="button" className={secondaryButtonClass} disabled={busy !== ''} onClick={() => archive(item)}>
                      {text.archive}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ))}
      {state.status === 'ready' && pages > 1 && (
        <nav className="flex items-center justify-between gap-4 text-sm">
          <button type="button" className={secondaryButtonClass} disabled={state.page <= 1}
            onClick={() => dispatch({ type: 'load', page: state.page - 1, unreadOnly: state.unreadOnly })}>
            {text.previous}
          </button>
          <span className="text-[var(--color-muted)]">{text.page(state.page, pages)}</span>
          <button type="button" className={secondaryButtonClass} disabled={state.page >= pages}
            onClick={() => dispatch({ type: 'load', page: state.page + 1, unreadOnly: state.unreadOnly })}>
            {text.next}
          </button>
        </nav>
      )}
    </div>
  );
}
