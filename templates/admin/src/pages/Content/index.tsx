import { useAdminI18n } from '@/i18n';
import { useRef, useState } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormTextArea,
  ProFormSelect,
  ProFormSwitch,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Alert, App, Button, Space, Tag } from 'antd';
import { validateSiteDocument, type SiteDocument } from '@zucker-framework/fe-site/content';
import httpClient from '@/lib/http-client';
interface Entry {
  id: string;
  kind: string;
  locale: string;
  slug: string;
  status: string;
  revision: number;
  publishedRevision: number | null;
  publishedSlug: string | null;
  draft: { document: SiteDocument; categoryIds: string[] };
  updatedAt: string;
}
interface Category {
  id: string;
  locale: string;
  draft: { title: string };
  status: string;
}
const empty = {
  version: 1,
  title: '',
  description: '',
  authorName: '',
  markdown: '',
  blocks: [],
  seo: { title: '', description: '', noIndex: false },
};
const statuses = { draft: '草稿', published: '已发布', archived: '已归档' };
export default function ContentPage() {
  const { t } = useAdminI18n();
  const { message } = App.useApp(),
    actionRef = useRef<ActionType>(null);
  const [editing, setEditing] = useState<Entry | 'new' | null>(null),
    [categories, setCategories] = useState<Category[]>([]),
    [failed, setFailed] = useState(false);
  async function open(row: Entry | 'new') {
    try {
      const available = await httpClient.get<Category[]>('/content/manage/categories');
      setCategories(available);
      setEditing(row);
    } catch {
      message.error(t('分类读取失败，请重试'));
    }
  }
  async function transition(row: Entry, action: string) {
    try {
      await httpClient.post(`/content/manage/entries/${row.id}/${action}`, {
        expectedRevision: row.revision,
      });
      message.success(t('发布状态已更新'));
      actionRef.current?.reload();
    } catch (error) {
      message.error(
        (error as { status?: number }).status === 409
          ? t('内容已变化，请刷新后再操作')
          : t('操作失败，请检查内容及分类是否可发布'),
      );
    }
  }
  const columns: ProColumns<Entry>[] = [
    { title: t('标题'), dataIndex: ['draft', 'document', 'title'], search: false },
    {
      title: t('类型'),
      dataIndex: 'kind',
      valueEnum: { page: t('页面'), post: t('博客'), doc: t('文档') },
    },
    { title: t('语言'), dataIndex: 'locale', valueEnum: { zh: t('中文'), en: 'English' } },
    { title: t('路径'), dataIndex: 'slug', search: false },
    {
      title: t('状态'),
      dataIndex: 'status',
      valueEnum: Object.fromEntries(
        Object.entries(statuses).map(([key, label]) => [key, t(label)]),
      ),
      render: (_, row) => (
        <Space>
          <Tag>{t(statuses[row.status as keyof typeof statuses] ?? row.status)}</Tag>
          {row.status === 'published' && row.revision !== row.publishedRevision && (
            <Tag color="orange">{t('有未发布修改')}</Tag>
          )}
        </Space>
      ),
    },
    { title: t('更新时间'), dataIndex: 'updatedAt', valueType: 'dateTime', search: false },
    {
      title: t('操作'),
      valueType: 'option',
      render: (_, row) => (
        <Space wrap>
          {row.status !== 'archived' && <a onClick={() => void open(row)}>{t('编辑草稿')}</a>}
          {row.status !== 'archived' && (
            <a onClick={() => void transition(row, 'publish')}>{t('发布已保存版本')}</a>
          )}
          {row.status === 'published' && (
            <a onClick={() => void transition(row, 'unpublish')}>{t('取消发布')}</a>
          )}
          <a
            onClick={() => void transition(row, row.status === 'archived' ? 'restore' : 'archive')}
          >
            {row.status === 'archived' ? t('恢复草稿') : t('归档')}
          </a>
        </Space>
      ),
    },
  ];
  const row = editing && editing !== 'new' ? editing : null;
  return (
    <PageContainer title={t('页面、博客与文档')}>
      <p style={{ marginTop: 0, marginBottom: 20, opacity: 0.75 }}>
        {t('保存只更新草稿；发布后才改变公开页面、地址、搜索与站点地图。')}
      </p>
      {failed && (
        <Alert type="error" message={t('内容加载失败，可刷新重试')} style={{ marginBottom: 16 }} />
      )}
      <ProTable<Entry>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        request={async (params) => {
          try {
            const result = await httpClient.get<{ data: Entry[]; total: number }>(
              '/content/manage/entries',
              {
                page: params.current ?? 1,
                ...(params.kind ? { kind: params.kind } : {}),
                ...(params.locale ? { locale: params.locale } : {}),
                ...(params.status ? { status: params.status } : {}),
              },
            );
            setFailed(false);
            return { ...result, success: true };
          } catch (error) {
            setFailed(true);
            throw error;
          }
        }}
        toolBarRender={() => [
          <Button key="new" type="primary" onClick={() => void open('new')}>
            {t('新建内容')}
          </Button>,
        ]}
      />
      {editing && (
        <ModalForm
          name="content-editor"
          key={row?.id ?? 'new'}
          title={row ? t('编辑草稿') : t('新建内容')}
          open
          width={960}
          modalProps={{ destroyOnHidden: true, onCancel: () => setEditing(null) }}
          initialValues={{
            kind: row?.kind ?? 'post',
            locale: row?.locale ?? 'zh',
            slug: row?.slug ?? '',
            document: row?.draft.document ?? empty,
            categoryIds: row?.draft.categoryIds ?? [],
            blocks: JSON.stringify(row?.draft.document.blocks ?? [], null, 2),
          }}
          submitter={{ searchConfig: { submitText: t('保存草稿') } }}
          onFinish={async (values) => {
            let document;
            try {
              document = validateSiteDocument({
                ...values.document,
                version: 1,
                blocks: JSON.parse(values.blocks),
              });
            } catch {
              message.error(t('请检查文档字段、内容块 JSON 和链接格式'));
              return false;
            }
            const body = {
              slug: values.slug,
              document,
              categoryIds: (row?.kind ?? values.kind) === 'post' ? (values.categoryIds ?? []) : [],
            };
            try {
              if (row)
                await httpClient.put(`/content/manage/entries/${row.id}`, {
                  ...body,
                  expectedRevision: row.revision,
                });
              else
                await httpClient.post('/content/manage/entries', {
                  ...body,
                  kind: values.kind,
                  locale: values.locale,
                });
              message.success(t('草稿已保存'));
              setEditing(null);
              actionRef.current?.reload();
              return true;
            } catch (error) {
              message.error(
                (error as { status?: number }).status === 409
                  ? t('版本冲突或地址已占用，请重新打开内容')
                  : t('草稿保存失败'),
              );
              return false;
            }
          }}
        >
          <Alert
            type="info"
            message={t('本窗口不会发布内容')}
            description={t(
              '关闭后点击列表中的“发布已保存版本”。发布会校验同语言已发布分类；禁用内容块不会出现在公开版本。',
            )}
            style={{ marginBottom: 20 }}
          />
          <Space align="start" wrap>
            <ProFormSelect
              name="kind"
              label={t('内容类型')}
              disabled={Boolean(row)}
              options={[
                { label: t('页面'), value: 'page' },
                { label: t('博客'), value: 'post' },
                { label: t('文档'), value: 'doc' },
              ]}
              rules={[{ required: true }]}
              width="sm"
            />
            <ProFormSelect
              name="locale"
              label={t('语言')}
              disabled={Boolean(row)}
              options={[
                { label: t('中文'), value: 'zh' },
                { label: 'English', value: 'en' },
              ]}
              rules={[{ required: true }]}
              width="sm"
            />
          </Space>
          <ProFormText
            name="slug"
            label={t('地址路径')}
            rules={[{ required: true }]}
            extra={t('小写字母、数字和连字符；页面与文档支持多级路径。')}
          />
          <ProFormText
            name={['document', 'title']}
            label={t('标题')}
            rules={[{ required: true, max: 200 }]}
          />
          <ProFormTextArea
            name={['document', 'description']}
            label={t('简介')}
            fieldProps={{ rows: 2 }}
          />
          <ProFormText name={['document', 'authorName']} label={t('作者')} />
          <ProFormTextArea
            name={['document', 'markdown']}
            label={t('正文（Markdown）')}
            fieldProps={{ rows: 12 }}
            extra={t('不执行 HTML 或 MDX。')}
          />
          <ProFormSelect
            name="categoryIds"
            label={t('博客分类')}
            mode="multiple"
            options={categories.map((category) => ({
              value: category.id,
              label: `${category.locale} · ${category.draft.title}${category.status === 'published' ? '' : t('（未发布）')}`,
            }))}
            extra={t('仅博客使用；发布时必须是同一语言且已发布的分类。')}
          />
          <ProFormTextArea
            name="blocks"
            label={t('结构化内容块（JSON 数组）')}
            fieldProps={{ rows: 6 }}
          />
          <ProFormText name={['document', 'seo', 'title']} label={t('SEO 标题')} />
          <ProFormTextArea
            name={['document', 'seo', 'description']}
            label={t('SEO 描述')}
            fieldProps={{ rows: 2 }}
          />
          <ProFormSwitch name={['document', 'seo', 'noIndex']} label={t('不被搜索引擎收录')} />
        </ModalForm>
      )}
    </PageContainer>
  );
}
