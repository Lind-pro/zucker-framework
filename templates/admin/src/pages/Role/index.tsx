import React, { useRef, useState, useEffect } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormTextArea,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Button, message, Popconfirm, Tree } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { queryRequest } from '@/lib/http-client';
import httpClient from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';
import { useBatchDelete } from '@/hooks/useBatchDelete';

interface RoleRecord {
  id: string;
  name: string;
  code: string;
  description: string;
  createTime: string;
}

interface PermissionNode {
  key: string;
  title: string;
  children?: PermissionNode[];
}

const RolePage: React.FC = () => {
  const actionRef = useRef<ActionType>(null);
  const { rowSelection, batchDelete, selectedRowKeys } = useBatchDelete('/roles', actionRef);
  const [permissionTree, setPermissionTree] = useState<PermissionNode[]>([]);
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);

  useEffect(() => {
    httpClient.get<PermissionNode[]>('/permissions/tree').then(setPermissionTree).catch(() => {});
  }, []);

  const handleDelete = async (id: string) => {
    await httpClient.delete(`/roles/${id}`);
    message.success('删除成功');
    actionRef.current?.reload();
  };

  const columns: ProColumns<RoleRecord>[] = [
    { title: '角色名称', dataIndex: 'name' },
    { title: '角色编码', dataIndex: 'code', copyable: true },
    { title: '描述', dataIndex: 'description', search: false, ellipsis: true },
    { title: '创建时间', dataIndex: 'createTime', valueType: 'dateTime', search: false },
    {
      title: '操作',
      valueType: 'option',
      render: (_, record) => [
        <PermissionGuard key="edit" permission="roles:update">
          <ModalForm
            title="编辑角色"
            trigger={<a>编辑</a>}
            initialValues={record}
            onFinish={async (values) => {
              await httpClient.put(`/roles/${record.id}`, { ...values, permissionIds: checkedKeys });
              message.success('更新成功');
              actionRef.current?.reload();
              return true;
            }}
          >
            <ProFormText name="name" label="角色名称" rules={[{ required: true }]} />
            <ProFormText name="code" label="角色编码" rules={[{ required: true }]} />
            <ProFormTextArea name="description" label="描述" />
            <div style={{ marginBottom: 24 }}>
              <label style={{ display: 'block', marginBottom: 8 }}>权限分配</label>
              <Tree
                checkable
                treeData={permissionTree}
                checkedKeys={checkedKeys}
                onCheck={(keys) => setCheckedKeys(keys as string[])}
              />
            </div>
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="roles:delete">
          <Popconfirm title="确定删除?" onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: '#DC2626' }}>删除</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];

  return (
    <PageContainer title="角色管理">
      <ProTable<RoleRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        rowSelection={rowSelection}
        request={(params) => queryRequest<RoleRecord>('/roles', params)}
        toolBarRender={() => [
          selectedRowKeys.length > 0 && (
            <PermissionGuard key="batch-delete" permission="roles:delete">
              <Popconfirm title={`确定删除选中的 ${selectedRowKeys.length} 条记录?`} onConfirm={batchDelete}>
                <Button danger icon={<DeleteOutlined />}>
                  批量删除 ({selectedRowKeys.length})
                </Button>
              </Popconfirm>
            </PermissionGuard>
          ),
          <PermissionGuard key="create" permission="roles:add">
            <ModalForm
              title="新建角色"
              trigger={<Button type="primary" icon={<PlusOutlined />}>新建角色</Button>}
              onFinish={async (values) => {
                await httpClient.post('/roles', { ...values, permissionIds: checkedKeys });
                message.success('创建成功');
                actionRef.current?.reload();
                return true;
              }}
            >
              <ProFormText name="name" label="角色名称" rules={[{ required: true }]} />
              <ProFormText name="code" label="角色编码" rules={[{ required: true }]} />
              <ProFormTextArea name="description" label="描述" />
              <div style={{ marginBottom: 24 }}>
                <label style={{ display: 'block', marginBottom: 8 }}>权限分配</label>
                <Tree
                  checkable
                  treeData={permissionTree}
                  checkedKeys={checkedKeys}
                  onCheck={(keys) => setCheckedKeys(keys as string[])}
                />
              </div>
            </ModalForm>
          </PermissionGuard>,
        ]}
      />
    </PageContainer>
  );
};

export default RolePage;
