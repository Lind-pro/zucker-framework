'use client';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { httpClient } from '@/lib/http-client';
import { validateSiteDocument } from '@zucker-framework/fe-site/content';
import { DocumentView } from './DocumentView';
import {
  contentPath,
  emptyDocument,
  localizedHref,
  type ContentKind,
  type ContentLocale,
  type DraftCategory,
  type DraftEntry,
} from './types';
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

export function ContentEditor({ id }: { id?: string }) {
  const t = useCopy(),
    locale = useLocale();
  const [row, setRow] = useState<DraftEntry | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (id)
      void httpClient
        .get<DraftEntry>(`/content/manage/entries/${id}`)
        .then((data) => {
          if (active) setRow(data);
        })
        .catch((e) => {
          if (active) setError(errorMessage(e, locale === 'zh'));
        });
    return () => {
      active = false;
    };
  }, [id, locale]);
  return (
    <ManageShell title={id ? t('编辑内容', 'Edit content') : t('新建内容', 'Create content')}>
      <Notice error={error} />
      {id && !row ? (
        error ? (
          <button className={secondary} onClick={() => window.location.reload()}>
            {t('重新加载', 'Reload')}
          </button>
        ) : (
          <p>{t('正在加载…', 'Loading…')}</p>
        )
      ) : (
        <EditorForm key={row?.id ?? 'new'} initial={row} />
      )}
    </ManageShell>
  );
}
function EditorForm({ initial }: { initial: DraftEntry | null }) {
  const t = useCopy(),
    locale = useLocale();
  const [saved, setSaved] = useState(initial),
    [document, setDocument] = useState(initial?.draft.document ?? emptyDocument());
  const [slug, setSlug] = useState(initial?.slug ?? ''),
    [kind, setKind] = useState<ContentKind>(initial?.kind ?? 'post'),
    [language, setLanguage] = useState<ContentLocale>(
      initial?.locale ?? (locale === 'en' ? 'en' : 'zh'),
    );
  const [blocks, setBlocks] = useState(
      JSON.stringify(initial?.draft.document.blocks ?? [], null, 2),
    ),
    [categoryIds, setCategoryIds] = useState(initial?.draft.categoryIds ?? []),
    [categories, setCategories] = useState<DraftCategory[]>([]);
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(false);
  useEffect(() => {
    let active = true;
    void httpClient
      .get<DraftCategory[]>('/content/manage/categories', { locale: language })
      .then((data) => {
        if (active) setCategories(data);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e, locale === 'zh'));
      });
    return () => {
      active = false;
    };
  }, [language, locale]);
  const dirty =
    !saved ||
    slug !== saved.slug ||
    JSON.stringify({ ...document, blocks: undefined }) !==
      JSON.stringify({ ...saved.draft.document, blocks: undefined }) ||
    blocks !== JSON.stringify(saved.draft.document.blocks, null, 2) ||
    JSON.stringify(categoryIds) !== JSON.stringify(saved.draft.categoryIds);
  const archived = saved?.status === 'archived';
  function currentDocument() {
    return validateSiteDocument({ ...document, blocks: JSON.parse(blocks) });
  }
  async function save() {
    setError('');
    setMessage('');
    setBusy(true);
    let navigating = false;
    try {
      let valid;
      try {
        valid = currentDocument();
      } catch {
        setError(
          t(
            '内容块格式或文档字段不正确，请检查 JSON、链接及文本长度。',
            'Check the block JSON, links and document field lengths.',
          ),
        );
        return;
      }
      const body = { slug, document: valid, categoryIds: kind === 'post' ? categoryIds : [] };
      const result = saved
        ? await httpClient.put<DraftEntry>(`/content/manage/entries/${saved.id}`, {
            ...body,
            expectedRevision: saved.revision,
          })
        : await httpClient.post<DraftEntry>('/content/manage/entries', {
            ...body,
            kind,
            locale: language,
          });
      if (!saved) {
        navigating = true;
        window.location.replace(localizedHref(`/content/manage/entries/${result.id}`, locale));
        return;
      }
      setSaved(result);
      setDocument(result.draft.document);
      setBlocks(JSON.stringify(result.draft.document.blocks, null, 2));
      setCategoryIds(result.draft.categoryIds);
      setMessage(t('草稿已保存。', 'Draft saved.'));
    } catch (e) {
      setError(errorMessage(e, locale === 'zh'));
    } finally {
      if (!navigating) setBusy(false);
    }
  }
  async function transition(action: string) {
    if (!saved || (dirty && action === 'publish')) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await httpClient.post<DraftEntry>(
        `/content/manage/entries/${saved.id}/${action}`,
        { expectedRevision: saved.revision },
      );
      setSaved(result);
      setMessage(t('发布状态已更新。', 'Publication status updated.'));
    } catch (e) {
      setError(errorMessage(e, locale === 'zh'));
    } finally {
      setBusy(false);
    }
  }
  let previewDocument = null;
  if (preview) {
    try {
      previewDocument = currentDocument();
    } catch {
      /* Validation is shown below without executing arbitrary content. */
    }
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          className={primary}
          disabled={busy || archived || !dirty}
          onClick={() => void save()}
        >
          {t('保存草稿', 'Save draft')}
        </button>
        {saved && (
          <>
            <button
              className={secondary}
              disabled={busy || dirty || archived}
              onClick={() => void transition('publish')}
            >
              {t('发布已保存版本', 'Publish saved version')}
            </button>
            {saved.status === 'published' && (
              <button
                className={secondary}
                disabled={busy}
                onClick={() => void transition('unpublish')}
              >
                {t('取消发布', 'Unpublish')}
              </button>
            )}
            <button
              className={secondary}
              disabled={busy}
              onClick={() => void transition(archived ? 'restore' : 'archive')}
            >
              {archived ? t('恢复草稿', 'Restore draft') : t('归档', 'Archive')}
            </button>
            <Status row={saved} />
          </>
        )}
        <button className={secondary} onClick={() => setPreview(!preview)}>
          {preview ? t('关闭预览', 'Close preview') : t('预览草稿', 'Preview draft')}
        </button>
        {saved?.publishedSlug && (
          <a
            className="text-sm text-primary-400"
            href={`/${saved.locale}${contentPath(saved.kind, saved.publishedSlug)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('查看线上版本', 'View live version')} ↗
          </a>
        )}
      </div>
      <Notice
        error={error}
        message={
          message ||
          (dirty
            ? t(
                '有未保存修改。请先保存，再发布。',
                'There are unsaved changes. Save before publishing.',
              )
            : '')
        }
      />
      <fieldset
        disabled={busy || archived}
        className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]"
      >
        <div className="space-y-6">
          <div className={`${panel} space-y-5`}>
            <Field label={t('标题', 'Title')}>
              <input
                className="content-input"
                value={document.title}
                maxLength={200}
                onChange={(e) => setDocument({ ...document, title: e.target.value })}
              />
            </Field>
            <Field label={t('简介', 'Description')}>
              <textarea
                rows={3}
                className="content-input"
                value={document.description}
                onChange={(e) => setDocument({ ...document, description: e.target.value })}
              />
            </Field>
            <Field label={t('正文（Markdown）', 'Body (Markdown)')}>
              <textarea
                rows={18}
                className="content-input font-mono text-sm"
                value={document.markdown}
                onChange={(e) => setDocument({ ...document, markdown: e.target.value })}
              />
            </Field>
            <p className="text-xs text-[var(--color-muted)]">
              {t(
                '支持标题、列表、链接与代码块。HTML 与 MDX 不会执行。',
                'Headings, lists, links and code blocks are supported. HTML and MDX are not executed.',
              )}
            </p>
          </div>
          <div className={`${panel} space-y-4`}>
            <Field label={t('结构化内容块（JSON 数组）', 'Structured blocks (JSON array)')}>
              <textarea
                rows={10}
                className="content-input font-mono text-sm"
                value={blocks}
                onChange={(e) => setBlocks(e.target.value)}
              />
            </Field>
            <p className="text-xs text-[var(--color-muted)]">
              {t(
                '支持 hero、markdown、features、faq、cta、links。enabled=false 的内容不会发布。',
                'Supports hero, markdown, features, faq, cta and links. Blocks with enabled=false are not published.',
              )}
            </p>
            <button
              className={secondary}
              type="button"
              onClick={() => {
                try {
                  const items = JSON.parse(blocks);
                  if (!Array.isArray(items)) return;
                  setBlocks(
                    JSON.stringify(
                      [
                        ...items,
                        {
                          id: `section-${items.length + 1}`,
                          type: 'hero',
                          enabled: true,
                          heading: t('新章节', 'New section'),
                          text: '',
                        },
                      ],
                      null,
                      2,
                    ),
                  );
                } catch {
                  setError(t('请先修正内容块 JSON。', 'Fix the block JSON first.'));
                }
              }}
            >
              {t('添加首屏块', 'Add hero block')}
            </button>
          </div>
        </div>
        <aside className="space-y-6">
          <div className={`${panel} space-y-5`}>
            <Field label={t('类型', 'Type')}>
              <select
                className="content-input"
                value={kind}
                disabled={Boolean(saved)}
                onChange={(e) => {
                  setKind(e.target.value as ContentKind);
                  setCategoryIds([]);
                }}
              >
                <option value="page">{t('页面', 'Page')}</option>
                <option value="post">{t('博客', 'Blog post')}</option>
                <option value="doc">{t('文档', 'Documentation')}</option>
              </select>
            </Field>
            <Field label={t('语言', 'Language')}>
              <select
                className="content-input"
                disabled={Boolean(saved)}
                value={language}
                onChange={(e) => {
                  setLanguage(e.target.value as ContentLocale);
                  setCategoryIds([]);
                }}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
            </Field>
            <Field label={t('地址路径', 'URL slug')}>
              <input
                className="content-input"
                value={slug}
                placeholder="getting-started"
                onChange={(e) => setSlug(e.target.value)}
              />
            </Field>
            <p className="text-xs text-[var(--color-muted)]">
              {t(
                '使用小写英文字母、数字和连字符。修改路径在发布后生效。',
                'Use lowercase letters, numbers and hyphens. Address changes go live when published.',
              )}
            </p>
            <Field label={t('作者', 'Author')}>
              <input
                className="content-input"
                value={document.authorName}
                onChange={(e) => setDocument({ ...document, authorName: e.target.value })}
              />
            </Field>
            {kind === 'post' && (
              <fieldset>
                <legend className="mb-3 text-sm">{t('博客分类', 'Blog categories')}</legend>
                {categories
                  .filter(
                    (category) =>
                      category.status === 'published' || categoryIds.includes(category.id),
                  )
                  .map((category) => (
                    <label className="flex items-center gap-2 mb-3 text-sm" key={category.id}>
                      <input
                        type="checkbox"
                        checked={categoryIds.includes(category.id)}
                        onChange={(e) =>
                          setCategoryIds(
                            e.target.checked
                              ? [...categoryIds, category.id]
                              : categoryIds.filter((id) => id !== category.id),
                          )
                        }
                      />
                      {category.draft.title}
                      {category.status !== 'published' && ` (${t('已下线', 'Unpublished')})`}
                    </label>
                  ))}
                {!categories.some((category) => category.status === 'published') && (
                  <p className="text-xs text-[var(--color-muted)]">
                    {t('先创建并发布分类。', 'Create and publish categories first.')}
                  </p>
                )}
              </fieldset>
            )}
          </div>
          <div className={`${panel} space-y-5`}>
            <h2 className="font-semibold">SEO</h2>
            <Field label={t('搜索标题（可选）', 'Search title (optional)')}>
              <input
                className="content-input"
                value={document.seo.title}
                onChange={(e) =>
                  setDocument({ ...document, seo: { ...document.seo, title: e.target.value } })
                }
              />
            </Field>
            <Field label={t('搜索描述（可选）', 'Search description (optional)')}>
              <textarea
                className="content-input"
                value={document.seo.description}
                onChange={(e) =>
                  setDocument({
                    ...document,
                    seo: { ...document.seo, description: e.target.value },
                  })
                }
              />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={document.seo.noIndex}
                onChange={(e) =>
                  setDocument({ ...document, seo: { ...document.seo, noIndex: e.target.checked } })
                }
              />
              {t('不被搜索引擎收录', 'Exclude from search engine indexing')}
            </label>
          </div>
        </aside>
      </fieldset>
      {preview && (
        <section className={`${panel} space-y-6`}>
          <h2 className="text-xl font-semibold">{t('草稿预览', 'Draft preview')}</h2>
          {previewDocument ? (
            <>
              <h3 className="text-3xl font-bold">{previewDocument.title}</h3>
              <DocumentView document={previewDocument} locale={language} />
            </>
          ) : (
            <Notice
              error={t(
                '修正文档字段和内容块后才能预览。',
                'Fix document fields and blocks to preview.',
              )}
            />
          )}
        </section>
      )}
    </div>
  );
}
