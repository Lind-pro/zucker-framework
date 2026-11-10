import {
  Button,
  DataTable,
  Dialog,
  Field,
  Input,
  Notice,
  PageContainer,
  Panel,
  ResourceTable,
  Select,
  StatusBadge,
  Switch,
  Tabs,
  Textarea,
  assertPage,
  errorBody,
  errorStatus,
  formatDateTime,
  toast,
  useAdminApi,
  useAdminI18n,
  useResource,
  type ResourceTableHandle,
} from '@zucker-framework/fe-admin';
import type { SiteDocument } from '@zucker-framework/fe-site/content';
import { useRef, useState } from 'react';
import {
  BlockListEditor,
  BlocksJsonEditor,
  DraftPreview,
  checkDocument,
  issueSummary,
  issueText,
  toDocumentDraft,
  type DocumentDraft,
  type DocumentIssue,
} from '../features/blocks';
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
/** `GET /content/manage/files`: documents read from the server's `content/` directory. */
interface FileEntryRow {
  id: string;
  kind: string;
  locale: string;
  slug: string;
  title: string;
  publishedAt: string;
  source: string;
  overridden: boolean;
}
interface FileEntries {
  data: FileEntryRow[];
  issues: Array<{ source: string; message: string }>;
}
type Tx = (zh: string, en: string) => string;
type EditorTab = 'content' | 'blocks' | 'json' | 'preview';

const kindOptions = (tx: Tx) => [
  { value: 'page', label: tx('页面', 'Page') },
  { value: 'post', label: tx('博客', 'Post') },
  { value: 'doc', label: tx('文档', 'Doc') },
  { value: 'log', label: tx('更新日志', 'Changelog') },
];
/** Kinds whose slug is a single segment (server `content.validation.ts`). */
const SINGLE_SEGMENT_KINDS = new Set(['post', 'log']);

function EntryEditor({ entry, categories, onClose, onSaved }: { entry: Entry | null; categories: Category[]; onClose: () => void; onSaved: () => void }) {
  const api = useAdminApi();
  const tx = useText();
  const [kind, setKind] = useState(entry?.kind ?? 'post');
  const [language, setLanguage] = useState(entry?.locale ?? 'zh');
  const [slug, setSlug] = useState(entry?.slug ?? '');
  const [draft, setDraft] = useState<DocumentDraft>(() => toDocumentDraft(entry?.draft.document));
  const [categoryIds, setCategoryIds] = useState<string[]>(entry?.draft.categoryIds ?? []);
  const [issue, setIssue] = useState<DocumentIssue | null>(null);
  const [tab, setTab] = useState<EditorTab>('content');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const currentKind = entry?.kind ?? kind;
  /** Every edit goes through here: a reported issue is cleared once its field no longer fails. */
  const updateDraft = (next: DocumentDraft) => {
    setDraft(next);
    if (issue) {
      const check = checkDocument(next);
      if (check.ok || check.issue.field !== issue.field) {
        setIssue(null);
        setError(null);
      }
    }
  };
  const set = <K extends keyof DocumentDraft>(key: K, value: DocumentDraft[K]) => updateDraft({ ...draft, [key]: value });
  async function save() {
    if (!slug.trim()) {
      setError(tx('请填写地址路径', 'Enter a path'));
      setTab('content');
      return;
    }
    // The shared fe-site validator is the only gate; its dotted field path selects the tab and input.
    const check = checkDocument(draft);
    if (!check.ok) {
      setIssue(check.issue);
      setError(issueSummary(check.issue, draft.blocks, tx));
      setTab(check.issue.field.startsWith('blocks') ? 'blocks' : 'content');
      return;
    }
    setSaving(true);
    setError(null);
    setIssue(null);
    const body = { slug: slug.trim(), document: check.document, categoryIds: currentKind === 'post' ? categoryIds : [] };
    try {
      if (entry) await api.put(`/content/manage/entries/${encodeURIComponent(entry.id)}`, { ...body, expectedRevision: entry.revision });
      else await api.post('/content/manage/entries', { ...body, kind, locale: language });
      toast.success(tx('草稿已保存', 'Draft saved'));
      onSaved();
    } catch (failure) {
      const status = errorStatus(failure);
      setError(
        status === 409
          ? tx('版本冲突或地址已占用，请重新打开内容', 'Version conflict or path in use; reopen the entry')
          : status === 400
            ? `${tx('服务器拒绝了草稿', 'The server rejected the draft')}: ${errorBody(failure).message ?? ''}`
            : tx('草稿保存失败', 'Could not save the draft'),
      );
    } finally {
      setSaving(false);
    }
  }
  const text = (path: string, label: string, value: string, onChange: (value: string) => void, options: { rows?: number; required?: boolean; description?: string } = {}) => (
    <Field label={label} required={options.required} description={options.description} error={issue?.field === path ? issueText(issue.message, tx) : undefined}>
      {({ id, describedBy, invalid }) =>
        options.rows ? (
          <Textarea id={id} rows={options.rows} data-field={path} aria-describedby={describedBy} aria-invalid={invalid || undefined} value={value} disabled={saving} onChange={(event) => onChange(event.target.value)} />
        ) : (
          <Input id={id} data-field={path} aria-describedby={describedBy} aria-invalid={invalid || undefined} value={value} disabled={saving} onChange={(event) => onChange(event.target.value)} />
        )
      }
    </Field>
  );
  const contentTab = (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tx('内容类型', 'Type')} required>
          {({ id }) => <Select id={id} value={kind} disabled={Boolean(entry) || saving} onChange={(event) => setKind(event.target.value)} options={kindOptions(tx)} />}
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
      {text('slug', tx('地址路径', 'Path'), slug, setSlug, {
        required: true,
        description: SINGLE_SEGMENT_KINDS.has(currentKind)
          ? tx('小写字母、数字和连字符，单级路径。', 'Lowercase letters, digits and hyphens; a single segment.')
          : tx('小写字母、数字和连字符；页面与文档支持多级路径。首页使用 home。', 'Lowercase letters, digits and hyphens; pages and docs may be nested. The home page is "home".'),
      })}
      {text('title', tx('标题', 'Title'), draft.title, (value) => set('title', value), { required: true })}
      {text('description', tx('简介', 'Summary'), draft.description, (value) => set('description', value), { rows: 2 })}
      {text('authorName', tx('作者', 'Author'), draft.authorName, (value) => set('authorName', value))}
      {text('markdown', tx('正文（Markdown）', 'Body (Markdown)'), draft.markdown, (value) => set('markdown', value), { rows: 12, description: tx('不执行 HTML 或 MDX。落地页通常只用内容块。', 'HTML and MDX are not executed. Landing pages usually use blocks only.') })}
      {currentKind === 'post' && (
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
                  onChange={(event) => setCategoryIds((previous) => (event.target.checked ? [...previous, category.id] : previous.filter((id) => id !== category.id)))}
                />
                {category.locale} · {category.draft.title}
                {category.status !== 'published' && tx('（未发布）', ' (unpublished)')}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {text('seo.title', tx('SEO 标题', 'SEO title'), draft.seo.title, (value) => set('seo', { ...draft.seo, title: value }))}
      {text('seo.description', tx('SEO 描述', 'SEO description'), draft.seo.description, (value) => set('seo', { ...draft.seo, description: value }), { rows: 2 })}
      <Field label={tx('不被搜索引擎收录', 'Hide from search engines')} inline>
        {({ id }) => <Switch id={id} checked={draft.seo.noIndex} disabled={saving} onCheckedChange={(checked) => set('seo', { ...draft.seo, noIndex: checked })} />}
      </Field>
    </div>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      busy={saving}
      width={1100}
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
            '关闭后点击列表中的“发布已保存版本”。发布会校验同语言已发布分类；隐藏的内容块不会出现在公开版本。',
            'Use “Publish saved version” in the list. Publishing checks published categories in the same language; hidden blocks never appear publicly.',
          )}
        </Notice>
        {error && <Notice tone="danger" title={error} />}
        <Tabs
          label={tx('编辑视图', 'Editor view')}
          value={tab}
          onValueChange={(value) => setTab(value as EditorTab)}
          items={[
            { value: 'content', label: tx('基本信息', 'Content'), content: contentTab },
            {
              value: 'blocks',
              label: `${tx('内容块', 'Blocks')} (${draft.blocks.length})`,
              content: <BlockListEditor blocks={draft.blocks} issue={issue} disabled={saving} onChange={(blocks) => set('blocks', blocks)} />,
            },
            { value: 'json', label: tx('高级 JSON', 'Advanced JSON'), content: <BlocksJsonEditor draft={draft} disabled={saving} onApply={(blocks) => set('blocks', blocks)} /> },
            { value: 'preview', label: tx('预览', 'Preview'), content: <DraftPreview draft={draft} locale={language} /> },
          ]}
        />
      </div>
    </Dialog>
  );
}

/** Starter documents read from the server's `content/` directory (read-only here). */
function FileEntriesPanel() {
  const api = useAdminApi();
  const tx = useText();
  const { locale } = useAdminI18n();
  const files = useResource(async (signal) => {
    const result = await api.get<FileEntries>('/content/manage/files', undefined, { signal });
    if (!result || !Array.isArray(result.data)) throw new Error('Unexpected file entries response');
    return { data: result.data, issues: Array.isArray(result.issues) ? result.issues : [] };
  }, []);
  const kinds = Object.fromEntries(kindOptions(tx).map((option) => [option.value, option.label]));
  return (
    <Panel title={tx('内容文件', 'Content files')}>
      <p className="mb-3 text-sm text-muted-foreground">
        {tx(
          '服务器启动时读取 content/ 目录中的文档。发布同类型、同语言、同路径的数据库内容后，它将替代文件版本；运行 pnpm content:seed 可把文件复制为可编辑的草稿。',
          'Documents in the server’s content/ directory are read at startup. Publishing a database entry with the same type, language and path replaces the file version; run pnpm content:seed to copy files into editable drafts.',
        )}
      </p>
      {files.data && files.data.issues.length > 0 && (
        <Notice tone="warning" title={tx('部分文件未加载', 'Some files were not loaded')}>
          <ul className="list-disc pl-5">
            {files.data.issues.map((issue, index) => (
              <li key={index}>
                {issue.source}: {issue.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <DataTable<FileEntryRow>
        label={tx('内容文件', 'Content files')}
        rows={files.data?.data ?? []}
        rowKey={(row) => row.id}
        loading={files.loading}
        error={files.error}
        onRetry={files.reload}
        columns={[
          { key: 'title', title: tx('标题', 'Title'), field: 'title' },
          { key: 'kind', title: tx('类型', 'Type'), render: (row) => kinds[row.kind] ?? row.kind },
          { key: 'locale', title: tx('语言', 'Language'), field: 'locale' },
          { key: 'slug', title: tx('路径', 'Path'), field: 'slug' },
          {
            key: 'state',
            title: tx('状态', 'Status'),
            render: (row) =>
              row.overridden ? (
                <StatusBadge tone="neutral">{tx('已被数据库内容替代', 'Replaced by a database entry')}</StatusBadge>
              ) : (
                <StatusBadge tone="info">{tx('公开显示文件版本', 'File version is public')}</StatusBadge>
              ),
          },
          { key: 'publishedAt', title: tx('发布时间', 'Published'), render: (row) => formatDateTime(row.publishedAt, locale), hideOnMobile: true },
        ]}
      />
    </Panel>
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
          { name: 'kind', label: tx('类型', 'Type'), type: 'select', options: kindOptions(tx) },
          { name: 'locale', label: tx('语言', 'Language'), type: 'select', options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }] },
          { name: 'status', label: tx('状态', 'Status'), type: 'select', options: Object.entries(statuses).map(([value, label]) => ({ value, label })) },
        ]}
        columns={[
          { key: 'title', title: tx('标题', 'Title'), field: 'draft.document.title' },
          { key: 'kind', title: tx('类型', 'Type'), render: (row) => kindOptions(tx).find((option) => option.value === row.kind)?.label ?? row.kind },
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
      <FileEntriesPanel />
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
