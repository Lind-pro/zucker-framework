import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '../components/button';
import { toast } from '../components/feedback';
import { FormDialog } from '../components/form';
import { PageContainer } from '../components/layout';
import { ResourceTable, type ResourceTableHandle } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import { formatDateTime } from '../lib/format';
import { BatchDeleteButton, DeleteAction, crudLoader, enc } from './shared';

interface PermissionRecord {
  id: string;
  name: string;
  description?: string | null;
  createdAt?: string;
}

/** Permission definitions. The code (id) is immutable; grants are edited on users and roles. */
export function PermissionsPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const can = usePermissionCheck();
  const codes = config.permissions.permissions;
  const path = config.endpoints.permissions;
  const table = useRef<ResourceTableHandle>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<PermissionRecord | 'new' | null>(null);
  const reload = () => table.current?.reload();
  const record = editing && editing !== 'new' ? editing : null;
  return (
    <PageContainer title={t('page.permissions')}>
      <ResourceTable<PermissionRecord>
        ref={table}
        label={t('page.permissions')}
        load={crudLoader(api, path, (filters) =>
          Object.fromEntries(Object.entries(filters).map(([key, value]) => [`${key}$like`, value])),
        )}
        rowKey={(row) => row.id}
        filters={[
          { name: 'name', label: t('permissions.name') },
          { name: 'id', label: t('permissions.code') },
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
                {t('permissions.create')}
              </Button>
            )}
          </>
        }
        columns={[
          { key: 'name', title: t('permissions.name'), field: 'name' },
          { key: 'id', title: t('permissions.code'), field: 'id' },
          { key: 'description', title: t('common.description'), field: 'description', hideOnMobile: true },
          { key: 'createdAt', title: t('common.createdAt'), render: (row) => formatDateTime(row.createdAt, locale), hideOnMobile: true },
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
        title={record ? t('permissions.edit') : t('permissions.create')}
        initialValues={{ id: record?.id ?? '', name: record?.name ?? '', description: record?.description ?? '' }}
        fields={[
          { name: 'name', label: t('permissions.name'), required: true, maxLength: 100 },
          { name: 'id', label: t('permissions.code'), required: true, disabled: Boolean(record), placeholder: 'resource:action', maxLength: 128 },
          { name: 'description', label: t('common.description'), type: 'textarea' },
        ]}
        onSubmit={async (values) => {
          const fields = { name: String(values.name).trim(), description: String(values.description ?? '') };
          if (record) await api.put(`${path}/${enc(record.id)}`, fields);
          else await api.post(path, { id: String(values.id).trim(), ...fields });
          toast.success(t('common.saved'));
          reload();
        }}
      />
    </PageContainer>
  );
}
