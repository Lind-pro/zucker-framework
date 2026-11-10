import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Notice,
  PageContainer,
  Panel,
  Select,
  StatusBadge,
  Switch,
  Textarea,
  errorStatus,
  toast,
  useAdminApi,
  useAdminI18n,
  usePermissionCheck,
  useResource,
} from '@zucker-framework/fe-admin';
import { useState, type ReactNode } from 'react';
import { useText } from '../text';

/** Field types the server's `definePolicy` accepts; policies never carry secrets. */
type PolicyFieldType = 'boolean' | 'number' | 'text' | 'select' | 'json';
const FIELD_TYPES: readonly string[] = ['boolean', 'number', 'text', 'select', 'json'];

export interface PolicyField {
  key: string;
  type: string;
  label?: string;
  description?: string;
  default?: unknown;
  /** Effective value (env pin > saved > default); may instead come from `PolicyView.values`. */
  value?: unknown;
  public?: boolean;
  min?: number;
  max?: number;
  options?: ReadonlyArray<string | { value: string; label?: string }>;
  /** `POLICY_<ID>_<KEY>` overrides the stored value; the field is read-only here. */
  pinnedByEnvironment?: boolean;
}
export interface PolicyView {
  id: string;
  name?: string;
  label?: string;
  description?: string;
  revision?: number;
  values?: Record<string, unknown>;
  fields: PolicyField[];
}

const POLICIES = '/management/policies';
const policyPath = (id: string) => `${POLICIES}/${encodeURIComponent(id)}`;

function currentValue(policy: PolicyView, field: PolicyField): unknown {
  if (field.value !== undefined) return field.value;
  if (policy.values && Object.prototype.hasOwnProperty.call(policy.values, field.key)) return policy.values[field.key];
  return field.default;
}

/** Draft text per field; booleans use 'true'/'false', JSON is pretty-printed. */
function toDraft(type: string, value: unknown): string {
  if (value === undefined || value === null) return type === 'boolean' ? 'false' : '';
  if (type === 'json') return JSON.stringify(value, null, 2);
  return String(value);
}

function draftsOf(policy: PolicyView): Record<string, string> {
  return Object.fromEntries(policy.fields.map((field) => [field.key, toDraft(field.type, currentValue(policy, field))]));
}

function optionsOf(field: PolicyField) {
  return (field.options ?? []).map((option) => (typeof option === 'string' ? { value: option, label: option } : { value: option.value, label: option.label ?? option.value }));
}

/** One policy form. Saves are revision-guarded; a 409 keeps the draft and offers a reload. */
function PolicyEditor({ initial, writable }: { initial: PolicyView; writable: boolean }) {
  const api = useAdminApi();
  const tx = useText();
  const { serverLabel } = useAdminI18n();
  const [policy, setPolicy] = useState(initial);
  const [drafts, setDrafts] = useState(() => draftsOf(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const editableFields = policy.fields.filter((field) => FIELD_TYPES.includes(field.type) && !field.pinnedByEnvironment);
  const original = draftsOf(policy);
  const changed = editableFields.some((field) => drafts[field.key] !== original[field.key]);
  const canEdit = writable && editableFields.length > 0;

  function parse(): Record<string, unknown> | null {
    const values: Record<string, unknown> = {};
    const next: Record<string, string> = {};
    for (const field of editableFields) {
      const raw = drafts[field.key] ?? '';
      const type = field.type as PolicyFieldType;
      if (type === 'boolean') values[field.key] = raw === 'true';
      else if (type === 'number') {
        const number = Number(raw);
        if (!raw.trim() || !Number.isFinite(number)) next[field.key] = tx('请输入数字', 'Enter a number');
        else if ((field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max))
          next[field.key] = tx(`取值范围 ${field.min ?? '−∞'}–${field.max ?? '∞'}`, `Allowed range ${field.min ?? '−∞'}–${field.max ?? '∞'}`);
        else values[field.key] = number;
      } else if (type === 'json') {
        try {
          values[field.key] = raw.trim() ? JSON.parse(raw) : null;
        } catch {
          next[field.key] = tx('JSON 格式无效', 'Invalid JSON');
        }
      } else values[field.key] = raw;
    }
    setErrors(next);
    return Object.keys(next).length ? null : values;
  }

  /**
   * Revision-guarded PUT of `values` (a partial update is allowed; `null` removes the saved value so the
   * declared default applies). `keepOtherDrafts` limits the form refresh to the written keys.
   */
  async function write(values: Record<string, unknown>, success: string, keepOtherDrafts = false) {
    setSaving(true);
    try {
      // Pinned fields are never sent: the environment value wins and the server rejects writing it.
      const saved = await api.put<PolicyView>(policyPath(policy.id), { expectedRevision: policy.revision ?? 0, values });
      const next = saved && Array.isArray(saved.fields) ? saved : await api.get<PolicyView>(policyPath(policy.id));
      const nextDrafts = draftsOf(next);
      setPolicy(next);
      setDrafts((previous) =>
        keepOtherDrafts ? { ...previous, ...Object.fromEntries(Object.keys(values).map((key) => [key, nextDrafts[key] ?? ''])) } : nextDrafts,
      );
      if (!keepOtherDrafts) setErrors({});
      toast.success(success);
    } catch (error) {
      if (errorStatus(error) === 409) setConflict(true);
      else toast.error(tx('保存失败，请检查取值或权限。', 'Save failed; check the values or your access.'));
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const values = parse();
    if (values) await write(values, tx('策略已保存，立即生效', 'Policy saved; it applies immediately'));
  }

  async function resetField(field: PolicyField) {
    setErrors(({ [field.key]: _dropped, ...rest }) => rest);
    await write({ [field.key]: null }, tx('已恢复默认值，立即生效', 'Default restored; it applies immediately'), true);
  }

  async function reload() {
    setSaving(true);
    try {
      const fresh = await api.get<PolicyView>(policyPath(policy.id));
      setPolicy(fresh);
      setDrafts(draftsOf(fresh));
      setErrors({});
      setConflict(false);
      toast.info(tx('已读取最新版本', 'Latest revision loaded'));
    } catch {
      toast.error(tx('最新策略读取失败，请重试', 'Could not load the latest policy; retry'));
    } finally {
      setSaving(false);
    }
  }

  const title = serverLabel(policy.name ?? policy.label ?? policy.id);
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          {title}
          <StatusBadge>{tx(`版本 ${policy.revision ?? 0}`, `Revision ${policy.revision ?? 0}`)}</StatusBadge>
        </span>
      }
    >
      <form
        className="max-w-3xl space-y-4"
        aria-label={title}
        // Range/format errors are reported by parse(); native min/max validation would block submit silently.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {policy.description && <p className="text-sm text-muted-foreground">{serverLabel(policy.description)}</p>}
        {conflict && (
          <Notice tone="warning" title={tx('策略已被其他人修改', 'This policy was changed elsewhere')}>
            {tx('请重新读取最新版本后再修改；当前草稿不会被保存。', 'Reload the latest revision before editing again; this draft was not saved.')}
          </Notice>
        )}
        {policy.fields.map((field) => {
          const label = serverLabel(field.label ?? field.key);
          const pinned = field.pinnedByEnvironment === true;
          const disabled = !writable || pinned || saving || conflict;
          const value = drafts[field.key] ?? '';
          const set = (next: string) => setDrafts((previous) => ({ ...previous, [field.key]: next }));
          const known = FIELD_TYPES.includes(field.type);
          const atDefault = JSON.stringify(currentValue(policy, field) ?? null) === JSON.stringify(field.default ?? null);
          // Badges and the reset action sit outside <label> so the control's accessible name is the label alone.
          const meta =
            pinned || field.public || (known && writable) ? (
              <div className="flex flex-wrap items-center gap-2">
                {pinned && <StatusBadge tone="warning">{tx('环境变量锁定', 'Pinned by environment')}</StatusBadge>}
                {field.public && <StatusBadge>{tx('公开', 'Public')}</StatusBadge>}
                {known && writable && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={tx(`将 ${label} 恢复默认值`, `Reset ${label} to default`)}
                    title={pinned ? tx('环境变量锁定的字段无法重置', 'Fields pinned by the environment cannot be reset') : undefined}
                    disabled={disabled || atDefault}
                    onClick={() => void resetField(field)}
                  >
                    {tx('恢复默认', 'Reset to default')}
                  </Button>
                )}
              </div>
            ) : null;
          const row = (control: ReactNode) => (
            <div key={field.key} className="space-y-1.5">
              {control}
              {meta}
            </div>
          );
          const description =
            field.description || pinned ? (
              <>
                {field.description && <span className="block">{serverLabel(field.description)}</span>}
                {pinned && <span className="block">{tx('该值由服务器环境变量设置，此处只读。', 'Set by a server environment variable; read-only here.')}</span>}
              </>
            ) : undefined;
          if (!known)
            // Unknown types (never secrets by contract) are listed without their value.
            return row(
              <Field label={label} description={tx('此字段类型不支持在此编辑。', 'This field type cannot be edited here.')}>
                {({ id }) => <Input id={id} disabled value="" readOnly />}
              </Field>
            );
          if (field.type === 'boolean')
            return row(
              <Field inline label={label} description={description}>
                {({ id, describedBy }) => (
                  <Switch id={id} aria-describedby={describedBy} disabled={disabled} checked={value === 'true'} onCheckedChange={(checked) => set(String(checked))} />
                )}
              </Field>
            );
          return row(
            <Field label={label} description={description} error={errors[field.key] || undefined}>
              {({ id, describedBy, invalid }) =>
                field.type === 'select' ? (
                  <Select id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} disabled={disabled} value={value} options={optionsOf(field)} onChange={(event) => set(event.target.value)} />
                ) : field.type === 'json' ? (
                  <Textarea
                    id={id}
                    rows={6}
                    className="font-mono text-xs"
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    disabled={disabled}
                    value={value}
                    onChange={(event) => set(event.target.value)}
                  />
                ) : (
                  <Input
                    id={id}
                    type={field.type === 'number' ? 'number' : 'text'}
                    min={field.min}
                    max={field.max}
                    maxLength={field.type === 'text' ? 4096 : undefined}
                    autoComplete="off"
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    disabled={disabled}
                    value={value}
                    onChange={(event) => set(event.target.value)}
                  />
                )
              }
            </Field>
          );
        })}
        <div className="flex flex-wrap gap-2">
          {conflict ? (
            <Button variant="primary" loading={saving} onClick={() => void reload()}>
              {tx('重新读取', 'Reload')}
            </Button>
          ) : (
            canEdit && (
              <Button type="submit" variant="primary" loading={saving} disabled={!changed}>
                {tx('保存策略', 'Save policy')}
              </Button>
            )
          )}
        </div>
      </form>
    </Panel>
  );
}

/** Hot-applied product policies (`/management/policies`); the server validates and authorizes every write. */
export function PoliciesPage() {
  const api = useAdminApi();
  const tx = useText();
  const can = usePermissionCheck();
  const writable = can('config:update');
  const list = useResource(async (signal) => {
    const result = await api.get<{ policies?: PolicyView[] } | PolicyView[]>(POLICIES, undefined, { signal });
    return Array.isArray(result) ? result : (result?.policies ?? []);
  }, []);
  return (
    <PageContainer
      title={tx('产品策略', 'Policies')}
      description={tx('保存后立即生效（各服务进程最多 30 秒内刷新）。环境变量锁定的字段只读。', 'Changes apply immediately (each server process refreshes within 30 seconds). Fields pinned by the environment are read-only.')}
      actions={<Button onClick={list.reload}>{tx('刷新', 'Refresh')}</Button>}
    >
      {!writable && <Notice tone="info" title={tx('当前账号只能查看策略', 'You can view policies but not change them')} />}
      {list.error ? (
        <ErrorState onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <LoadingState />
      ) : !list.data?.length ? (
        <EmptyState>{tx('暂无已定义的策略', 'No policies are defined')}</EmptyState>
      ) : (
        <div className="space-y-4">
          {list.data.map((policy) => (
            <PolicyEditor key={`${policy.id}:${policy.revision ?? 0}`} initial={policy} writable={writable} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
