import {
  Button,
  ConfirmDialog,
  Drawer,
  ErrorState,
  Field,
  Input,
  KeyValueList,
  LoadingState,
  Notice,
  PageContainer,
  ResourceTable,
  Select,
  StatusBadge,
  Tabs,
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
} from '@zucker-framework/fe-admin';
import { useRef, useState, type FormEvent } from 'react';
import { useText } from '../../text';

export const PROMOTIONS_PATH = '/management/promotions';
const ALIAS = /^[A-Z0-9_-]{3,32}$/;
const PROVIDER_CODE = /^[A-Za-z0-9_-]{1,128}$/;
const TARGET = /^(\*|(plan|pack|offer):[A-Za-z0-9_-]{1,64})$/;

/** `GET /management/promotions` row. Amounts are exact decimal strings. */
export interface PromotionRecord {
  id: string;
  alias: string | null;
  providerId: string;
  providerCode: string;
  target: string;
  currency: string | null;
  discountType: 'percent' | 'amount';
  percentOff: number | null;
  amountOff: string | null;
  maxRedemptions: number | null;
  status: 'active' | 'disabled';
  startsAt: string | null;
  endsAt: string | null;
  note: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  usage: { redeemed: number; reserved: number };
}
interface RedemptionRecord {
  orderId: string;
  ownerId: string;
  providerId: string;
  status: 'reserved' | 'redeemed';
  reference: string | null;
  discount: { amount: string; currency: string };
  payable: { amount: string; currency: string };
  expiresAt: string;
  redeemedAt: string | null;
  createdAt: string;
}

/** Form state: every field is text so partial input never loses characters. */
export interface PromotionDraft {
  alias: string;
  providerId: string;
  providerCode: string;
  target: string;
  currency: string;
  discountType: 'percent' | 'amount';
  percentOff: string;
  amountOff: string;
  maxRedemptions: string;
  status: 'active' | 'disabled';
  startsAt: string;
  endsAt: string;
  note: string;
}
export const emptyPromotionDraft = (): PromotionDraft => ({
  alias: '', providerId: 'stripe', providerCode: '', target: '*', currency: '', discountType: 'percent', percentOff: '',
  amountOff: '', maxRedemptions: '', status: 'active', startsAt: '', endsAt: '', note: '',
});

/** `datetime-local` value (browser local time) ↔ ISO instant. */
const toLocalInput = (value: string | null) => {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);

export function draftFromRecord(record: PromotionRecord): PromotionDraft {
  return {
    alias: record.alias ?? '', providerId: record.providerId, providerCode: record.providerCode, target: record.target,
    currency: record.currency ?? '', discountType: record.discountType, percentOff: record.percentOff?.toString() ?? '',
    amountOff: record.amountOff ?? '', maxRedemptions: record.maxRedemptions?.toString() ?? '', status: record.status,
    startsAt: toLocalInput(record.startsAt), endsAt: toLocalInput(record.endsAt), note: record.note ?? '',
  };
}

export type PromotionDraftError = 'alias' | 'providerId' | 'providerCode' | 'target' | 'currency' | 'percentOff' | 'amountOff' | 'maxRedemptions' | 'window' | 'note';

/**
 * Pure: the full write body for a draft (the server requires every field), or the first invalid
 * field. The server repeats every check; this only gives earlier feedback.
 */
export function promotionBody(draft: PromotionDraft): { body: Record<string, unknown> } | { error: PromotionDraftError } {
  const alias = draft.alias.trim().toUpperCase();
  if (alias && !ALIAS.test(alias)) return { error: 'alias' };
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(draft.providerId)) return { error: 'providerId' };
  if (!PROVIDER_CODE.test(draft.providerCode.trim())) return { error: 'providerCode' };
  if (!TARGET.test(draft.target.trim())) return { error: 'target' };
  const currency = draft.currency.trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) return { error: 'currency' };
  let percentOff: number | null = null, amountOff: string | null = null;
  if (draft.discountType === 'percent') {
    percentOff = Number(draft.percentOff);
    if (!/^\d{1,2}$/.test(draft.percentOff.trim()) || percentOff < 1 || percentOff > 99) return { error: 'percentOff' };
  } else {
    if (!currency) return { error: 'currency' };
    amountOff = draft.amountOff.trim();
    if (!/^\d+(?:\.\d+)?$/.test(amountOff) || Number(amountOff) <= 0) return { error: 'amountOff' };
  }
  const max = draft.maxRedemptions.trim();
  if (max && (!/^\d{1,7}$/.test(max) || Number(max) < 1 || Number(max) > 1_000_000)) return { error: 'maxRedemptions' };
  const startsAt = fromLocalInput(draft.startsAt), endsAt = fromLocalInput(draft.endsAt);
  if (startsAt && endsAt && endsAt <= startsAt) return { error: 'window' };
  if (draft.note.length > 500) return { error: 'note' };
  return { body: { alias: alias || null, providerId: draft.providerId, providerCode: draft.providerCode.trim(), target: draft.target.trim(),
    currency: currency || null, discountType: draft.discountType, percentOff, amountOff, maxRedemptions: max ? Number(max) : null,
    status: draft.status, startsAt, endsAt, note: draft.note.trim() || null } };
}

type Text = (zh: string, en: string) => string;
const discountLabel = (record: PromotionRecord) =>
  record.discountType === 'percent' ? `${record.percentOff}%` : `${record.currency} ${record.amountOff}`;
const statusBadge = (tx: Text, status: string) =>
  status === 'active' ? <StatusBadge tone="success">{tx('启用', 'Active')}</StatusBadge> : <StatusBadge tone="neutral">{tx('停用', 'Disabled')}</StatusBadge>;

function PromotionForm({ record, onSaved }: { record: PromotionRecord | null; onSaved: (saved: PromotionRecord) => void }) {
  const api = useAdminApi();
  const tx = useText();
  const can = usePermissionCheck();
  const allowed = record ? can('promotions:update') : can('promotions:create');
  const [draft, setDraft] = useState<PromotionDraft>(() => (record ? draftFromRecord(record) : emptyPromotionDraft()));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<PromotionDraftError | 'server' | 'conflict' | 'forbidden' | ''>('');
  const set = <K extends keyof PromotionDraft>(key: K) => (value: PromotionDraft[K]) => { setDraft((current) => ({ ...current, [key]: value })); setProblem(''); };
  const messages: Record<Exclude<typeof problem, ''>, string> = {
    alias: tx('优惠码需为 3–32 位大写字母、数字、_ 或 -。', 'The code must be 3–32 of A–Z, 0–9, _ or -.'),
    providerId: tx('支付渠道无效。', 'Invalid payment provider.'),
    providerCode: tx('渠道优惠码 ID 无效（例如 Stripe 的 promo_…）。', 'Invalid provider code (for Stripe a promo_… ID).'),
    target: tx("适用范围应为 *、plan:<id>、pack:<id> 或 offer:<id>。", "Target must be *, plan:<id>, pack:<id> or offer:<id>."),
    currency: tx('请填写三位币种代码（金额折扣必填）。', 'Enter a 3-letter currency (required for an amount discount).'),
    percentOff: tx('折扣比例需为 1–99 的整数。', 'Percent off must be a whole number from 1 to 99.'),
    amountOff: tx('请填写大于 0 的金额。', 'Enter an amount greater than 0.'),
    maxRedemptions: tx('使用上限需为 1–1000000 或留空。', 'Limit must be 1–1000000 or empty.'),
    window: tx('结束时间必须晚于开始时间。', 'The end must be after the start.'),
    note: tx('备注最多 500 字。', 'Note is at most 500 characters.'),
    server: tx('保存失败：请检查适用范围是否存在，然后重试。', 'Saving failed: check that the target exists, then retry.'),
    conflict: tx('已被他人修改或优惠码重复，请重新加载。', 'Changed by someone else or the code already exists; reload and retry.'),
    forbidden: tx('没有修改权限。', 'You are not allowed to change promotions.'),
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!allowed || busy) return;
    const result = promotionBody(draft);
    if ('error' in result) { setProblem(result.error); return; }
    setBusy(true);
    try {
      const saved = record
        ? await api.put<PromotionRecord>(`${PROMOTIONS_PATH}/${encodeURIComponent(record.id)}`, { ...result.body, expectedRevision: record.revision })
        : await api.post<PromotionRecord>(PROMOTIONS_PATH, result.body);
      toast.success(tx('已保存', 'Saved'));
      onSaved(saved);
    } catch (error) {
      const status = errorStatus(error);
      setProblem(status === 409 ? 'conflict' : status === 403 ? 'forbidden' : 'server');
    } finally {
      setBusy(false);
    }
  }

  const disabled = !allowed || busy;
  const text = (key: keyof PromotionDraft, label: string, description?: string, props: Record<string, unknown> = {}) => (
    <Field label={label} description={description}>
      {({ id, describedBy }) => (
        <Input id={id} aria-describedby={describedBy} value={draft[key] as string} disabled={disabled}
          onChange={(event) => set(key)(event.target.value as never)} {...props} />
      )}
    </Field>
  );
  return (
    <form className="space-y-4" onSubmit={(event) => void save(event)} aria-label={tx('优惠码设置', 'Promotion settings')}>
      {!allowed && <Notice tone="info">{tx('只读：缺少修改权限。', 'Read-only: you lack the permission to change this.')}</Notice>}
      <Notice tone="info">
        {tx('折扣由服务器按此处设置计算并冻结在订单上；支付渠道中的优惠码必须产生完全相同的折扣，否则订单不会履约。',
          'The server computes the discount from these settings and freezes it on the order; the provider promotion must produce exactly the same discount or the order is not fulfilled.')}
      </Notice>
      {text('alias', tx('优惠码（用户输入）', 'Code buyers enter'), tx('留空则自动应用于匹配的一次性购买。', 'Empty: applied automatically to matching one-time purchases.'), { className: 'uppercase', maxLength: 32 })}
      <Field label={tx('支付渠道', 'Payment provider')}>
        {({ id }) => (
          <Select id={id} value={draft.providerId} disabled={disabled} onChange={(event) => set('providerId')(event.target.value)}
            options={[{ value: 'stripe', label: 'Stripe' }]} />
        )}
      </Field>
      {text('providerCode', tx('渠道优惠码 ID', 'Provider promotion code ID'), tx('订阅仅支持只作用一次的优惠券（首期）。', 'Subscriptions require a coupon that applies once (first invoice).'), { maxLength: 128 })}
      {text('target', tx('适用范围', 'Applies to'), '*, plan:<id>, pack:<id>, offer:<id>', { maxLength: 70 })}
      <Field label={tx('折扣类型', 'Discount type')}>
        {({ id }) => (
          <Select id={id} value={draft.discountType} disabled={disabled} onChange={(event) => set('discountType')(event.target.value as PromotionDraft['discountType'])}
            options={[{ value: 'percent', label: tx('百分比', 'Percent') }, { value: 'amount', label: tx('固定金额', 'Fixed amount') }]} />
        )}
      </Field>
      {draft.discountType === 'percent'
        ? text('percentOff', tx('折扣比例 (%)', 'Percent off'), undefined, { inputMode: 'numeric' })
        : text('amountOff', tx('减免金额', 'Amount off'), undefined, { inputMode: 'decimal' })}
      {text('currency', tx('币种', 'Currency'), tx('百分比折扣可留空（所有币种）。', 'Optional for a percent discount (all currencies).'), { className: 'uppercase', maxLength: 3 })}
      {text('maxRedemptions', tx('使用上限', 'Redemption limit'), tx('留空为不限。', 'Empty for unlimited.'), { inputMode: 'numeric' })}
      {text('startsAt', tx('开始时间', 'Starts'), undefined, { type: 'datetime-local' })}
      {text('endsAt', tx('结束时间', 'Ends'), undefined, { type: 'datetime-local' })}
      <Field label={tx('状态', 'Status')}>
        {({ id }) => (
          <Select id={id} value={draft.status} disabled={disabled} onChange={(event) => set('status')(event.target.value as PromotionDraft['status'])}
            options={[{ value: 'active', label: tx('启用', 'Active') }, { value: 'disabled', label: tx('停用', 'Disabled') }]} />
        )}
      </Field>
      <Field label={tx('备注', 'Note')}>
        {({ id }) => <Textarea id={id} rows={2} value={draft.note} disabled={disabled} onChange={(event) => set('note')(event.target.value)} />}
      </Field>
      {problem && <p role="alert" className="text-sm text-destructive">{messages[problem]}</p>}
      <Button type="submit" disabled={disabled}>{busy ? tx('保存中…', 'Saving…') : tx('保存', 'Save')}</Button>
    </form>
  );
}

function Redemptions({ id }: { id: string }) {
  const api = useAdminApi();
  const tx = useText();
  const { locale } = useAdminI18n();
  return (
    <ResourceTable<RedemptionRecord>
      label={tx('使用记录', 'Redemptions')}
      load={pageLoader(api, `${PROMOTIONS_PATH}/${encodeURIComponent(id)}/redemptions`)}
      rowKey={(row) => row.orderId}
      minWidth={640}
      columns={[
        { key: 'createdAt', title: tx('时间', 'Time'), render: (row) => formatDateTime(row.createdAt, locale) },
        { key: 'status', title: tx('状态', 'Status'), render: (row) => (row.status === 'redeemed'
          ? <StatusBadge tone="success">{tx('已使用', 'Redeemed')}</StatusBadge> : <StatusBadge tone="info">{tx('已预留', 'Reserved')}</StatusBadge>) },
        { key: 'payable', title: tx('实付', 'Paid'), render: (row) => `${row.payable.currency} ${row.payable.amount}` },
        { key: 'discount', title: tx('折扣', 'Discount'), render: (row) => `${row.discount.currency} ${row.discount.amount}` },
        { key: 'ownerId', title: tx('用户', 'User'), render: (row) => displayValue(row.ownerId), hideOnMobile: true },
        { key: 'orderId', title: tx('订单', 'Order'), render: (row) => <span className="font-mono text-xs">{row.orderId.slice(0, 12)}…</span>, hideOnMobile: true },
      ]}
    />
  );
}

function PromotionDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const api = useAdminApi();
  const tx = useText();
  const { locale } = useAdminI18n();
  const can = usePermissionCheck();
  const [confirm, setConfirm] = useState(false);
  const detail = useResource((signal) => api.get<PromotionRecord | null>(`${PROMOTIONS_PATH}/${encodeURIComponent(id)}`, undefined, { signal }), [id]);
  if (detail.loading && detail.data === undefined) return <LoadingState />;
  if (detail.error) return errorStatus(detail.error) === 404
    ? <Notice tone="warning">{tx('该优惠码已不存在。', 'This promotion no longer exists.')}</Notice>
    : <ErrorState onRetry={detail.reload} />;
  if (!detail.data) return <Notice tone="warning">{tx('该优惠码已不存在。', 'This promotion no longer exists.')}</Notice>;
  const record = detail.data;
  const used = record.usage.redeemed + record.usage.reserved > 0;
  async function remove() {
    try {
      await api.delete(`${PROMOTIONS_PATH}/${encodeURIComponent(record.id)}`, { expectedRevision: record.revision });
      toast.success(tx('已删除', 'Deleted'));
      onChanged();
    } catch (error) {
      toast.error(errorStatus(error) === 409 ? tx('已使用的优惠码不能删除，请停用。', 'A used promotion cannot be deleted; disable it instead.') : tx('删除失败。', 'Deleting failed.'));
      detail.reload();
      throw error;
    }
  }
  return (
    <div className="space-y-5">
      <KeyValueList
        items={[
          { key: 'alias', label: tx('优惠码', 'Code'), value: record.alias ?? tx('（自动应用）', '(automatic)') },
          { key: 'discount', label: tx('折扣', 'Discount'), value: discountLabel(record) },
          { key: 'status', label: tx('状态', 'Status'), value: statusBadge(tx, record.status) },
          { key: 'usage', label: tx('已使用 / 预留 / 上限', 'Redeemed / reserved / limit'),
            value: `${record.usage.redeemed} / ${record.usage.reserved} / ${record.maxRedemptions ?? '∞'}` },
          { key: 'updatedAt', label: tx('更新时间', 'Updated'), value: formatDateTime(record.updatedAt, locale) },
        ]}
      />
      <Tabs
        label={tx('优惠码详情', 'Promotion details')}
        defaultValue="settings"
        items={[
          { value: 'settings', label: tx('设置', 'Settings'), content: (
            <PromotionForm key={`${record.id}:${record.revision}`} record={record} onSaved={() => { detail.reload(); onChanged(); }} />
          ) },
          { value: 'redemptions', label: tx('使用记录', 'Redemptions'), content: <Redemptions id={record.id} /> },
        ]}
      />
      {can('promotions:delete') && !used && (
        <Button variant="danger" onClick={() => setConfirm(true)}>{tx('删除', 'Delete')}</Button>
      )}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} destructive title={tx('删除优惠码？', 'Delete this promotion?')}
        description={tx('删除后无法恢复。', 'This cannot be undone.')} confirmText={tx('删除', 'Delete')} onConfirm={remove} />
    </div>
  );
}

/** `/promotions`: promo codes with status/search filters, a create drawer and a detail drawer. */
export function PromotionsPage() {
  const api = useAdminApi();
  const tx = useText();
  const { locale } = useAdminI18n();
  const can = usePermissionCheck();
  const table = useRef<ResourceTableHandle>(null);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const title = tx('优惠码', 'Promotions');
  return (
    <PageContainer
      title={title}
      description={tx('结算时使用的优惠码。折扣由服务器计算并冻结在订单上。', 'Promo codes used at checkout. The server computes the discount and freezes it on the order.')}
      actions={can('promotions:create') ? <Button onClick={() => setSelected('new')}>{tx('新建优惠码', 'New promotion')}</Button> : undefined}
    >
      <ResourceTable<PromotionRecord>
        ref={table}
        label={title}
        load={pageLoader(api, PROMOTIONS_PATH)}
        rowKey={(row) => row.id}
        filters={[
          { name: 'status', label: tx('状态', 'Status'), type: 'select', options: [{ value: 'active', label: tx('启用', 'Active') }, { value: 'disabled', label: tx('停用', 'Disabled') }] },
          { name: 'q', label: tx('搜索', 'Search') },
        ]}
        minWidth={820}
        columns={[
          { key: 'alias', title: tx('优惠码', 'Code'), render: (row) => <span className="font-mono">{row.alias ?? tx('（自动）', '(automatic)')}</span> },
          { key: 'discount', title: tx('折扣', 'Discount'), render: (row) => discountLabel(row) },
          { key: 'target', title: tx('适用范围', 'Applies to'), render: (row) => <span className="font-mono text-xs">{row.target}</span> },
          { key: 'status', title: tx('状态', 'Status'), render: (row) => statusBadge(tx, row.status) },
          { key: 'usage', title: tx('已使用', 'Redeemed'), render: (row) => `${row.usage.redeemed} / ${row.maxRedemptions ?? '∞'}` },
          { key: 'endsAt', title: tx('结束', 'Ends'), render: (row) => formatDateTime(row.endsAt, locale), hideOnMobile: true },
        ]}
        actions={(row) => (
          <Button size="sm" variant="ghost" onClick={() => setSelected(row.id)}>
            {tx('详情', 'Details')}
          </Button>
        )}
      />
      <Drawer open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}
        title={selected === 'new' ? tx('新建优惠码', 'New promotion') : tx('优惠码详情', 'Promotion details')}>
        {selected === 'new' && <PromotionForm record={null} onSaved={(saved) => { table.current?.reload(); setSelected(saved.id); }} />}
        {selected && selected !== 'new' && <PromotionDetail key={selected} id={selected} onChanged={() => { table.current?.reload(); }} />}
      </Drawer>
    </PageContainer>
  );
}
