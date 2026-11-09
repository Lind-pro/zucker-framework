import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/button';
import { ConfirmButton, Dialog } from '../components/dialog';
import { ErrorState, LoadingState, StatusBadge, toast } from '../components/feedback';
import { FormDialog, type FieldSpec, type FormErrors } from '../components/form';
import { Select } from '../components/inputs';
import { PageContainer } from '../components/layout';
import { DataTable, ResourceTable } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck, useResource } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import { formatDateTime } from '../lib/format';
import type { MailLogRow } from '@zucker-framework/fe-types/back-office';
import { DeleteAction, enc, pageLoader } from './shared';

interface MailTemplateRow extends Record<string, unknown> {
  id: string | null;
  key: string;
  name: string;
  description?: string | null;
  subject?: string | null;
  variables?: string[] | null;
  isActive?: boolean;
  isBuiltIn?: boolean;
  updatedAt?: string | null;
}

/**
 * Blocks every network fetch from the previewed markup (remote images, tracking pixels, fonts,
 * stylesheets); inline styles and embedded data images still render. A CSP `<meta>` in the head
 * applies to the whole srcdoc document.
 */
export const MAIL_PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
export function previewDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_PREVIEW_CSP}"></head><body>${html}</body></html>`;
}

/** Rendered email in an isolated, script-less frame that cannot load remote resources. */
function HtmlPreview({ html, title }: { html: string; title: string }) {
  return <iframe title={title} sandbox="" srcDoc={previewDocument(html)} className="h-[60dvh] w-full rounded-lg border bg-white" />;
}

function PreviewDialog({ row, onClose }: { row: MailTemplateRow; onClose: () => void }) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t } = useAdminI18n();
  const [locale, setLocale] = useState(config.mailPreviewLocales[0] ?? 'zh');
  const preview = useResource(
    async (signal) => {
      const result = await api.post<{ html?: unknown }>(`${config.endpoints.emailTemplates}/${enc(String(row.id))}/preview`, { locale }, { signal });
      if (typeof result?.html !== 'string') throw new Error('Unexpected preview');
      return result.html;
    },
    [row.id, locale],
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} width={860} title={t('email.previewTitle')} description={`${row.name} · ${row.key}`}>
      <div className="space-y-3">
        {config.mailPreviewLocales.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            {t('email.previewLocale')}
            <Select
              className="w-auto"
              value={locale}
              options={config.mailPreviewLocales.map((value) => ({ value, label: value }))}
              onChange={(event) => setLocale(event.target.value)}
            />
          </label>
        )}
        {preview.error ? (
          <ErrorState message={t('email.previewFailed')} onRetry={preview.reload} />
        ) : preview.loading || preview.data === undefined ? (
          <LoadingState />
        ) : (
          <HtmlPreview html={preview.data} title={t('email.previewTitle')} />
        )}
      </div>
    </Dialog>
  );
}

/** Mail templates over `createMailTemplateAdminController` (RFC §8.5). */
export function EmailTemplatesPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const can = usePermissionCheck();
  const canWrite = can(config.permissions.mail.update);
  const path = config.endpoints.emailTemplates;
  const contentFields = Object.entries(config.mailContentFields);
  const templates = useResource(async (signal) => {
    const rows = await api.get<unknown>(path, undefined, { signal });
    if (!Array.isArray(rows)) throw new Error('Unexpected template list');
    return rows as MailTemplateRow[];
  }, []);
  const [editing, setEditing] = useState<MailTemplateRow | 'new' | null>(null);
  const [previewing, setPreviewing] = useState<MailTemplateRow | null>(null);
  const [draftPreview, setDraftPreview] = useState<string | null>(null);
  const record = editing && editing !== 'new' ? editing : null;
  const fields: FieldSpec[] = [
    { name: 'key', label: t('email.key'), required: true, disabled: Boolean(record), maxLength: 64 },
    { name: 'name', label: t('email.name'), required: true, maxLength: 100 },
    { name: 'subject', label: t('email.subject'), maxLength: 200, wide: true },
    { name: 'description', label: t('common.description'), type: 'textarea', rows: 2, wide: true },
    ...contentFields.map(([language, field]) => ({
      name: field,
      label: t('email.content', { locale: language }),
      type: 'textarea' as const,
      rows: 10,
      wide: true,
      required: !record && language === contentFields[0]?.[0],
    })),
    ...(record ? [{ name: 'isActive', label: t('email.active'), type: 'switch' as const }] : []),
  ];
  return (
    <PageContainer
      title={t('page.emailTemplates')}
      description={t('email.templatesDescription')}
      actions={
        canWrite && (
          <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
            {t('email.create')}
          </Button>
        )
      }
    >
      <DataTable<MailTemplateRow>
        label={t('page.emailTemplates')}
        rows={templates.data ?? []}
        rowKey={(row) => row.id ?? `builtin:${row.key}`}
        loading={templates.loading}
        error={templates.error}
        onRetry={templates.reload}
        columns={[
          { key: 'name', title: t('email.name'), render: (row) => <span className="font-medium">{row.name}</span> },
          { key: 'key', title: t('email.key'), field: 'key' },
          { key: 'subject', title: t('email.subject'), field: 'subject', hideOnMobile: true },
          {
            key: 'kind',
            title: t('common.status'),
            render: (row) => (
              <span className="flex flex-wrap gap-1">
                <StatusBadge tone={row.isBuiltIn ? 'neutral' : 'info'}>{row.isBuiltIn ? t('email.builtIn') : t('email.custom')}</StatusBadge>
                {!row.isBuiltIn && (
                  <StatusBadge tone={row.isActive ? 'success' : 'neutral'}>{row.isActive ? t('common.enabled') : t('common.disabled')}</StatusBadge>
                )}
              </span>
            ),
          },
          { key: 'variables', title: t('email.variables'), render: (row) => row.variables?.join(', ') || '—', hideOnMobile: true },
          { key: 'updatedAt', title: t('common.updatedAt'), render: (row) => formatDateTime(row.updatedAt, locale), hideOnMobile: true },
        ]}
        actions={(row) =>
          row.id === null ? (
            canWrite && (
              <ConfirmButton
                size="sm"
                variant="ghost"
                title={t('email.seed')}
                description={`${row.name} · ${row.key}`}
                onConfirm={async () => {
                  try {
                    await api.post(`${path}/seed/${enc(row.key)}`, {});
                    toast.success(t('email.seeded'));
                    templates.reload();
                  } catch (error) {
                    toast.error(t('common.saveFailed'));
                    throw error;
                  }
                }}
              >
                {t('email.seed')}
              </ConfirmButton>
            )
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setPreviewing(row)}>
                {t('email.preview')}
              </Button>
              {canWrite && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>
                  {t('common.edit')}
                </Button>
              )}
              {canWrite && (
                <DeleteAction
                  onDelete={async () => {
                    await api.delete(`${path}/${enc(String(row.id))}`);
                    templates.reload();
                  }}
                />
              )}
            </>
          )
        }
      />
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={record ? t('email.edit') : t('email.create')}
        columns={2}
        width={900}
        initialValues={{
          key: record?.key ?? '',
          name: record?.name ?? '',
          subject: record?.subject ?? '',
          description: record?.description ?? '',
          isActive: record?.isActive !== false,
          ...Object.fromEntries(contentFields.map(([, field]) => [field, typeof record?.[field] === 'string' ? record[field] : ''])),
        } as Record<string, unknown>}
        fields={fields}
        validate={(values) => {
          const errors: FormErrors = {};
          if (!record && typeof values.key === 'string' && values.key && !/^[\w-]+$/.test(values.key.trim())) errors.key = t('email.error.key');
          return errors;
        }}
        onSubmit={async (values) => {
          const body: Record<string, unknown> = {
            name: String(values.name).trim(),
            subject: String(values.subject ?? ''),
            description: String(values.description ?? ''),
          };
          for (const [, field] of contentFields) body[field] = String(values[field] ?? '');
          if (record) await api.patch(`${path}/${enc(String(record.id))}`, { ...body, isActive: values.isActive === true });
          else await api.post(path, { key: String(values.key).trim(), ...body });
          toast.success(t('common.saved'));
          templates.reload();
        }}
      >
        {(form) => (
          <div className="flex flex-wrap items-center gap-2">
            {config.mailPreviewLocales.map((language) => (
              <Button
                key={language}
                size="sm"
                onClick={async () => {
                  try {
                    const draft: Record<string, unknown> = { locale: language };
                    for (const [, field] of contentFields) draft[field] = String(form.values[field] ?? '');
                    const result = await api.post<{ html?: unknown }>(`${path}/preview-html`, draft);
                    if (typeof result?.html !== 'string') throw new Error('Unexpected preview');
                    setDraftPreview(result.html);
                  } catch {
                    toast.error(t('email.previewFailed'));
                  }
                }}
              >
                {t('email.previewDraft')} · {language}
              </Button>
            ))}
          </div>
        )}
      </FormDialog>
      {previewing && <PreviewDialog row={previewing} onClose={() => setPreviewing(null)} />}
      {draftPreview !== null && (
        <Dialog open onOpenChange={(open) => !open && setDraftPreview(null)} width={860} title={t('email.previewDraft')}>
          <HtmlPreview html={draftPreview} title={t('email.previewDraft')} />
        </Dialog>
      )}
    </PageContainer>
  );
}

/** Delivery log (`GET /management/email-logs`, filters `to,status,template`). */
export function EmailLogsPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  return (
    <PageContainer title={t('page.emailLogs')} description={t('email.logsDescription')}>
      <ResourceTable<MailLogRow>
        label={t('page.emailLogs')}
        load={pageLoader(api, config.endpoints.emailLogs)}
        rowKey={(row) => row.id}
        filters={[
          { name: 'to', label: t('email.to') },
          { name: 'template', label: t('email.template') },
          {
            name: 'status',
            label: t('email.status'),
            type: 'select',
            options: [
              { value: 'success', label: 'success' },
              { value: 'failed', label: 'failed' },
            ],
          },
        ]}
        columns={[
          { key: 'recipient', title: t('email.to'), field: 'recipient' },
          { key: 'template', title: t('email.template'), field: 'template' },
          { key: 'subject', title: t('email.subject'), field: 'subject', hideOnMobile: true },
          {
            key: 'status',
            title: t('email.status'),
            render: (row) => <StatusBadge tone={row.status === 'success' ? 'success' : row.status === 'failed' ? 'danger' : 'neutral'}>{row.status ?? '—'}</StatusBadge>,
          },
          { key: 'errorMessage', title: t('email.error'), field: 'errorMessage', hideOnMobile: true },
          { key: 'createdAt', title: t('email.sentAt'), render: (row) => formatDateTime(row.createdAt, locale) },
        ]}
      />
    </PageContainer>
  );
}
