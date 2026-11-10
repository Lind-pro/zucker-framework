'use client';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { readSseStream } from '@zucker-framework/fe-http-client';
import { Link } from '@/i18n/navigation';
import { inputClass } from '@/app/[locale]/account/_components/AccountForm';
import { FormMessage, buttonClass, panelClass, secondaryButtonClass } from '@/features/billing/components';
import { aiApi, announceCreditsChanged } from '@/features/ai/api';
import { aiFailureKind, failureInfo } from '@/features/ai/errors';
import { CreditsNotice } from '@/features/ai/GeneratorPage';
import { AccountScopePending, useAccountScope } from '@/features/ai/useAccountScope';
import type { AICatalog, ChatCatalogEntry } from '@/features/ai/types';
import { chatApi } from './api';
import { chatReducer, initialChatState, isStreaming, parseSseData } from './chat-state';
import { chatCopy, type ChatCopy } from './copy';
import { renderChatMarkdown } from './markdown';
import type { ChatMessage, ChatSummary } from './types';

export const MESSAGE_MAX = 8000;
/** Abort a turn whose stream has been silent this long (the server sends tokens continuously). */
const STREAM_IDLE_MS = 120_000;
const CHAT_ID = /^[A-Za-z0-9-]{1,80}$/;
const entryKey = (entry: { providerId: string; model: string }) => `${entry.providerId}\n${entry.model}`;

export default function ChatPage() {
  const scope = useAccountScope();
  return scope === null ? <AccountScopePending /> : <Chat key={scope} />;
}

function Chat() {
  const locale = useLocale(),
    text = chatCopy(locale);
  const params = useSearchParams();
  const [initialId] = useState(() => {
    const value = params.get('c');
    return value && CHAT_ID.test(value) ? value : null;
  });
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [activeId, setActiveId] = useState<string | null>(initialId);
  /** Which chat to fetch; changes only when the user opens one (not when a send creates one). */
  const [loadTarget, setLoadTarget] = useState<{ id: string; revision: number; keepError?: boolean } | null>(initialId ? { id: initialId, revision: 0 } : null);
  const [view, setView] = useState<'idle' | 'loading' | 'failed'>(initialId ? 'loading' : 'idle');
  const [sessions, setSessions] = useState<ChatSummary[] | null>(null);
  const [sessionsNext, setSessionsNext] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<AICatalog | null>(null);
  const [modelKey, setModelKey] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const streaming = isStreaming(state);

  const refreshBalance = useCallback(() => {
    aiApi.balance().then(setBalance, () => setBalance(null));
  }, []);
  const refreshSessions = useCallback(() => {
    chatApi.list({ limit: 30 }).then(
      (page) => {
        setSessions(page.items);
        setSessionsNext(page.next);
      },
      () => setSessions((previous) => previous ?? []),
    );
  }, []);

  useEffect(() => {
    let active = true;
    aiApi.catalog().then(
      (value) => {
        if (!active) return;
        setCatalog(value);
        const first = value.chat.find((entry) => entry.available);
        setModelKey((previous) => previous || (first ? entryKey(first) : ''));
      },
      () => undefined,
    );
    refreshBalance();
    refreshSessions();
    return () => {
      active = false;
    };
  }, [refreshBalance, refreshSessions]);

  useEffect(() => {
    if (!loadTarget) return;
    const controller = new AbortController();
    chatApi.get(loadTarget.id, controller.signal).then(
      (detail) => {
        if (controller.signal.aborted) return;
        dispatch({ type: 'load', messages: detail.messages, keepError: loadTarget.keepError });
        setModelKey(entryKey(detail));
        setView('idle');
      },
      () => {
        if (!controller.signal.aborted) setView('failed');
      },
    );
    return () => controller.abort();
  }, [loadTarget]);

  // Keep the newest text in view while it streams.
  const last = state.messages.at(-1);
  const tail = `${state.messages.length}:${last?.content.length ?? 0}:${last?.reasoning?.length ?? 0}`;
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [tail]);

  // Leaving the page stops the turn; the server settles what was delivered.
  useEffect(() => () => abort.current?.abort(), []);

  const entries: ChatCatalogEntry[] = catalog?.chat ?? [];
  const entry = entries.find((item) => entryKey(item) === modelKey && item.available);
  const pricing = catalog?.chatPricing;
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
  const insufficient = balance !== null && pricing !== undefined && pricing.minimum > 0 && balance < pricing.minimum;

  function replaceUrl(chatId: string | null) {
    const url = new URL(window.location.href);
    if (chatId) url.searchParams.set('c', chatId);
    else url.searchParams.delete('c');
    window.history.replaceState(window.history.state, '', url.pathname + url.search);
  }

  function openChat(chatId: string | null) {
    if (streaming) return;
    setActiveId(chatId);
    replaceUrl(chatId);
    dispatch({ type: 'load', messages: [] });
    if (chatId) {
      setView('loading');
      setLoadTarget((previous) => ({ id: chatId, revision: (previous?.revision ?? 0) + 1 }));
    } else {
      setView('idle');
      setLoadTarget(null);
    }
  }

  async function send() {
    const content = draft.trim();
    if (!content || content.length > MESSAGE_MAX || streaming || view !== 'idle') return;
    const model = entry ? { providerId: entry.providerId, model: entry.model } : {};
    const controller = new AbortController();
    abort.current = controller;
    setDraft('');
    dispatch({ type: 'send', content, localId: `${Date.now()}` });
    let chatId = activeId;
    try {
      if (!chatId) {
        const created = await chatApi.create(model);
        chatId = created.id;
        setActiveId(created.id);
        replaceUrl(created.id);
        setSessions((previous) => [created, ...(previous ?? []).filter((item) => item.id !== created.id)]);
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await chatApi.send(chatId, { content, ...model }, controller.signal);
      await readSseStream(response, {
        idleTimeoutMs: STREAM_IDLE_MS,
        onEvent: (event) => {
          if (!event.isComment) dispatch({ type: 'event', event: event.event, data: parseSseData(event.data) });
        },
      });
      // No-op after `done`/`error`; otherwise the stream closed early.
      dispatch({ type: 'ended' });
    } catch (error) {
      const { status } = failureInfo(error);
      if (controller.signal.aborted) dispatch({ type: 'stopped' });
      else if (status !== undefined) {
        dispatch({ type: 'rejected', reason: aiFailureKind(error) });
        // Refused before anything was stored: give the text back. A 5xx may have stored the turn.
        if (status < 500) setDraft(content);
        else if (chatId) setLoadTarget((previous) => ({ id: chatId!, revision: (previous?.revision ?? 0) + 1, keepError: true }));
      } else dispatch({ type: 'ended' });
    } finally {
      if (abort.current === controller) abort.current = null;
      announceCreditsChanged();
      refreshBalance();
      refreshSessions();
    }
  }

  async function moreSessions() {
    if (!sessionsNext) return;
    try {
      const page = await chatApi.list({ limit: 30, before: sessionsNext });
      setSessions((previous) => [...(previous ?? []), ...page.items.filter((item) => !previous?.some((known) => known.id === item.id))]);
      setSessionsNext(page.next);
    } catch {
      /* the button stays; the user can retry */
    }
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 lg:flex-row lg:px-6">
      <aside className="space-y-3 lg:w-64 lg:shrink-0" aria-label={text.sessions}>
        <button type="button" className={`${buttonClass} w-full`} disabled={streaming} onClick={() => openChat(null)}>
          {text.newChat}
        </button>
        <nav className="max-h-[60vh] space-y-1 overflow-y-auto lg:max-h-[calc(100vh-12rem)]">
          {sessions === null ? (
            <FormMessage message={text.loading} />
          ) : sessions.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">{text.noSessions}</p>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                disabled={streaming}
                aria-current={session.id === activeId ? 'page' : undefined}
                onClick={() => openChat(session.id)}
                className={`block w-full truncate rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--color-card)] disabled:opacity-60 ${
                  session.id === activeId ? 'bg-[var(--color-card)] font-medium text-primary-400' : ''
                }`}
              >
                {session.title || text.untitled}
              </button>
            ))
          )}
          {sessionsNext && (
            <button type="button" className="w-full px-3 py-2 text-left text-xs text-primary-400 hover:underline" onClick={() => void moreSessions()}>
              {text.loadMore}
            </button>
          )}
        </nav>
        <Link href="/account/chats" className="block px-3 text-xs text-[var(--color-muted)] hover:underline">
          {text.allChats}
        </Link>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--color-border)] pb-4">
          <h1 className="text-2xl font-bold tracking-tight">{text.title}</h1>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {entries.length > 0 && (
              <label className="flex items-center gap-2 text-[var(--color-muted)]">
                {text.model}
                <select
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm text-[var(--color-foreground)]"
                  value={entry ? modelKey : ''}
                  disabled={streaming}
                  onChange={(event) => setModelKey(event.target.value)}
                >
                  {!entry && <option value="">—</option>}
                  {entries.map((item) => (
                    <option key={entryKey(item)} value={entryKey(item)} disabled={!item.available}>
                      {item.label || item.model}
                      {item.available ? '' : ` (${text.unavailable})`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {balance !== null && (
              <span className="text-[var(--color-muted)]" data-testid="chat-balance">
                {text.balance(number(balance))}
              </span>
            )}
          </div>
          {pricing && pricing.per1kOutputTokens > 0 && (
            <p className="w-full text-xs text-[var(--color-muted)]">{text.pricing(number(pricing.per1kOutputTokens), number(pricing.minimum))}</p>
          )}
        </header>
        <div className={`${panelClass} min-h-[40vh] flex-1 space-y-5 overflow-y-auto`} aria-live="polite" aria-busy={streaming}>
          {view === 'loading' && <FormMessage message={text.loading} />}
          {view === 'failed' && (
            <div className="space-y-3">
              <FormMessage message={text.loadFailed} error />
              <button type="button" className={secondaryButtonClass} onClick={() => openChat(activeId)}>
                {text.retry}
              </button>
            </div>
          )}
          {view === 'idle' && state.messages.length === 0 && <p className="text-sm text-[var(--color-muted)]">{text.empty}</p>}
          {view === 'idle' && state.messages.map((message) => <Message key={message.id} message={message} text={text} number={number} />)}
          <div ref={bottom} />
        </div>
        {state.error &&
          (state.error === 'credits' ? (
            <CreditsNotice text={text} message={text.errors.credits} />
          ) : (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              <span>{text.errors[state.error] ?? text.errors.uncertain}</span>
              <button type="button" className="text-xs hover:underline" onClick={() => dispatch({ type: 'dismiss' })}>
                {text.dismiss}
              </button>
            </div>
          ))}
        {insufficient && !state.error && <CreditsNotice text={text} message={text.errors.credits} />}
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor="chat-message" className="sr-only">
            {text.message}
          </label>
          <textarea
            id="chat-message"
            rows={3}
            maxLength={MESSAGE_MAX}
            className={`${inputClass} flex-1 resize-y`}
            placeholder={text.placeholder}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter and IME composition (Chinese input) keep typing.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {streaming ? (
            <button type="button" className={secondaryButtonClass} onClick={() => abort.current?.abort()}>
              {text.stop}
            </button>
          ) : (
            <button className={buttonClass} disabled={!draft.trim() || view !== 'idle'}>
              {text.send}
            </button>
          )}
        </form>
      </section>
    </div>
  );
}

function Message({ message, text, number }: { message: ChatMessage; text: ChatCopy; number: (value: number) => string }) {
  const html = useMemo(() => (message.role === 'assistant' && message.content ? renderChatMarkdown(message.content) : ''), [message.role, message.content]);
  if (message.role === 'user')
    return (
      <article className="ml-auto max-w-[85%] rounded-2xl bg-primary-600/15 px-4 py-3" data-role="user">
        <h2 className="sr-only">{text.you}</h2>
        <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
      </article>
    );
  const streaming = message.status === 'STREAMING';
  return (
    <article className="max-w-full space-y-2" data-role="assistant" data-status={message.status}>
      <h2 className="sr-only">{text.assistant}</h2>
      {message.reasoning && (
        <details className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted)]" open={streaming && !message.content}>
          <summary className="cursor-pointer select-none">{text.reasoning}</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{message.reasoning}</p>
        </details>
      )}
      {html ? (
        // HTML is disabled in the renderer and links pass safeSiteHref; images are not rendered.
        <div className="chat-markdown prose-sm max-w-none break-words text-sm leading-relaxed [&_a]:text-primary-400 [&_a]:underline [&_code]:rounded [&_code]:bg-[var(--color-background)] [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--color-background)] [&_pre]:p-3 [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: html }} />
      ) : streaming ? (
        <p className="animate-pulse text-sm text-[var(--color-muted)]">{text.thinking}</p>
      ) : null}
      <p className="text-xs text-[var(--color-muted)]">
        {message.status === 'ABORTED' && <span>{text.stopped} </span>}
        {message.status === 'FAILED' && <span className="text-red-300">{text.errors[message.errorCode ?? ''] ?? text.failed} </span>}
        {!streaming && typeof message.cost === 'number' && message.cost > 0 && <span>{text.cost(number(message.cost))}</span>}
      </p>
    </article>
  );
}
