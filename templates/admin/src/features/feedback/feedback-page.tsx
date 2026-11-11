import {
  Button,
  Drawer,
  ErrorState,
  Field,
  KeyValueList,
  LoadingState,
  Notice,
  PageContainer,
  ResourceTable,
  Select,
  StatusBadge,
  Textarea,
  displayValue,
  errorStatus,
  formatDateTime,
  pageLoader,
  toast,
  useAdminApi,
  useAdminI18n,
  usePermissionCheck,
  useResource,
  type ResourceTableHandle,
  type Tone,
} from '@zucker-framework/fe-admin';
import { useRef, useState, type FormEvent } from 'react';
import { useText } from '../../text';

export const FEEDBACK_PATH = '/management/feedback';
export const FEEDBACK_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export const FEEDBACK_TYPES = ['bug', 'idea', 'question', 'other'] as const;
export const FEEDBACK_TEXT_MAX = 2000;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Back-office projection of `GET /management/feedback` (everything except the idempotency key). */
export interface FeedbackRecord {
  id: string;
  ownerId: string;
  type: string;
  message: string;
  pagePath: string | null;
  locale: string | null;
  userAgent: string | null;
  status: FeedbackStatus;
  reply: string | null;
  staffNote: string | null;
  handledBy: string | null;
  repliedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

type Text = (zh: string, en: string) => string;
const statusLabel = (tx: Text, status: string) =>
  ({ open: tx('待处理', 'Open'), in_progress: tx('处理中', 'In progress'), resolved: tx('已解决', 'Resolved'), closed: tx('已关闭', 'Closed') })[status] ?? status;
const typeLabel = (tx: Text, type: string) =>
  ({ bug: tx('问题', 'Problem'), idea: tx('建议', 'Idea'), question: tx('咨询', 'Question'), other: tx('其他', 'Other') })[type] ?? type;
const statusTone = (status: string): Tone => (status === 'open' ? 'info' : status === 'in_progress' ? 'warning' : status === 'resolved' ? 'success' : 'neutral');
/** User and staff text is rendered as plain text only. */
const plain = (value: string | null) => <span className="whitespace-pre-wrap break-words">{value || '—'}</span>;

/**
 * Pure: the PATCH body for a draft, with only changed fields, or a validation error key. Empty text
 * clears a field (sent as `null`).
 */
export function feedbackPatch(
  current: Pick<FeedbackRecord, 'status' | 'reply' | 'staffNote' | 'revision'>,
  draft: { status: string; reply: string; staffNote: string },
): { body: Record<string, unknown> } | { error: 'reply' | 'staffNote' | 'unchanged' } {
  const reply = draft.reply.trim(),
    note = draft.staffNote.trim();
  if (reply.length > FEEDBACK_TEXT_MAX) return { error: 'reply' };
  if (note.length > FEEDBACK_TEXT_MAX) return { error: 'staffNote' };
  const body: Record<string, unknown> = { expectedRevision: current.revision };
  if (draft.status !== current.status) body.status = draft.status;
  if ((reply || null) !== (current.reply ?? null)) body.reply = reply || null;
  if ((note || null) !== (current.staffNote ?? null)) body.staffNote = note || null;
  return Object.keys(body).length === 1 ? { error: 'unchanged' } : { body };
}

function FeedbackDetail({ id, onSaved }: { id: string; onSaved: () => void }) {
  const api = useAdminApi();
  const tx = useText();
  const { locale } = useAdminI18n();
  const canUpdate = usePermissionCheck()('feedback:update');
  const detail = useResource((signal) => api.get<FeedbackRecord | null>(`${FEEDBACK_PATH}/${encodeURIComponent(id)}`, undefined, { signal }), [id]);
  if (detail.loading && detail.data === undefined) return <LoadingState />;
  if (detail.error) return <ErrorState onRetry={detail.reload} />;
  if (!detail.data) return <Notice tone="warning">{tx('该反馈已不存在。', 'This feedback no longer exists.')}</Notice>;
  const record = detail.data;
  return (
    <div className="space-y-6">
      <KeyValueList
        items={[
          { key: 'id', label: 'ID', value: record.id },
          { key: 'ownerId', label: tx('用户', 'User'), value: record.ownerId },
          { key: 'type', label: tx('类型', 'Type'), value: typeLabel(tx, record.type) },
          { key: 'status', label: tx('状态', 'Status'), value: <StatusBadge tone={statusTone(record.status)}>{statusLabel(tx, record.status)}</StatusBadge> },
          { key: 'message', label: tx('内容', 'Message'), value: plain(record.message) },
          { key: 'pagePath', label: tx('来源页面', 'Page'), value: displayValue(record.pagePath) },
          { key: 'locale', label: tx('语言', 'Locale'), value: displayValue(record.locale) },
          { key: 'userAgent', label: 'User agent', value: displayValue(record.userAgent) },
          { key: 'createdAt', label: tx('提交时间', 'Submitted'), value: formatDateTime(record.createdAt, locale) },
          { key: 'handledBy', label: tx('处理人', 'Handled by'), value: displayValue(record.handledBy) },
          { key: 'repliedAt', label: tx('回复时间', 'Replied'), value: formatDateTime(record.repliedAt, locale) },
        ]}
      />
      <ReplyForm key={`${record.id}:${record.revision}`} record={record} canUpdate={canUpdate} onSaved={() => { detail.reload(); onSaved(); }} onConflict={detail.reload} />
    </div>
  );
}

function ReplyForm({ record, canUpdate, onSaved, onConflict }: {
  record: FeedbackRecord; canUpdate: boolean; onSaved: () => void; onConflict: () => void;
}) {
  const api = useAdminApi();
  const tx = useText();
  const [status, setStatus] = useState<string>(record.status);
  const [reply, setReply] = useState(record.reply ?? '');
  const [staffNote, setStaffNote] = useState(record.staffNote ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const tooLong = tx(`最多 ${FEEDBACK_TEXT_MAX} 个字符`, `At most ${FEEDBACK_TEXT_MAX} characters`);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canUpdate || busy) return;
    const patch = feedbackPatch(record, { status, reply, staffNote });
    if ('error' in patch) {
      setProblem(patch.error === 'unchanged' ? tx('没有需要保存的修改。', 'Nothing to save.') : tooLong);
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      await api.patch<FeedbackRecord>(`${FEEDBACK_PATH}/${encodeURIComponent(record.id)}`, patch.body);
      toast.success(tx('已保存', 'Saved'));
      onSaved();
    } catch (error) {
      if (errorStatus(error) === 409) {
        toast.error(tx('该反馈已被他人修改，已重新加载。', 'Someone else changed this feedback; it was reloaded.'));
        onConflict();
      } else if (errorStatus(error) === 403) setProblem(tx('没有修改权限。', 'You are not allowed to change feedback.'));
      else setProblem(tx('保存失败，请重试。', 'Saving failed. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  const disabled = !canUpdate || busy;
  return (
    <form className="space-y-4 border-t pt-5" onSubmit={(event) => void save(event)} aria-label={tx('回复与状态', 'Reply and status')}>
      {!canUpdate && <Notice tone="info">{tx('只读：需要 feedback:update 权限才能回复。', 'Read-only: replying needs the feedback:update permission.')}</Notice>}
      <Field label={tx('状态', 'Status')}>
        {({ id }) => (
          <Select id={id} value={status} disabled={disabled} onChange={(event) => setStatus(event.target.value)}
            options={FEEDBACK_STATUSES.map((value) => ({ value, label: statusLabel(tx, value) }))} />
        )}
      </Field>
      <Field label={tx('回复（用户可见）', 'Reply (shown to the user)')} error={reply.trim().length > FEEDBACK_TEXT_MAX ? tooLong : undefined}>
        {({ id, describedBy, invalid }) => (
          <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={5} value={reply} disabled={disabled}
            onChange={(event) => setReply(event.target.value)} />
        )}
      </Field>
      <Field label={tx('内部备注（用户不可见）', 'Staff note (never shown to the user)')} error={staffNote.trim().length > FEEDBACK_TEXT_MAX ? tooLong : undefined}>
        {({ id, describedBy, invalid }) => (
          <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={3} value={staffNote} disabled={disabled}
            onChange={(event) => setStaffNote(event.target.value)} />
        )}
      </Field>
      {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
      <Button type="submit" disabled={disabled}>{busy ? tx('保存中…', 'Saving…') : tx('保存', 'Save')}</Button>
    </form>
  );
}

/** `/feedback`: all users' feedback with status/type filters and a reply drawer. */
export function FeedbackPage() {
  const api = useAdminApi();
  const tx = useText();
  const { locale } = useAdminI18n();
  const table = useRef<ResourceTableHandle>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const title = tx('用户反馈', 'Feedback');
  return (
    <PageContainer title={title} description={tx('用户提交的问题与建议；回复会显示给用户。', 'Problems and ideas sent by users; replies are shown to them.')}>
      <ResourceTable<FeedbackRecord>
        ref={table}
        label={title}
        load={pageLoader(api, FEEDBACK_PATH)}
        rowKey={(row) => row.id}
        filters={[
          { name: 'status', label: tx('状态', 'Status'), type: 'select', options: FEEDBACK_STATUSES.map((value) => ({ value, label: statusLabel(tx, value) })) },
          { name: 'type', label: tx('类型', 'Type'), type: 'select', options: FEEDBACK_TYPES.map((value) => ({ value, label: typeLabel(tx, value) })) },
          { name: 'ownerId', label: tx('用户 ID', 'User id') },
        ]}
        minWidth={860}
        columns={[
          { key: 'createdAt', title: tx('提交时间', 'Submitted'), render: (row) => formatDateTime(row.createdAt, locale) },
          { key: 'type', title: tx('类型', 'Type'), render: (row) => typeLabel(tx, row.type) },
          { key: 'status', title: tx('状态', 'Status'), render: (row) => <StatusBadge tone={statusTone(row.status)}>{statusLabel(tx, row.status)}</StatusBadge> },
          {
            key: 'message',
            title: tx('内容', 'Message'),
            render: (row) => <span className="block max-w-sm truncate" title={row.message}>{row.message}</span>,
          },
          { key: 'ownerId', title: tx('用户', 'User'), render: (row) => displayValue(row.ownerId), hideOnMobile: true },
          { key: 'repliedAt', title: tx('回复时间', 'Replied'), render: (row) => formatDateTime(row.repliedAt, locale), hideOnMobile: true },
        ]}
        actions={(row) => (
          <Button size="sm" variant="ghost" onClick={() => setSelected(row.id)}>
            {tx('详情', 'Details')}
          </Button>
        )}
      />
      <Drawer open={selected !== null} onOpenChange={(open) => !open && setSelected(null)} title={tx('反馈详情', 'Feedback details')}>
        {selected && <FeedbackDetail key={selected} id={selected} onSaved={() => table.current?.reload()} />}
      </Drawer>
    </PageContainer>
  );
}
