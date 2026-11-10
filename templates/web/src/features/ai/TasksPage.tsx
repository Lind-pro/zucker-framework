'use client';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { FormMessage, buttonClass, panelClass, secondaryButtonClass } from '@/features/billing/components';
import { useAuthStore } from '@/lib/stores/auth-store';
import { aiApi } from './api';
import { aiCopy } from './copy';
import { TaskCard } from './TaskCard';
import { AI_MEDIA_KINDS, AI_SCENES, AI_TASK_STATUSES, type AIMediaKind, type AITaskStatus, type AITaskView } from './types';
import { useTaskPolling } from './useTaskPolling';

const selectClass = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-sm';

/** Console list of the caller's AI tasks (`GET /ai/tasks`, cursor pages, owner-scoped on the server). */
export default function TasksPage() {
  const identity = useAuthStore((state) => state.user?.id);
  return <TaskList key={typeof identity === 'string' ? identity : 'account'} />;
}

function TaskList() {
  const locale = useLocale(),
    text = aiCopy(locale);
  const [kind, setKind] = useState<AIMediaKind | ''>('');
  const [status, setStatus] = useState<AITaskStatus | ''>('');
  const [tasks, setTasks] = useState<AITaskView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [revision, setRevision] = useState(0);
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let active = true;
    aiApi
      .list({ limit: 20, ...(kind ? { kind } : {}), ...(status ? { status } : {}) })
      .then((page) => {
        if (!active) return;
        setTasks(page.items);
        setNext(page.next);
        setState('ready');
      })
      .catch(() => {
        if (active) setState('failed');
      });
    return () => {
      active = false;
    };
  }, [kind, status, revision]);

  const upsert = useCallback(
    (task: AITaskView) => setTasks((previous) => previous.map((item) => (item.id === task.id ? task : item))),
    [],
  );
  useTaskPolling(tasks, upsert, (taskId) => setStopped((previous) => new Set(previous).add(taskId)));

  async function loadMore() {
    if (!next) return;
    try {
      const page = await aiApi.list({ limit: 20, before: next, ...(kind ? { kind } : {}), ...(status ? { status } : {}) });
      setTasks((previous) => [...previous, ...page.items.filter((item) => !previous.some((known) => known.id === item.id))]);
      setNext(page.next);
    } catch {
      setState('failed');
    }
  }

  const reload = () => {
    setState('loading');
    setRevision((value) => value + 1);
  };

  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{text.tasks.title}</h1>
          <p className="mt-3 text-[var(--color-muted)]">{text.tasks.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {AI_SCENES.map((scene) => (
            <Link key={scene.kind} href={`/ai/${scene.segment}`} className={secondaryButtonClass}>
              {text.kindNames[scene.kind]}
            </Link>
          ))}
        </div>
      </header>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          {text.tasks.kind}
          <select
            className={selectClass}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as AIMediaKind | '');
              setState('loading');
            }}
          >
            <option value="">{text.tasks.all}</option>
            {AI_MEDIA_KINDS.map((value) => (
              <option key={value} value={value}>
                {text.kindNames[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          {text.tasks.status}
          <select
            className={selectClass}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as AITaskStatus | '');
              setState('loading');
            }}
          >
            <option value="">{text.tasks.all}</option>
            {AI_TASK_STATUSES.filter((value) => value !== 'RETRYING').map((value) => (
              <option key={value} value={value}>
                {text.statuses[value]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {state === 'loading' && <FormMessage message={text.loading} />}
      {state === 'failed' && (
        <section className={`${panelClass} space-y-4`}>
          <FormMessage message={text.loadFailed} error />
          <button type="button" className={buttonClass} onClick={reload}>
            {text.retry}
          </button>
        </section>
      )}
      {state === 'ready' &&
        (tasks.length === 0 ? (
          <section className={`${panelClass} text-sm text-[var(--color-muted)]`}>{text.tasks.empty}</section>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                text={text}
                locale={locale}
                onChange={upsert}
                autoPreview={false}
                pollStopped={stopped.has(task.id)}
              />
            ))}
          </div>
        ))}
      {state === 'ready' && next && (
        <button type="button" className={secondaryButtonClass} onClick={() => void loadMore()}>
          {text.loadMore}
        </button>
      )}
    </div>
  );
}
