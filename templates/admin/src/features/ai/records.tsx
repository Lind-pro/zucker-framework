import {
  Button,
  Drawer,
  ErrorState,
  KeyValueList,
  LoadingState,
  PageContainer,
  ResourceTable,
  StatusBadge,
  displayValue,
  formatDateTime,
  pageLoader,
  useAdminApi,
  useAdminI18n,
  useResource,
  type FilterSpec,
  type Tone,
} from '@zucker-framework/fe-admin';
import { useState, type ReactNode } from 'react';
import { useText } from '../../text';
import { MEDIA_KINDS } from './policy-layout';

/** Durable task states shared with `@zucker-framework/task` (same set as the Jobs page). */
export const AI_TASK_STATUSES = ['QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;

type Row = Record<string, unknown> & { id?: string };
type Kind = 'text' | 'dateTime' | 'status' | 'credits' | 'clip';
type Text = (zh: string, en: string) => string;

interface ColumnDef {
  key: string;
  title: (tx: Text) => string;
  kind?: Kind;
}

interface RecordsDefinition {
  path: string;
  title: (tx: Text) => string;
  description: (tx: Text) => string;
  filters: (tx: Text) => FilterSpec[];
  columns: readonly ColumnDef[];
  /** Extra fields shown in the detail drawer only. Anything not declared here or in `columns` is never rendered. */
  details?: readonly ColumnDef[];
}

const col = (key: string, zh: string, en: string, kind?: Kind): ColumnDef => ({ key, title: (tx) => tx(zh, en), kind });

/**
 * Read-only management projections (WP 2.3, `createReadOnlyAdminController`):
 * `GET {path}?page&pageSize&<filter>=<value>` → `{ data, total, page, pageSize }`, `GET {path}/:id` → one row.
 * Prompts arrive truncated by the server and provider payloads are never included.
 */
export const aiRecordDefinitions = {
  tasks: {
    path: '/management/ai-tasks',
    title: (tx) => tx('AI 生成任务', 'AI tasks'),
    description: (tx) => tx('所有用户的图片/视频/音频生成任务（只读）。', 'Image, video and audio generation tasks of all users (read-only).'),
    filters: (tx) => [
      { name: 'id', label: tx('任务 ID', 'Task id') },
      { name: 'ownerId', label: tx('用户 ID', 'User id') },
      {
        name: 'kind',
        label: tx('类型', 'Kind'),
        type: 'select',
        options: MEDIA_KINDS.map((kind) => ({ value: kind, label: kind })),
      },
      { name: 'status', label: tx('状态', 'Status'), type: 'select', options: AI_TASK_STATUSES.map((status) => ({ value: status, label: status })) },
    ],
    columns: [
      col('id', 'ID', 'Id'),
      col('ownerId', '用户', 'User'),
      col('kind', '类型', 'Kind'),
      col('status', '状态', 'Status', 'status'),
      col('model', '模型', 'Model'),
      col('cost', '积分', 'Credits', 'credits'),
      col('createdAt', '创建时间', 'Created', 'dateTime'),
      col('providerId', '提供方', 'Provider'),
      col('prompt', '提示词', 'Prompt', 'clip'),
      col('outputCount', '输出数', 'Outputs'),
      col('errorCode', '错误码', 'Error code'),
      col('completedAt', '完成时间', 'Finished', 'dateTime'),
    ],
    details: [
      col('stage', '阶段', 'Stage'),
      col('progress', '进度', 'Progress'),
      col('charge', '扣费状态', 'Charge'),
      col('updatedAt', '更新时间', 'Updated', 'dateTime'),
    ],
  },
  chats: {
    path: '/management/chats',
    title: (tx) => tx('AI 对话', 'AI chats'),
    description: (tx) => tx('所有用户的对话会话（只读，不含消息正文）。', 'Chat sessions of all users (read-only, without message content).'),
    filters: (tx) => [
      { name: 'id', label: tx('会话 ID', 'Chat id') },
      { name: 'ownerId', label: tx('用户 ID', 'User id') },
    ],
    columns: [
      col('id', 'ID', 'Id'),
      col('ownerId', '用户', 'User'),
      col('title', '标题', 'Title', 'clip'),
      col('model', '模型', 'Model'),
      col('messageCount', '消息数', 'Messages'),
      col('cost', '累计积分', 'Credits used', 'credits'),
      col('updatedAt', '最近活动', 'Last activity', 'dateTime'),
      col('providerId', '提供方', 'Provider'),
      col('createdAt', '创建时间', 'Created', 'dateTime'),
    ],
  },
} satisfies Record<string, RecordsDefinition>;

export type AIRecordResource = keyof typeof aiRecordDefinitions;

function statusTone(value: string): Tone {
  if (value === 'COMPLETED') return 'success';
  if (value === 'FAILED') return 'danger';
  if (value === 'CANCELLED') return 'neutral';
  return 'info';
}

function cell(kind: Kind | undefined, value: unknown, locale: string, full = false): ReactNode {
  if (kind === 'dateTime') return formatDateTime(value, locale);
  if (kind === 'status') return value == null ? '—' : <StatusBadge tone={statusTone(String(value))}>{String(value)}</StatusBadge>;
  if (kind === 'credits') return typeof value === 'number' ? value.toLocaleString(locale) : displayValue(value);
  if (kind === 'clip' && !full) {
    const text = displayValue(value);
    return (
      <span className="block max-w-xs truncate" title={text}>
        {text}
      </span>
    );
  }
  return displayValue(value);
}

/** Fresh detail read; falls back to the listed row when the record is gone. */
function RecordDetail({ definition, row }: { definition: RecordsDefinition; row: Row }) {
  const api = useAdminApi();
  const tx = useText();
  const { locale } = useAdminI18n();
  const id = String(row.id ?? '');
  const detail = useResource((signal) => api.get<Row | null>(`${definition.path}/${encodeURIComponent(id)}`, undefined, { signal }), [definition.path, id], {
    enabled: id !== '',
  });
  if (detail.loading && detail.data === undefined) return <LoadingState />;
  if (detail.error) return <ErrorState onRetry={detail.reload} />;
  const record = detail.data && typeof detail.data === 'object' ? detail.data : row;
  // Declared fields only (allow-list): a server that starts returning more (keys, payloads, secrets)
  // must not leak them into the back office by accident.
  const fields = [...definition.columns, ...(definition.details ?? []).filter((field) => Object.prototype.hasOwnProperty.call(record, field.key))];
  return (
    <KeyValueList
      items={fields.map((column) => ({ key: column.key, label: column.title(tx), value: cell(column.kind, record[column.key], locale, true) }))}
    />
  );
}

/** Paginated read-only list with filters and a detail drawer. */
export function AIRecordsPage({ resource }: { resource: AIRecordResource }) {
  const api = useAdminApi();
  const tx = useText();
  const { locale } = useAdminI18n();
  const definition: RecordsDefinition = aiRecordDefinitions[resource];
  const [selected, setSelected] = useState<Row | null>(null);
  const title = definition.title(tx);
  return (
    <PageContainer title={title} description={definition.description(tx)}>
      <ResourceTable<Row>
        key={resource}
        label={title}
        load={pageLoader(api, definition.path)}
        rowKey={(row) => String(row.id ?? JSON.stringify(row))}
        filters={definition.filters(tx)}
        minWidth={900}
        columns={definition.columns.map((column, index) => ({
          key: column.key,
          title: column.title(tx),
          render: (row: Row) => cell(column.kind, row[column.key], locale),
          hideOnMobile: index > 4,
        }))}
        actions={(row) => (
          <Button size="sm" variant="ghost" onClick={() => setSelected(row)}>
            {tx('详情', 'Details')}
          </Button>
        )}
      />
      <Drawer open={selected !== null} onOpenChange={(open) => !open && setSelected(null)} title={tx(`${title}详情`, `${title}: details`)}>
        {selected && <RecordDetail key={String(selected.id)} definition={definition} row={selected} />}
      </Drawer>
    </PageContainer>
  );
}

export const AITasksPage = () => <AIRecordsPage resource="tasks" />;
export const AIChatsPage = () => <AIRecordsPage resource="chats" />;
