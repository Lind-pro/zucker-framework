import React, { useRef } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormSwitch,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Button, message, Popconfirm, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import httpClient, { queryRequest } from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';
import { useBatchDelete } from '@/hooks/useBatchDelete';

interface UserRecord {
  id: string;
  username: string;
  email: string;
  name: string;
  status: boolean;
  createTime: string;
}

const UserPage: React.FC = () => {
  const actionRef = useRef<ActionType>(null);
  const { rowSelection, batchDelete, selectedRowKeys } = useBatchDelete('/users', actionRef);

  const handleDelete = async (id: string) => {
    await httpClient.delete(`/users/${id}`);
    message.success('删除成功');
    actionRef.current?.reload();
  };

  const columns: ProColumns<UserRecord>[] = [
    { title: '用户名', dataIndex: 'username', copyable: true },
    { title: '邮箱', dataIndex: 'email', copyable: true },
    { title: '姓名', dataIndex: 'name' },
    {
      title: '状态',
      dataIndex: 'status',
      valueEnum: { true: { text: '启用', status: 'Success' }, false: { text: '禁用', status: 'Error' } },
      render: (_, record) => (
        <Tag color={record.status ? 'green' : 'red'}>
          {record.status ? '启用' : '禁用'}
        </Tag>
      ),
    },
    { title: '创建时间', dataIndex: 'createTime', valueType: 'dateTime', search: false },
    {
      title: '操作',
      valueType: 'option',
      render: (_, record) => [
        <PermissionGuard key="edit" permission="users:update">
          <ModalForm
            title="编辑用户"
            trigger={<a>编辑</a>}
            initialValues={record}
            onFinish={async (values) => {
              await httpClient.put(`/users/${record.id}`, values);
              message.success('更新成功');
              actionRef.current?.reload();
              return true;
            }}
          >
            <ProFormText name="username" label="用户名" rules={[{ required: true }]} />
            <ProFormText name="email" label="邮箱" rules={[{ required: true, type: 'email' }]} />
            <ProFormText name="name" label="姓名" />
            <ProFormSwitch name="status" label="启用" />
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="users:delete">
          <Popconfirm title="确定删除?" onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: '#DC2626' }}>删除</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];

  return (
    <PageContainer title="用户管理">
      <ProTable<UserRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        rowSelection={rowSelection}
        request={(params) => queryRequest<UserRecord>('/users', params)}
        toolBarRender={() => [
          selectedRowKeys.length > 0 && (
            <PermissionGuard key="batch-delete" permission="users:delete">
              <Popconfirm title={`确定删除选中的 ${selectedRowKeys.length} 条记录?`} onConfirm={batchDelete}>
                <Button danger icon={<DeleteOutlined />}>
                  批量删除 ({selectedRowKeys.length})
                </Button>
              </Popconfirm>
            </PermissionGuard>
          ),
          <PermissionGuard key="create" permission="users:add">
            <ModalForm
              title="新建用户"
              trigger={<Button type="primary" icon={<PlusOutlined />}>新建用户</Button>}
              onFinish={async (values) => {
                await httpClient.post('/users', values);
                message.success('创建成功');
                actionRef.current?.reload();
                return true;
              }}
            >
              <ProFormText name="username" label="用户名" rules={[{ required: true }]} />
              <ProFormText name="email" label="邮箱" rules={[{ required: true, type: 'email' }]} />
              <ProFormText name="name" label="姓名" />
              <ProFormText.Password name="password" label="密码" rules={[{ required: true }]} />
            </ModalForm>
          </PermissionGuard>,
        ]}
      />
    </PageContainer>
  );
};

export default UserPage;
