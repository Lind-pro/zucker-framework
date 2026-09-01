import React, { useRef } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormDigit,
  ProFormSelect,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Button, message, Popconfirm, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import httpClient from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';

interface MenuRecord {
  id: string;
  name: string;
  path?: string;
  icon?: string;
  parentId?: string;
  sortIndex: number;
  type: 'directory' | 'menu' | 'button';
  children?: MenuRecord[];
}

const typeColorMap: Record<string, string> = { directory: 'blue', menu: 'green', button: 'orange' };
const typeOptions = [
  { label: '目录', value: 'directory' },
  { label: '菜单', value: 'menu' },
  { label: '按钮', value: 'button' },
];

const MenuPage: React.FC = () => {
  const actionRef = useRef<ActionType>(null);

  const handleDelete = async (id: string) => {
    await httpClient.delete(`/menu/${id}`);
    message.success('删除成功');
    actionRef.current?.reload();
  };

  const columns: ProColumns<MenuRecord>[] = [
    { title: '菜单名称', dataIndex: 'name' },
    { title: '路径', dataIndex: 'path' },
    { title: '图标', dataIndex: 'icon', search: false },
    {
      title: '类型',
      dataIndex: 'type',
      render: (_, record) => (
        <Tag color={typeColorMap[record.type]}>{record.type}</Tag>
      ),
    },
    { title: '排序', dataIndex: 'sortIndex', search: false },
    {
      title: '操作',
      valueType: 'option',
      render: (_, record) => [
        <PermissionGuard key="edit" permission="menu:update">
          <ModalForm
            title="编辑菜单"
            trigger={<a>编辑</a>}
            initialValues={record}
            onFinish={async (values) => {
              await httpClient.put(`/menu/${record.id}`, values);
              message.success('更新成功');
              actionRef.current?.reload();
              return true;
            }}
          >
            <ProFormText name="name" label="菜单名称" rules={[{ required: true }]} />
            <ProFormText name="path" label="路径" />
            <ProFormText name="icon" label="图标" />
            <ProFormSelect name="type" label="类型" options={typeOptions} rules={[{ required: true }]} />
            <ProFormDigit name="sortIndex" label="排序" initialValue={0} />
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="menu:delete">
          <Popconfirm title="确定删除?" onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: '#DC2626' }}>删除</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];

  return (
    <PageContainer title="菜单管理">
      <ProTable<MenuRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        search={false}
        pagination={false}
        request={async () => {
          const data = await httpClient.get<MenuRecord[]>('/menu/tree');
          return { data: data ?? [], success: true };
        }}
        toolBarRender={() => [
          <PermissionGuard key="create" permission="menu:add">
            <ModalForm
              title="新建菜单"
              trigger={<Button type="primary" icon={<PlusOutlined />}>新建菜单</Button>}
              onFinish={async (values) => {
                await httpClient.post('/menu', values);
                message.success('创建成功');
                actionRef.current?.reload();
                return true;
              }}
            >
              <ProFormText name="name" label="菜单名称" rules={[{ required: true }]} />
              <ProFormText name="path" label="路径" />
              <ProFormText name="icon" label="图标" />
              <ProFormSelect name="type" label="类型" options={typeOptions} rules={[{ required: true }]} />
              <ProFormDigit name="sortIndex" label="排序" initialValue={0} />
            </ModalForm>
          </PermissionGuard>,
        ]}
      />
    </PageContainer>
  );
};

export default MenuPage;
