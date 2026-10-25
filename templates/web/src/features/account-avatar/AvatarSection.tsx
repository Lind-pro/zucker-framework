'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useLocale } from 'next-intl';
import { httpClient } from '@/lib/http-client';
import { useAuthStore } from '@/lib/stores/auth-store';
import { buttonClass, FormMessage, inputClass, panelClass } from '@/app/[locale]/account/_components/AccountForm';

const copy = {
  en: { title: 'Profile photo', description: 'Upload a PNG or JPEG up to 2 MiB. Your photo is visible only in your account.', choose: 'Choose a photo',
    save: 'Save photo', saving: 'Saving photo…', remove: 'Remove photo', removing: 'Removing photo…', loading: 'Loading profile photo…',
    noPhoto: 'No profile photo is set.', loadFailed: 'Could not load your profile photo. Try again.', uploadFailed: 'Could not save the photo. Your selected file is kept; try again.',
    removeFailed: 'Could not confirm removal. Try again.', changed: 'The photo changed in another window. The latest photo is shown; review it before trying again.',
    newer: 'A newer photo is already saved. The latest photo is shown.', saved: 'Profile photo saved.', removed: 'Profile photo removed.',
    invalid: 'Choose one PNG or JPEG file no larger than 2 MiB.', rejected: 'This image cannot be used. Choose another PNG or JPEG within the size limit.', retry: 'Retry', imageAlt: 'Your profile photo', imageFailed: 'The photo could not be loaded. Try again.' },
  zh: { title: '个人头像', description: '上传不超过 2 MiB 的 PNG 或 JPEG 图片。头像仅在你的账户中显示。', choose: '选择头像图片',
    save: '保存头像', saving: '正在保存头像…', remove: '移除头像', removing: '正在移除头像…', loading: '正在加载头像…',
    noPhoto: '尚未设置头像。', loadFailed: '未能加载头像，请重试。', uploadFailed: '未能保存头像，已保留所选图片，请重试。',
    removeFailed: '未能确认头像已移除，请重试。', changed: '头像已在另一窗口更新，当前显示最新头像，请确认后再操作。',
    newer: '已有更新的头像，当前显示最新头像。', saved: '头像已保存。', removed: '头像已移除。',
    invalid: '请选择一张不超过 2 MiB 的 PNG 或 JPEG 图片。', rejected: '这张图片无法使用，请选择另一张符合大小限制的 PNG 或 JPEG 图片。', retry: '重试', imageAlt: '你的头像', imageFailed: '图片加载失败，请重试。' },
};
interface Snapshot { assetId: string | null; revision: number; appliedRevision?: number }
interface Command { key: string; revision: number }
function valid(value: Snapshot): Snapshot {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0
    || (value.assetId !== null && (typeof value.assetId !== 'string' || !value.assetId))
    || (value.appliedRevision !== undefined && (!Number.isSafeInteger(value.appliedRevision) || value.appliedRevision < 0 || value.appliedRevision > value.revision)))
    throw new Error('Invalid avatar response');
  return value;
}
const conflict = (failure: unknown) => !!failure && typeof failure === 'object' && 'status' in failure && failure.status === 409;
const rejectedImage = (failure: unknown) => !!failure && typeof failure === 'object' && 'status' in failure && (failure.status === 400 || failure.status === 413);
export function AvatarSection() {
  const owner = useAuthStore(state => state.user?.id), locale = useLocale(), text = copy[locale === 'zh' ? 'zh' : 'en'];
  if (typeof owner !== 'string' || !owner) return <section className={`${panelClass} space-y-4`} aria-label={text.title}><h2 className="text-xl font-semibold">{text.title}</h2><FormMessage message={text.loading} /></section>;
  return <AvatarPanel key={owner} />;
}
function AvatarPanel() {
  const locale = useLocale(), text = copy[locale === 'zh' ? 'zh' : 'en'];
  const username = useAuthStore(state => { const value = state.user?.name || state.user?.username; return typeof value === 'string' && value ? value : '?'; });
  const [current, setCurrent] = useState<Snapshot | null>(null), [file, setFile] = useState<File | null>(null);
  const [image, setImage] = useState<{ revision: number; url: string } | null>(null), [imageError, setImageError] = useState(false);
  const [loading, setLoading] = useState(true), [loadFailed, setLoadFailed] = useState(false), [busy, setBusy] = useState<'save' | 'remove' | ''>('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0), [imageReload, setImageReload] = useState(0);
  const uploadCommand = useRef<Command | null>(null), removeCommand = useRef<Command | null>(null), fileInput = useRef<HTMLInputElement>(null);
  const adopt = useCallback((value: Snapshot) => {
    const snapshot = valid(value); setCurrent(previous => previous && previous.revision > snapshot.revision ? previous : snapshot);
  }, []);
  useEffect(() => {
    let active = true;
    void httpClient.get<Snapshot>('/authorize/avatar').then(value => { if (active) { adopt(valid(value)); setLoadFailed(false); } })
      .catch(() => { if (active) { setLoadFailed(true); setError(text.loadFailed); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload, text.loadFailed, adopt]);
  const revision = current?.revision, assetId = current?.assetId;
  useEffect(() => {
    if (!assetId || revision === undefined) return;
    let active = true, objectUrl: string | undefined;
    void httpClient.downloadFile('/authorize/avatar/content', { revision }).then(response => {
      if (!active) return;
      objectUrl = URL.createObjectURL(new Blob([response.data], { type: 'image/png' }));
      setImage({ revision, url: objectUrl }); setImageError(false);
    }).catch(async failure => {
      if (!active) return;
      if (conflict(failure)) {
        try { const latest = valid(await httpClient.get<Snapshot>('/authorize/avatar')); if (active) adopt(latest); return; } catch { /* Show the image retry below. */ }
      }
      if (active) setImageError(true);
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [assetId, revision, imageReload, adopt]);
  const refreshAfterConflict = async () => { adopt(valid(await httpClient.get<Snapshot>('/authorize/avatar'))); setLoadFailed(false); };
  const applied = (result: Snapshot, action: 'save' | 'remove') => {
    adopt(valid(result)); setImageError(false); uploadCommand.current = null; removeCommand.current = null;
    setNotice(result.appliedRevision !== undefined && result.appliedRevision < result.revision ? text.newer : action === 'save' ? text.saved : text.removed);
  };
  return <section className={`${panelClass} space-y-4`} aria-label={text.title}>
    <h2 className="text-xl font-semibold">{text.title}</h2><p className="text-sm text-[var(--color-muted)]">{text.description}</p>
    {loading ? <FormMessage message={text.loading} /> : <div className="flex flex-wrap items-center gap-5">
      {current?.assetId && image?.revision === current.revision ? <Image src={image.url} width={96} height={96} unoptimized alt={text.imageAlt} className="h-24 w-24 rounded-full object-cover" />
        : <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-background)] text-3xl font-semibold text-primary-400" aria-hidden="true">{Array.from(username)[0]}</div>}
      {current && !current.assetId && <p className="text-sm text-[var(--color-muted)]">{text.noPhoto}</p>}
      {current?.assetId && imageError && <div className="space-y-2"><FormMessage message={text.imageFailed} error /><button className={buttonClass} type="button" onClick={async () => {
        setImageError(false); try { await refreshAfterConflict(); setImageReload(value => value + 1); } catch { setImageError(true); }
      }}>{text.retry}</button></div>}
    </div>}
    <form className="space-y-3" onSubmit={async event => {
      event.preventDefault(); if (!current || !file) return;
      setBusy('save'); setError(''); setNotice('');
      const command = uploadCommand.current ??= { key: crypto.randomUUID(), revision: current.revision };
      const body = new FormData(); body.append('file', file);
      try {
        const result = await httpClient.upload<Snapshot>('/authorize/avatar', body, { headers: { 'Idempotency-Key': command.key, 'If-Match': `"${command.revision}"` } });
        applied(result, 'save'); setFile(null); if (fileInput.current) fileInput.current.value = '';
      } catch (failure) {
        if (conflict(failure)) { uploadCommand.current = null; try { await refreshAfterConflict(); setError(text.changed); } catch { setLoadFailed(true); setError(text.loadFailed); } }
        else if (rejectedImage(failure)) { uploadCommand.current = null; setFile(null); if (fileInput.current) fileInput.current.value = ''; setError(text.rejected); }
        else setError(text.uploadFailed);
      } finally { setBusy(''); }
    }}>
      <div><label htmlFor="account-avatar-file" className="mb-1.5 block text-sm font-medium">{text.choose}</label>
        <input ref={fileInput} id="account-avatar-file" type="file" accept="image/png,image/jpeg" disabled={!current || loadFailed || Boolean(busy)} className={inputClass} onChange={event => {
          const selected = event.target.files?.[0]; setError(''); setNotice(''); uploadCommand.current = null; removeCommand.current = null;
          if (!selected) { setFile(null); return; }
          if (!['image/png', 'image/jpeg'].includes(selected.type) || selected.size > 2 * 1024 * 1024 || !selected.size) {
            setError(text.invalid); setFile(null); event.target.value = ''; return;
          }
          setFile(selected);
        }} /></div>
      <div className="flex flex-wrap gap-3"><button type="submit" className={buttonClass} disabled={!current || !file || loadFailed || Boolean(busy)}>{busy === 'save' ? text.saving : text.save}</button>
        <button type="button" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60" disabled={!current?.assetId || loadFailed || Boolean(busy)} onClick={async () => {
          if (!current) return; setBusy('remove'); setError(''); setNotice('');
          const command = removeCommand.current ??= { key: crypto.randomUUID(), revision: current.revision };
          try { applied(await httpClient.delete<Snapshot>('/authorize/avatar', undefined, { headers: { 'Idempotency-Key': command.key, 'If-Match': `"${command.revision}"` } }), 'remove'); }
          catch (failure) {
            if (conflict(failure)) { removeCommand.current = null; try { await refreshAfterConflict(); setError(text.changed); } catch { setLoadFailed(true); setError(text.loadFailed); } }
            else setError(text.removeFailed);
          } finally { setBusy(''); }
        }}>{busy === 'remove' ? text.removing : text.remove}</button></div>
    </form>
    <FormMessage message={error} error /><FormMessage message={notice} />
    {loadFailed && <button type="button" className={buttonClass} disabled={loading || Boolean(busy)} onClick={() => { setLoading(true); setError(''); setReload(value => value + 1); }}>{text.retry}</button>}
  </section>;
}
