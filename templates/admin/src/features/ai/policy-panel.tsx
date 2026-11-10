import { Button, Notice, Panel, StatusBadge, errorBody, errorStatus, toast, useAdminApi } from '@zucker-framework/fe-admin';
import { useState, type ReactNode } from 'react';
import type { PolicyView } from '../../pages/policies';
import { useText } from '../../text';
import { policyLayout, type AIKind, type PolicyLayout } from './policy-layout';

export const policyPath = (id: string) => `/management/policies/${encodeURIComponent(id)}`;

export interface PolicyEditorContext {
  layout: PolicyLayout;
  /** Editing allowed: `config:update`, no pending conflict and no save in flight. */
  editable: boolean;
  saving: boolean;
  /** Writes the given kinds (pinned kinds are dropped) with the loaded revision as `expectedRevision`. */
  save: (next: Partial<Record<AIKind, unknown>>) => Promise<void>;
}

/**
 * Revision-guarded editor frame for one AI policy, with the same save semantics as the Policies page:
 * `PUT /management/policies/:id { expectedRevision, values }`, pinned fields never sent, a 409 keeps the
 * draft unsaved and offers a reload. The editor body remounts on each new revision so its drafts always
 * start from the server's current values.
 */
export function AIPolicyPanel({
  initial,
  title,
  description,
  kinds,
  writable,
  onSaved,
  children,
}: {
  initial: PolicyView;
  title: string;
  description: string;
  kinds: readonly AIKind[];
  writable: boolean;
  onSaved?: (policy: PolicyView) => void;
  children: (context: PolicyEditorContext) => ReactNode;
}) {
  const api = useAdminApi();
  const tx = useText();
  const [policy, setPolicy] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const layout = policyLayout(policy, kinds);
  const path = policyPath(policy.id);

  function apply(next: PolicyView) {
    setPolicy(next);
    onSaved?.(next);
  }

  async function save(next: Partial<Record<AIKind, unknown>>) {
    if (!layout) return;
    const values = layout.write(next);
    if (!Object.keys(values).length) return;
    setSaving(true);
    try {
      const saved = await api.put<PolicyView>(path, { expectedRevision: policy.revision ?? 0, values });
      apply(saved && Array.isArray(saved.fields) ? saved : await api.get<PolicyView>(path));
      toast.success(tx('已保存，立即生效', 'Saved; it applies immediately'));
    } catch (error) {
      if (errorStatus(error) === 409) setConflict(true);
      else if (errorStatus(error) === 400)
        // The policy's server-side validator explains the rejection (it never echoes other policies).
        toast.error(errorBody(error).message ?? tx('服务器拒绝了这些取值', 'The server rejected these values'));
      else toast.error(tx('保存失败，请检查权限后重试。', 'Save failed; check your access and retry.'));
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    setSaving(true);
    try {
      apply(await api.get<PolicyView>(path));
      setConflict(false);
      toast.info(tx('已读取最新版本', 'Latest revision loaded'));
    } catch {
      toast.error(tx('最新版本读取失败，请重试', 'Could not load the latest revision; retry'));
    } finally {
      setSaving(false);
    }
  }

  const pinned = layout?.slots.some((slot) => slot.pinned);
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          {title}
          <StatusBadge>{tx(`版本 ${policy.revision ?? 0}`, `Revision ${policy.revision ?? 0}`)}</StatusBadge>
          {pinned && <StatusBadge tone="warning">{tx('部分环境变量锁定', 'Partly pinned by environment')}</StatusBadge>}
        </span>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{description}</p>
        {conflict && (
          <Notice
            tone="warning"
            title={tx('该策略已被其他人修改', 'This policy was changed elsewhere')}
            action={
              <Button variant="primary" size="sm" loading={saving} onClick={() => void reload()}>
                {tx('重新读取', 'Reload')}
              </Button>
            }
          >
            {tx('请重新读取最新版本后再修改；当前草稿不会被保存。', 'Reload the latest revision before editing again; this draft was not saved.')}
          </Notice>
        )}
        {!layout ? (
          <Notice tone="warning" title={tx('无法识别该策略的字段', 'This policy has an unexpected shape')}>
            {tx('请在“产品策略”页面以 JSON 编辑。', 'Edit it as JSON on the Policies page.')}
          </Notice>
        ) : (
          <div key={policy.revision ?? 0}>{children({ layout, editable: writable && !conflict && !saving, saving, save })}</div>
        )}
      </div>
    </Panel>
  );
}
