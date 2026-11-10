import {
  Button,
  Dialog,
  Field,
  Input,
  Notice,
  PageContainer,
  ResourceTable,
  Select,
  StatusBadge,
  Switch,
  Textarea,
  assertPage,
  errorStatus,
  formatDateTime,
  toast,
  useAdminApi,
  useAdminI18n,
  type ResourceTableHandle,
} from '@zucker-framework/fe-admin';
import { validateSiteDocument, type SiteDocument } from '@zucker-framework/fe-site/content';
import { useRef, useState } from 'react';
import { useText } from '../text';

interface Entry {
  id: string;
  kind: string;
  locale: string;
  slug: string;
  status: string;
  revision: number;
  publishedRevision: number | null;
  draft: { document: SiteDocument; categoryIds: string[] };
  updatedAt: string;
}
interface Category {
  id: string;
  locale: string;
  draft: { title: string };
  status: string;
}
const emptyDocument: SiteDocument = {
  version: 1,
  title: '',
  description: '',
  authorName: '',
  markdown: '',
  blocks: [],
  seo: { title: '', description: '', noIndex: false },
};

function EntryEditor({ entry, categories, onClose, onSaved }: { entry: Entry | null; categories: Category[]; onClose: () => void; onSaved: () => void }) {
  const api = useAdminApi();
  const tx = useText();
  const [kind, setKind] = useState(entry?.kind ?? 'post');
  const [language, setLanguage] = useState(entry?.locale ?? 'zh');
  const [slug, setSlug] = useState(entry?.slug ?? '');
  const [document, setDocument] = useState<SiteDocument>(entry?.draft.document ?? emptyDocument);
  const [categoryIds, setCategoryIds] = useState<string[]>(entry?.draft.categoryIds ?? []);
  const [blocks, setBlocks] = useState(JSON.stringify(entry?.draft.document.blocks ?? [], null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof SiteDocument>(key: K, value: SiteDocument[K]) => setDocument((previous) => ({ ...previous, [key]: value }));
  async function save() {
    let validated: SiteDocument;
    try {
      validated = validateSiteDocument({ ...document, version: 1, blocks: JSON.parse(blocks) });
    } catch {
      setError(tx('请检查文档字段、内容块 JSON 和链接格式', 'Check the document fields, block JSON and link format'));
      return;
    }
    if (!slug.trim()) {
      setError(tx('请填写地址路径', 'Enter a path'));
      return;
    }
    setSaving(true);
    setError(null);
    const body = { slug: slug.trim(), document: validated, categoryIds: (entry?.kind ?? kind) === 'post' ? categoryIds : [] };
    try {
      if (entry) await api.put(`/content/manage/entries/${encodeURIComponent(entry.id)}`, { ...body, expectedRevision: entry.revision });
      else await api.post('/content/manage/entries', { ...body, kind, locale: language });
      toast.success(tx('草稿已保存', 'Draft saved'));
      onSaved();
    } catch (failure) {
      setError(errorStatus(failure) === 409 ? tx('版本冲突或地址已占用，请重新打开内容', 'Version conflict or path in use; reopen the entry') : tx('草稿保存失败', 'Could not save the draft'));
    } finally {
      setSaving(false);
    }
  }
  const text = (label: string, value: string, onChange: (value: string) => void, options: { rows?: number; required?: boolean; description?: string } = {}) => (
    <Field label={label} required={options.required} description={options.description}>
      {({ id }) =>
        options.rows ? (
          <Textarea id={id} rows={options.rows} value={value} disabled={saving} onChange={(event) => onChange(event.target.value)} />
        ) : (
          <Input id={id} value={value} disabled={saving} onChange={(event) => onChange(event.target.value)} />
        )
      }
    </Field>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      busy={saving}
      width={960}
      title={entry ? tx('编辑草稿', 'Edit draft') : tx('新建内容', 'New entry')}
      footer={
        <>
          <Button disabled={saving} onClick={onClose}>
            {tx('取消', 'Cancel')}
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {tx('保存草稿', 'Save draft')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Notice tone="info" title={tx('本窗口不会发布内容', 'Saving here never publishes')}>
          {tx(
            '关闭后点击列表中的“发布已保存版本”。发布会校验同语言已发布分类；禁用内容块不会出现在公开版本。',
            'Use “Publish saved version” in the list. Publishing checks published categories in the same language; disabled blocks never appear publicly.',
          )}
        </Notice>
        {error && <Notice tone="danger" title={error} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tx('内容类型', 'Type')} required>
            {({ id }) => (
              <Select
                id={id}
                value={kind}
                disabled={Boolean(entry) || saving}
                onChange={(event) => setKind(event.target.value)}
                options={[
                  { value: 'page', label: tx('页面', 'Page') },
                  { value: 'post', label: tx('博客', 'Post') },
                  { value: 'doc', label: tx('文档', 'Doc') },
                ]}
              />
            )}
          </Field>
          <Field label={tx('语言', 'Language')} required>
            {({ id }) => (
              <Select
                id={id}
                value={language}
                disabled={Boolean(entry) || saving}
                onChange={(event) => setLanguage(event.target.value)}
                options={[
                  { value: 'zh', label: '中文' },
                  { value: 'en', label: 'English' },
                ]}
              />
            )}
          </Field>
        </div>
        {text(tx('地址路径', 'Path'), slug, setSlug, { required: true, description: tx('小写字母、数字和连字符；页面与文档支持多级路径。', 'Lowercase letters, digits and hyphens; pages and docs may be nested.') })}
        {text(tx('标题', 'Title'), document.title, (value) => set('title', value), { required: true })}
        {text(tx('简介', 'Summary'), document.description, (value) => set('description', value), { rows: 2 })}
        {text(tx('作者', 'Author'), document.authorName, (value) => set('authorName', value))}
        {text(tx('正文（Markdown）', 'Body (Markdown)'), document.markdown, (value) => set('markdown', value), { rows: 12, description: tx('不执行 HTML 或 MDX。', 'HTML and MDX are not executed.') })}
        {(entry?.kind ?? kind) === 'post' && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{tx('博客分类', 'Blog categories')}</legend>
            <p className="text-xs text-muted-foreground">{tx('发布时必须是同一语言且已发布的分类。', 'Categories must be published and in the same language when publishing.')}</p>
            <div className="flex flex-wrap gap-3">
              {categories.map((category) => (
                <label key={category.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={categoryIds.includes(category.id)}
                    disabled={saving}
                    onChange={(event) =>
                      setCategoryIds((previous) => (event.target.checked ? [...previous, category.id] : previous.filter((id) => id !== category.id)))
                    }
                  />
                  {category.locale} · {category.draft.title}
                  {category.status !== 'published' && tx('（未发布）', ' (unpublished)')}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {text(tx('结构化内容块（JSON 数组）', 'Structured blocks (JSON array)'), blocks, setBlocks, { rows: 6 })}
        {text(tx('SEO 标题', 'SEO title'), document.seo.title, (value) => set('seo', { ...document.seo, title: value }))}
        {text(tx('SEO 描述', 'SEO description'), document.seo.description, (value) => set('seo', { ...document.seo, description: value }), { rows: 2 })}
        <Field label={tx('不被搜索引擎收录', 'Hide from search engines')} inline>
          {({ id }) => <Switch id={id} checked={document.seo.noIndex} disabled={saving} onCheckedChange={(checked) => set('seo', { ...document.seo, noIndex: checked })} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** Content drafts and publishing over the server template's `/content/manage` API. */
/** Fixed page size of `GET /content/manage/entries` (ContentRepository.adminEntries). */
const CONTENT_PAGE_SIZE = 20;

export function ContentPage() {
  const api = useAdminApi();
  const { locale } = useAdminI18n();
  const tx = useText();
  const table = useRef<ResourceTableHandle>(null);
  const [editing, setEditing] = useState<{ entry: Entry | null; categories: Category[] } | null>(null);
  const statuses: Record<string, string> = { draft: tx('草稿', 'Draft'), published: tx('已发布', 'Published'), archived: tx('已归档', 'Archived') };
  async function open(entry: Entry | null) {
    try {
      const categories = await api.get<Category[]>('/content/manage/categories');
      setEditing({ entry, categories: Array.isArray(categories) ? categories : [] });
    } catch {
      toast.error(tx('分类读取失败，请重试', 'Could not load categories; retry'));
    }
  }
  async function transition(row: Entry, action: string) {
    try {
      await api.post(`/content/manage/entries/${encodeURIComponent(row.id)}/${action}`, { expectedRevision: row.revision });
      toast.success(tx('发布状态已更新', 'Publishing state updated'));
    } catch (error) {
      toast.error(errorStatus(error) === 409 ? tx('内容已变化，请刷新后再操作', 'The entry changed; refresh and retry') : tx('操作失败，请检查内容及分类是否可发布', 'Failed; check the entry and its categories'));
    } finally {
      table.current?.reload();
    }
  }
  return (
    <PageContainer
      title={tx('页面、博客与文档', 'Pages, blog & docs')}
      description={tx('保存只更新草稿；发布后才改变公开页面、地址、搜索与站点地图。', 'Saving updates the draft only; publishing changes public pages, paths, search and the sitemap.')}
      actions={
        <Button variant="primary" onClick={() => void open(null)}>
          {tx('新建内容', 'New entry')}
        </Button>
      }
    >
      <ResourceTable<Entry>
        ref={table}
        label={tx('内容', 'Content')}
        // The content API pages by a fixed 20 rows and rejects a pageSize parameter; keep the table in step.
        load={async ({ page, filters, signal }) => assertPage<Entry>(await api.get('/content/manage/entries', { page, ...filters }, { signal }))}
        pageSize={CONTENT_PAGE_SIZE}
        pageSizeOptions={[CONTENT_PAGE_SIZE]}
        rowKey={(row) => row.id}
        filters={[
          { name: 'kind', label: tx('类型', 'Type'), type: 'select', options: [{ value: 'page', label: tx('页面', 'Page') }, { value: 'post', label: tx('博客', 'Post') }, { value: 'doc', label: tx('文档', 'Doc') }] },
          { name: 'locale', label: tx('语言', 'Language'), type: 'select', options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }] },
          { name: 'status', label: tx('状态', 'Status'), type: 'select', options: Object.entries(statuses).map(([value, label]) => ({ value, label })) },
        ]}
        columns={[
          { key: 'title', title: tx('标题', 'Title'), field: 'draft.document.title' },
          { key: 'kind', title: tx('类型', 'Type'), field: 'kind' },
          { key: 'locale', title: tx('语言', 'Language'), field: 'locale' },
          { key: 'slug', title: tx('路径', 'Path'), field: 'slug' },
          {
            key: 'status',
            title: tx('状态', 'Status'),
            render: (row) => (
              <span className="flex flex-wrap gap-1">
                <StatusBadge tone={row.status === 'published' ? 'success' : 'neutral'}>{statuses[row.status] ?? row.status}</StatusBadge>
                {row.status === 'published' && row.revision !== row.publishedRevision && <StatusBadge tone="warning">{tx('有未发布修改', 'Unpublished changes')}</StatusBadge>}
              </span>
            ),
          },
          { key: 'updatedAt', title: tx('更新时间', 'Updated'), render: (row) => formatDateTime(row.updatedAt, locale), hideOnMobile: true },
        ]}
        actions={(row) => (
          <>
            {row.status !== 'archived' && (
              <Button size="sm" variant="ghost" onClick={() => void open(row)}>
                {tx('编辑草稿', 'Edit draft')}
              </Button>
            )}
            {row.status !== 'archived' && (
              <Button size="sm" variant="ghost" onClick={() => void transition(row, 'publish')}>
                {tx('发布已保存版本', 'Publish saved version')}
              </Button>
            )}
            {row.status === 'published' && (
              <Button size="sm" variant="ghost" onClick={() => void transition(row, 'unpublish')}>
                {tx('取消发布', 'Unpublish')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void transition(row, row.status === 'archived' ? 'restore' : 'archive')}>
              {row.status === 'archived' ? tx('恢复草稿', 'Restore draft') : tx('归档', 'Archive')}
            </Button>
          </>
        )}
      />
      {editing && (
        <EntryEditor
          key={editing.entry?.id ?? 'new'}
          entry={editing.entry}
          categories={editing.categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            table.current?.reload();
          }}
        />
      )}
    </PageContainer>
  );
}
