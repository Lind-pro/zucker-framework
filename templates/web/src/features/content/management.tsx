'use client';
import { useLocale } from 'next-intl';
import { cloneElement, useEffect, useId, useState, type ReactElement, type ReactNode } from 'react';
import { httpClient } from '@/lib/http-client';
import { Link } from '@/i18n/navigation';
import type { DraftEntry, DraftCategory } from './types';

export const primary =
  'inline-flex items-center justify-center rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed';
export const secondary =
  'inline-flex items-center justify-center rounded-lg border border-[var(--color-border)] px-4 py-2.5 text-sm hover:border-primary-500 disabled:opacity-40 disabled:cursor-not-allowed';
export const panel = 'rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-6';
export function useCopy() {
  const locale = useLocale();
  return (zh: string, en: string) => (locale === 'zh' ? zh : en);
}
export function errorMessage(error: unknown, zh: boolean): string {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : 0;
  if (status === 403)
    return zh
      ? '你没有内容管理权限，或请求来源不受信任。'
      : 'Content management permission is required, or the request origin is not trusted.';
  if (status === 409)
    return zh
      ? '内容已被修改或地址被占用。请重新加载后再保存。'
      : 'The content changed or its address is in use. Reload before saving.';
  if (status === 400)
    return zh
      ? '请检查字段、内容块和分类：分类需要先在同一语言下发布。'
      : 'Check the fields, blocks and categories. Categories must be published in the same language first.';
  return zh ? '操作未完成，请稍后重试。' : 'The operation did not complete. Please try again.';
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
}) {
  const generated = useId(),
    id = children.props.id ?? generated;
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}
export function Notice({ error, message }: { error?: string; message?: string }) {
  return error ? (
    <p
      role="alert"
      className="rounded-lg border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-300"
    >
      {error}
    </p>
  ) : message ? (
    <p role="status" className="text-sm text-[var(--color-muted)]">
      {message}
    </p>
  ) : null;
}
export function ManageShell({ children, title }: { children: ReactNode; title: string }) {
  const t = useCopy();
  return (
    <section className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 border-b border-[var(--color-border)] pb-6">
        <p className="text-sm text-primary-400">{t('内容工作台', 'Content workspace')}</p>
        <h1 className="mt-2 text-3xl font-bold">{title}</h1>
        <nav aria-label={t('内容管理', 'Content management')} className="mt-6 flex flex-wrap gap-3">
          <Link href="/content/manage" className={secondary}>
            {t('页面、博客与文档', 'Pages, blog and docs')}
          </Link>
          <Link href="/content/manage/categories" className={secondary}>
            {t('博客分类', 'Blog categories')}
          </Link>
          <Link href="/content/manage/settings" className={secondary}>
            {t('站点设置', 'Site settings')}
          </Link>
          <Link href="/account" className={secondary}>
            {t('我的账户', 'My account')}
          </Link>
        </nav>
      </header>
      {children}
    </section>
  );
}
export function Status({
  row,
}: {
  row: Pick<DraftEntry | DraftCategory, 'status' | 'revision' | 'publishedRevision'>;
}) {
  const t = useCopy();
  return (
    <span className="text-xs text-[var(--color-muted)]">
      {row.status === 'published'
        ? t('已发布', 'Published')
        : row.status === 'archived'
          ? t('已归档', 'Archived')
          : t('草稿', 'Draft')}
      {row.status === 'published' && row.revision !== row.publishedRevision
        ? ` · ${t('有未发布修改', 'Unpublished changes')}`
        : ''}
    </span>
  );
}
export function ContentManager() {
  const t = useCopy(),
    locale = useLocale();
  const [kind, setKind] = useState(''),
    [status, setStatus] = useState(''),
    [language, setLanguage] = useState(locale),
    [page, setPage] = useState(1);
  return (
    <ManageShell title={t('内容管理', 'Manage content')}>
      <div className="mb-6 flex flex-wrap gap-3">
        <select
          aria-label={t('内容类型', 'Content type')}
          className={secondary}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('全部类型', 'All types')}</option>
          <option value="page">{t('页面', 'Page')}</option>
          <option value="post">{t('博客', 'Blog post')}</option>
          <option value="doc">{t('文档', 'Documentation')}</option>
        </select>
        <select
          aria-label={t('发布状态', 'Publication status')}
          value={status}
          className={secondary}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('全部状态', 'All statuses')}</option>
          <option value="draft">{t('草稿', 'Draft')}</option>
          <option value="published">{t('已发布', 'Published')}</option>
          <option value="archived">{t('已归档', 'Archived')}</option>
        </select>
        <select
          aria-label={t('内容语言', 'Content language')}
          value={language}
          className={secondary}
          onChange={(e) => {
            setLanguage(e.target.value);
            setPage(1);
          }}
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
        <Link href="/content/manage/new" className={`${primary} ml-auto`}>
          {t('新建内容', 'Create content')}
        </Link>
      </div>
      <ContentRows
        key={`${kind}:${status}:${language}:${page}`}
        kind={kind}
        status={status}
        language={language}
        page={page}
        onPage={setPage}
      />
    </ManageShell>
  );
}
function ContentRows({
  kind,
  status,
  language,
  page,
  onPage,
}: {
  kind: string;
  status: string;
  language: string;
  page: number;
  onPage: (page: number) => void;
}) {
  const t = useCopy(),
    locale = useLocale();
  const [rows, setRows] = useState<{ data: DraftEntry[]; total: number; pageSize: number } | null>(
      null,
    ),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    httpClient
      .get<{ data: DraftEntry[]; total: number; pageSize: number }>('/content/manage/entries', {
        locale: language,
        page,
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
      })
      .then((data) => {
        if (active) setRows(data);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e, locale === 'zh'));
      });
    return () => {
      active = false;
    };
  }, [kind, status, language, page, retry, locale]);
  return (
    <div className="space-y-5">
      <Notice error={error} message={!rows ? t('正在加载内容…', 'Loading content…') : ''} />
      {error && (
        <button
          className={secondary}
          onClick={() => {
            setError('');
            setRetry((x) => x + 1);
          }}
        >
          {t('重试', 'Retry')}
        </button>
      )}
      {rows && (
        <>
          {rows.data.length ? (
            <ul className="space-y-3">
              {rows.data.map((row) => (
                <li key={row.id}>
                  <Link
                    href={`/content/manage/entries/${row.id}`}
                    className={`${panel} flex flex-wrap items-center justify-between gap-4`}
                  >
                    <div>
                      <h2 className="font-semibold">{row.draft.document.title}</h2>
                      <p className="mt-2 text-sm text-[var(--color-muted)]">
                        {row.kind} · {row.locale} · /{row.slug}
                      </p>
                    </div>
                    <Status row={row} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className={`${panel} text-[var(--color-muted)]`}>
              {t('暂无内容，创建第一篇吧。', 'No content yet. Create your first entry.')}
            </p>
          )}
          <div className="flex items-center justify-between">
            <button className={secondary} disabled={page === 1} onClick={() => onPage(page - 1)}>
              {t('上一页', 'Previous')}
            </button>
            <span className="text-sm text-[var(--color-muted)]">
              {page} / {Math.max(1, Math.ceil(rows.total / rows.pageSize))}
            </span>
            <button
              className={secondary}
              disabled={page * rows.pageSize >= rows.total}
              onClick={() => onPage(page + 1)}
            >
              {t('下一页', 'Next')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
