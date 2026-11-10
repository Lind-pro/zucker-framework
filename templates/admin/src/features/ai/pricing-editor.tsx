import { Button, Field, Input, toast } from '@zucker-framework/fe-admin';
import { useId, useState } from 'react';
import { useText } from '../../text';
import { AddRowButton, CellInput, KindSection, RemoveRowButton, useIssueText, useKindLabel } from './editor-parts';
import type { AIKind, MediaKind } from './policy-layout';
import type { PolicyEditorContext } from './policy-panel';
import { chatPriceDraft, mediaPriceDraft, parsePricing, type ChatPriceDraft, type MediaPriceDraft, type PricingDraft } from './pricing-model';
import { MAX_ROWS, rowId } from './validation';

function initialDraft(context: PolicyEditorContext): PricingDraft {
  const draft: PricingDraft = {};
  for (const slot of context.layout.slots) {
    if (slot.kind === 'chat') draft.chat = chatPriceDraft(slot.value);
    else draft[slot.kind] = mediaPriceDraft(slot.value);
  }
  return draft;
}

/** Only kinds that may be written are validated; a pinned kind's value is the environment's business. */
function editablePart(draft: PricingDraft, context: PolicyEditorContext): PricingDraft {
  const editable = new Set(context.layout.slots.filter((slot) => !slot.pinned).map((slot) => slot.kind));
  return Object.fromEntries(Object.entries(draft).filter(([kind]) => editable.has(kind as AIKind))) as PricingDraft;
}

/**
 * Typed table editor for the `ai-pricing` policy: credits per task (default plus per-model overrides)
 * for each media kind, and token rates for chat. Model suggestions come from the saved `ai-catalog`.
 */
export function PricingEditor({ context, suggestions = {} }: { context: PolicyEditorContext; suggestions?: Partial<Record<AIKind, readonly string[]>> }) {
  const tx = useText();
  const issueText = useIssueText();
  const kindLabel = useKindLabel();
  const prefix = useId();
  const [draft, setDraft] = useState(() => initialDraft(context));
  const [dirty, setDirty] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const issues = submitted ? parsePricing(editablePart(draft, context)).issues : {};
  const error = (kind: AIKind, path: string) => issueText(issues[`${kind}.${path}`]);

  function update(next: PricingDraft) {
    setDraft(next);
    setDirty(true);
  }
  const setMedia = (kind: MediaKind, change: (media: MediaPriceDraft) => MediaPriceDraft) => {
    const media = draft[kind];
    if (media) update({ ...draft, [kind]: change(media) });
  };
  const setChat = (change: Partial<ChatPriceDraft>) => draft.chat && update({ ...draft, chat: { ...draft.chat, ...change } });

  async function submit() {
    setSubmitted(true);
    const parsed = parsePricing(editablePart(draft, context));
    if (Object.keys(parsed.issues).length) {
      toast.error(tx('请修正标出的字段', 'Fix the highlighted fields'));
      return;
    }
    await context.save(parsed.values);
  }

  return (
    <form
      className="space-y-4"
      aria-label={tx('AI 价格表', 'AI price table')}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {context.layout.slots.map((slot) => {
        const title = kindLabel(slot.kind);
        if (slot.kind === 'chat') {
          const chat = draft.chat;
          if (!chat) return null;
          const rate = (key: 'per1kInputTokens' | 'per1kOutputTokens' | 'minimum', label: string, description: string) => (
            <Field label={label} description={description} error={error('chat', key)}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  autoComplete="off"
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  value={chat[key]}
                  onChange={(event) => setChat({ [key]: event.target.value })}
                />
              )}
            </Field>
          );
          return (
            <KindSection key="chat" title={title} pinned={slot.pinned} disabled={!context.editable}>
              <div className="grid gap-4 sm:grid-cols-3">
                {rate('per1kInputTokens', tx('每千输入 token 积分', 'Credits per 1k input tokens'), tx('可含小数', 'Decimals allowed'))}
                {rate('per1kOutputTokens', tx('每千输出 token 积分', 'Credits per 1k output tokens'), tx('可含小数', 'Decimals allowed'))}
                {rate('minimum', tx('每条消息最低积分', 'Minimum credits per message'), tx('发送前预扣此数额', 'Held before streaming starts'))}
              </div>
            </KindSection>
          );
        }
        const kind = slot.kind;
        const media = draft[kind];
        if (!media) return null;
        const listId = `${prefix}-${kind}-models`;
        const models = suggestions[kind] ?? [];
        return (
          <KindSection key={kind} title={title} pinned={slot.pinned} disabled={!context.editable}>
            <Field
              label={tx(`${title}：默认每次积分`, `${title}: default credits per task`)}
              description={tx('未单独定价的模型使用此值；0 表示免费。', 'Used for models without their own price; 0 means free.')}
              error={error(kind, 'default')}
              className="max-w-xs"
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  autoComplete="off"
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  value={media.default}
                  onChange={(event) => setMedia(kind, (current) => ({ ...current, default: event.target.value }))}
                />
              )}
            </Field>
            {models.length > 0 && (
              <datalist id={listId}>
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            )}
            {media.rows.length > 0 && (
              <div className="space-y-2" role="group" aria-label={tx(`${title}按模型定价`, `${title} prices by model`)}>
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)_2.25rem] gap-2 text-xs text-muted-foreground" aria-hidden="true">
                  <span>{tx('模型 ID', 'Model id')}</span>
                  <span>{tx('每次积分', 'Credits per task')}</span>
                </div>
                {media.rows.map((row, index) => {
                  const n = index + 1;
                  const change = (patch: Partial<typeof row>) =>
                    setMedia(kind, (current) => ({ ...current, rows: current.rows.map((item) => (item.id === row.id ? { ...item, ...patch } : item)) }));
                  return (
                    <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)_2.25rem] items-start gap-2">
                      <CellInput
                        id={`${prefix}-${row.id}-model`}
                        label={tx(`${title}模型 ${n}`, `${title} model ${n}`)}
                        value={row.model}
                        list={models.length ? listId : undefined}
                        error={error(kind, `${row.id}.model`)}
                        onChange={(model) => change({ model })}
                      />
                      <CellInput
                        id={`${prefix}-${row.id}-cost`}
                        label={tx(`${title}模型 ${n} 积分`, `${title} model ${n} credits`)}
                        value={row.cost}
                        numeric
                        error={error(kind, `${row.id}.cost`)}
                        onChange={(cost) => change({ cost })}
                      />
                      <RemoveRowButton
                        label={tx(`删除${title}模型 ${n}`, `Remove ${title.toLowerCase()} model ${n}`)}
                        onClick={() => setMedia(kind, (current) => ({ ...current, rows: current.rows.filter((item) => item.id !== row.id) }))}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            {error(kind, 'rows') && <p className="text-xs text-destructive">{error(kind, 'rows')}</p>}
            <AddRowButton
              label={tx(`添加${title}模型价格`, `Add ${title.toLowerCase()} model price`)}
              disabled={media.rows.length >= MAX_ROWS}
              onClick={() => setMedia(kind, (current) => ({ ...current, rows: [...current.rows, { id: rowId(), model: '', cost: current.default }] }))}
            />
          </KindSection>
        );
      })}
      {context.layout.slots.some((slot) => !slot.pinned) && (context.editable || context.saving) ? (
        <Button type="submit" variant="primary" loading={context.saving} disabled={!dirty}>
          {tx('保存价格表', 'Save price table')}
        </Button>
      ) : null}
    </form>
  );
}
