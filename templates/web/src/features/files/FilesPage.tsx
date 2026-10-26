'use client';
import { useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { httpClient } from '@/lib/http-client';
import { useAuthStore } from '@/lib/stores/auth-store';
import {
  FormMessage,
  buttonClass,
  inputClass,
  panelClass,
} from '@/app/[locale]/account/_components/AccountForm';
import { secondaryButtonClass } from '@/features/billing/components';
import { clearFileAttempt, fileAttempt, fileFingerprint, importFingerprint } from './attempt';
import { fileCopy } from './copy';
import type { DownloadTicket, FilePage, PrivateFile } from './types';

const MAX_BYTES = 10 * 1024 * 1024;
function expiredTicket(ticket: DownloadTicket) {
  return Date.parse(ticket.expiresAt) <= Date.now();
}
function failureInfo(error: unknown) {
  const value = error as {
    status?: number;
    code?: string;
    response?: { data?: { code?: string } };
  };
  return { status: value?.status, code: value?.response?.data?.code ?? value?.code };
}
export default function FilesPage() {
  const identity = useAuthStore((state) => state.user?.id);
  return <FilesPanel key={typeof identity === 'string' ? identity : 'account'} />;
}
function FilesPanel() {
  const locale = useLocale(),
    text = fileCopy(locale);
  const [result, setResult] = useState<FilePage | null>(null),
    [owner, setOwner] = useState('');
  const [loading, setLoading] = useState(true),
    [loadFailed, setLoadFailed] = useState(false),
    [revision, setRevision] = useState(0),
    [page, setPage] = useState(1);
  const [file, setFile] = useState<File | null>(null),
    [sourceUrl, setSourceUrl] = useState(''),
    [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [confirmDelete, setConfirmDelete] = useState('');
  const [tickets, setTickets] = useState<Record<string, DownloadTicket>>({});
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([
      httpClient.get<FilePage>('/files', { page }),
      httpClient.get<{ id: string }>('/authorize/me'),
    ])
      .then(([files, identity]) => {
        if (active) {
          setResult(files);
          setOwner(identity.id);
          setLoadFailed(false);
        }
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, revision]);
  const refresh = () => {
    setLoading(true);
    setRevision((value) => value + 1);
  };
  const maxBytes = Math.min(MAX_BYTES, result?.limits?.maxFileBytes ?? MAX_BYTES);
  const disabled = Boolean(busy) || loading || loadFailed || !owner;
  const date = (value: string) =>
    Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(value),
        )
      : text.noDate;
  const bytes = (value: number) =>
    value >= 1048576
      ? `${(value / 1048576).toLocaleString(locale, { maximumFractionDigits: 2 })} MiB`
      : value < 1024
        ? `${value} B`
        : `${(value / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} KiB`;
  const pages = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.pageSize ?? 20)));
  async function assertOwner() {
    const current = await httpClient.get<{ id: string }>('/authorize/me');
    if (current.id !== owner) throw new Error('Account changed');
  }
  async function recovered(key: string): Promise<PrivateFile | null> {
    try {
      const asset = await httpClient.get<PrivateFile>(`/files/requests/${encodeURIComponent(key)}`);
      return asset.state === 'pending'
        ? await httpClient.post<PrivateFile>(`/files/${encodeURIComponent(asset.id)}/recover`, {})
        : asset;
    } catch (failure) {
      if (failureInfo(failure).status === 404) return null;
      throw failure;
    }
  }
  async function submit(kind: 'upload' | 'import') {
    setError('');
    setNotice('');
    setBusy(kind);
    let attempt: ReturnType<typeof fileAttempt> | undefined;
    try {
      await assertOwner();
      let url = sourceUrl.trim();
      if (kind === 'upload' && (!file || !file.size || file.size > maxBytes)) {
        setError(text.invalid);
        return;
      }
      if (kind === 'import') {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash)
            throw new Error();
          url = parsed.href;
        } catch {
          setError(text.invalidUrl);
          return;
        }
      }
      const fingerprint =
        kind === 'upload'
          ? await fileFingerprint(file!)
          : await importFingerprint(url, fileName.trim());
      attempt = fileAttempt(owner, kind, fingerprint);
      if (!attempt.persisted) setNotice(text.storageUnavailable);
      let asset = attempt.existing ? await recovered(attempt.key) : null;
      if (asset?.state === 'deleted') {
        clearFileAttempt(attempt);
        setError(text.deletedRequest);
        refresh();
        return;
      }
      if (asset?.state !== 'ready') {
        if (kind === 'upload') {
          const body = new FormData();
          body.append('file', file!);
          asset = await httpClient.upload<PrivateFile>('/files', body, {
            headers: { 'Idempotency-Key': attempt.key },
          });
        } else
          asset = await httpClient.post<PrivateFile>(
            '/files/import',
            { url, ...(fileName.trim() ? { fileName: fileName.trim() } : {}) },
            undefined,
            { headers: { 'Idempotency-Key': attempt.key } },
          );
      }
      if (asset.state === 'ready') {
        clearFileAttempt(attempt);
        setNotice(text.saved);
        if (kind === 'upload') {
          setFile(null);
          if (input.current) input.current.value = '';
        } else {
          setSourceUrl('');
          setFileName('');
        }
      } else setNotice(text.pending);
      refresh();
    } catch (failure) {
      const { status, code } = failureInfo(failure);
      setError(
        code === 'FILE_IMPORT_DISABLED'
          ? text.importDisabled
          : code === 'FILE_IMPORT_SOURCE_FORBIDDEN'
            ? text.forbiddenImport
            : status === 400 || status === 413
              ? text.rejected
              : status === 409
                ? text.conflict
                : text.uncertain,
      );
      refresh();
    } finally {
      setBusy('');
    }
  }
  async function operate(row: PrivateFile, operation: 'recover' | 'delete' | 'ticket') {
    setBusy(`${operation}:${row.id}`);
    setError('');
    setNotice('');
    try {
      await assertOwner();
      if (operation === 'ticket') {
        const ticket = await httpClient.post<DownloadTicket>(
          `/files/${encodeURIComponent(row.id)}/download-url`,
          {},
        );
        const url = new URL(ticket.url, window.location.origin);
        if (
          url.origin !== window.location.origin ||
          url.pathname !== `/api/files/${encodeURIComponent(row.id)}/download` ||
          !url.searchParams.get('token') ||
          !Number.isFinite(Date.parse(ticket.expiresAt)) ||
          expiredTicket(ticket)
        )
          throw new Error('Invalid download ticket');
        setTickets((previous) => ({
          ...previous,
          [row.id]: { ...ticket, url: url.pathname + url.search },
        }));
      } else {
        const asset =
          operation === 'recover'
            ? await httpClient.post<PrivateFile>(`/files/${encodeURIComponent(row.id)}/recover`, {})
            : await httpClient.delete<PrivateFile>(`/files/${encodeURIComponent(row.id)}`);
        setNotice(
          asset.state === 'pending'
            ? text.pending
            : asset.state === 'deleted'
              ? text.removed
              : text.checked,
        );
        setConfirmDelete('');
        setTickets((previous) => {
          const next = { ...previous };
          delete next[row.id];
          return next;
        });
        refresh();
      }
    } catch (failure) {
      const { code } = failureInfo(failure);
      setError(
        code === 'ASSET_IN_USE'
          ? text.avatarInUse
          : operation === 'ticket'
            ? text.downloadFailed
            : operation === 'delete'
              ? text.deleteFailed
              : text.recoverFailed,
      );
      if (operation !== 'ticket') refresh();
    } finally {
      setBusy('');
    }
  }
  async function download(row: PrivateFile, ticket: DownloadTicket) {
    setError('');
    setNotice('');
    if (expiredTicket(ticket)) {
      setError(text.expired);
      setTickets((previous) => {
        const next = { ...previous };
        delete next[row.id];
        return next;
      });
      return;
    }
    setBusy(`download:${row.id}`);
    try {
      // A ticket failure must not refresh or revoke the account session.
      const downloadUrl = new URL(ticket.url, window.location.origin);
      const token = downloadUrl.searchParams.get('token');
      if (!token) throw new Error('Missing download ticket');
      const response = await fetch(downloadUrl.pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error('Download failed');
      const blob = await response.blob();
      if (blob.size > MAX_BYTES) throw new Error('Download too large');
      const objectUrl = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = row.fileName;
      anchor.rel = 'noreferrer';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setNotice(text.downloadStarted);
    } catch {
      setError(text.downloadFailed);
      setTickets((previous) => {
        const next = { ...previous };
        delete next[row.id];
        return next;
      });
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="mx-auto max-w-6xl space-y-7 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{text.title}</h1>
          <p className="mt-3 text-[var(--color-muted)]">{text.description}</p>
        </div>
        <Link href="/account" className={secondaryButtonClass}>
          {text.back}
        </Link>
      </header>
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <section className={`${panelClass} space-y-4`} aria-label={text.uploadTitle}>
          <h2 className="text-xl font-semibold">{text.uploadTitle}</h2>
          <p className="text-sm text-[var(--color-muted)]">{text.limit(maxBytes)}</p>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit('upload');
            }}
          >
            <div>
              <label htmlFor="private-file" className="mb-2 block text-sm">
                {text.choose}
              </label>
              <input
                id="private-file"
                ref={input}
                type="file"
                disabled={disabled}
                className={inputClass}
                onChange={(event) => {
                  const selected = event.target.files?.[0] ?? null;
                  setError('');
                  setNotice('');
                  if (selected && (!selected.size || selected.size > maxBytes)) {
                    setFile(null);
                    event.target.value = '';
                    setError(text.invalid);
                  } else setFile(selected);
                }}
              />
            </div>
            <button className={buttonClass} disabled={disabled || !file}>
              {busy === 'upload' ? text.working : text.upload}
            </button>
          </form>
        </section>
        <section className={`${panelClass} space-y-4`} aria-label={text.importTitle}>
          <h2 className="text-xl font-semibold">{text.importTitle}</h2>
          <p className="text-sm text-[var(--color-muted)]">{text.importDescription}</p>
          {result?.limits?.urlImportEnabled ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit('import');
              }}
            >
              <div>
                <label htmlFor="file-source" className="mb-2 block text-sm">
                  {text.url}
                </label>
                <input
                  id="file-source"
                  type="url"
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  disabled={disabled}
                  required
                  maxLength={2048}
                  autoComplete="off"
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="import-name" className="mb-2 block text-sm">
                  {text.name}
                </label>
                <input
                  id="import-name"
                  value={fileName}
                  onChange={(event) => setFileName(event.target.value)}
                  disabled={disabled}
                  maxLength={255}
                  autoComplete="off"
                  className={inputClass}
                />
              </div>
              <button className={buttonClass} disabled={disabled || !sourceUrl.trim()}>
                {busy === 'import' ? text.working : text.import}
              </button>
            </form>
          ) : (
            <FormMessage
              message={loading ? text.loading : loadFailed ? text.loadFailed : text.importDisabled}
            />
          )}
        </section>
      </div>
      <FormMessage message={error} error />
      <FormMessage message={notice} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{text.title}</h2>
        <button
          className={secondaryButtonClass}
          disabled={Boolean(busy) || loading}
          onClick={refresh}
        >
          {text.refresh}
        </button>
      </div>
      {loading && <FormMessage message={text.loading} />}
      {loadFailed && (
        <div className={`${panelClass} space-y-3`}>
          <FormMessage message={text.loadFailed} error />
          <button className={buttonClass} disabled={loading || Boolean(busy)} onClick={refresh}>
            {text.retry}
          </button>
        </div>
      )}
      {result && !loadFailed && (
        <>
          {result.data.length ? (
            <ul className="space-y-3">
              {result.data.map((row) => (
                <li key={row.id} className={`${panelClass} space-y-4`} aria-label={row.fileName}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1 space-y-2">
                      <h3 className="break-all font-semibold">{row.fileName}</h3>
                      <p className="break-all text-sm text-[var(--color-muted)]">
                        {bytes(row.size)} · {row.mimeType} · {date(row.createdAt)}
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-3 py-1 text-xs ${row.state === 'ready' ? 'border-emerald-500/30 text-emerald-300' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}
                    >
                      {row.state === 'ready'
                        ? text.ready
                        : row.state === 'pending'
                          ? text.waiting
                          : row.cleanupStatus === 'pending'
                            ? text.cleanupPending
                            : text.deleted}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {row.state === 'ready' && (
                      <button
                        className={secondaryButtonClass}
                        disabled={disabled}
                        onClick={() => void operate(row, 'ticket')}
                      >
                        {text.requestDownload}
                      </button>
                    )}
                    {(row.state === 'pending' ||
                      (row.state === 'deleted' && row.cleanupStatus === 'pending')) && (
                      <button
                        className={secondaryButtonClass}
                        disabled={disabled}
                        onClick={() => void operate(row, 'recover')}
                      >
                        {row.state === 'pending' ? text.verify : text.cleanup}
                      </button>
                    )}
                    {row.state !== 'deleted' && (
                      <button
                        className={secondaryButtonClass}
                        disabled={disabled}
                        onClick={() => setConfirmDelete(row.id)}
                      >
                        {text.remove}
                      </button>
                    )}
                  </div>
                  {tickets[row.id] && row.state === 'ready' && (
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        className={buttonClass}
                        disabled={disabled}
                        onClick={() => void download(row, tickets[row.id])}
                      >
                        {text.download}
                      </button>
                      <p className="text-xs text-[var(--color-muted)]">
                        {text.expires(date(tickets[row.id].expiresAt))}
                      </p>
                    </div>
                  )}
                  {confirmDelete === row.id && (
                    <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
                      <p className="text-sm">{text.deleteWarning}</p>
                      <div className="flex flex-wrap gap-3">
                        <button
                          className={buttonClass}
                          disabled={disabled}
                          onClick={() => void operate(row, 'delete')}
                        >
                          {text.confirmRemove}
                        </button>
                        <button
                          className={secondaryButtonClass}
                          disabled={Boolean(busy)}
                          onClick={() => setConfirmDelete('')}
                        >
                          {text.cancel}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className={`${panelClass} space-y-2`}>
              <h3 className="font-semibold">{text.empty}</h3>
              <p className="text-sm text-[var(--color-muted)]">{text.emptyDescription}</p>
            </div>
          )}
          <nav
            className="flex flex-wrap items-center justify-between gap-3"
            aria-label={text.pagination}
          >
            <p className="text-sm text-[var(--color-muted)]">
              {text.pageLabel(page, pages, result.total)}
            </p>
            <div className="flex gap-3">
              <button
                className={secondaryButtonClass}
                disabled={disabled || page <= 1}
                onClick={() => {
                  setLoading(true);
                  setPage((value) => value - 1);
                }}
              >
                {text.previous}
              </button>
              <button
                className={secondaryButtonClass}
                disabled={disabled || page >= pages}
                onClick={() => {
                  setLoading(true);
                  setPage((value) => value + 1);
                }}
              >
                {text.next}
              </button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
