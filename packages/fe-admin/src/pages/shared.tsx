import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { ConfirmButton } from '../components/dialog';
import { toast } from '../components/feedback';
import { assertPage, type FilterValues, type PageLoader } from '../components/data-table';
import type { AdminApi } from '../app/session';
import { useAdminI18n } from '../i18n/context';

/** `POST {path}/_query` (CRUD resources): 0-based pageIndex and a field filter map. */
export function crudLoader<T>(
  api: AdminApi,
  path: string,
  mapFilters: (filters: FilterValues) => Record<string, unknown> = (filters) => filters,
): PageLoader<T> {
  return async ({ page, pageSize, filters, signal }) => {
    const filter = mapFilters(filters);
    const body = {
      pageIndex: page - 1,
      pageSize,
      ...(Object.keys(filter).length ? { filter } : {}),
    };
    return assertPage<T>(await api.post(`${path}/_query`, body, { signal }));
  };
}

/** `GET {path}?page&pageSize&…filters` (management read models). */
export function pageLoader<T>(
  api: AdminApi,
  path: string,
  mapFilters: (filters: FilterValues) => Record<string, unknown> = (filters) => filters,
): PageLoader<T> {
  return async ({ page, pageSize, filters, signal }) =>
    assertPage<T>(await api.get(path, { page, pageSize, ...mapFilters(filters) }, { signal }));
}

/** Delete selected ids one by one and report partial failures. */
export function BatchDeleteButton({
  api,
  path,
  ids,
  onDone,
}: {
  api: AdminApi;
  path: string;
  ids: readonly string[];
  onDone: () => void;
}) {
  const { t } = useAdminI18n();
  if (!ids.length) return null;
  return (
    <ConfirmButton
      variant="danger"
      icon={<Trash2 />}
      destructive
      title={t('common.batchDeleteConfirm', { count: ids.length })}
      description={t('common.deleteConfirmDescription')}
      onConfirm={async () => {
        const results = await Promise.allSettled(ids.map((id) => api.delete(`${path}/${encodeURIComponent(id)}`)));
        const succeeded = results.filter((result) => result.status === 'fulfilled').length;
        const failed = results.length - succeeded;
        if (failed) toast.warning(t('common.batchDeleteResult', { succeeded, failed }));
        else toast.success(t('common.deleted'));
        onDone();
      }}
    >
      {t('common.batchDelete')} ({ids.length})
    </ConfirmButton>
  );
}

/** Delete one record with confirmation. */
export function DeleteAction({
  onDelete,
  title,
  description,
  label,
}: {
  onDelete: () => Promise<unknown>;
  title?: ReactNode;
  description?: ReactNode;
  label?: ReactNode;
}) {
  const { t } = useAdminI18n();
  return (
    <ConfirmButton
      variant="ghost"
      size="sm"
      className="text-destructive"
      destructive
      title={title ?? t('common.deleteConfirm')}
      description={description ?? t('common.deleteConfirmDescription')}
      confirmText={t('common.delete')}
      onConfirm={async () => {
        try {
          await onDelete();
          toast.success(t('common.deleted'));
        } catch (error) {
          toast.error(t('common.deleteFailed'));
          throw error;
        }
      }}
    >
      {label ?? t('common.delete')}
    </ConfirmButton>
  );
}

export const enc = encodeURIComponent;

/**
 * Re-read the signed-in account from the server before an idempotent command, so a retry key is
 * never reused across accounts after a session change in another tab.
 */
export async function confirmActor(api: AdminApi, mePath: string): Promise<string> {
  const actor = await api.get<{ id?: unknown }>(mePath);
  if (typeof actor?.id !== 'string' || !actor.id) throw new Error('Invalid account response');
  return actor.id;
}
