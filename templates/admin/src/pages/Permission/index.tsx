import { useAdminI18n } from '@/i18n';
import React, { useRef } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormTextArea,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Button, message, Popconfirm } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import httpClient, { queryRequest } from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';
import { useBatchDelete } from '@/hooks/useBatchDelete';

interface PermissionRecord {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

const PermissionPage: React.FC = () => {
  const { t } = useAdminI18n();
  const actionRef = useRef<ActionType>(null);
  const { rowSelection, batchDelete, selectedRowKeys } = useBatchDelete('/permissions', actionRef);

  const handleDelete = async (id: string) => {
    await httpClient.delete(`/permissions/${encodeURIComponent(id)}`);
    message.success(t('删除成功'));
    actionRef.current?.reload();
  };
  async function savePermission(values: Record<string, unknown>, id?: string) {
    const fields = {
      name: String(values.name).trim(),
      description: String(values.description ?? ''),
    };
    try {
      if (id) await httpClient.put(`/permissions/${encodeURIComponent(id)}`, fields);
      else await httpClient.post('/permissions', { id: String(values.id).trim(), ...fields });
      message.success(t(id ? '更新成功' : '创建成功'));
      actionRef.current?.reload();
      return true;
    } catch {
      message.error(
        t(
          '权限保存未确认，请核对编码、权限和连接后重试；当前草稿已保留。',
          'Permission save was not confirmed. Check the identifier, access and connection, then retry. Your draft is kept.',
        ),
      );
      return false;
    }
  }

  const columns: ProColumns<PermissionRecord>[] = [
    { title: t('权限名称'), dataIndex: 'name' },
    { title: t('权限编码'), dataIndex: 'id', copyable: true },
    { title: t('描述'), dataIndex: 'description', search: false, ellipsis: true },
    { title: t('创建时间'), dataIndex: 'createdAt', valueType: 'dateTime', search: false },
    {
      title: t('操作'),
      valueType: 'option',
      render: (_, record) => [
        <PermissionGuard key="edit" permission="permissions:update">
          <ModalForm
            name={`permission-edit-${record.id}`}
            modalProps={{ destroyOnHidden: true }}
            submitter={{ searchConfig: { submitText: t('保存'), resetText: t('取消') } }}
            title={t('编辑权限')}
            trigger={<a>{t('编辑')}</a>}
            initialValues={record}
            onFinish={(values) => savePermission(values, record.id)}
          >
            <ProFormText
              name="name"
              label={t('权限名称')}
              rules={[{ required: true, whitespace: true }]}
            />
            <ProFormText name="id" label={t('权限编码')} disabled />
            <ProFormTextArea name="description" label={t('描述')} />
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="permissions:delete">
          <Popconfirm title={t('确定删除?')} onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: '#DC2626' }}>{t('删除')}</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];

  return (
    <PageContainer title={t('权限管理')}>
      <ProTable<PermissionRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        rowSelection={rowSelection}
        request={(params) => queryRequest<PermissionRecord>('/permissions', params)}
        toolBarRender={() => [
          selectedRowKeys.length > 0 && (
            <PermissionGuard key="batch-delete" permission="permissions:delete">
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
          <PermissionGuard key="create" permission="permissions:add">
            <ModalForm
              name="permission-create"
              modalProps={{ destroyOnHidden: true }}
              submitter={{ searchConfig: { submitText: t('保存'), resetText: t('取消') } }}
              title={t('新建权限')}
              trigger={
                <Button type="primary" icon={<PlusOutlined />}>
                  {t('新建权限')}
                </Button>
              }
              onFinish={(values) => savePermission(values)}
            >
              <ProFormText
                name="name"
                label={t('权限名称')}
                rules={[{ required: true, whitespace: true }]}
              />
              <ProFormText
                name="id"
                label={t('权限编码')}
                rules={[{ required: true, whitespace: true }]}
              />
              <ProFormTextArea name="description" label={t('描述')} />
            </ModalForm>
          </PermissionGuard>,
        ]}
      />
    </PageContainer>
  );
};

export default PermissionPage;
