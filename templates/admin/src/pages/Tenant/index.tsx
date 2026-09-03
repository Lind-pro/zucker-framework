import React, { useRef } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormSelect,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Button, message, Popconfirm, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import httpClient, { queryRequest } from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';
import { useBatchDelete } from '@/hooks/useBatchDelete';

interface TenantRecord {
  id: string;
  name: string;
  code: string;
  status: 'enabled' | 'disabled';
  createdAt: string;
}

const TenantPage: React.FC = () => {
  const actionRef = useRef<ActionType>(null);
  const { rowSelection, batchDelete, selectedRowKeys } = useBatchDelete('/tenant', actionRef);

  const handleDelete = async (id: string) => {
    await httpClient.delete(`/tenant/${id}`);
    message.success('删除成功');
    actionRef.current?.reload();
  };

  const columns: ProColumns<TenantRecord>[] = [
    { title: '租户名称', dataIndex: 'name' },
    { title: '租户编码', dataIndex: 'code', copyable: true },
    {
      title: '状态',
      dataIndex: 'status',
      render: (_, record) => (
        <Tag color={record.status === 'enabled' ? 'green' : 'red'}>
          {record.status === 'enabled' ? '启用' : '禁用'}
        </Tag>
      ),
    },
    { title: '创建时间', dataIndex: 'createdAt', valueType: 'dateTime', search: false },
    {
      title: '操作',
      valueType: 'option',
      render: (_, record) => [
        <PermissionGuard key="edit" permission="tenant:update">
          <ModalForm
            title="编辑租户"
            trigger={<a>编辑</a>}
            initialValues={record}
            onFinish={async (values) => {
              await httpClient.put(`/tenant/${record.id}`, values);
              message.success('更新成功');
              actionRef.current?.reload();
              return true;
            }}
          >
            <ProFormText name="name" label="租户名称" rules={[{ required: true }]} />
            <ProFormText name="code" label="租户编码" rules={[{ required: true }]} />
            <ProFormSelect
              name="status"
              label="状态"
              options={[{ label: '启用', value: 'enabled' }, { label: '禁用', value: 'disabled' }]}
            />
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="tenant:delete">
          <Popconfirm title="确定删除?" onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: '#DC2626' }}>删除</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];

  return (
    <PageContainer title="租户管理">
      <ProTable<TenantRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        rowSelection={rowSelection}
        request={(params) => queryRequest<TenantRecord>('/tenant', params)}
        toolBarRender={() => [
          selectedRowKeys.length > 0 && (
            <PermissionGuard key="batch-delete" permission="tenant:delete">
              <Popconfirm title={`确定删除选中的 ${selectedRowKeys.length} 条记录?`} onConfirm={batchDelete}>
                <Button danger icon={<DeleteOutlined />}>
                  批量删除 ({selectedRowKeys.length})
                </Button>
              </Popconfirm>
            </PermissionGuard>
          ),
          <PermissionGuard key="create" permission="tenant:add">
            <ModalForm
              title="新建租户"
              trigger={<Button type="primary" icon={<PlusOutlined />}>新建租户</Button>}
              onFinish={async (values) => {
                await httpClient.post('/tenant', values);
                message.success('创建成功');
                actionRef.current?.reload();
                return true;
              }}
            >
              <ProFormText name="name" label="租户名称" rules={[{ required: true }]} />
              <ProFormText name="code" label="租户编码" rules={[{ required: true }]} />
            </ModalForm>
          </PermissionGuard>,
        ]}
      />
    </PageContainer>
  );
};

export default TenantPage;
