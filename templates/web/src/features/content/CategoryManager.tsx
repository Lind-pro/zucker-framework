'use client';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { httpClient } from '@/lib/http-client';
import type { DraftCategory } from './types';
import {
  errorMessage,
  Field,
  ManageShell,
  Notice,
  panel,
  primary,
  secondary,
  Status,
  useCopy,
} from './management';

export function CategoryManager() {
  const t = useCopy(),
    locale = useLocale();
  const [language, setLanguage] = useState(locale);
  return (
    <ManageShell title={t('博客分类', 'Blog categories')}>
      <select
        className={`${secondary} mb-6`}
        aria-label={t('分类语言', 'Category language')}
        value={language}
        onChange={(e) => setLanguage(e.target.value)}
      >
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
      <Categories key={language} language={language} />
    </ManageShell>
  );
}
function Categories({ language }: { language: string }) {
  const t = useCopy(),
    locale = useLocale();
  const [rows, setRows] = useState<DraftCategory[] | null>(null),
    [selected, setSelected] = useState<DraftCategory | null>(null),
    [reload, setReload] = useState(0),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void httpClient
      .get<DraftCategory[]>('/content/manage/categories', { locale: language })
      .then((data) => {
        if (active) setRows(data);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e, locale === 'zh'));
      });
    return () => {
      active = false;
    };
  }, [language, reload, locale]);
  return (
    <div className="grid gap-6 md:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="space-y-3">
        <button className={`${primary} w-full`} onClick={() => setSelected(null)}>
          {t('新建分类', 'New category')}
        </button>
        <Notice error={error} message={!rows ? t('正在加载…', 'Loading…') : ''} />
        {error && (
          <button
            className={secondary}
            onClick={() => {
              setError('');
              setReload((x) => x + 1);
            }}
          >
            {t('重试', 'Retry')}
          </button>
        )}
        {rows?.map((row) => (
          <button
            key={row.id}
            className={`${panel} block w-full text-left ${selected?.id === row.id ? 'border-primary-500' : ''}`}
            onClick={() => setSelected(row)}
          >
            <span className="block font-medium mb-2">{row.draft.title}</span>
            <Status row={row} />
          </button>
        ))}
      </aside>
      <CategoryForm
        key={`${selected?.id ?? 'new'}:${selected?.revision ?? reload}`}
        initial={selected}
        language={language}
        onSaved={(row) => {
          setSelected(row);
          setReload((x) => x + 1);
        }}
      />
    </div>
  );
}
function CategoryForm({
  initial,
  language,
  onSaved,
}: {
  initial: DraftCategory | null;
  language: string;
  onSaved: (row: DraftCategory) => void;
}) {
  const t = useCopy(),
    locale = useLocale();
  const [title, setTitle] = useState(initial?.draft.title ?? ''),
    [description, setDescription] = useState(initial?.draft.description ?? ''),
    [slug, setSlug] = useState(initial?.slug ?? '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const dirty =
      !initial ||
      title !== initial.draft.title ||
      description !== initial.draft.description ||
      slug !== initial.slug,
    archived = initial?.status === 'archived';
  async function save(action?: string) {
    setBusy(true);
    setError('');
    try {
      const row =
        action && initial
          ? await httpClient.post<DraftCategory>(
              `/content/manage/categories/${initial.id}/${action}`,
              { expectedRevision: initial.revision },
            )
          : initial
            ? await httpClient.put<DraftCategory>(`/content/manage/categories/${initial.id}`, {
                expectedRevision: initial.revision,
                title,
                description,
                slug,
              })
            : await httpClient.post<DraftCategory>('/content/manage/categories', {
                locale: language,
                title,
                description,
                slug,
              });
      onSaved(row);
    } catch (e) {
      setError(errorMessage(e, locale === 'zh'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`${panel} space-y-5`}>
      <h2 className="text-xl font-semibold">
        {initial ? t('编辑分类', 'Edit category') : t('新建分类', 'New category')}
      </h2>
      <Notice
        error={error}
        message={dirty ? t('保存后才能发布。', 'Save before publishing.') : ''}
      />
      <fieldset disabled={busy || archived} className="space-y-5">
        <Field label={t('分类名称', 'Category title')}>
          <input
            className="content-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label={t('地址路径', 'URL slug')}>
          <input className="content-input" value={slug} onChange={(e) => setSlug(e.target.value)} />
        </Field>
        <Field label={t('简介', 'Description')}>
          <textarea
            rows={4}
            className="content-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <button
          className={primary}
          disabled={busy || archived || !dirty}
          onClick={() => void save()}
        >
          {t('保存草稿', 'Save draft')}
        </button>
        {initial && (
          <>
            <button
              className={secondary}
              disabled={busy || dirty || archived}
              onClick={() => void save('publish')}
            >
              {t('发布', 'Publish')}
            </button>
            {initial.status === 'published' && (
              <button className={secondary} disabled={busy} onClick={() => void save('unpublish')}>
                {t('取消发布', 'Unpublish')}
              </button>
            )}
            <button
              className={secondary}
              disabled={busy}
              onClick={() => void save(archived ? 'restore' : 'archive')}
            >
              {archived ? t('恢复', 'Restore') : t('归档', 'Archive')}
            </button>
          </>
        )}
      </div>
      <p className="text-xs text-[var(--color-muted)]">
        {t(
          '分类下线后，文章仍可访问，但不再显示该分类。重新发布文章前需解除引用或恢复分类。',
          'Unpublishing a category keeps its posts accessible and hides the category. Remove the reference or restore the category before republishing a post.',
        )}
      </p>
    </div>
  );
}
