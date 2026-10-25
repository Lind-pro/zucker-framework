import React, { useEffect, useRef, useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Skeleton,
  Tree,
  Typography,
} from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import httpClient, { queryRequest } from '@/lib/http-client';
import { PermissionGuard, usePermission } from '@/lib/permission';
import { useBatchDelete } from '@/hooks/useBatchDelete';
import { useAdminI18n } from '@/i18n';

interface RoleRecord {
  id: string;
  name: string;
  description?: string | null;
  createTime: string;
}
interface RoleDetail extends RoleRecord {
  permissionIds: string[];
}
interface PermissionGroup {
  resource: string;
  permissions: Array<{ id: string; name: string }>;
}
interface RoleValues {
  name: string;
  description?: string;
}

function RoleEditor({
  roleId,
  onClose,
  onSaved,
}: {
  roleId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useAdminI18n(),
    { message } = App.useApp(),
    { hasPermission } = usePermission();
  const canAuthorize = hasPermission('roles:authorize'),
    canReadPermissions = hasPermission('permissions:query');
  const [form] = Form.useForm<RoleValues>();
  const [role, setRole] = useState<RoleDetail | null>(null),
    [loading, setLoading] = useState(roleId !== null),
    [loadError, setLoadError] = useState(false),
    [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false),
    [editPermissions, setEditPermissions] = useState(false),
    [checkedKeys, setCheckedKeys] = useState<string[]>([]);
  const [groups, setGroups] = useState<PermissionGroup[]>([]),
    [treeLoading, setTreeLoading] = useState(false),
    [treeError, setTreeError] = useState(false),
    [treeRetry, setTreeRetry] = useState(0);
  useEffect(() => {
    if (roleId === null) return;
    let active = true;
    setLoading(true);
    setLoadError(false);
    void httpClient
      .get<RoleDetail>(`/roles/${encodeURIComponent(roleId)}`)
      .then((detail) => {
        if (
          !detail ||
          detail.id !== roleId ||
          typeof detail.name !== 'string' ||
          !Array.isArray(detail.permissionIds) ||
          detail.permissionIds.some((id) => typeof id !== 'string')
        )
          throw new Error('Invalid role detail');
        if (!active) return;
        setRole(detail);
        setCheckedKeys([...detail.permissionIds]);
        form.setFieldsValue({ name: detail.name, description: detail.description ?? '' });
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [roleId, retry, form]);
  useEffect(() => {
    if (!editPermissions || !canAuthorize || !canReadPermissions) return;
    let active = true;
    setTreeLoading(true);
    setTreeError(false);
    void httpClient
      .get<PermissionGroup[]>('/permissions/tree')
      .then((result) => {
        if (
          !Array.isArray(result) ||
          result.some(
            (group) =>
              typeof group.resource !== 'string' ||
              !Array.isArray(group.permissions) ||
              group.permissions.some(
                (permission) =>
                  typeof permission.id !== 'string' || typeof permission.name !== 'string',
              ),
          )
        )
          throw new Error('Invalid permission catalog');
        if (active) setGroups(result);
      })
      .catch(() => {
        if (active) setTreeError(true);
      })
      .finally(() => {
        if (active) setTreeLoading(false);
      });
    return () => {
      active = false;
    };
  }, [editPermissions, canAuthorize, canReadPermissions, treeRetry]);
  const permissionIds = new Set(
    groups.flatMap((group) => group.permissions.map((permission) => permission.id)),
  );
  const hiddenExisting = role?.permissionIds.filter((id) => !permissionIds.has(id)) ?? [];
  const blocked =
    loading ||
    loadError ||
    (roleId !== null && !role) ||
    (editPermissions && (treeLoading || treeError));
  async function save(values: RoleValues) {
    if (blocked) return;
    const payload: Record<string, unknown> = {};
    const name = values.name.trim(),
      description = values.description ?? '';
    if (!role || name !== role.name) payload.name = name;
    if (!role || description !== (role.description ?? '')) payload.description = description;
    if (editPermissions && canAuthorize && canReadPermissions) {
      const selected = [...new Set(checkedKeys)].sort(),
        original = [...(role?.permissionIds ?? [])].sort();
      if (JSON.stringify(selected) !== JSON.stringify(original)) payload.permissionIds = selected;
    }
    setSaving(true);
    try {
      if (roleId === null) await httpClient.post('/roles', payload);
      else if (Object.keys(payload).length)
        await httpClient.put(`/roles/${encodeURIComponent(roleId)}`, payload);
      message.success(t(roleId === null ? '创建成功' : '更新成功'));
      onSaved();
    } catch {
      message.error(
        t(
          '角色保存未确认，请核对权限和连接后重试；当前草稿已保留。',
          'Role save was not confirmed. Check your access and connection, then retry. Your draft is kept.',
        ),
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      open
      title={t(roleId === null ? '新建角色' : '编辑角色')}
      onCancel={onClose}
      maskClosable={false}
      closable={!saving}
      keyboard={!saving}
      footer={
        <>
          <Button disabled={saving} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button
            type="primary"
            loading={saving}
            disabled={!!blocked}
            onClick={() => form.submit()}
          >
            {t('保存')}
          </Button>
        </>
      }
    >
      {loading ? (
        <Skeleton active />
      ) : loadError ? (
        <Alert
          type="error"
          showIcon
          message={t('角色详情读取失败', 'Could not load role details')}
          description={t(
            '读取成功前不能保存，以免覆盖现有授权。',
            'Saving is unavailable until the current role and grants have loaded.',
          )}
          action={<Button onClick={() => setRetry((value) => value + 1)}>{t('重试')}</Button>}
        />
      ) : (
        <Form
          form={form}
          name={`role-editor-${roleId ?? 'new'}`}
          layout="vertical"
          onFinish={(values) => void save(values)}
          disabled={saving}
          initialValues={{ name: '', description: '' }}
        >
          <Form.Item
            name="name"
            label={t('角色名称')}
            rules={[{ required: true, whitespace: true }]}
            extra={
              roleId !== null && !canAuthorize
                ? t(
                    '更改角色名称需要授权管理权限。',
                    'Changing a role name requires authorization-management access.',
                  )
                : undefined
            }
          >
            <Input disabled={roleId !== null && !canAuthorize} />
          </Form.Item>
          <Form.Item name="description" label={t('描述')}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Typography.Paragraph type="secondary">
            {t(
              '常规保存保留现有授权；只有显式编辑授权才提交权限变化。',
              'Regular saves preserve existing grants. Permission changes are sent only when you explicitly edit grants.',
            )}
          </Typography.Paragraph>
          {canAuthorize && (
            <Checkbox
              checked={editPermissions}
              disabled={saving || !canReadPermissions}
              onChange={(event) => setEditPermissions(event.target.checked)}
            >
              {t('编辑角色授权', 'Edit role grants')}
            </Checkbox>
          )}
          {canAuthorize && !canReadPermissions && (
            <Typography.Paragraph type="secondary">
              {t(
                '查看权限目录后才能编辑授权。',
                'Permission-catalog access is required to edit grants.',
              )}
            </Typography.Paragraph>
          )}
          {editPermissions &&
            (treeLoading ? (
              <Skeleton active />
            ) : treeError ? (
              <Alert
                type="error"
                showIcon
                message={t('权限目录读取失败', 'Could not load the permission catalog')}
                action={
                  <Button onClick={() => setTreeRetry((value) => value + 1)}>{t('重试')}</Button>
                }
              />
            ) : (
              <>
                {hiddenExisting.length > 0 && (
                  <Alert
                    type="info"
                    message={t(
                      '未在目录中列出的已有授权会保留。',
                      'Existing grants not listed in this catalog are preserved.',
                    )}
                  />
                )}
                <Tree
                  checkable
                  checkStrictly
                  defaultExpandAll
                  checkedKeys={checkedKeys}
                  treeData={groups.map((group) => ({
                    key: `catalog:${group.resource}`,
                    title: group.resource,
                    checkable: false,
                    children: group.permissions.map((permission) => ({
                      key: permission.id,
                      title: permission.name,
                    })),
                  }))}
                  onCheck={(keys) =>
                    setCheckedKeys([
                      ...new Set([
                        ...hiddenExisting,
                        ...(Array.isArray(keys) ? keys : keys.checked)
                          .map(String)
                          .filter((id) => permissionIds.has(id)),
                      ]),
                    ])
                  }
                />
              </>
            ))}
        </Form>
      )}
    </Modal>
  );
}

const RolePage: React.FC = () => {
  const { t } = useAdminI18n(),
    { message } = App.useApp();
  const actionRef = useRef<ActionType>(null),
    { rowSelection, batchDelete, selectedRowKeys } = useBatchDelete('/roles', actionRef);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const columns: ProColumns<RoleRecord>[] = [
    { title: t('角色名称'), dataIndex: 'name' },
    { title: t('角色 ID', 'Role ID'), dataIndex: 'id', copyable: true, search: false },
    { title: t('描述'), dataIndex: 'description', search: false, ellipsis: true },
    { title: t('创建时间'), dataIndex: 'createTime', valueType: 'dateTime', search: false },
    {
      title: t('操作'),
      valueType: 'option',
      render: (_, record) => [
        <PermissionGuard key="edit" permission="roles:update">
          <a onClick={() => setEditing({ id: record.id })}>{t('编辑')}</a>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="roles:delete">
          <Popconfirm
            title={t('确定删除?')}
            onConfirm={async () => {
              await httpClient.delete(`/roles/${encodeURIComponent(record.id)}`);
              message.success(t('删除成功'));
              actionRef.current?.reload();
            }}
          >
            <a style={{ color: '#DC2626' }}>{t('删除')}</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];
  return (
    <PageContainer title={t('角色管理')}>
      <ProTable<RoleRecord>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        rowSelection={rowSelection}
        scroll={{ x: 'max-content' }}
        request={(params) => queryRequest<RoleRecord>('/roles', params)}
        toolBarRender={() => [
          selectedRowKeys.length > 0 && (
            <PermissionGuard key="batch-delete" permission="roles:delete">
              <Popconfirm
                title={t('确定删除选中的 {count} 条记录？', undefined, {
                  count: selectedRowKeys.length,
                })}
                onConfirm={batchDelete}
              >
                <Button danger icon={<DeleteOutlined />}>
                  {t('批量删除')} ({selectedRowKeys.length})
                </Button>
              </Popconfirm>
            </PermissionGuard>
          ),
          <PermissionGuard key="create" permission="roles:add">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ id: null })}>
              {t('新建角色')}
            </Button>
          </PermissionGuard>,
        ]}
      />
      {editing && (
        <RoleEditor
          key={editing.id ?? 'new-role'}
          roleId={editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            actionRef.current?.reload();
          }}
        />
      )}
    </PageContainer>
  );
};
export default RolePage;
