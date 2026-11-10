'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { inputClass } from '@/app/[locale]/account/_components/AccountForm';
import { FormMessage, buttonClass, panelClass, secondaryButtonClass } from '@/features/billing/components';
import type { PrivateFile } from '@/features/files/types';
import { aiApi, announceCreditsChanged, referenceCandidates } from './api';
import { aiCopy, type AICopy } from './copy';
import { aiFailureKind, isDefiniteRejection, nextSubmitAttempt, type AIFailureKind, type SubmitAttempt } from './errors';
import { isTerminalStatus } from './polling';
import { TaskCard } from './TaskCard';
import { AI_SCENES, type AICatalog, type AIMediaKind, type AITaskOptionValue, type AITaskView, type MediaCatalogEntry } from './types';
import { useTaskPolling } from './useTaskPolling';
import { AccountScopePending, useAccountScope } from './useAccountScope';

export const PROMPT_MAX = 4000;
const MAX_REFERENCES = 4;
const ASPECTS = { square: [1024, 1024], portrait: [1024, 1792], landscape: [1792, 1024] } as const;
const VIDEO_DURATIONS = [5, 10] as const;
const AUDIO_DURATIONS = [30, 60, 120] as const;
const RESOLUTIONS = ['720p', '1080p'] as const;

/** Generation options sent for each kind; only keys the server's per-kind rules accept. */
export function generationOptions(
  kind: AIMediaKind,
  form: { count: number; aspect: keyof typeof ASPECTS; duration: number; resolution: string; instrumental: boolean; lyrics: string },
): Record<string, AITaskOptionValue> {
  if (kind === 'image') {
    const [width, height] = ASPECTS[form.aspect];
    return { count: form.count, width, height };
  }
  if (kind === 'video') return { duration: form.duration, resolution: form.resolution };
  const lyrics = form.lyrics.trim();
  return { duration: form.duration, instrumental: form.instrumental, ...(!form.instrumental && lyrics ? { lyrics } : {}) };
}

export default function GeneratorPage({ kind }: { kind: AIMediaKind }) {
  const scope = useAccountScope();
  // Not mounted before the session hydrates; a different account must never see the previous
  // account's tasks or reuse its submit key.
  return scope === null ? <AccountScopePending /> : <Generator key={`${kind}:${scope}`} kind={kind} />;
}

function Generator({ kind }: { kind: AIMediaKind }) {
  const locale = useLocale(),
    text = aiCopy(locale);
  const [catalog, setCatalog] = useState<AICatalog | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(1);
  const [aspect, setAspect] = useState<keyof typeof ASPECTS>('square');
  const [duration, setDuration] = useState<number>(kind === 'audio' ? AUDIO_DURATIONS[0] : VIDEO_DURATIONS[0]);
  const [resolution, setResolution] = useState<string>(RESOLUTIONS[0]);
  const [instrumental, setInstrumental] = useState(false);
  const [lyrics, setLyrics] = useState('');
  const [references, setReferences] = useState<string[]>([]);
  const [tasks, setTasks] = useState<AITaskView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<AIFailureKind | null>(null);
  const attempt = useRef<SubmitAttempt | null>(null);

  const refreshBalance = useCallback(() => {
    aiApi.balance().then(setBalance, () => setBalance(null));
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([aiApi.catalog(), aiApi.list({ kind, limit: 12 })])
      .then(([loadedCatalog, page]) => {
        if (!active) return;
        setCatalog(loadedCatalog);
        setTasks(page.items);
        setNext(page.next);
        setLoadState('ready');
        // First offered model that is available right now.
        const entries = loadedCatalog[kind] ?? [];
        setSelected(Math.max(0, entries.findIndex((entry) => entry.available)));
      })
      .catch(() => {
        if (active) setLoadState('failed');
      });
    aiApi.balance().then(
      (value) => active && setBalance(value),
      () => active && setBalance(null),
    );
    return () => {
      active = false;
    };
  }, [kind, revision]);

  const upsert = useCallback((task: AITaskView) => {
    setTasks((previous) =>
      previous.some((item) => item.id === task.id) ? previous.map((item) => (item.id === task.id ? task : item)) : [task, ...previous],
    );
  }, []);
  // A task that settled may have returned or confirmed reserved credits: re-read the balance.
  const settled = tasks
    .filter((task) => isTerminalStatus(task.status))
    .map((task) => task.id)
    .sort()
    .join(',');
  const lastSettled = useRef<string | null>(null);
  useEffect(() => {
    if (lastSettled.current !== null && lastSettled.current !== settled) {
      announceCreditsChanged();
      refreshBalance();
    }
    lastSettled.current = settled;
  }, [settled, refreshBalance]);
  useTaskPolling(tasks, upsert, (taskId) => setStopped((previous) => new Set(previous).add(taskId)));

  const entries: MediaCatalogEntry[] = catalog?.[kind] ?? [];
  const entry = entries[selected];
  const outputs = kind === 'image' ? count : 1;
  const cost = entry ? entry.cost * outputs : 0;
  const insufficient = balance !== null && cost > balance;
  const trimmed = prompt.trim();
  const canSubmit = Boolean(entry?.available) && trimmed.length > 0 && prompt.length <= PROMPT_MAX && !insufficient && !submitting;
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);

  async function submit() {
    if (!entry || !canSubmit) return;
    setFailure(null);
    setSubmitting(true);
    const body = {
      kind,
      providerId: entry.providerId,
      model: entry.model,
      prompt: trimmed,
      options: generationOptions(kind, { count, aspect, duration, resolution, instrumental, lyrics }),
      ...(kind !== 'audio' && references.length ? { references } : {}),
      cost,
    };
    // One key per distinct request; an uncertain outcome keeps it so a resubmit cannot double-charge.
    const current = nextSubmitAttempt(attempt.current, JSON.stringify(body));
    attempt.current = current;
    try {
      const task = await aiApi.submit(body, current.key);
      attempt.current = null;
      upsert(task);
      announceCreditsChanged();
      refreshBalance();
    } catch (error) {
      if (isDefiniteRejection(error)) attempt.current = null;
      const reason = aiFailureKind(error);
      setFailure(reason);
      if (reason === 'costChanged' || reason === 'notOffered') {
        aiApi.catalog().then(setCatalog, () => undefined);
      }
      if (reason === 'credits') refreshBalance();
    } finally {
      setSubmitting(false);
    }
  }

  async function loadMore() {
    if (!next) return;
    try {
      const page = await aiApi.list({ kind, limit: 12, before: next });
      setTasks((previous) => [...previous, ...page.items.filter((item) => !previous.some((known) => known.id === item.id))]);
      setNext(page.next);
    } catch {
      setFailure('uncertain');
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-7 px-4 py-8 lg:px-6">
      <header className="space-y-4 border-b border-[var(--color-border)] pb-6">
        <nav aria-label={text.scenes} className="flex flex-wrap gap-2">
          {AI_SCENES.map((scene) => (
            <Link
              key={scene.kind}
              href={`/ai/${scene.segment}`}
              aria-current={scene.kind === kind ? 'page' : undefined}
              className={`${secondaryButtonClass} ${scene.kind === kind ? 'border-primary-500 text-primary-400' : ''}`}
            >
              {text.kindNames[scene.kind]}
            </Link>
          ))}
        </nav>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{text.titles[kind]}</h1>
          <p className="mt-3 text-[var(--color-muted)]">{text.descriptions[kind]}</p>
        </div>
      </header>
      {loadState === 'loading' && <FormMessage message={text.loading} />}
      {loadState === 'failed' && (
        <section className={`${panelClass} space-y-4`}>
          <FormMessage message={text.loadFailed} error />
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              setLoadState('loading');
              setRevision((value) => value + 1);
            }}
          >
            {text.retry}
          </button>
        </section>
      )}
      {loadState === 'ready' && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <form
            className={`${panelClass} space-y-5`}
            aria-label={text.titles[kind]}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {entries.length === 0 ? (
              <FormMessage message={text.noModels} />
            ) : (
              <div>
                <label htmlFor="ai-model" className="mb-2 block text-sm">
                  {text.model}
                </label>
                <select
                  id="ai-model"
                  className={inputClass}
                  value={selected}
                  onChange={(event) => {
                    setSelected(Number(event.target.value));
                    setFailure(null);
                  }}
                >
                  {entries.map((item, index) => (
                    <option key={`${item.providerId}/${item.model}`} value={index} disabled={!item.available}>
                      {item.label || item.model} · {number(item.cost)}
                      {item.available ? '' : ` (${text.unavailable})`}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor="ai-prompt" className="block text-sm">
                  {text.prompt}
                </label>
                <span className={`text-xs ${prompt.length > PROMPT_MAX ? 'text-red-300' : 'text-[var(--color-muted)]'}`}>
                  {text.promptCount(prompt.length, PROMPT_MAX)}
                </span>
              </div>
              <textarea
                id="ai-prompt"
                rows={5}
                className={inputClass}
                value={prompt}
                maxLength={PROMPT_MAX}
                placeholder={text.promptPlaceholder}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </div>
            <KindOptions
              kind={kind}
              text={text}
              form={{ count, aspect, duration, resolution, instrumental, lyrics }}
              set={{ setCount, setAspect, setDuration, setResolution, setInstrumental, setLyrics }}
            />
            {kind !== 'audio' && <ReferencePicker kind={kind} text={text} value={references} onChange={setReferences} />}
            <div className="space-y-2 border-t border-[var(--color-border)] pt-4">
              <p className="flex flex-wrap items-baseline justify-between gap-2 text-sm" data-testid="ai-cost">
                <span className="font-semibold">{text.cost(number(cost))}</span>
                {entry && outputs > 1 && <span className="text-xs text-[var(--color-muted)]">{text.perOutput(number(entry.cost), outputs)}</span>}
              </p>
              {balance !== null && <p className="text-xs text-[var(--color-muted)]">{text.balance(number(balance))}</p>}
              {insufficient && failure !== 'credits' && <CreditsNotice text={text} message={text.insufficient} />}
            </div>
            {failure && failure !== 'credits' && <FormMessage message={text.failures[failure]} error />}
            {failure === 'credits' && <CreditsNotice text={text} message={text.failures.credits} />}
            <button className={`${buttonClass} w-full`} disabled={!canSubmit}>
              {submitting ? text.submitting : text.generate}
            </button>
          </form>
          <section className="space-y-4" aria-label={text.results}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">{text.results}</h2>
              <Link href="/account/tasks" className="text-sm text-primary-400 hover:underline">
                {text.allTasks}
              </Link>
            </div>
            {tasks.length === 0 ? (
              <p className={`${panelClass} text-sm text-[var(--color-muted)]`}>{text.empty}</p>
            ) : (
              <div className="grid gap-4 xl:grid-cols-2">
                {tasks.map((task) => (
                  <TaskCard key={task.id} task={task} text={text} locale={locale} onChange={upsert} pollStopped={stopped.has(task.id)} />
                ))}
              </div>
            )}
            {next && (
              <button type="button" className={secondaryButtonClass} onClick={() => void loadMore()}>
                {text.loadMore}
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export function CreditsNotice({ text, message }: { text: Pick<AICopy, 'buyCredits'>; message: string }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
      <span>{message}</span>
      <Link href="/pricing" className="font-medium text-primary-400 hover:underline">
        {text.buyCredits}
      </Link>
    </div>
  );
}

type FormState = { count: number; aspect: keyof typeof ASPECTS; duration: number; resolution: string; instrumental: boolean; lyrics: string };
type FormSetters = {
  setCount: (value: number) => void;
  setAspect: (value: keyof typeof ASPECTS) => void;
  setDuration: (value: number) => void;
  setResolution: (value: string) => void;
  setInstrumental: (value: boolean) => void;
  setLyrics: (value: string) => void;
};

function KindOptions({ kind, text, form, set }: { kind: AIMediaKind; text: AICopy; form: FormState; set: FormSetters }) {
  if (kind === 'image')
    return (
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="ai-count" className="mb-2 block text-sm">
            {text.count}
          </label>
          <select id="ai-count" className={inputClass} value={form.count} onChange={(event) => set.setCount(Number(event.target.value))}>
            {[1, 2, 3, 4].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ai-aspect" className="mb-2 block text-sm">
            {text.aspect}
          </label>
          <select
            id="ai-aspect"
            className={inputClass}
            value={form.aspect}
            onChange={(event) => set.setAspect(event.target.value as keyof typeof ASPECTS)}
          >
            {Object.keys(ASPECTS).map((value) => (
              <option key={value} value={value}>
                {text.aspects[value]}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  const durations = kind === 'video' ? VIDEO_DURATIONS : AUDIO_DURATIONS;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="ai-duration" className="mb-2 block text-sm">
            {text.duration}
          </label>
          <select id="ai-duration" className={inputClass} value={form.duration} onChange={(event) => set.setDuration(Number(event.target.value))}>
            {durations.map((value) => (
              <option key={value} value={value}>
                {text.seconds(value)}
              </option>
            ))}
          </select>
        </div>
        {kind === 'video' && (
          <div>
            <label htmlFor="ai-resolution" className="mb-2 block text-sm">
              {text.resolution}
            </label>
            <select id="ai-resolution" className={inputClass} value={form.resolution} onChange={(event) => set.setResolution(event.target.value)}>
              {RESOLUTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {kind === 'audio' && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.instrumental} onChange={(event) => set.setInstrumental(event.target.checked)} />
            {text.instrumental}
          </label>
          {!form.instrumental && (
            <div>
              <label htmlFor="ai-lyrics" className="mb-2 block text-sm">
                {text.lyrics}
              </label>
              <textarea
                id="ai-lyrics"
                rows={4}
                maxLength={3000}
                className={inputClass}
                value={form.lyrics}
                onChange={(event) => set.setLyrics(event.target.value)}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Reference images are chosen from the user's own files by id; URLs are never accepted. */
function ReferencePicker({
  kind,
  text,
  value,
  onChange,
}: {
  kind: AIMediaKind;
  text: AICopy;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [files, setFiles] = useState<PrivateFile[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    referenceCandidates().then(
      (items) => active && setFiles(items),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, []);
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((item) => item !== id) : value.length < MAX_REFERENCES ? [...value, id] : value);
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm">{text.references}</legend>
      <p className="text-xs text-[var(--color-muted)]">
        {text.referencesHint} {kind === 'video' ? text.referencesVideoHint : ''}
      </p>
      {failed ? (
        <FormMessage message={text.referencesFailed} error />
      ) : files === null ? (
        <FormMessage message={text.loading} />
      ) : files.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">
          {text.noReferences}{' '}
          <Link href="/account/files" className="text-primary-400 hover:underline">
            {text.manageFiles}
          </Link>
        </p>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-[var(--color-border)] p-2">
          {files.map((file) => (
            <li key={file.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={value.includes(file.id)}
                  disabled={!value.includes(file.id) && value.length >= MAX_REFERENCES}
                  onChange={() => toggle(file.id)}
                />
                <span className="truncate">{file.fileName}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
