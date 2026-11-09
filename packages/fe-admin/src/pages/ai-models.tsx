import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '../components/button';
import { ConfirmButton } from '../components/dialog';
import { Notice, StatusBadge, toast } from '../components/feedback';
import { FormDialog } from '../components/form';
import { PageContainer } from '../components/layout';
import { ResourceTable, assertPage, type ResourceTableHandle } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import { formatDateTime } from '../lib/format';
import { DeleteAction, enc } from './shared';

interface AIModelRow {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  isEnabled?: boolean;
  isDefault?: boolean;
  description?: string | null;
  updatedAt?: string;
}

/** AI model credentials over `createAIModelAdminController` (RFC §8.5). Keys are masked; revealing needs `read-secret`. */
export function AIModelsPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const can = usePermissionCheck();
  const codes = config.permissions.aiModels;
  const path = config.endpoints.aiModels;
  const table = useRef<ResourceTableHandle>(null);
  const [editing, setEditing] = useState<AIModelRow | 'new' | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const record = editing && editing !== 'new' ? editing : null;
  const reload = () => table.current?.reload();
  // Provider ids are product vocabulary (`config.ai.providers`); without them nothing can be created.
  const configured = config.aiProviders.length > 0;
  return (
    <PageContainer
      title={t('page.aiModels')}
      description={t('ai.description')}
      actions={
        can(codes.add) && (
          <Button variant="primary" icon={<Plus />} disabled={!configured} onClick={() => setEditing('new')}>
            {t('ai.create')}
          </Button>
        )
      }
    >
      {!configured && <Notice tone="warning" title={t('ai.providersRequired')} />}
      <ResourceTable<AIModelRow>
        ref={table}
        label={t('page.aiModels')}
        load={async ({ page, pageSize, filters, signal }) =>
          assertPage<AIModelRow>(await api.get(path, { current: page, pageSize, ...filters }, { signal }))
        }
        rowKey={(row) => row.id}
        filters={[
          { name: 'provider', label: t('ai.provider'), type: 'select', options: config.aiProviders.map((value) => ({ value, label: value })) },
          {
            name: 'isEnabled',
            label: t('ai.enabled'),
            type: 'select',
            options: [
              { value: 'true', label: t('common.yes') },
              { value: 'false', label: t('common.no') },
            ],
          },
        ]}
        columns={[
          {
            key: 'name',
            title: t('ai.name'),
            render: (row) => (
              <span className="flex flex-wrap items-center gap-1">
                <span className="font-medium">{row.name}</span>
                {row.isDefault && <StatusBadge tone="info">{t('ai.default')}</StatusBadge>}
              </span>
            ),
          },
          { key: 'provider', title: t('ai.provider'), field: 'provider' },
          { key: 'modelId', title: t('ai.modelId'), field: 'modelId' },
          { key: 'apiKey', title: t('ai.apiKey'), render: (row) => <code className="text-xs">{revealed[row.id] ?? row.apiKey ?? '—'}</code>, hideOnMobile: true },
          {
            key: 'enabled',
            title: t('ai.enabled'),
            render: (row) => <StatusBadge tone={row.isEnabled ? 'success' : 'neutral'}>{row.isEnabled ? t('common.enabled') : t('common.disabled')}</StatusBadge>,
          },
          { key: 'updatedAt', title: t('common.updatedAt'), render: (row) => formatDateTime(row.updatedAt, locale), hideOnMobile: true },
        ]}
        actions={(row) => (
          <>
            {can(codes.update) && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>
                {t('common.edit')}
              </Button>
            )}
            {can(codes.update) && !row.isDefault && (
              <ConfirmButton
                size="sm"
                variant="ghost"
                title={t('ai.setDefault')}
                description={row.name}
                onConfirm={async () => {
                  try {
                    await api.post(`${path}/${enc(row.id)}/set-default`, {});
                    toast.success(t('ai.defaultSet'));
                    reload();
                  } catch (error) {
                    toast.error(t('common.saveFailed'));
                    throw error;
                  }
                }}
              >
                {t('ai.setDefault')}
              </ConfirmButton>
            )}
            {can(codes.readSecret) && !revealed[row.id] && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    const full = await api.get<AIModelRow>(`${path}/${enc(row.id)}/full`);
                    if (typeof full?.apiKey === 'string') setRevealed((previous) => ({ ...previous, [row.id]: full.apiKey as string }));
                  } catch {
                    toast.error(t('ai.revealFailed'));
                  }
                }}
              >
                {t('ai.revealKey')}
              </Button>
            )}
            {can(codes.query) && (
              <ConfirmButton
                size="sm"
                variant="ghost"
                title={t('ai.test')}
                description={t('ai.testNotice')}
                onConfirm={async () => {
                  try {
                    const result = await api.post<{ success?: boolean; message?: string }>(`${path}/${enc(row.id)}/test`, {});
                    if (result?.success) toast.success(t('ai.testResult', { message: result.message ?? 'OK' }));
                    else toast.error(t('ai.testResult', { message: result?.message ?? t('ai.testFailed') }));
                  } catch {
                    toast.error(t('ai.testFailed'));
                  }
                }}
              >
                {t('ai.test')}
              </ConfirmButton>
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
        title={record ? t('ai.edit') : t('ai.create')}
        columns={2}
        initialValues={{
          name: record?.name ?? '',
          provider: record?.provider ?? config.aiProviders[0] ?? '',
          modelId: record?.modelId ?? '',
          apiKey: '',
          baseUrl: record?.baseUrl ?? '',
          temperature: record?.temperature == null ? '' : String(record.temperature),
          maxTokens: record?.maxTokens == null ? '' : String(record.maxTokens),
          description: record?.description ?? '',
          isEnabled: record ? record.isEnabled === true : true,
        }}
        fields={[
          { name: 'name', label: t('ai.name'), required: true, maxLength: 100 },
          {
            name: 'provider',
            label: t('ai.provider'),
            type: 'select',
            required: true,
            options: [...new Set([...config.aiProviders, ...(record?.provider ? [record.provider] : [])])].map((value) => ({ value, label: value })),
          },
          { name: 'modelId', label: t('ai.modelId'), required: true, maxLength: 200 },
          {
            name: 'apiKey',
            label: t('ai.apiKey'),
            type: 'password',
            required: !record,
            description: record ? t('ai.apiKeyKeep') : undefined,
            autoComplete: 'new-password',
          },
          { name: 'baseUrl', label: t('ai.baseUrl'), maxLength: 500 },
          { name: 'temperature', label: t('ai.temperature'), type: 'number', min: 0, max: 2 },
          { name: 'maxTokens', label: t('ai.maxTokens'), type: 'integer', min: 1 },
          { name: 'isEnabled', label: t('ai.enabled'), type: 'switch' },
          { name: 'description', label: t('common.description'), type: 'textarea', wide: true },
        ]}
        onSubmit={async (values) => {
          const body: Record<string, unknown> = {
            name: String(values.name).trim(),
            provider: values.provider,
            modelId: String(values.modelId).trim(),
            baseUrl: String(values.baseUrl ?? '').trim() || null,
            description: String(values.description ?? ''),
            isEnabled: values.isEnabled === true,
          };
          if (values.temperature !== '' && values.temperature != null) body.temperature = Number(values.temperature);
          if (values.maxTokens !== '' && values.maxTokens != null) body.maxTokens = Number(values.maxTokens);
          // An empty key on edit keeps the stored secret; it is never echoed back into the form.
          if (typeof values.apiKey === 'string' && values.apiKey) body.apiKey = values.apiKey;
          if (record) await api.put(`${path}/${enc(record.id)}`, body);
          else await api.post(path, body);
          toast.success(t('common.saved'));
          reload();
        }}
      />
    </PageContainer>
  );
}
