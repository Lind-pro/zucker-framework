import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Modal, Pagination, Skeleton, Space, Typography } from 'antd';
import httpClient, { queryRequest } from '@/lib/http-client';
import { usePermission } from '@/lib/permission';
import { useAdminI18n } from '@/i18n';

interface Props {
  userId: string;
  username: string;
  onClose: () => void;
  onSaved: () => void;
}
interface Role {
  id: string;
  name: string;
  description?: string | null;
}
interface CurrentRoles {
  roleIds: string[];
  roles: unknown[];
}
const pageSize = 20;
const validRole = (value: unknown): value is Role =>
  !!value &&
  typeof value === 'object' &&
  'id' in value &&
  typeof value.id === 'string' &&
  Boolean(value.id) &&
  'name' in value &&
  typeof value.name === 'string' &&
  (!('description' in value) ||
    value.description === null ||
    typeof value.description === 'string');

/** Each target has its own draft and request lifetime, including when the caller switches targets. */
export default function UserRoleEditor(props: Props) {
  return <UserRolePanel key={props.userId} {...props} />;
}

function UserRolePanel({ userId, username, onClose, onSaved }: Props) {
  const { t } = useAdminI18n(),
    { message } = App.useApp(),
    { hasPermission } = usePermission();
  const canAuthorize = hasPermission('users:authorize'),
    canReadRoles = hasPermission('roles:query');
  const canAccess = canAuthorize && canReadRoles;
  const alive = useRef(true);
  const [selected, setSelected] = useState<string[]>([]),
    [initial, setInitial] = useState<string[] | null>(null);
  const [known, setKnown] = useState<Map<string, Role>>(new Map());
  const [roles, setRoles] = useState<Role[]>([]),
    [total, setTotal] = useState(0),
    [page, setPage] = useState(1);
  const [detailLoading, setDetailLoading] = useState(true),
    [detailError, setDetailError] = useState(false),
    [detailRetry, setDetailRetry] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(true),
    [catalogError, setCatalogError] = useState(false),
    [catalogRetry, setCatalogRetry] = useState(0);
  const [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!canAccess) return;
    let active = true;
    setDetailLoading(true);
    setDetailError(false);
    void httpClient
      .get<CurrentRoles>(`/users/${encodeURIComponent(userId)}/roles`)
      .then((result) => {
        if (
          !result ||
          !Array.isArray(result.roleIds) ||
          result.roleIds.some((id) => typeof id !== 'string' || !id) ||
          !Array.isArray(result.roles)
        )
          throw new Error('Invalid user roles');
        if (!active) return;
        const ids = [...new Set(result.roleIds)].sort();
        setInitial(ids);
        setSelected(ids);
        setKnown(
          (previous) =>
            new Map([
              ...previous,
              ...result.roles.filter(validRole).map((role) => [role.id, role] as const),
            ]),
        );
      })
      .catch(() => {
        if (active) setDetailError(true);
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canAccess, userId, detailRetry]);
  useEffect(() => {
    if (!canAccess) return;
    let active = true;
    setCatalogLoading(true);
    setCatalogError(false);
    void queryRequest<Role>('/roles', { current: page, pageSize })
      .then((result) => {
        if (
          !Array.isArray(result.data) ||
          result.data.some((role) => !validRole(role)) ||
          !Number.isSafeInteger(result.total) ||
          result.total < 0
        )
          throw new Error('Invalid role directory');
        if (!active) return;
        setRoles(result.data);
        setTotal(result.total);
        setKnown(
          (previous) =>
            new Map([...previous, ...result.data.map((role) => [role.id, role] as const)]),
        );
      })
      .catch(() => {
        if (active) setCatalogError(true);
      })
      .finally(() => {
        if (active) setCatalogLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canAccess, page, catalogRetry]);
  function toggle(id: string, checked: boolean) {
    setSaveError(false);
    setSelected((previous) =>
      checked ? [...new Set([...previous, id])].sort() : previous.filter((value) => value !== id),
    );
  }
  const changed = initial !== null && JSON.stringify(selected) !== JSON.stringify(initial);
  const canSave =
    canAccess &&
    initial !== null &&
    !detailLoading &&
    !detailError &&
    !catalogLoading &&
    !catalogError &&
    changed &&
    !saving;
  async function save() {
    if (!canSave) return;
    const roleIds = [...selected];
    setSaving(true);
    setSaveError(false);
    try {
      const result = await httpClient.put<{ roleIds: string[] }>(
        `/users/${encodeURIComponent(userId)}/roles`,
        { roleIds },
      );
      if (
        !result ||
        !Array.isArray(result.roleIds) ||
        JSON.stringify([...new Set(result.roleIds)].sort()) !== JSON.stringify(roleIds)
      )
        throw new Error('Role save not confirmed');
      if (!alive.current) return;
      message.success(t('用户角色已保存', 'User roles saved'));
      onSaved();
    } catch {
      if (alive.current) setSaveError(true);
    } finally {
      if (alive.current) setSaving(false);
    }
  }
  return (
    <Modal
      open
      title={t('为 {name} 分配角色', 'Assign roles to {name}', { name: username })}
      width="min(720px, 100vw)"
      maskClosable={false}
      closable={!saving}
      keyboard={!saving}
      onCancel={() => {
        if (!saving) onClose();
      }}
      footer={
        <Space wrap>
          <Button disabled={saving} onClick={onClose}>
            {t('取消')}
          </Button>
          <Button type="primary" loading={saving} disabled={!canSave} onClick={() => void save()}>
            {t('保存角色', 'Save roles')}
          </Button>
        </Space>
      }
    >
      {!canAccess ? (
        <Alert
          type="warning"
          showIcon
          message={t(
            '角色分配需要用户授权与角色目录读取权限',
            'Assigning roles requires user authorization and role directory access',
          )}
          description={t(
            '需要 users:authorize 与 roles:query；未读取或修改此用户的角色。',
            'Both users:authorize and roles:query are required. No roles were read or changed.',
          )}
        />
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={t(
              '保存将替换此用户的完整角色列表',
              'Saving replaces this user’s complete role list',
            )}
            description={t(
              '跨页勾选会保留，未显示的现有角色不会自动移除。直接分配的权限不在此修改。',
              'Selections are retained across pages. Existing roles outside the current page are kept. Direct permission grants are not changed here.',
            )}
          />
          {detailLoading ? (
            <Skeleton active paragraph={{ rows: 2 }} />
          ) : detailError ? (
            <Alert
              type="error"
              showIcon
              message={t(
                '当前用户角色读取失败，暂不可保存',
                'Current roles could not be loaded. Saving is disabled.',
              )}
              action={
                <Button onClick={() => setDetailRetry((value) => value + 1)}>{t('重试')}</Button>
              }
            />
          ) : (
            <section aria-label={t('已选角色', 'Selected roles')}>
              <Typography.Title level={5}>
                {t('已选角色（{count}）', 'Selected roles ({count})', { count: selected.length })}
              </Typography.Title>
              {selected.length ? (
                <Space wrap>
                  {selected.map((id) => (
                    <Space
                      key={id}
                      style={{
                        border: '1px solid var(--ant-color-border, #d9d9d9)',
                        borderRadius: 6,
                        padding: '4px 8px',
                        maxWidth: '100%',
                      }}
                    >
                      <span style={{ overflowWrap: 'anywhere' }}>{known.get(id)?.name ?? id}</span>
                      <Button
                        type="text"
                        size="small"
                        disabled={saving}
                        aria-label={t('移除角色 {name}', 'Remove role {name}', {
                          name: known.get(id)?.name ?? id,
                        })}
                        onClick={() => toggle(id, false)}
                      >
                        {t('移除', 'Remove')}
                      </Button>
                    </Space>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">
                  {t('未选择角色', 'No roles selected')}
                </Typography.Text>
              )}
            </section>
          )}
          <section aria-label={t('角色目录', 'Role directory')}>
            <Typography.Title level={5}>{t('角色目录', 'Role directory')}</Typography.Title>
            {catalogError ? (
              <Alert
                type="error"
                showIcon
                message={t(
                  '角色目录读取失败，已保留勾选草稿',
                  'Could not load roles. Your selections are kept.',
                )}
                action={
                  <Button onClick={() => setCatalogRetry((value) => value + 1)}>{t('重试')}</Button>
                }
              />
            ) : catalogLoading ? (
              <Skeleton active paragraph={{ rows: 3 }} />
            ) : roles.length ? (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {roles.map((role) => (
                  <div key={role.id}>
                    <Checkbox
                      checked={selected.includes(role.id)}
                      disabled={saving || detailLoading || detailError || initial === null}
                      onChange={(event) => toggle(role.id, event.target.checked)}
                    >
                      {role.name}
                    </Checkbox>
                    {role.description && (
                      <div style={{ marginLeft: 24, color: '#888', overflowWrap: 'anywhere' }}>
                        {role.description}
                      </div>
                    )}
                  </div>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {t('本页暂无角色', 'No roles on this page')}
              </Typography.Text>
            )}
            <Pagination
              style={{ marginTop: 16 }}
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger={false}
              disabled={saving || catalogLoading}
              onChange={(next) => setPage(next)}
              showTotal={(count) => t('共 {count} 个角色', '{count} roles in total', { count })}
            />
          </section>
          {saveError && (
            <Alert
              type="error"
              showIcon
              message={t(
                '角色保存结果未确认，草稿已保留',
                'Role save was not confirmed. Your draft is kept.',
              )}
              description={t(
                '请核对权限和连接后重试同一选择。保存是完整替换，不会自动合并其他管理员的修改。',
                'Check access and connectivity, then retry the same selection. Saving replaces the full list and does not merge another administrator’s changes.',
              )}
            />
          )}
        </Space>
      )}
    </Modal>
  );
}
