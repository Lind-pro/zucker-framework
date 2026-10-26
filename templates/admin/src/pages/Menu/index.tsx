import { useAdminI18n } from '@/i18n';
import { useRef, useState } from 'react';
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
} from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Alert, App, Button, Popconfirm, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import httpClient from '@/lib/http-client';
import { PermissionGuard } from '@/lib/permission';
import { adminRoutes, type BackendMenuItem } from '@/config/admin-navigation';
function descendants(rows: BackendMenuItem[], id: string): Set<string> {
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) {
        ids.add(row.id);
        changed = true;
      }
  }
  return ids;
}
export default function MenuPage() {
  const { t } = useAdminI18n();
  const { message } = App.useApp(),
    actionRef = useRef<ActionType>(null);
  const [rows, setRows] = useState<BackendMenuItem[]>([]);
  const fields = (record?: BackendMenuItem) => {
    const excluded = record ? descendants(rows, record.id) : new Set<string>();
    return (
      <>
        <ProFormText name="name" label={t('菜单名称')} rules={[{ required: true }]} />
        <ProFormSelect
          name="path"
          label={t('页面')}
          allowClear
          options={Object.entries(adminRoutes).map(([value, route]) => ({
            value,
            label: `${t(route.name)} (${value})`,
          }))}
          extra={t('留空表示分组。应用新增路由后再扩展页面目录。')}
        />
        <ProFormSelect
          name="parentId"
          label={t('上级分组')}
          allowClear
          options={rows
            .filter((row) => !row.path && !excluded.has(row.id))
            .map((row) => ({ value: row.id, label: row.name }))}
        />
        <ProFormDigit name="sortOrder" label={t('排序')} initialValue={0} min={0} />
        <ProFormSwitch name="status" label={t('启用')} initialValue />
        <ProFormSelect
          name="permissions"
          label={t('可见权限（任一满足）')}
          mode="tags"
          extra={t('菜单可见性不代替 API 授权。分组可不填写权限。')}
        />
      </>
    );
  };
  async function save(values: Record<string, unknown>, id?: string) {
    const body = {
      name: values.name,
      path: values.path || null,
      parentId: values.parentId || null,
      sortOrder: values.sortOrder ?? 0,
      status: values.status === true,
      permissions: values.permissions ?? [],
    };
    try {
      if (id) await httpClient.put(`/menu/${id}`, body);
      else await httpClient.post('/menu', body);
      message.success(t('菜单已保存，刷新页面后更新导航'));
      actionRef.current?.reload();
      return true;
    } catch {
      message.error(t('菜单保存失败'));
      return false;
    }
  }
  const columns: ProColumns<BackendMenuItem>[] = [
    { title: t('名称'), dataIndex: 'name' },
    { title: t('页面'), dataIndex: 'path', renderText: (value) => value || t('分组') },
    {
      title: t('上级'),
      dataIndex: 'parentId',
      renderText: (value) => rows.find((row) => row.id === value)?.name ?? '—',
    },
    { title: t('排序'), dataIndex: 'sortOrder' },
    {
      title: t('状态'),
      dataIndex: 'status',
      render: (_, row) => (
        <Tag color={row.status ? 'green' : 'default'}>{row.status ? t('启用') : t('停用')}</Tag>
      ),
    },
    {
      title: t('操作'),
      valueType: 'option',
      render: (_, row) => [
        <PermissionGuard key="edit" permission="menu:update">
          <ModalForm
            name={`menu-${row.id}`}
            title={t('编辑菜单')}
            trigger={<a>{t('编辑')}</a>}
            initialValues={row}
            onFinish={(values) => save(values, row.id)}
          >
            {fields(row)}
          </ModalForm>
        </PermissionGuard>,
        <PermissionGuard key="delete" permission="menu:delete">
          <Popconfirm
            title={t('删除此菜单及其所有子菜单？')}
            onConfirm={async () => {
              try {
                await httpClient.delete(`/menu/${row.id}`);
                message.success(t('菜单已删除'));
                actionRef.current?.reload();
              } catch {
                message.error(t('删除失败，请重试'));
              }
            }}
          >
            <a style={{ color: '#DC2626' }}>{t('删除')}</a>
          </Popconfirm>
        </PermissionGuard>,
      ],
    },
  ];
  return (
    <PageContainer title={t('菜单管理')}>
      <Alert
        type="info"
        showIcon
        message={t('管理完整菜单目录')}
        description={t(
          '当前列表包含停用和未分配的菜单。登录导航仅显示已启用、已授权且已注册的页面；账户、角色权限仍由服务端验证。',
        )}
        style={{ marginBottom: 20 }}
      />
      <ProTable<BackendMenuItem>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        search={false}
        pagination={false}
        request={async () => {
          const data = await httpClient.get<BackendMenuItem[]>('/menu/all');
          setRows(data);
          return { data, success: true };
        }}
        toolBarRender={() => [
          <PermissionGuard key="add" permission="menu:add">
            <ModalForm
              name="menu-create"
              title={t('新建菜单')}
              trigger={
                <Button type="primary" icon={<PlusOutlined />}>
                  {t('新建菜单')}
                </Button>
              }
              onFinish={(values) => save(values)}
            >
              {fields()}
            </ModalForm>
          </PermissionGuard>,
        ]}
      />
    </PageContainer>
  );
}
