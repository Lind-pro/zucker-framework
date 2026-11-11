import { useState } from 'react';
import { Button } from '../components/button';
import { ConfirmDialog, Dialog } from '../components/dialog';
import { Notice, StatusBadge, toast, type Tone } from '../components/feedback';
import { Field, Input, Select } from '../components/inputs';
import { PageContainer } from '../components/layout';
import { DataTable } from '../components/data-table';
import { useAdmin, useAdminApi, usePermissionCheck, useResource } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import type { AdminMessageKey } from '../i18n/zh-CN';
import { errorStatus, formatDateTime } from '../lib/format';
import { enc } from './shared';

export interface ConnectionField {
  key: string;
  label: string;
  /** Stable translation key (`connections.field.<KEY>`); its description uses `<labelKey>.description`. */
  labelKey?: string;
  type: 'text' | 'secret' | 'boolean' | 'select' | 'number' | 'url';
  options?: string[];
  description?: string;
  min?: number;
  max?: number;
  configured: boolean;
  source: 'saved' | 'environment' | 'default' | 'cleared' | 'unset';
  value?: string | null;
  /** The server refuses changes to this field (e.g. it is pinned by the server environment). */
  readOnly?: boolean;
  /** The value comes from the server environment and cannot be saved here. */
  pinnedByEnvironment?: boolean;
}
export interface ConnectionProfile {
  id: string;
  name: string;
  /** Stable translation key of the name (`connections.<id>`). */
  labelKey?: string;
  category: string;
  /** Stable translation key of the category (`connections.category.<id>`). */
  categoryKey?: string;
  storedRevision: number;
  appliedRevision: number;
  pendingRestart: boolean;
  canSave: boolean;
  /** `encryption_key_required`, `environment_pinned` (every field pinned) or another server reason. */
  saveUnavailableReason: string | null;
  /** Keys of the fields pinned by the server environment (older servers omit it). */
  pinnedFields?: string[];
  /**
   * `hot`: a save applies without a restart; `restart`: it applies on the next server start.
   * Older servers omit it and every profile then applies after a restart.
   */
  applyMode?: ConnectionApplyMode;
  /** Encrypted saved revisions the server keeps (older servers omit it); the revisions themselves are never sent. */
  retainedRevisions?: number;
  fields: ConnectionField[];
}
export type ConnectionApplyMode = 'hot' | 'restart';
interface Connection {
  id: string;
  name: string;
  labelKey?: string;
  category: string;
  categoryKey?: string;
  source: string;
  status: string;
  enabled: boolean | null;
  missing: string[];
  sdkAvailable: boolean | null;
  mode?: string;
  note: string;
  configuredOfferCount?: number;
  registeredProviderIds?: string[];
  configurationSourceIds?: string[];
  storedRevision?: number;
  appliedRevision?: number;
  pendingRestart?: boolean;
  applyMode?: ConnectionApplyMode;
  /** A saved revision of a hot profile could not be assembled; the previous revision keeps serving. */
  applyError?: { revision: number; reason: string };
}

/** 409 code of a storage location change that needs explicit acknowledgement (D14). */
const DATA_LOCATION_CHANGE_CODE = 'DATA_LOCATION_CHANGE_UNACKNOWLEDGED';
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

/** Hot profiles never wait for a restart, whatever `pendingRestart` says. */
const isHot = (profile: { applyMode?: string } | undefined) => profile?.applyMode === 'hot';
/** A field the operator cannot change here (pinned by the server environment or marked read-only). */
const isLocked = (profile: ConnectionProfile, field: ConnectionField) =>
  field.readOnly === true || field.pinnedByEnvironment === true || (profile.pinnedFields?.includes(field.key) ?? false);

type Action = 'keep' | 'replace' | 'clear';
const KNOWN_STATES = ['configured', 'disabled', 'missing', 'invalid', 'missing-sdk', 'managed-elsewhere', 'not-registered'];
const KNOWN_SOURCES = ['server-environment', 'web-environment', 'runtime-registration', 'runtime-snapshot'];

/**
 * Descriptor-driven editor. Each field keeps its value and source unless explicitly replaced or
 * cleared; secrets are never echoed. Saves are revision-guarded (409 keeps non-secret drafts).
 */
function ConnectionEditor({
  profile: initial,
  writable,
  onClose,
  onSaved,
}: {
  profile: ConnectionProfile;
  writable: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, serverLabel } = useAdminI18n();
  const [profile, setProfile] = useState(initial);
  const [actions, setActions] = useState<Record<string, Action>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [failed, setFailed] = useState(false);
  // D14: the server refused a storage location change until it is acknowledged; nothing was saved.
  const [locationChange, setLocationChange] = useState(false);
  const editable = writable && profile.canSave;
  const changed = Object.values(actions).some((action) => action !== 'keep');
  const path = `${config.endpoints.connectionSettings}/${enc(profile.id)}`;
  const sourceLabel = (source: ConnectionField['source']) => t(`connections.fieldSource.${source}` as AdminMessageKey);
  function validate(): boolean {
    const next: Record<string, string> = {};
    for (const field of profile.fields) {
      if (actions[field.key] !== 'replace') continue;
      const value = values[field.key] ?? '';
      if (!value.trim()) next[field.key] = t('connections.newValueRequired');
      else if (field.type === 'number') {
        const number = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < (field.min ?? 1) || number > (field.max ?? Number.MAX_SAFE_INTEGER))
          next[field.key] = t('connections.integerRange');
      }
    }
    setErrors(next);
    return !Object.keys(next).length;
  }
  async function save(acknowledgeDataLocationChange = false) {
    if (!validate()) return;
    const plain: Record<string, string | null> = {};
    const secrets: Record<string, { action: 'clear' } | { action: 'replace'; value: string }> = {};
    for (const field of profile.fields) {
      const action = actions[field.key];
      if (!action || action === 'keep' || isLocked(profile, field)) continue;
      if (field.type === 'secret')
        secrets[field.key] = action === 'clear' ? { action: 'clear' } : { action: 'replace', value: values[field.key] ?? '' };
      else plain[field.key] = action === 'clear' ? null : (values[field.key] ?? '');
    }
    setSaving(true);
    setFailed(false);
    try {
      const saved = await api.put<ConnectionProfile>(path, {
        expectedRevision: profile.storedRevision,
        values: plain,
        secrets,
        ...(acknowledgeDataLocationChange ? { acknowledgeDataLocationChange: true } : {}),
      });
      toast.success(
        isHot(saved ?? profile) ? t('connections.savedApplied') : saved?.pendingRestart ? t('connections.savedPending') : t('connections.savedUnchanged'),
      );
      onSaved();
    } catch (error) {
      if (errorStatus(error) === 409 && errorCode(error) === DATA_LOCATION_CHANGE_CODE && !acknowledgeDataLocationChange) {
        // Keep every draft (secrets included): only the acknowledgement is missing.
        setLocationChange(true);
      } else if (errorStatus(error) === 409) {
        // Drop secret edits; keep non-secret drafts for review against the newer revision.
        const secretKeys = new Set(profile.fields.filter((field) => field.type === 'secret').map((field) => field.key));
        setActions((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => !secretKeys.has(key))));
        setValues((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => !secretKeys.has(key))));
        setConflict(true);
      } else setFailed(true);
    } finally {
      setSaving(false);
    }
  }
  async function reload() {
    setSaving(true);
    try {
      setProfile(await api.get<ConnectionProfile>(path));
      setConflict(false);
      setFailed(false);
      toast.info(t('connections.reloaded'));
    } catch {
      toast.error(t('connections.reloadFailed'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      busy={saving}
      width={760}
      title={t('connections.editorTitle', { action: editable ? t('common.edit') : t('common.view'), name: serverLabel(profile.name, profile.labelKey ?? `connections.${profile.id}`) })}
      footer={
        <>
          <Button disabled={saving} onClick={onClose}>
            {editable ? t('common.cancel') : t('common.close')}
          </Button>
          {conflict ? (
            <Button variant="primary" loading={saving} onClick={() => void reload()}>
              {t('connections.reload')}
            </Button>
          ) : (
            editable && (
              <Button variant="primary" loading={saving} disabled={!changed} onClick={() => void save()}>
                {t('connections.saveEncrypted')}
              </Button>
            )
          )}
        </>
      }
    >
      <ConfirmDialog
        open={locationChange}
        onOpenChange={setLocationChange}
        destructive
        title={t('connections.locationChangeTitle')}
        description={t('connections.locationChangeDescription')}
        confirmText={t('connections.locationChangeConfirm')}
        onConfirm={() => save(true)}
      />
      <div className="space-y-4">
        <Notice tone="info" title={t('connections.revisionNotice', { stored: profile.storedRevision, applied: profile.appliedRevision })}>
          {isHot(profile) ? t('connections.revisionNoticeDescriptionHot') : t('connections.revisionNoticeDescription')}
        </Notice>
        {isHot(profile) && profile.id.startsWith('payment-') && (
          <Notice tone="info" title={t('connections.paymentHotNotice')}>
            {typeof profile.retainedRevisions === 'number' ? t('connections.retainedRevisions', { count: profile.retainedRevisions }) : null}
          </Notice>
        )}
        {!profile.canSave && profile.saveUnavailableReason === 'environment_pinned' ? (
          <Notice tone="info" title={t('connections.allPinned')}>
            {t('connections.allPinnedDescription')}
          </Notice>
        ) : (
          !profile.canSave && (
            <Notice tone="warning" title={t('connections.noKey')}>
              {t('connections.noKeyDescription')}
            </Notice>
          )
        )}
        {!writable && <Notice tone="info" title={t('connections.readOnly')} />}
        {conflict && (
          <Notice tone="warning" title={t('connections.conflict')}>
            {t('connections.conflictDescription')}
          </Notice>
        )}
        {failed && (
          <Notice tone="danger" title={t('connections.unconfirmed')}>
            {t('connections.unconfirmedDescription')}
          </Notice>
        )}
        <ul className="divide-y">
          {profile.fields.map((field) => {
            const action = actions[field.key] ?? 'keep';
            const label = serverLabel(field.label, field.labelKey);
            const locked = isLocked(profile, field);
            return (
              <li key={field.key} className="space-y-2 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{label}</span>
                  <StatusBadge>{sourceLabel(field.source)}</StatusBadge>
                  {locked && <StatusBadge tone="info">{t('connections.pinned')}</StatusBadge>}
                </div>
                <p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
                  {field.type === 'secret'
                    ? field.configured
                      ? t('connections.secretConfigured')
                      : t('connections.secretUnset')
                    : (field.value ?? t('common.notSet'))}
                  {field.description && <span className="mt-1 block">{serverLabel(field.description, field.labelKey && `${field.labelKey}.description`)}</span>}
                </p>
                {locked && editable && <p className="text-xs text-muted-foreground">{t('connections.pinnedDescription')}</p>}
                {editable && !locked && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('connections.action', { label })}>
                      {({ id }) => (
                        <Select
                          id={id}
                          disabled={saving || conflict}
                          value={action}
                          options={[
                            { value: 'keep', label: t('connections.action.keep') },
                            { value: 'replace', label: field.type === 'secret' ? t('connections.action.replaceSecret') : t('connections.action.replace') },
                            { value: 'clear', label: t('connections.action.clear') },
                          ]}
                          onChange={(event) => {
                            const next = event.target.value as Action;
                            setActions((previous) => ({ ...previous, [field.key]: next }));
                            setValues((previous) => ({
                              ...previous,
                              [field.key]: next === 'replace' && field.type !== 'secret' ? (field.value ?? '') : '',
                            }));
                            setErrors((previous) => ({ ...previous, [field.key]: '' }));
                          }}
                        />
                      )}
                    </Field>
                    {action === 'replace' && (
                      <Field label={t('connections.newValue', { label })} error={errors[field.key] || undefined} required>
                        {({ id, describedBy, invalid }) =>
                          field.type === 'boolean' || field.type === 'select' ? (
                            <Select
                              id={id}
                              aria-describedby={describedBy}
                              aria-invalid={invalid || undefined}
                              disabled={saving || conflict}
                              value={values[field.key] ?? ''}
                              placeholder=""
                              options={
                                field.type === 'boolean'
                                  ? [
                                      { value: 'true', label: t('connections.true') },
                                      { value: 'false', label: t('connections.false') },
                                    ]
                                  : (field.options ?? []).map((value) => ({ value, label: value }))
                              }
                              onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))}
                            />
                          ) : (
                            <Input
                              id={id}
                              type={field.type === 'secret' ? 'password' : 'text'}
                              autoComplete={field.type === 'secret' ? 'new-password' : 'off'}
                              inputMode={field.type === 'number' ? 'numeric' : undefined}
                              maxLength={field.type === 'secret' ? 16384 : 2048}
                              aria-describedby={describedBy}
                              aria-invalid={invalid || undefined}
                              disabled={saving || conflict}
                              value={values[field.key] ?? ''}
                              onChange={(event) => setValues((previous) => ({ ...previous, [field.key]: event.target.value }))}
                            />
                          )
                        }
                      </Field>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Dialog>
  );
}

const statusTone = (status: string): Tone =>
  status === 'configured' ? 'success' : ['missing', 'invalid', 'missing-sdk'].includes(status) ? 'warning' : 'neutral';

/** Runtime connection status and encrypted connection settings (`/management/connections`, `/management/connection-settings`). */
export function ConnectionsPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale, serverLabel } = useAdminI18n();
  const listSeparator = locale.startsWith('zh') ? '、' : ', ';
  const can = usePermissionCheck();
  const writable = can(config.permissions.config.update);
  const status = useResource(
    (signal) => api.get<{ connections: Connection[]; checkedAt: string }>(config.endpoints.connections, undefined, { signal }),
    [],
  );
  const settings = useResource(
    (signal) => api.get<{ profiles: ConnectionProfile[] }>(config.endpoints.connectionSettings, undefined, { signal }),
    [],
  );
  const [selected, setSelected] = useState<ConnectionProfile | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const profiles = settings.data?.profiles ?? [];
  const connections = status.data?.connections ?? [];
  const rows: Connection[] = [
    ...connections,
    ...profiles
      .filter((profile) => !connections.some((row) => row.id === profile.id))
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        labelKey: profile.labelKey,
        category: profile.category,
        categoryKey: profile.categoryKey,
        source: 'runtime-snapshot',
        status: 'unknown',
        enabled: null,
        missing: [],
        sdkAvailable: null,
        note: t('connections.unreadable'),
      })),
  ];
  // Status rows (`/management/connections`) may omit keys that the settings profile carries.
  const profileOf = (row: Connection) => profiles.find((profile) => profile.id === row.id);
  const refresh = () => {
    status.reload();
    settings.reload();
  };
  async function open(id: string) {
    setOpening(id);
    try {
      setSelected(await api.get<ConnectionProfile>(`${config.endpoints.connectionSettings}/${enc(id)}`));
      setOpenFailed(false);
    } catch {
      setOpenFailed(true);
    } finally {
      setOpening(null);
    }
  }
  return (
    <PageContainer title={t('page.connections')} actions={<Button onClick={refresh}>{t('common.refresh')}</Button>}>
      <Notice tone="info" title={t('connections.notice')}>
        {profiles.some((profile) => profile.applyMode) ? t('connections.noticeDescriptionPerProfile') : t('connections.noticeDescription')}
      </Notice>
      {status.error && (
        <Notice tone="danger" title={t('connections.statusFailed')}>
          {t('connections.statusFailedDescription')}
        </Notice>
      )}
      {(settings.error || openFailed) && (
        <Notice tone="danger" title={t('connections.settingsFailed')}>
          {t('connections.settingsFailedDescription')}
        </Notice>
      )}
      {status.data?.checkedAt && (
        <p className="text-sm text-muted-foreground">{t('connections.readAt', { time: formatDateTime(status.data.checkedAt, locale) })}</p>
      )}
      <DataTable<Connection>
        label={t('page.connections')}
        rows={rows}
        rowKey={(row) => row.id}
        loading={status.loading || settings.loading}
        minWidth={1000}
        columns={[
          { key: 'name', title: t('connections.name'), render: (row) => <span className="font-medium">{serverLabel(row.name, row.labelKey ?? profileOf(row)?.labelKey ?? `connections.${row.id}`)}</span> },
          { key: 'category', title: t('connections.category'), render: (row) => serverLabel(row.category, row.categoryKey ?? profileOf(row)?.categoryKey) },
          {
            key: 'status',
            title: t('connections.status'),
            render: (row) => (
              <StatusBadge tone={statusTone(row.status)}>
                {KNOWN_STATES.includes(row.status) ? t(`connections.state.${row.status}` as AdminMessageKey) : t('common.unknown')}
              </StatusBadge>
            ),
          },
          {
            key: 'source',
            title: t('connections.source'),
            hideOnMobile: true,
            render: (row) => (KNOWN_SOURCES.includes(row.source) ? t(`connections.source.${row.source}` as AdminMessageKey) : row.source),
          },
          {
            key: 'revision',
            title: t('connections.revision'),
            render: (row) => {
              const current = profiles.find((profile) => profile.id === row.id) ?? row;
              const applyMode = current.applyMode ?? row.applyMode;
              const modeBadge =
                applyMode === 'hot' || applyMode === 'restart' ? (
                  <StatusBadge tone={applyMode === 'hot' ? 'success' : 'neutral'}>{t(`connections.applyMode.${applyMode}`)}</StatusBadge>
                ) : null;
              return current.appliedRevision === undefined ? (
                (modeBadge ?? '—')
              ) : (
                <span className="flex flex-col gap-1">
                  {t('connections.revisionValue', { applied: current.appliedRevision, stored: current.storedRevision ?? 0 })}
                  {modeBadge}
                  {current.pendingRestart && !isHot({ applyMode }) && <StatusBadge tone="warning">{t('connections.pendingRestart')}</StatusBadge>}
                  {row.applyError && (
                    <StatusBadge tone="danger">{t('connections.applyError', { revision: row.applyError.revision })}</StatusBadge>
                  )}
                </span>
              );
            },
          },
          {
            key: 'summary',
            title: t('connections.summary'),
            hideOnMobile: true,
            render: (row) => (
              <span className="flex flex-col gap-1 text-sm">
                {row.mode && <span>{t('connections.mode', { value: row.mode })}</span>}
                {row.configuredOfferCount !== undefined && <span>{t('connections.offers', { value: row.configuredOfferCount })}</span>}
                {row.sdkAvailable !== null && (
                  <span>{t('connections.sdk', { value: row.sdkAvailable ? t('connections.sdkAvailable') : t('connections.sdkMissing') })}</span>
                )}
                {row.missing.length > 0 && (
                  <span className="flex flex-wrap items-center gap-1">
                    {t('connections.missing')}
                    {row.missing.map((key) => (
                      <StatusBadge key={key}>{key}</StatusBadge>
                    ))}
                  </span>
                )}
                {row.registeredProviderIds && (
                  <span>{t('connections.registered', { value: row.registeredProviderIds.join(listSeparator) || t('common.none') })}</span>
                )}
                {row.configurationSourceIds && (
                  <span>{t('connections.sources', { value: row.configurationSourceIds.join(listSeparator) || t('common.none') })}</span>
                )}
                <span className="text-muted-foreground">{serverLabel(row.note)}</span>
              </span>
            ),
          },
        ]}
        actions={(row) => {
          const profile = profiles.find((candidate) => candidate.id === row.id);
          return profile ? (
            <Button
              size="sm"
              variant="ghost"
              loading={opening === row.id}
              disabled={opening !== null && opening !== row.id}
              onClick={() => void open(row.id)}
            >
              {writable && profile.canSave ? t('connections.editProfile') : t('connections.viewProfile')}
            </Button>
          ) : null;
        }}
      />
      {selected && (
        <ConnectionEditor
          key={`${selected.id}:${selected.storedRevision}`}
          profile={selected}
          writable={writable}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            refresh();
          }}
        />
      )}
    </PageContainer>
  );
}
