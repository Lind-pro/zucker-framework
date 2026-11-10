import { Button, toast } from '@zucker-framework/fe-admin';
import { useId, useState } from 'react';
import { useText } from '../../text';
import { parseCatalog, catalogDraft, type CatalogRow } from './catalog-model';
import { AddRowButton, CellInput, KindSection, RemoveRowButton, useIssueText, useKindLabel } from './editor-parts';
import type { AIKind } from './policy-layout';
import type { PolicyEditorContext } from './policy-panel';
import type { Issues } from './pricing-model';
import { MAX_ROWS, rowId } from './validation';

type CatalogDraft = Partial<Record<AIKind, CatalogRow[]>>;

function validate(draft: CatalogDraft, context: PolicyEditorContext) {
  const values: Partial<Record<AIKind, unknown>> = {};
  const issues: Issues = {};
  for (const slot of context.layout.slots) {
    const rows = draft[slot.kind];
    if (slot.pinned || !rows) continue;
    const parsed = parseCatalog(rows);
    if (parsed.issues) for (const [path, code] of Object.entries(parsed.issues)) issues[`${slot.kind}.${path}`] = code;
    else values[slot.kind] = parsed.value;
  }
  return { values, issues };
}

/**
 * Typed list editor for the public `ai-catalog` policy: the provider/model pairs the web generator and
 * chat pages offer per kind. The server rejects any submitted model outside this list.
 */
export function CatalogEditor({ context }: { context: PolicyEditorContext }) {
  const tx = useText();
  const issueText = useIssueText();
  const kindLabel = useKindLabel();
  const prefix = useId();
  const [draft, setDraft] = useState<CatalogDraft>(() => Object.fromEntries(context.layout.slots.map((slot) => [slot.kind, catalogDraft(slot.value)])));
  const [dirty, setDirty] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const issues = submitted ? validate(draft, context).issues : {};
  const error = (kind: AIKind, path: string) => issueText(issues[`${kind}.${path}`]);

  const setRows = (kind: AIKind, change: (rows: CatalogRow[]) => CatalogRow[]) => {
    setDraft((current) => ({ ...current, [kind]: change(current[kind] ?? []) }));
    setDirty(true);
  };

  async function submit() {
    setSubmitted(true);
    const parsed = validate(draft, context);
    if (Object.keys(parsed.issues).length) {
      toast.error(tx('请修正标出的字段', 'Fix the highlighted fields'));
      return;
    }
    await context.save(parsed.values);
  }

  return (
    <form
      className="space-y-4"
      aria-label={tx('AI 模型目录', 'AI model catalog')}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {context.layout.slots.map((slot) => {
        const kind = slot.kind;
        const title = kindLabel(kind);
        const rows = draft[kind] ?? [];
        return (
          <KindSection key={kind} title={title} pinned={slot.pinned} disabled={!context.editable}>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tx('未提供任何模型，前台不会显示此类生成。', 'No models offered; the site hides this kind.')}</p>
            ) : (
              <div className="space-y-2" role="group" aria-label={tx(`${title}模型`, `${title} models`)}>
                <div className="hidden grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,1fr)_2.25rem] gap-2 text-xs text-muted-foreground sm:grid" aria-hidden="true">
                  <span>{tx('提供方 ID', 'Provider id')}</span>
                  <span>{tx('模型 ID', 'Model id')}</span>
                  <span>{tx('显示名称（可选）', 'Display name (optional)')}</span>
                </div>
                {rows.map((row, index) => {
                  const n = index + 1;
                  const change = (patch: Partial<CatalogRow>) => setRows(kind, (current) => current.map((item) => (item.id === row.id ? { ...item, ...patch } : item)));
                  return (
                    <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_2.25rem] items-start gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,1fr)_2.25rem]">
                      <div className="contents max-sm:grid max-sm:gap-2">
                        <CellInput
                          id={`${prefix}-${row.id}-provider`}
                          label={tx(`${title}条目 ${n} 提供方`, `${title} entry ${n} provider`)}
                          placeholder={tx('提供方 ID', 'Provider id')}
                          value={row.providerId}
                          error={error(kind, `${row.id}.providerId`)}
                          onChange={(providerId) => change({ providerId })}
                        />
                        <CellInput
                          id={`${prefix}-${row.id}-model`}
                          label={tx(`${title}条目 ${n} 模型`, `${title} entry ${n} model`)}
                          placeholder={tx('模型 ID', 'Model id')}
                          value={row.model}
                          error={error(kind, `${row.id}.model`)}
                          onChange={(model) => change({ model })}
                        />
                        <CellInput
                          id={`${prefix}-${row.id}-label`}
                          label={tx(`${title}条目 ${n} 显示名称`, `${title} entry ${n} display name`)}
                          placeholder={tx('显示名称（可选）', 'Display name (optional)')}
                          value={row.label}
                          error={error(kind, `${row.id}.label`)}
                          onChange={(label) => change({ label })}
                        />
                      </div>
                      <RemoveRowButton
                        label={tx(`删除${title}条目 ${n}`, `Remove ${title.toLowerCase()} entry ${n}`)}
                        onClick={() => setRows(kind, (current) => current.filter((item) => item.id !== row.id))}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            {error(kind, 'rows') && <p className="text-xs text-destructive">{error(kind, 'rows')}</p>}
            <AddRowButton
              label={tx(`添加${title}模型`, `Add ${title.toLowerCase()} model`)}
              disabled={rows.length >= MAX_ROWS}
              onClick={() => setRows(kind, (current) => [...current, { id: rowId(), providerId: current[current.length - 1]?.providerId ?? '', model: '', label: '', extra: {} }])}
            />
          </KindSection>
        );
      })}
      {context.layout.slots.some((slot) => !slot.pinned) && (context.editable || context.saving) ? (
        <Button type="submit" variant="primary" loading={context.saving} disabled={!dirty}>
          {tx('保存模型目录', 'Save model catalog')}
        </Button>
      ) : null}
    </form>
  );
}
