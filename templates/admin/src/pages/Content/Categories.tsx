import { useAdminI18n } from '@/i18n';
import { useRef } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormTextArea,
  ProFormSelect,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { App, Button, Space, Tag } from 'antd';
import httpClient from '@/lib/http-client';
interface Category {
  id: string;
  locale: string;
  slug: string;
  draft: { title: string; description: string };
  status: string;
  revision: number;
  publishedRevision: number | null;
}
export default function CategoriesPage() {
  const { t } = useAdminI18n();
  const { message } = App.useApp(),
    ref = useRef<ActionType>(null);
  const fields = (editing: boolean) => (
    <>
      <ProFormSelect
        name="locale"
        label={t('语言')}
        disabled={editing}
        options={[
          { label: t('中文'), value: 'zh' },
          { label: 'English', value: 'en' },
        ]}
        rules={[{ required: true }]}
      />
      <ProFormText name="slug" label={t('地址路径')} rules={[{ required: true }]} />
      <ProFormText name="title" label={t('分类名称')} rules={[{ required: true }]} />
      <ProFormTextArea name="description" label={t('简介')} />
    </>
  );
  async function save(values: Record<string, unknown>, row?: Category) {
    try {
      if (row) {
        const { locale: _language, ...body } = values;
        await httpClient.put(`/content/manage/categories/${row.id}`, {
          ...body,
          expectedRevision: row.revision,
        });
      } else await httpClient.post('/content/manage/categories', values);
      message.success(t('分类草稿已保存'));
      ref.current?.reload();
      return true;
    } catch {
      message.error(t('保存失败，请检查字段、地址或版本冲突'));
      return false;
    }
  }
  async function transition(row: Category, action: string) {
    try {
      await httpClient.post(`/content/manage/categories/${row.id}/${action}`, {
        expectedRevision: row.revision,
      });
      ref.current?.reload();
      message.success(t('分类状态已更新'));
    } catch {
      message.error(t('操作失败，请刷新后重试'));
    }
  }
  const columns: ProColumns<Category>[] = [
    { title: t('名称'), dataIndex: ['draft', 'title'] },
    { title: t('语言'), dataIndex: 'locale' },
    { title: t('路径'), dataIndex: 'slug' },
    {
      title: t('状态'),
      dataIndex: 'status',
      render: (_, row) => (
        <Tag>
          {row.status === 'published'
            ? row.revision === row.publishedRevision
              ? t('已发布')
              : t('有未发布修改')
            : row.status === 'archived'
              ? t('已归档')
              : t('草稿')}
        </Tag>
      ),
    },
    {
      title: t('操作'),
      valueType: 'option',
      render: (_, row) => (
        <Space wrap>
          {row.status !== 'archived' && (
            <>
              <ModalForm
                name={`category-${row.id}`}
                title={t('编辑分类')}
                trigger={<a>{t('编辑草稿')}</a>}
                initialValues={{ ...row.draft, slug: row.slug, locale: row.locale }}
                onFinish={(values) => save(values, row)}
              >
                {fields(true)}
              </ModalForm>
              <a onClick={() => void transition(row, 'publish')}>{t('发布')}</a>
            </>
          )}
          {row.status === 'published' && (
            <a onClick={() => void transition(row, 'unpublish')}>{t('取消发布')}</a>
          )}
          <a
            onClick={() => void transition(row, row.status === 'archived' ? 'restore' : 'archive')}
          >
            {row.status === 'archived' ? t('恢复') : t('归档')}
          </a>
        </Space>
      ),
    },
  ];
  return (
    <PageContainer title={t('博客分类')}>
      <p style={{ marginTop: 0, marginBottom: 20, opacity: 0.75 }}>
        {t('分类下线不会删除文章，但文章不再显示该分类；重新发布文章前需解除引用或恢复分类。')}
      </p>
      <ProTable<Category>
        actionRef={ref}
        rowKey="id"
        columns={columns}
        search={false}
        pagination={false}
        request={async () => ({
          data: await httpClient.get<Category[]>('/content/manage/categories'),
          success: true,
        })}
        toolBarRender={() => [
          <ModalForm
            key="new"
            name="category-create"
            title={t('新建分类')}
            trigger={<Button type="primary">{t('新建分类')}</Button>}
            initialValues={{ locale: 'zh', description: '' }}
            onFinish={(values) => save(values)}
          >
            {fields(false)}
          </ModalForm>,
        ]}
      />
    </PageContainer>
  );
}
