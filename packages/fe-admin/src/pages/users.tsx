import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/button';
import { Dialog } from '../components/dialog';
import { ErrorState, LoadingState, Notice, StatusBadge, toast } from '../components/feedback';
import { FormDialog, type FieldSpec } from '../components/form';
import { Checkbox } from '../components/inputs';
import { PageContainer } from '../components/layout';
import { Pagination, ResourceTable, type ResourceTableHandle } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import { formatDateTime } from '../lib/format';
import { BatchDeleteButton, DeleteAction, crudLoader, enc } from './shared';

export interface UserRecord {
  id: string;
  username: string;
  email?: string | null;
  name?: string | null;
  status?: boolean;
  createTime?: string;
}

export function UsersPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const can = usePermissionCheck();
  const codes = config.permissions.users;
  const path = config.endpoints.users;
  const table = useRef<ResourceTableHandle>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<UserRecord | 'new' | null>(null);
  const [roleUser, setRoleUser] = useState<UserRecord | null>(null);
  const reload = () => table.current?.reload();
  const fields = (record: UserRecord | null): FieldSpec[] => [
    { name: 'username', label: t('users.username'), required: true, disabled: Boolean(record), autoComplete: 'off', maxLength: 64 },
    { name: 'email', label: t('users.email'), type: 'email', required: true, maxLength: 254 },
    { name: 'name', label: t('users.name'), maxLength: 100 },
    ...(record
      ? [{ name: 'status', label: t('common.enabled'), type: 'switch' } as FieldSpec]
      : [{ name: 'password', label: t('users.password'), type: 'password', required: true, autoComplete: 'new-password' } as FieldSpec]),
  ];
  const record = editing && editing !== 'new' ? editing : null;
  return (
    <PageContainer title={t('page.users')}>
      <ResourceTable<UserRecord>
        ref={table}
        label={t('page.users')}
        load={crudLoader(api, path, (filters) =>
          Object.fromEntries(Object.entries(filters).map(([key, value]) => [`${key}$like`, value])),
        )}
        rowKey={(row) => row.id}
        filters={[
          { name: 'username', label: t('users.searchUsername') },
          { name: 'email', label: t('users.searchEmail') },
        ]}
        selection={can(codes.delete) ? { selected, onChange: setSelected } : undefined}
        toolbar={
          <>
            {can(codes.delete) && (
              <BatchDeleteButton
                api={api}
                path={path}
                ids={selected}
                onDone={() => {
                  setSelected([]);
                  reload();
                }}
              />
            )}
            {can(codes.add) && (
              <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
                {t('users.create')}
              </Button>
            )}
          </>
        }
        columns={[
          { key: 'username', title: t('users.username'), field: 'username' },
          { key: 'email', title: t('users.email'), field: 'email' },
          { key: 'name', title: t('users.name'), field: 'name' },
          {
            key: 'status',
            title: t('users.status'),
            render: (row) =>
              row.status === false ? (
                <StatusBadge tone="danger">{t('common.disabled')}</StatusBadge>
              ) : (
                <StatusBadge tone="success">{t('common.enabled')}</StatusBadge>
              ),
          },
          { key: 'createTime', title: t('common.createdAt'), render: (row) => formatDateTime(row.createTime, locale), hideOnMobile: true },
        ]}
        actions={(row) => (
          <>
            {can(codes.authorize) && can(config.permissions.roles.query) && (
              <Button size="sm" variant="ghost" onClick={() => setRoleUser(row)}>
                {t('users.assignRoles')}
              </Button>
            )}
            {can(codes.update) && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>
                {t('common.edit')}
              </Button>
            )}
            {can(codes.delete) && (
              <DeleteAction
                onDelete={async () => {
                  await api.delete(`${path}/${enc(row.id)}`);
                  reload();
                }}
              />
            )}
          </>
        )}
      />
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={record ? t('users.edit') : t('users.create')}
        initialValues={
          record
            ? { username: record.username, email: record.email ?? '', name: record.name ?? '', status: record.status !== false }
            : { username: '', email: '', name: '', password: '' }
        }
        fields={fields(record)}
        onSubmit={async (values) => {
          if (record)
            await api.put(`${path}/${enc(record.id)}`, {
              email: String(values.email).trim(),
              name: String(values.name ?? '').trim(),
              status: values.status === true,
            });
          // Creation follows the consumer's registration policy (createDefaults, e.g. a user type).
          else
            await api.post(path, {
              ...config.usersCreateDefaults,
              username: String(values.username).trim(),
              email: String(values.email).trim(),
              name: String(values.name ?? '').trim(),
              password: values.password,
            });
          toast.success(t('common.saved'));
          reload();
        }}
      />
      {roleUser && (
        <UserRoleEditor
          key={roleUser.id}
          user={roleUser}
          onClose={() => setRoleUser(null)}
          onSaved={() => {
            setRoleUser(null);
            reload();
          }}
        />
      )}
    </PageContainer>
  );
}

interface Role {
  id: string;
  name: string;
  description?: string | null;
}
const validRole = (value: unknown): value is Role =>
  !!value && typeof (value as Role).id === 'string' && !!(value as Role).id && typeof (value as Role).name === 'string';
const ROLE_PAGE_SIZE = 20;

/**
 * Replace a user's complete role set (`GET/PUT /users/:id/roles`). Selections persist across
 * directory pages; saving is disabled until the current roles have loaded, and a failed save keeps
 * the draft for retry.
 */
export function UserRoleEditor({ user, onClose, onSaved }: { user: UserRecord; onClose: () => void; onSaved: () => void }) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const can = usePermissionCheck();
  const canAccess = can(config.permissions.users.authorize) && can(config.permissions.roles.query);
  const alive = useRef(true);
  const [initial, setInitial] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [known, setKnown] = useState<Map<string, Role>>(new Map());
  const [roles, setRoles] = useState<Role[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState({ loading: true, error: false, retry: 0 });
  const [catalog, setCatalog] = useState({ loading: true, error: false, retry: 0 });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const rolesPath = `${config.endpoints.users}/${enc(user.id)}/roles`;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!canAccess) return;
    const controller = new AbortController();
    setDetail((state) => ({ ...state, loading: true, error: false }));
    api
      .get<{ roleIds?: unknown; roles?: unknown }>(rolesPath, undefined, { signal: controller.signal })
      .then((result) => {
        if (!result || !Array.isArray(result.roleIds) || result.roleIds.some((id) => typeof id !== 'string' || !id))
          throw new Error('Invalid user roles');
        const ids = [...new Set(result.roleIds as string[])].sort();
        setInitial(ids);
        setSelected(ids);
        const current = Array.isArray(result.roles) ? result.roles.filter(validRole) : [];
        setKnown((previous) => new Map([...previous, ...current.map((role) => [role.id, role] as const)]));
        setDetail((state) => ({ ...state, loading: false }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setDetail((state) => ({ ...state, loading: false, error: true }));
      });
    return () => controller.abort();
  }, [api, canAccess, rolesPath, detail.retry]);
  useEffect(() => {
    if (!canAccess) return;
    const controller = new AbortController();
    setCatalog((state) => ({ ...state, loading: true, error: false }));
    api
      .post<{ data?: unknown; total?: unknown }>(
        `${config.endpoints.roles}/_query`,
        { pageIndex: page - 1, pageSize: ROLE_PAGE_SIZE },
        { signal: controller.signal },
      )
      .then((result) => {
        if (!Array.isArray(result?.data) || result.data.some((role) => !validRole(role)) || !Number.isSafeInteger(result.total))
          throw new Error('Invalid role directory');
        const list = result.data as Role[];
        setRoles(list);
        setTotal(result.total as number);
        setKnown((previous) => new Map([...previous, ...list.map((role) => [role.id, role] as const)]));
        setCatalog((state) => ({ ...state, loading: false }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setCatalog((state) => ({ ...state, loading: false, error: true }));
      });
    return () => controller.abort();
  }, [api, canAccess, config.endpoints.roles, page, catalog.retry]);
  const toggle = (id: string, checked: boolean) => {
    setSaveError(false);
    setSelected((previous) => (checked ? [...new Set([...previous, id])].sort() : previous.filter((value) => value !== id)));
  };
  const changed = initial !== null && JSON.stringify(selected) !== JSON.stringify(initial);
  const canSave = canAccess && initial !== null && !detail.loading && !detail.error && !catalog.loading && !catalog.error && changed && !saving;
  async function save() {
    if (!canSave) return;
    const roleIds = [...selected];
    setSaving(true);
    setSaveError(false);
    try {
      const result = await api.put<{ roleIds?: unknown }>(rolesPath, { roleIds });
      if (!result || !Array.isArray(result.roleIds) || JSON.stringify([...new Set(result.roleIds)].sort()) !== JSON.stringify(roleIds))
        throw new Error('Role save not confirmed');
      if (!alive.current) return;
      toast.success(t('roleAssign.saved'));
      onSaved();
    } catch {
      if (alive.current) setSaveError(true);
    } finally {
      if (alive.current) setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      busy={saving}
      width={720}
      title={t('roleAssign.title', { name: user.username })}
      footer={
        <>
          <Button disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={saving} disabled={!canSave} onClick={() => void save()}>
            {t('roleAssign.save')}
          </Button>
        </>
      }
    >
      {!canAccess ? (
        <Notice tone="warning" title={t('roleAssign.noAccess')}>
          {t('roleAssign.noAccessDescription', {
            authorize: config.permissions.users.authorize,
            query: config.permissions.roles.query,
          })}
        </Notice>
      ) : (
        <div className="space-y-4">
          <Notice tone="info" title={t('roleAssign.replaceNotice')}>
            {t('roleAssign.replaceNoticeDescription')}
          </Notice>
          {detail.loading ? (
            <LoadingState />
          ) : detail.error ? (
            <ErrorState message={t('roleAssign.loadFailed')} onRetry={() => setDetail((state) => ({ ...state, retry: state.retry + 1 }))} />
          ) : (
            <section aria-label={t('roleAssign.selected', { count: selected.length })} className="space-y-2">
              <h3 className="text-sm font-medium">{t('roleAssign.selected', { count: selected.length })}</h3>
              {selected.length ? (
                <ul className="flex flex-wrap gap-2">
                  {selected.map((id) => {
                    const name = known.get(id)?.name ?? id;
                    return (
                      <li key={id} className="flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-sm">
                        <span className="break-all">{name}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={saving}
                          aria-label={t('roleAssign.remove', { name })}
                          onClick={() => toggle(id, false)}
                        >
                          {t('common.removeItem')}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('roleAssign.noneSelected')}</p>
              )}
            </section>
          )}
          <section aria-label={t('roleAssign.directory')} className="space-y-3">
            <h3 className="text-sm font-medium">{t('roleAssign.directory')}</h3>
            {catalog.error ? (
              <ErrorState message={t('roleAssign.directoryFailed')} onRetry={() => setCatalog((state) => ({ ...state, retry: state.retry + 1 }))} />
            ) : catalog.loading ? (
              <LoadingState />
            ) : roles.length ? (
              <ul className="space-y-3">
                {roles.map((role) => (
                  <li key={role.id}>
                    <label className="flex items-start gap-2 text-sm">
                      <Checkbox
                        className="mt-0.5"
                        checked={selected.includes(role.id)}
                        disabled={saving || detail.loading || detail.error || initial === null}
                        onCheckedChange={(checked) => toggle(role.id, checked)}
                      />
                      <span className="min-w-0">
                        <span className="block break-all">{role.name}</span>
                        {role.description && <span className="block text-xs text-muted-foreground">{role.description}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('roleAssign.directoryEmpty')}</p>
            )}
            <Pagination
              page={page}
              pageSize={ROLE_PAGE_SIZE}
              total={total}
              pageSizeOptions={[ROLE_PAGE_SIZE]}
              disabled={saving || catalog.loading}
              onChange={(next) => setPage(next)}
            />
          </section>
          {saveError && <Notice tone="danger" title={t('roleAssign.saveFailed')} />}
        </div>
      )}
    </Dialog>
  );
}
