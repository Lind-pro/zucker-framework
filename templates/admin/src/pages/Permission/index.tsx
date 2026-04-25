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
import { Button, message, Popconfirm, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { queryRequest } from '@/lib/http-client';
import httpClient from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';
import { useBatchDelete } from '@/hooks/useBatchDelete';

interface PermissionRecord {
  id: string;
  name: string;
  code: string;
  type: string;
  description: string;
  createdAt: string;
}

const typeOptions = [
  { label: '菜单', value: 'menu' },
  { label: '按钮', value: 'button' },
  { label: '接口', value: 'api' },
];

const typeColorMap: Record<string, string> = { menu: 'blue', button: 'green', api: 'orange' };

const PermissionPage: React.FC = () => {
  const actionRef = useRef<ActionType>(null);
  const { rowSelection, batchDelete, selectedRowKeys } = useBatchDelete('/permissions', actionRef);

  const handleDelete = async (id: string) => {
    await httpClient.delete(`/permissions/${id}`);
    message.success('删除成功');
    actionRef.current?.reload();
  };

  const columns: ProColumns<PermissionRecord>[] = [
    { title: '权限名称', dataIndex: 'name' },
    { title: '权限编码', dataIndex: 'code', copyable: true },
    {
      title: '类型',
      dataIndex: 'type',
      valueEnum: { menu: '菜单', button: '按钮', api: '接口' },
      render: (_, record) => (
        <Tag color={typeColorMap[record.type]}>{record.type}</Tag>
      ),
    },
    { title: '描述', dataIndex: 'description', search: false, ellipsis: true },
    { title: '创建时间', dataIndex: 'createdAt', valueType: 'dateTime', search: false },
    {
      title: '操作',
      valueType: 'option',
      render: (_, record) => [
        <PermissionGuard key="edit" permission="permissions:update">
          <ModalForm
            title="编辑权限"
            trigger={<a>编辑</a>}
            initialValues={record}
            onFinish={async (values) => {
              await httpClient.put(`/permissions/${record.id}`, values);
              message.success('更新成功');
              actionRef.current?.reload();
              return true;
            }}
          >
            <ProFormText name="name" label="权限名称" rules={[{ required: true }]} />
            <ProFormText name="code" label="权限编码" rules={[{ required: true }]} />
            <ProFormSelect name="type" label="类型" options={typeOptions} rules={[{ required: true }]} />
            <ProFormTextArea name="description" label="描述" />
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="permissions:delete">
          <Popconfirm title="确定删除?" onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: '#DC2626' }}>删除</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];

  return (
    <PageContainer title="权限管理">
      <ProTable<PermissionRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        rowSelection={rowSelection}
        request={(params) => queryRequest<PermissionRecord>('/permissions', params)}
        toolBarRender={() => [
          selectedRowKeys.length > 0 && (
            <PermissionGuard key="batch-delete" permission="permissions:delete">
              <Popconfirm title={`确定删除选中的 ${selectedRowKeys.length} 条记录?`} onConfirm={batchDelete}>
                <Button danger icon={<DeleteOutlined />}>
                  批量删除 ({selectedRowKeys.length})
                </Button>
              </Popconfirm>
            </PermissionGuard>
          ),
          <PermissionGuard key="create" permission="permissions:add">
            <ModalForm
              title="新建权限"
              trigger={<Button type="primary" icon={<PlusOutlined />}>新建权限</Button>}
              onFinish={async (values) => {
                await httpClient.post('/permissions', values);
                message.success('创建成功');
                actionRef.current?.reload();
                return true;
              }}
            >
              <ProFormText name="name" label="权限名称" rules={[{ required: true }]} />
              <ProFormText name="code" label="权限编码" rules={[{ required: true }]} />
              <ProFormSelect name="type" label="类型" options={typeOptions} rules={[{ required: true }]} />
              <ProFormTextArea name="description" label="描述" />
            </ModalForm>
          </PermissionGuard>,
        ]}
      />
    </PageContainer>
  );
};

export default PermissionPage;
