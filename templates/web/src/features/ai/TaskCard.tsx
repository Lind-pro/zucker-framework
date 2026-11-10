'use client';
import { useEffect, useRef, useState } from 'react';
import { panelClass, secondaryButtonClass } from '@/features/billing/components';
import { aiApi } from './api';
import type { AICopy } from './copy';
import { outputFileName, redeemOutputTicket, saveBlob } from './download';
import { isTerminalStatus } from './polling';
import type { AITaskOutput, AITaskView } from './types';

export const smallButtonClass =
  'rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2';

const statusTone: Record<string, string> = {
  COMPLETED: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  FAILED: 'border-red-500/30 bg-red-500/10 text-red-300',
  CANCELLED: 'border-[var(--color-border)] text-[var(--color-muted)]',
};

export function TaskStatusBadge({ task, text }: { task: AITaskView; text: AICopy }) {
  return (
    <span
      data-status={task.status}
      className={`inline-flex shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${statusTone[task.status] ?? 'border-primary-500/30 bg-primary-500/10 text-primary-300'}`}
    >
      {text.statuses[task.status] ?? task.status}
    </span>
  );
}

/** One generation: status, progress, charge outcome, outputs (ticketed preview/download) and cancel. */
export function TaskCard({
  task,
  text,
  locale,
  onChange,
  autoPreview = true,
  pollStopped = false,
}: {
  task: AITaskView;
  text: AICopy;
  locale: string;
  onChange: (task: AITaskView) => void;
  autoPreview?: boolean;
  pollStopped?: boolean;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const created = Date.parse(task.createdAt);
  const progress = typeof task.progress === 'number' && Number.isFinite(task.progress) ? Math.min(100, Math.max(0, task.progress)) : null;
  const active = !isTerminalStatus(task.status);
  const returned = (task.status === 'FAILED' || task.status === 'CANCELLED') && task.charge !== 'CONFIRMED';

  async function cancel() {
    setCancelling(true);
    setError('');
    try {
      onChange(await aiApi.cancel(task.id));
    } catch {
      setError(text.cancelFailed);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <article className={`${panelClass} space-y-4`} data-task-id={task.id} aria-busy={active}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="line-clamp-3 break-words text-sm">{task.prompt}</p>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            {text.kindNames[task.kind]} · {task.model}
            {Number.isFinite(created) && (
              <>
                {' · '}
                <time dateTime={task.createdAt}>
                  {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(created)}
                </time>
              </>
            )}
          </p>
        </div>
        <TaskStatusBadge task={task} text={text} />
      </div>
      {active && (
        <div className="space-y-2">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]"
            role="progressbar"
            aria-label={text.statuses[task.status]}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ?? undefined}
          >
            <div
              className={`h-full rounded-full bg-primary-500 ${progress === null ? 'w-1/3 animate-pulse' : 'transition-[width]'}`}
              style={progress === null ? undefined : { width: `${progress}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-muted)]">
            <span>
              {progress !== null ? text.progress(progress) : text.statuses[task.status]}
              {task.charge === 'HELD' && task.cost > 0 ? ` · ${text.reserved(number(task.cost))}` : ''}
            </span>
            {task.canCancel && (
              <button type="button" className={secondaryButtonClass} disabled={cancelling} onClick={() => void cancel()}>
                {cancelling ? text.cancelling : text.cancel}
              </button>
            )}
          </div>
          {pollStopped && <p role="status" className="text-xs text-amber-300">{text.pollFailed}</p>}
        </div>
      )}
      {task.status === 'COMPLETED' && task.cost > 0 && (
        <p className="text-xs text-[var(--color-muted)]">{text.charged(number(task.cost))}</p>
      )}
      {task.status === 'FAILED' && task.error && (
        <p className="text-xs text-red-300">
          {/* Only the stable code is shown; provider messages and URLs never reach the page. */}
          <span className="font-mono">{task.error.code}</span>
        </p>
      )}
      {returned && (
        <p role="status" className="text-xs text-[var(--color-muted)]" data-testid="task-refunded">
          {text.refunded}
        </p>
      )}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {task.status === 'COMPLETED' && task.outputs.length > 0 && (
        <ul className="grid grid-cols-2 gap-3">
          {task.outputs.map((output) => (
            <OutputTile key={output.index} task={task} output={output} text={text} autoPreview={autoPreview} />
          ))}
        </ul>
      )}
    </article>
  );
}

function OutputTile({ task, output, text, autoPreview }: { task: AITaskView; output: AITaskOutput; text: AICopy; autoPreview: boolean }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'preview' | 'download'>('');
  const [failed, setFailed] = useState(false);
  const objectUrl = useRef<string | null>(null);
  const isImage = output.contentType.startsWith('image/');
  const label = text.outputLabel(output.index);

  // Every preview/download asks for a fresh ticket: tickets are short-lived and single-purpose.
  async function load(signal?: AbortSignal) {
    const ticket = await aiApi.outputTicket(task.id, output.index);
    return redeemOutputTicket(ticket, signal);
  }
  async function showPreview(signal?: AbortSignal) {
    setBusy('preview');
    setFailed(false);
    try {
      const blob = await load(signal);
      if (signal?.aborted) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(blob);
      setPreview(objectUrl.current);
    } catch {
      if (!signal?.aborted) setFailed(true);
    } finally {
      if (!signal?.aborted) setBusy('');
    }
  }
  async function download() {
    setBusy('download');
    setFailed(false);
    try {
      saveBlob(await load(), outputFileName(task.kind, task.id, output.index, output.contentType));
    } catch {
      setFailed(true);
    } finally {
      setBusy('');
    }
  }

  const autoLoad = autoPreview && isImage;
  useEffect(() => {
    const controller = new AbortController();
    // Deferred so the state updates of showPreview run outside the effect body.
    const timer = autoLoad ? setTimeout(() => void showPreview(controller.signal), 0) : undefined;
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // showPreview reads only stable values of this tile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoad, task.id, output.index]);
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  return (
    <li className="space-y-2" data-output-index={output.index}>
      <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]">
        {preview && isImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- blob: URL of a private output; next/image cannot optimise it
          <img src={preview} alt={label} className="h-full w-full object-contain" />
        ) : preview && output.contentType.startsWith('video/') ? (
          <video src={preview} controls className="h-full w-full" aria-label={label} />
        ) : preview && output.contentType.startsWith('audio/') ? (
          <audio src={preview} controls className="w-full px-2" aria-label={label} />
        ) : (
          <button
            type="button"
            className="text-xs text-[var(--color-muted)] hover:underline"
            disabled={busy !== ''}
            onClick={() => void showPreview()}
          >
            {busy === 'preview' ? text.previewing : text.preview}
          </button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-[var(--color-muted)]">{label}</span>
        <button type="button" className={smallButtonClass} disabled={busy !== ''} onClick={() => void download()}>
          {text.download}
        </button>
      </div>
      {failed && <p role="alert" className="text-xs text-red-300">{text.downloadFailed}</p>}
    </li>
  );
}
