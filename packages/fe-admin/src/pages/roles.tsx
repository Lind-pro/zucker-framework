import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '../components/button';
import { Dialog } from '../components/dialog';
import { ErrorState, LoadingState, Notice, toast } from '../components/feedback';
import { Checkbox, Field, Input, Textarea } from '../components/inputs';
import { PageContainer } from '../components/layout';
import { ResourceTable, type ResourceTableHandle } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck, useResource } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import { formatDateTime } from '../lib/format';
import { BatchDeleteButton, DeleteAction, crudLoader, enc } from './shared';

interface RoleRecord {
  id: string;
  name: string;
  description?: string | null;
  createTime?: string;
}
interface RoleDetail extends RoleRecord {
  permissionIds: string[];
}
export interface PermissionGroup {
  resource: string;
  permissions: Array<{ id: string; name: string }>;
}

function parsePermissionGroups(value: unknown): PermissionGroup[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (group: PermissionGroup) =>
        !group ||
        typeof group.resource !== 'string' ||
        !Array.isArray(group.permissions) ||
        group.permissions.some((permission) => typeof permission?.id !== 'string' || typeof permission?.name !== 'string'),
    )
  )
    throw new Error('Invalid permission catalog');
  return value as PermissionGroup[];
}

/** Grouped permission checklist; a group checkbox toggles all its permissions (tri-state). */
export function PermissionTree({
  groups,
  selected,
  onChange,
  disabled,
}: {
  groups: readonly PermissionGroup[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useAdminI18n();
  const chosen = new Set(selected);
  const set = (ids: string[], checked: boolean) => {
    const next = new Set(chosen);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    onChange([...next]);
  };
  return (
    <ul className="space-y-3" aria-label={t('roles.permissionTree')}>
      {groups.map((group) => {
        const ids = group.permissions.map((permission) => permission.id);
        const count = ids.filter((id) => chosen.has(id)).length;
        return (
          <li key={group.resource} className="rounded-lg border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                aria-label={t('roles.groupToggle', { group: group.resource })}
                checked={count === 0 ? false : count === ids.length ? true : 'indeterminate'}
                disabled={disabled || !ids.length}
                onCheckedChange={(checked) => set(ids, checked)}
              />
              {group.resource}
            </label>
            <ul className="mt-2 grid gap-2 pl-6 sm:grid-cols-2">
              {group.permissions.map((permission) => (
                <li key={permission.id}>
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={chosen.has(permission.id)}
                      disabled={disabled}
                      onCheckedChange={(checked) => set([permission.id], checked)}
                    />
                    <span className="min-w-0 break-all">
                      {permission.name}
                      <span className="block text-xs text-muted-foreground">{permission.id}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Role editor. Ordinary saves send only changed metadata; permission grants are submitted only
 * when the administrator explicitly edits them, and grants missing from the catalog are kept.
 */
function RoleEditor({ roleId, onClose, onSaved }: { roleId: string | null; onClose: () => void; onSaved: () => void }) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const can = usePermissionCheck();
  const canAuthorize = can(config.permissions.roles.authorize);
  const canReadPermissions = can(config.permissions.permissions.query);
  const path = config.endpoints.roles;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [editGrants, setEditGrants] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const detail = useResource<RoleDetail | null>(
    async (signal) => {
      if (roleId === null) return null;
      const role = await api.get<RoleDetail>(`${path}/${enc(roleId)}`, undefined, { signal });
      if (!role || role.id !== roleId || typeof role.name !== 'string' || !Array.isArray(role.permissionIds))
        throw new Error('Invalid role detail');
      setName(role.name);
      setDescription(role.description ?? '');
      setChecked([...role.permissionIds]);
      return role;
    },
    [roleId],
  );
  const tree = useResource(
    async (signal) => parsePermissionGroups(await api.get(config.endpoints.permissionTree, undefined, { signal })),
    [editGrants],
    { enabled: editGrants && canAuthorize && canReadPermissions },
  );
  const role = detail.data ?? null;
  const catalogIds = new Set((tree.data ?? []).flatMap((group) => group.permissions.map((permission) => permission.id)));
  const hiddenExisting = (role?.permissionIds ?? []).filter((id) => !catalogIds.has(id));
  const blocked = detail.loading || detail.error || (roleId !== null && !role) || (editGrants && (tree.loading || tree.error));
  async function save() {
    if (blocked || saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t('common.required', { label: t('roles.name') }));
      return;
    }
    const payload: Record<string, unknown> = {};
    if (!role || trimmed !== role.name) payload.name = trimmed;
    if (!role || description !== (role.description ?? '')) payload.description = description;
    if (editGrants && canAuthorize && canReadPermissions) {
      const next = [...new Set([...hiddenExisting, ...checked.filter((id) => catalogIds.has(id))])].sort();
      const original = [...(role?.permissionIds ?? [])].sort();
      if (JSON.stringify(next) !== JSON.stringify(original)) payload.permissionIds = next;
    }
    setSaving(true);
    try {
      if (roleId === null) await api.post(path, payload);
      else if (Object.keys(payload).length) await api.put(`${path}/${enc(roleId)}`, payload);
      toast.success(t('common.saved'));
      onSaved();
    } catch {
      toast.error(t('common.saveFailed'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      busy={saving}
      width={720}
      title={roleId === null ? t('roles.create') : t('roles.edit')}
      footer={
        <>
          <Button disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={saving} disabled={Boolean(blocked)} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {detail.loading ? (
        <LoadingState />
      ) : detail.error ? (
        <ErrorState message={t('roles.loadFailed')} onRetry={detail.reload} />
      ) : (
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field
            label={t('roles.name')}
            required
            error={nameError}
            description={roleId !== null && !canAuthorize ? t('roles.renameNeedsAuthorize') : undefined}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                name="name"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                disabled={saving || (roleId !== null && !canAuthorize)}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(undefined);
                }}
              />
            )}
          </Field>
          <Field label={t('common.description')}>
            {({ id }) => (
              <Textarea id={id} name="description" rows={3} disabled={saving} value={description} onChange={(event) => setDescription(event.target.value)} />
            )}
          </Field>
          <p className="text-sm text-muted-foreground">{t('roles.grantsNotice')}</p>
          {canAuthorize && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={editGrants} disabled={saving || !canReadPermissions} onCheckedChange={setEditGrants} />
              {t('roles.editGrants')}
            </label>
          )}
          {canAuthorize && !canReadPermissions && <p className="text-sm text-muted-foreground">{t('roles.grantsNeedCatalog')}</p>}
          {editGrants &&
            (tree.loading ? (
              <LoadingState />
            ) : tree.error ? (
              <ErrorState message={t('roles.catalogFailed')} onRetry={tree.reload} />
            ) : (
              <>
                {hiddenExisting.length > 0 && <Notice tone="info" title={t('roles.hiddenGrants')} />}
                <PermissionTree groups={tree.data ?? []} selected={checked} onChange={setChecked} disabled={saving} />
              </>
            ))}
        </form>
      )}
    </Dialog>
  );
}

export function RolesPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const can = usePermissionCheck();
  const codes = config.permissions.roles;
  const path = config.endpoints.roles;
  const table = useRef<ResourceTableHandle>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const reload = () => table.current?.reload();
  return (
    <PageContainer title={t('page.roles')}>
      <ResourceTable<RoleRecord>
        ref={table}
        label={t('page.roles')}
        load={crudLoader(api, path, (filters) => (filters.name ? { name$like: filters.name } : {}))}
        rowKey={(row) => row.id}
        filters={[{ name: 'name', label: t('roles.name') }]}
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
              <Button variant="primary" icon={<Plus />} onClick={() => setEditing({ id: null })}>
                {t('roles.create')}
              </Button>
            )}
          </>
        }
        columns={[
          { key: 'name', title: t('roles.name'), field: 'name' },
          { key: 'id', title: t('roles.id'), field: 'id', hideOnMobile: true },
          { key: 'description', title: t('common.description'), field: 'description' },
          { key: 'createTime', title: t('common.createdAt'), render: (row) => formatDateTime(row.createTime, locale), hideOnMobile: true },
        ]}
        actions={(row) => (
          <>
            {can(codes.update) && (
              <Button size="sm" variant="ghost" onClick={() => setEditing({ id: row.id })}>
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
      {editing && (
        <RoleEditor
          key={editing.id ?? 'new'}
          roleId={editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </PageContainer>
  );
}
