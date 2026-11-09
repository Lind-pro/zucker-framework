import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/button';
import { Notice, StatusBadge, toast } from '../components/feedback';
import { FormDialog } from '../components/form';
import { PageContainer } from '../components/layout';
import { DataTable } from '../components/data-table';
import { useAdmin, useAdminApi, usePageTitle, usePermissionCheck, useResource } from '../app/context';
import type { BackendMenuItem } from '../app/menu';
import { useAdminI18n } from '../i18n/context';
import { DeleteAction, enc } from './shared';

function descendants(rows: readonly BackendMenuItem[], id: string): Set<string> {
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

/** Complete menu catalog (`GET /menu/all`), including disabled entries; pages come from the route registry. */
export function MenuPage() {
  const { config, pages } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const can = usePermissionCheck();
  const title = usePageTitle();
  const codes = config.permissions.menu;
  const [editing, setEditing] = useState<BackendMenuItem | 'new' | null>(null);
  const rows = useResource(async (signal) => {
    const data = await api.get<unknown>(config.endpoints.menuAll, undefined, { signal });
    if (!Array.isArray(data)) throw new Error('Unexpected menu response');
    return data as BackendMenuItem[];
  }, []);
  const all = rows.data ?? [];
  const record = editing && editing !== 'new' ? editing : null;
  const excluded = record ? descendants(all, record.id) : new Set<string>();
  return (
    <PageContainer
      title={t('page.menu')}
      actions={
        can(codes.add) && (
          <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
            {t('menu.create')}
          </Button>
        )
      }
    >
      <Notice tone="info" title={t('menu.notice')}>
        {t('menu.noticeDescription')}
      </Notice>
      <DataTable<BackendMenuItem>
        label={t('page.menu')}
        rows={[...all].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))}
        rowKey={(row) => row.id}
        loading={rows.loading}
        error={rows.error}
        onRetry={rows.reload}
        columns={[
          { key: 'name', title: t('common.name'), field: 'name' },
          { key: 'path', title: t('menu.path'), render: (row) => row.path || t('menu.group') },
          { key: 'parent', title: t('menu.parent'), render: (row) => all.find((item) => item.id === row.parentId)?.name ?? '—' },
          { key: 'sortOrder', title: t('menu.sortOrder'), field: 'sortOrder', hideOnMobile: true },
          {
            key: 'status',
            title: t('common.status'),
            render: (row) => (
              <StatusBadge tone={row.status ? 'success' : 'neutral'}>{row.status ? t('common.enabled') : t('common.disabled')}</StatusBadge>
            ),
          },
          { key: 'permissions', title: t('menu.permissions'), render: (row) => row.permissions?.join(', ') || '—', hideOnMobile: true },
        ]}
        actions={(row) => (
          <>
            {can(codes.update) && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>
                {t('common.edit')}
              </Button>
            )}
            {can(codes.delete) && (
              <DeleteAction
                title={t('menu.deleteConfirm')}
                onDelete={async () => {
                  await api.delete(`${config.endpoints.menu}/${enc(row.id)}`);
                  rows.reload();
                }}
              />
            )}
          </>
        )}
      />
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={record ? t('menu.edit') : t('menu.create')}
        columns={2}
        initialValues={{
          name: record?.name ?? '',
          path: record?.path ?? '',
          parentId: record?.parentId ?? '',
          sortOrder: String(record?.sortOrder ?? 0),
          status: record ? record.status : true,
          permissions: record?.permissions ?? [],
        }}
        fields={[
          { name: 'name', label: t('menu.name'), required: true, maxLength: 100 },
          {
            name: 'path',
            label: t('menu.path'),
            type: 'select',
            description: t('menu.pathHint'),
            options: pages.map((page) => ({ value: page.path, label: `${title(page)} (${page.path})` })),
          },
          {
            name: 'parentId',
            label: t('menu.parent'),
            type: 'select',
            options: all.filter((row) => !row.path && !excluded.has(row.id)).map((row) => ({ value: row.id, label: row.name })),
          },
          { name: 'sortOrder', label: t('menu.sortOrder'), type: 'integer', min: 0, required: true },
          { name: 'status', label: t('common.enabled'), type: 'switch' },
          { name: 'permissions', label: t('menu.permissions'), type: 'list', description: t('menu.permissionsHint'), wide: true },
        ]}
        onSubmit={async (values) => {
          const body = {
            name: String(values.name).trim(),
            path: values.path || null,
            parentId: values.parentId || null,
            sortOrder: Number(values.sortOrder ?? 0),
            status: values.status === true,
            permissions: Array.isArray(values.permissions) ? values.permissions : [],
          };
          if (record) await api.put(`${config.endpoints.menu}/${enc(record.id)}`, body);
          else await api.post(config.endpoints.menu, body);
          toast.success(t('menu.saved'));
          rows.reload();
        }}
      />
    </PageContainer>
  );
}
