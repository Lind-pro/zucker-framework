import React, { useRef } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormSelect,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Button, message, Popconfirm } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { queryRequest } from '@/lib/http-client';
import httpClient from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';
import { useBatchDelete } from '@/hooks/useBatchDelete';

interface I18nRecord {
  id: string;
  lang: string;
  key: string;
  value: string;
  updatedAt: string;
}

const langOptions = [
  { label: '中文', value: 'zh' },
  { label: 'English', value: 'en' },
  { label: '日本語', value: 'ja' },
];

const I18nPage: React.FC = () => {
  const actionRef = useRef<ActionType>(null);
  const { rowSelection, batchDelete, selectedRowKeys } = useBatchDelete('/i18n', actionRef);

  const columns: ProColumns<I18nRecord>[] = [
    {
      title: '语言',
      dataIndex: 'lang',
      width: 90,
      valueEnum: Object.fromEntries(langOptions.map((o) => [o.value, o.label])),
    },
    { title: '键名', dataIndex: 'key', copyable: true },
    {
      title: '译文',
      dataIndex: 'value',
      search: false,
      render: (_, record) => (
        <PermissionGuard permission="i18n:update" fallback={<span>{record.value}</span>}>
          <ModalForm
            title="编辑译文"
            trigger={<a style={{ textDecoration: 'underline dotted' }}>{record.value || '（空）'}</a>}
            initialValues={record}
            onFinish={async (values) => {
              await httpClient.put(`/i18n/${record.id}`, values);
              message.success('更新成功');
              actionRef.current?.reload();
              return true;
            }}
          >
            <ProFormText name="key" label="键名" readonly />
            <ProFormText name="value" label="译文" rules={[{ required: true }]} />
          </ModalForm>
        </PermissionGuard>
      ),
    },
    { title: '更新时间', dataIndex: 'updatedAt', valueType: 'dateTime', search: false },
  ];

  return (
    <PageContainer title="国际化配置">
      <ProTable<I18nRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        rowSelection={rowSelection}
        request={(params) => queryRequest<I18nRecord>('/i18n', params)}
        toolBarRender={() => [
          selectedRowKeys.length > 0 && (
            <PermissionGuard key="batch-delete" permission="i18n:delete">
              <Popconfirm title={`确定删除选中的 ${selectedRowKeys.length} 条记录?`} onConfirm={batchDelete}>
                <Button danger icon={<DeleteOutlined />}>
                  批量删除 ({selectedRowKeys.length})
                </Button>
              </Popconfirm>
            </PermissionGuard>
          ),
          <PermissionGuard key="create" permission="i18n:add">
            <ModalForm
              title="新增词条"
              trigger={<Button type="primary" icon={<PlusOutlined />}>新增词条</Button>}
              onFinish={async (values) => {
                await httpClient.post('/i18n', values);
                message.success('创建成功');
                actionRef.current?.reload();
                return true;
              }}
            >
              <ProFormSelect name="lang" label="语言" options={langOptions} rules={[{ required: true }]} />
              <ProFormText name="key" label="键名" rules={[{ required: true }]} />
              <ProFormText name="value" label="译文" rules={[{ required: true }]} />
            </ModalForm>
          </PermissionGuard>,
        ]}
      />
    </PageContainer>
  );
};

export default I18nPage;
