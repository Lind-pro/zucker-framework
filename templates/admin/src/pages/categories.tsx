import {
  Button,
  DataTable,
  FormDialog,
  PageContainer,
  StatusBadge,
  toast,
  useAdminApi,
  useResource,
} from '@zucker-framework/fe-admin';
import { useState } from 'react';
import { useText } from '../text';

interface Category {
  id: string;
  locale: string;
  slug: string;
  draft: { title: string; description: string };
  status: string;
  revision: number;
  publishedRevision: number | null;
}

/** Blog categories with draft/publish lifecycle (`/content/manage/categories`). */
export function CategoriesPage() {
  const api = useAdminApi();
  const tx = useText();
  const categories = useResource(async (signal) => {
    const rows = await api.get<unknown>('/content/manage/categories', undefined, { signal });
    if (!Array.isArray(rows)) throw new Error('Unexpected categories response');
    return rows as Category[];
  }, []);
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const record = editing && editing !== 'new' ? editing : null;
  async function transition(row: Category, action: string) {
    try {
      await api.post(`/content/manage/categories/${encodeURIComponent(row.id)}/${action}`, { expectedRevision: row.revision });
      toast.success(tx('分类状态已更新', 'Category state updated'));
    } catch {
      toast.error(tx('操作失败，请刷新后重试', 'Failed; refresh and retry'));
    } finally {
      categories.reload();
    }
  }
  return (
    <PageContainer
      title={tx('博客分类', 'Blog categories')}
      description={tx('分类下线不会删除文章，但文章不再显示该分类；重新发布文章前需解除引用或恢复分类。', 'Unpublishing a category keeps its posts but hides the category; remove the reference or restore the category before republishing posts.')}
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          {tx('新建分类', 'New category')}
        </Button>
      }
    >
      <DataTable<Category>
        label={tx('博客分类', 'Blog categories')}
        rows={categories.data ?? []}
        rowKey={(row) => row.id}
        loading={categories.loading}
        error={categories.error}
        onRetry={categories.reload}
        columns={[
          { key: 'title', title: tx('名称', 'Name'), field: 'draft.title' },
          { key: 'locale', title: tx('语言', 'Language'), field: 'locale' },
          { key: 'slug', title: tx('路径', 'Path'), field: 'slug' },
          {
            key: 'status',
            title: tx('状态', 'Status'),
            render: (row) => (
              <StatusBadge tone={row.status === 'published' ? 'success' : 'neutral'}>
                {row.status === 'published'
                  ? row.revision === row.publishedRevision
                    ? tx('已发布', 'Published')
                    : tx('有未发布修改', 'Unpublished changes')
                  : row.status === 'archived'
                    ? tx('已归档', 'Archived')
                    : tx('草稿', 'Draft')}
              </StatusBadge>
            ),
          },
        ]}
        actions={(row) => (
          <>
            {row.status !== 'archived' && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>
                  {tx('编辑草稿', 'Edit draft')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void transition(row, 'publish')}>
                  {tx('发布', 'Publish')}
                </Button>
              </>
            )}
            {row.status === 'published' && (
              <Button size="sm" variant="ghost" onClick={() => void transition(row, 'unpublish')}>
                {tx('取消发布', 'Unpublish')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void transition(row, row.status === 'archived' ? 'restore' : 'archive')}>
              {row.status === 'archived' ? tx('恢复', 'Restore') : tx('归档', 'Archive')}
            </Button>
          </>
        )}
      />
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={record ? tx('编辑分类', 'Edit category') : tx('新建分类', 'New category')}
        initialValues={{ locale: record?.locale ?? 'zh', slug: record?.slug ?? '', title: record?.draft.title ?? '', description: record?.draft.description ?? '' }}
        fields={[
          { name: 'locale', label: tx('语言', 'Language'), type: 'select', required: true, disabled: Boolean(record), options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }] },
          { name: 'slug', label: tx('地址路径', 'Path'), required: true },
          { name: 'title', label: tx('分类名称', 'Name'), required: true },
          { name: 'description', label: tx('简介', 'Summary'), type: 'textarea' },
        ]}
        onSubmit={async (values) => {
          const body = { slug: values.slug, title: values.title, description: values.description ?? '' };
          if (record) await api.put(`/content/manage/categories/${encodeURIComponent(record.id)}`, { ...body, expectedRevision: record.revision });
          else await api.post('/content/manage/categories', { ...body, locale: values.locale });
          toast.success(tx('分类草稿已保存', 'Category draft saved'));
          categories.reload();
        }}
      />
    </PageContainer>
  );
}
