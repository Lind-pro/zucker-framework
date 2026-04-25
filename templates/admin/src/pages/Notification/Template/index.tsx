import React, { useRef } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormTextArea,
  ProFormSelect,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Button, message, Popconfirm } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { queryRequest } from '@/lib/http-client';
import httpClient from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';
import { useBatchDelete } from '@/hooks/useBatchDelete';

interface NotifyTemplate {
  id: string;
  name: string;
  type: string;
  subject?: string;
  template: string;
  createdAt: string;
}

const typeOptions = [
  { label: '邮件', value: 'email' },
  { label: '短信', value: 'sms' },
  { label: '站内信', value: 'internal' },
  { label: 'Webhook', value: 'webhook' },
];

const NotifyTemplatePage: React.FC = () => {
  const actionRef = useRef<ActionType>(null);
  const { rowSelection, batchDelete, selectedRowKeys } = useBatchDelete('/notification/template', actionRef);

  const handleDelete = async (id: string) => {
    await httpClient.delete(`/notification/template/${id}`);
    message.success('删除成功');
    actionRef.current?.reload();
  };

  const columns: ProColumns<NotifyTemplate>[] = [
    { title: '模板名称', dataIndex: 'name' },
    {
      title: '类型',
      dataIndex: 'type',
      valueEnum: Object.fromEntries(typeOptions.map((o) => [o.value, o.label])),
    },
    { title: '主题', dataIndex: 'subject', search: false, ellipsis: true },
    { title: '创建时间', dataIndex: 'createdAt', valueType: 'dateTime', search: false },
    {
      title: '操作',
      valueType: 'option',
      render: (_, record) => [
        <PermissionGuard key="edit" permission="notification:update">
          <ModalForm
            title="编辑模板"
            trigger={<a>编辑</a>}
            initialValues={record}
            onFinish={async (values) => {
              await httpClient.put(`/notification/template/${record.id}`, values);
              message.success('更新成功');
              actionRef.current?.reload();
              return true;
            }}
          >
            <ProFormText name="name" label="模板名称" rules={[{ required: true }]} />
            <ProFormSelect name="type" label="类型" options={typeOptions} rules={[{ required: true }]} />
            <ProFormText name="subject" label="主题（邮件）" />
            <ProFormTextArea name="template" label="模板内容" rules={[{ required: true }]} fieldProps={{ rows: 6 }} />
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="notification:delete">
          <Popconfirm title="确定删除?" onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: '#DC2626' }}>删除</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];

  return (
    <PageContainer title="通知模板">
      <ProTable<NotifyTemplate>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        rowSelection={rowSelection}
        request={(params) => queryRequest<NotifyTemplate>('/notification/template', params)}
        toolBarRender={() => [
          selectedRowKeys.length > 0 && (
            <PermissionGuard key="batch-delete" permission="notification:delete">
              <Popconfirm title={`确定删除选中的 ${selectedRowKeys.length} 条记录?`} onConfirm={batchDelete}>
                <Button danger icon={<DeleteOutlined />}>
                  批量删除 ({selectedRowKeys.length})
                </Button>
              </Popconfirm>
            </PermissionGuard>
          ),
          <PermissionGuard key="create" permission="notification:add">
            <ModalForm
              title="新建模板"
              trigger={<Button type="primary" icon={<PlusOutlined />}>新建模板</Button>}
              onFinish={async (values) => {
                await httpClient.post('/notification/template', values);
                message.success('创建成功');
                actionRef.current?.reload();
                return true;
              }}
            >
              <ProFormText name="name" label="模板名称" rules={[{ required: true }]} />
              <ProFormSelect name="type" label="类型" options={typeOptions} rules={[{ required: true }]} />
              <ProFormText name="subject" label="主题（邮件）" />
              <ProFormTextArea name="template" label="模板内容" rules={[{ required: true }]} fieldProps={{ rows: 6 }} />
            </ModalForm>
          </PermissionGuard>,
        ]}
      />
    </PageContainer>
  );
};

export default NotifyTemplatePage;
