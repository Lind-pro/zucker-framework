import { useAdminI18n } from '@/i18n';
import React, { useRef, useState } from 'react';
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
import UserRoleEditor from '@/features/users/UserRoleEditor';

interface UserRecord {
  id: string;
  username: string;
  email: string;
  name: string;
  status: boolean;
  createTime: string;
}

const UserPage: React.FC = () => {
  const { t } = useAdminI18n();
  const [roleUser, setRoleUser] = useState<UserRecord | null>(null);

  const actionRef = useRef<ActionType>(null);
  const { rowSelection, batchDelete, selectedRowKeys } = useBatchDelete('/users', actionRef);

  const handleDelete = async (id: string) => {
    await httpClient.delete(`/users/${id}`);
    message.success(t('删除成功'));
    actionRef.current?.reload();
  };

  const columns: ProColumns<UserRecord>[] = [
    { title: t('用户名'), dataIndex: 'username', copyable: true },
    { title: t('邮箱'), dataIndex: 'email', copyable: true },
    { title: t('姓名'), dataIndex: 'name' },
    {
      title: t('状态'),
      dataIndex: 'status',
      valueEnum: {
        true: { text: t('启用'), status: 'Success' },
        false: { text: t('禁用'), status: 'Error' },
      },
      render: (_, record) => (
        <Tag color={record.status ? 'green' : 'red'}>{record.status ? t('启用') : t('禁用')}</Tag>
      ),
    },
    { title: t('创建时间'), dataIndex: 'createTime', valueType: 'dateTime', search: false },
    {
      title: t('操作'),
      valueType: 'option',
      render: (_, record) => [
        <PermissionGuard key="roles" permission="users:authorize">
          <PermissionGuard permission="roles:query">
            <a onClick={() => setRoleUser(record)}>{t('分配角色', 'Assign roles')}</a>
          </PermissionGuard>
        </PermissionGuard>,
        <PermissionGuard key="edit" permission="users:update">
          <ModalForm
            name={`user-edit-${record.id}`}
            title={t('编辑用户')}
            trigger={<a>{t('编辑')}</a>}
            initialValues={record}
            onFinish={async (values) => {
              try {
                await httpClient.put(`/users/${encodeURIComponent(record.id)}`, {
                  email: values.email,
                  name: values.name,
                  status: values.status,
                });
                message.success(t('更新成功'));
                actionRef.current?.reload();
                return true;
              } catch {
                message.error(
                  t(
                    '用户保存未确认，请核对账号、权限和连接后重试；当前草稿已保留。',
                    'User save was not confirmed. Check the account, access and connection, then retry. Your draft is kept.',
                  ),
                );
                return false;
              }
            }}
          >
            <ProFormText name="username" label={t('用户名')} disabled />
            <ProFormText
              name="email"
              label={t('邮箱')}
              rules={[{ required: true, type: 'email' }]}
            />
            <ProFormText name="name" label={t('姓名')} />
            <ProFormSwitch name="status" label={t('启用')} />
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="users:delete">
          <Popconfirm title={t('确定删除?')} onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: '#DC2626' }}>{t('删除')}</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];

  return (
    <PageContainer title={t('用户管理')}>
      <ProTable<UserRecord>
        scroll={{ x: 1100 }}
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        rowSelection={rowSelection}
        request={(params) => queryRequest<UserRecord>('/users', params)}
        toolBarRender={() => [
          selectedRowKeys.length > 0 && (
            <PermissionGuard key="batch-delete" permission="users:delete">
              <Popconfirm
                title={t('确定删除选中的 {count} 条记录？', undefined, {
                  count: selectedRowKeys.length,
                })}
                onConfirm={batchDelete}
              >
                <Button danger icon={<DeleteOutlined />}>
                  {t('批量删除 (')}
                  {selectedRowKeys.length})
                </Button>
              </Popconfirm>
            </PermissionGuard>
          ),
          <PermissionGuard key="create" permission="users:add">
            <ModalForm
              name="user-create"
              title={t('新建用户')}
              trigger={
                <Button type="primary" icon={<PlusOutlined />}>
                  {t('新建用户')}
                </Button>
              }
              onFinish={async (values) => {
                try {
                  // Match this consumer's public registration policy; existing classifications are never rewritten by edit.
                  await httpClient.post('/users', {
                    username: values.username,
                    email: values.email,
                    name: values.name,
                    password: values.password,
                    typeId: 'member',
                  });
                  message.success(t('创建成功'));
                  actionRef.current?.reload();
                  return true;
                } catch {
                  message.error(
                    t(
                      '用户保存未确认，请核对账号、权限和连接后重试；当前草稿已保留。',
                      'User save was not confirmed. Check the account, access and connection, then retry. Your draft is kept.',
                    ),
                  );
                  return false;
                }
              }}
            >
              <ProFormText name="username" label={t('用户名')} rules={[{ required: true }]} />
              <ProFormText
                name="email"
                label={t('邮箱')}
                rules={[{ required: true, type: 'email' }]}
              />
              <ProFormText name="name" label={t('姓名')} />
              <ProFormText.Password
                name="password"
                label={t('密码')}
                rules={[{ required: true }]}
              />
            </ModalForm>
          </PermissionGuard>,
        ]}
      />
      {roleUser && (
        <UserRoleEditor
          userId={roleUser.id}
          username={roleUser.username}
          onClose={() => setRoleUser(null)}
          onSaved={() => {
            setRoleUser(null);
            actionRef.current?.reload();
          }}
        />
      )}
    </PageContainer>
  );
};

export default UserPage;
