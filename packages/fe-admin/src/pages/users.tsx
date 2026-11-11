import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/button';
import { Dialog } from '../components/dialog';
import { ErrorState, LoadingState, Notice, StatusBadge, toast } from '../components/feedback';
import { FormDialog, type FieldSpec, type FormValues } from '../components/form';
import { Checkbox, Input } from '../components/inputs';
import type { UserRoleExpiries, UserRolesWriteBody } from '@zucker-framework/fe-types/back-office';
import { PageContainer } from '../components/layout';
import { Pagination, ResourceTable, type ResourceTableHandle } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck } from '../app/context';
import type { ResolvedAdminConfig } from '../app/config';
import { localizedText } from '../app/menu';
import { useAdminI18n } from '../i18n/context';
import { errorBody, formatDateTime } from '../lib/format';
import { BatchDeleteButton, DeleteAction, crudLoader, enc } from './shared';

export interface UserRecord {
  id: string;
  username: string;
  email?: string | null;
  name?: string | null;
  status?: boolean;
  /** Account type; shown when `users.typeOptions` is configured. */
  typeId?: string | null;
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
  const [twoFactorUser, setTwoFactorUser] = useState<UserRecord | null>(null);
  const [passwordUser, setPasswordUser] = useState<UserRecord | null>(null);
  const resetPath = config.usersTwoFactorResetPath;
  const passwordReset = config.usersPasswordReset;
  const typeOptions = config.usersTypeOptions;
  const typeLabel = (value: string | null | undefined) => {
    const option = typeOptions.find((candidate) => candidate.value === value);
    return option ? localizedText(option.label, locale) : (value ?? '');
  };
  const reload = () => table.current?.reload();
  const defaultType = (() => {
    const preferred = config.usersCreateDefaults.typeId;
    return typeof preferred === 'string' && typeOptions.some((option) => option.value === preferred) ? preferred : (typeOptions[0]?.value ?? '');
  })();
  const typeField = (record: UserRecord | null): FieldSpec[] => {
    if (!typeOptions.length) return [];
    const options = typeOptions.map((option) => ({ value: option.value, label: localizedText(option.label, locale) }));
    // A stored type outside the configured options stays selectable, so an unrelated edit keeps it.
    if (record?.typeId && !typeOptions.some((option) => option.value === record.typeId))
      options.push({ value: record.typeId, label: record.typeId });
    // The server requires users:authorize to change the type of an existing account.
    return [{ name: 'typeId', label: t('users.type'), type: 'select', required: true, options, disabled: Boolean(record) && !can(codes.authorize) }];
  };
  const fields = (record: UserRecord | null): FieldSpec[] => [
    { name: 'username', label: t('users.username'), required: true, disabled: Boolean(record), autoComplete: 'off', maxLength: 64 },
    { name: 'email', label: t('users.email'), type: 'email', required: true, maxLength: 254 },
    { name: 'name', label: t('users.name'), maxLength: 100 },
    ...typeField(record),
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
          Object.fromEntries(
            Object.entries(filters).map(([key, value]) =>
              // Text filters match by substring; status and type match exactly (USER_FILTER of @zucker-framework/admin).
              key === 'status' ? [key, value === 'true'] : key === 'typeId' ? [key, value] : [`${key}$like`, value],
            ),
          ),
        )}
        rowKey={(row) => row.id}
        filters={[
          { name: 'username', label: t('users.searchUsername') },
          { name: 'email', label: t('users.searchEmail') },
          {
            name: 'status',
            label: t('users.status'),
            type: 'select',
            options: [
              { value: 'true', label: t('common.enabled') },
              { value: 'false', label: t('common.disabled') },
            ],
          },
          ...(typeOptions.length
            ? [{
                name: 'typeId',
                label: t('users.type'),
                type: 'select' as const,
                options: typeOptions.map((option) => ({ value: option.value, label: localizedText(option.label, locale) })),
              }]
            : []),
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
          ...(typeOptions.length
            ? [{ key: 'typeId', title: t('users.type'), render: (row: UserRecord) => typeLabel(row.typeId), hideOnMobile: true }]
            : []),
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
            {passwordReset && can(codes.authorize) && (
              <Button size="sm" variant="ghost" onClick={() => setPasswordUser(row)}>
                {t('users.resetPassword')}
              </Button>
            )}
            {resetPath && can(codes.update) && (
              <Button size="sm" variant="ghost" onClick={() => setTwoFactorUser(row)}>
                {t('users.resetTwoFactor')}
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
      <FormDialog<FormValues>
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={record ? t('users.edit') : t('users.create')}
        initialValues={
          record
            ? {
                username: record.username,
                email: record.email ?? '',
                name: record.name ?? '',
                status: record.status !== false,
                ...(typeOptions.length ? { typeId: record.typeId ?? '' } : {}),
              }
            : { username: '', email: '', name: '', password: '', ...(typeOptions.length ? { typeId: defaultType } : {}) }
        }
        fields={fields(record)}
        onSubmit={async (values) => {
          if (record)
            await api.put(`${path}/${enc(record.id)}`, {
              email: String(values.email).trim(),
              name: String(values.name ?? '').trim(),
              status: values.status === true,
              // Sent only when changed: an unchanged type needs no users:authorize.
              ...(typeOptions.length && values.typeId !== (record.typeId ?? '') ? { typeId: values.typeId } : {}),
            });
          // Creation follows the consumer's registration policy (createDefaults, e.g. a user type).
          else
            await api.post(path, {
              ...config.usersCreateDefaults,
              ...(typeOptions.length ? { typeId: values.typeId } : {}),
              username: String(values.username).trim(),
              email: String(values.email).trim(),
              name: String(values.name ?? '').trim(),
              password: values.password,
            });
          toast.success(t('common.saved'));
          reload();
        }}
      />
      {passwordUser && passwordReset && (
        <PasswordResetDialog
          key={passwordUser.id}
          user={passwordUser}
          reset={passwordReset}
          onClose={() => setPasswordUser(null)}
          onDone={() => {
            setPasswordUser(null);
            reload();
          }}
        />
      )}
      {twoFactorUser && resetPath && (
        <TwoFactorResetDialog
          key={twoFactorUser.id}
          user={twoFactorUser}
          path={resetPath.replace(':id', enc(twoFactorUser.id))}
          onClose={() => setTwoFactorUser(null)}
        />
      )}
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

/**
 * Administrator password reset (`users.passwordReset`): sends `{ password }` to the configured
 * endpoint. The new password lives only in this dialog's draft and is dropped when it closes; a
 * failure keeps it for retry.
 */
export function PasswordResetDialog({
  user,
  reset,
  onClose,
  onDone,
}: {
  user: UserRecord;
  reset: NonNullable<ResolvedAdminConfig['usersPasswordReset']>;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const minLength = reset.minLength;
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('users.resetPasswordTitle', { name: user.username })}
      description={t('users.resetPasswordDescription')}
      submitText={t('users.resetPassword')}
      failureMessage={t('users.resetPasswordFailed')}
      initialValues={{ password: '', confirm: '' }}
      fields={[
        { name: 'password', label: t('users.newPassword'), type: 'password', required: true, autoComplete: 'new-password' },
        { name: 'confirm', label: t('users.confirmPassword'), type: 'password', required: true, autoComplete: 'new-password' },
      ]}
      validate={(values) => ({
        ...(minLength && String(values.password).length < minLength ? { password: t('users.passwordTooShort', { min: minLength }) } : {}),
        ...(values.confirm && values.confirm !== values.password ? { confirm: t('users.passwordMismatch') } : {}),
      })}
      onSubmit={async (values) => {
        const path = reset.path.replace(':id', enc(user.id));
        const body = { password: String(values.password) };
        if (reset.method === 'PUT') await api.put(path, body);
        else if (reset.method === 'PATCH') await api.patch(path, body);
        else await api.post(path, body);
        toast.success(t('users.resetPasswordDone'));
        onDone();
      }}
    />
  );
}

const RESET_ERROR_KEYS = {
  TWO_FACTOR_NOT_ENABLED: 'users.resetTwoFactorNotEnabled',
  RECENT_AUTHENTICATION_REQUIRED: 'users.resetTwoFactorReauth',
  RECENT_AUTHENTICATION_FAILED: 'users.resetTwoFactorReauth',
  TWO_FACTOR_RESET_FORBIDDEN: 'users.resetTwoFactorForbidden',
} as const;

/**
 * Staff reset of another account's two-factor authentication. The operator's password is sent only
 * for the server's recent-authentication check and is cleared when the dialog closes.
 */
export function TwoFactorResetDialog({ user, path, onClose }: { user: UserRecord; path: string; onClose: () => void }) {
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(path, password ? { password } : {});
      toast.success(t('users.resetTwoFactorDone'));
      onClose();
    } catch (failure) {
      // fe-http-client flattens the server's `code`; port-style bodies carry it as `reason`.
      const flattened = (failure as { code?: unknown } | null)?.code;
      const reason = (typeof flattened === 'string' && flattened in RESET_ERROR_KEYS ? flattened : errorBody(failure).reason) as
        keyof typeof RESET_ERROR_KEYS | undefined;
      setError(t(reason && RESET_ERROR_KEYS[reason] ? RESET_ERROR_KEYS[reason] : 'users.resetTwoFactorFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      busy={busy}
      title={t('users.resetTwoFactorTitle', { name: user.username })}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void submit()}>
            {t('users.resetTwoFactorConfirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Notice tone="warning" title={t('users.resetTwoFactor')}>
          {t('users.resetTwoFactorDescription')}
        </Notice>
        <label className="block space-y-1 text-sm">
          <span>{t('users.resetTwoFactorPassword')}</span>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </Dialog>
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

/** `expiries` from the server, or null when it does not support role expiry (field omitted or malformed). */
export function parseRoleExpiries(value: unknown): UserRoleExpiries | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: UserRoleExpiries = {};
  for (const [roleId, at] of Object.entries(value as Record<string, unknown>)) {
    if (at === null) result[roleId] = null;
    else if (typeof at === 'string' && Number.isFinite(Date.parse(at))) result[roleId] = new Date(at).toISOString();
    else return null;
  }
  return result;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Local calendar date (`YYYY-MM-DD`) of an ISO instant, for `<input type="date">`. */
export function expiryDateValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` : '';
}

/** A picked local date expires at the end of that local day; empty → never. */
export function expiryFromDateValue(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

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
  // null: the server does not return `expiries` (role expiry off) and the field stays hidden.
  const [initialExpiries, setInitialExpiries] = useState<UserRoleExpiries | null>(null);
  const [expiries, setExpiries] = useState<UserRoleExpiries | null>(null);
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
      .get<{ roleIds?: unknown; roles?: unknown; expiries?: unknown }>(rolesPath, undefined, { signal: controller.signal })
      .then((result) => {
        if (!result || !Array.isArray(result.roleIds) || result.roleIds.some((id) => typeof id !== 'string' || !id))
          throw new Error('Invalid user roles');
        const ids = [...new Set(result.roleIds as string[])].sort();
        setInitial(ids);
        setSelected(ids);
        const loadedExpiries = parseRoleExpiries(result.expiries);
        setInitialExpiries(loadedExpiries);
        setExpiries(loadedExpiries);
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
  const expiryOf = (map: UserRoleExpiries | null, id: string) => map?.[id] ?? null;
  const setExpiry = (id: string, value: string) => {
    setSaveError(false);
    setExpiries((previous) => {
      if (!previous) return previous;
      const current = previous[id] ?? null;
      const next = expiryFromDateValue(value);
      // Keep the stored instant when the same local day is shown again.
      if (next !== null && current !== null && expiryDateValue(current) === value) return previous;
      return { ...previous, [id]: next };
    });
  };
  const expiriesChanged = expiries !== null
    && selected.some((id) => expiryOf(expiries, id) !== expiryOf(initialExpiries, id));
  const changed = initial !== null && (JSON.stringify(selected) !== JSON.stringify(initial) || expiriesChanged);
  const canSave = canAccess && initial !== null && !detail.loading && !detail.error && !catalog.loading && !catalog.error && changed && !saving;
  async function save() {
    if (!canSave) return;
    const roleIds = [...selected];
    setSaving(true);
    setSaveError(false);
    try {
      const body: UserRolesWriteBody = expiries
        ? { roleIds, expiries: Object.fromEntries(roleIds.map((id) => [id, expiryOf(expiries, id)])) }
        : { roleIds };
      const result = await api.put<{ roleIds?: unknown }>(rolesPath, body);
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
                    const expiresAt = expiryOf(expiries, id);
                    return (
                      <li key={id} className="flex max-w-full flex-wrap items-center gap-1 rounded-md border px-2 py-1 text-sm">
                        <span className="break-all">{name}</span>
                        {expiries && (
                          <>
                            <Input
                              type="date"
                              className="h-8 w-auto"
                              aria-label={t('roleAssign.expiresLabel', { name })}
                              title={t('roleAssign.expires')}
                              disabled={saving}
                              value={expiryDateValue(expiresAt)}
                              onChange={(event) => setExpiry(id, event.target.value)}
                            />
                            {expiresAt && Date.parse(expiresAt) <= Date.now() && (
                              <StatusBadge tone="danger">{t('roleAssign.expired')}</StatusBadge>
                            )}
                          </>
                        )}
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
              {expiries && selected.length > 0 && (
                <p className="text-xs text-muted-foreground">{t('roleAssign.expiresHint')}</p>
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
