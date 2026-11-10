import type { AIKind, MediaKind } from './policy-layout';
import { MAX_ROWS, checkCredits, checkModel, checkRate, isRecord, numberDraft, rowId, type IssueCode } from './validation';

/**
 * `ai-pricing` values (credits). Per task for media kinds: `byModel[model]` when present, otherwise
 * `default`. Chat: `ceil(in/1000 * per1kInputTokens + out/1000 * per1kOutputTokens)`, at least
 * `minimum`, which is also the amount held before streaming. 0 means free.
 */
export interface MediaPrice {
  default: number;
  byModel: Record<string, number>;
}
export interface ChatPrice {
  per1kInputTokens: number;
  per1kOutputTokens: number;
  minimum: number;
}

export interface PriceRow {
  id: string;
  model: string;
  cost: string;
}
export interface MediaPriceDraft {
  default: string;
  rows: PriceRow[];
  /** Stored keys this editor does not manage; written back unchanged. */
  extra: Record<string, unknown>;
}
export interface ChatPriceDraft {
  per1kInputTokens: string;
  per1kOutputTokens: string;
  minimum: string;
  extra: Record<string, unknown>;
}

/** Errors by field path: `default`, `rows`, `<rowId>.model`, `<rowId>.cost`, `per1kInputTokens`, … */
export type Issues = Record<string, IssueCode>;

export function mediaPriceDraft(value: unknown): MediaPriceDraft {
  const { default: base, byModel, ...extra } = isRecord(value) ? value : {};
  return {
    default: numberDraft(base, '0'),
    rows: Object.entries(isRecord(byModel) ? byModel : {}).map(([model, cost]) => ({ id: rowId(), model, cost: numberDraft(cost) })),
    extra,
  };
}

export function chatPriceDraft(value: unknown): ChatPriceDraft {
  const { per1kInputTokens, per1kOutputTokens, minimum, ...extra } = isRecord(value) ? value : {};
  return {
    per1kInputTokens: numberDraft(per1kInputTokens, '0'),
    per1kOutputTokens: numberDraft(per1kOutputTokens, '0'),
    minimum: numberDraft(minimum, '0'),
    extra,
  };
}

export type Parsed<T> = { value: T; issues: null } | { value: null; issues: Issues };

/** Validates one media kind: whole credits everywhere, unique non-empty model ids, bounded row count. */
export function parseMediaPrice(draft: MediaPriceDraft): Parsed<MediaPrice & Record<string, unknown>> {
  const issues: Issues = {};
  const base = checkCredits(draft.default);
  if (!base.ok) issues.default = base.issue;
  if (draft.rows.length > MAX_ROWS) issues.rows = 'tooMany';
  const byModel: Record<string, number> = {};
  const seen = new Map<string, string>();
  for (const row of draft.rows) {
    const model = checkModel(row.model);
    if (!model.ok) issues[`${row.id}.model`] = model.issue;
    else if (seen.has(model.value)) issues[`${row.id}.model`] = 'duplicate';
    else seen.set(model.value, row.id);
    const cost = checkCredits(row.cost);
    if (!cost.ok) issues[`${row.id}.cost`] = cost.issue;
    if (model.ok && cost.ok) byModel[model.value] = cost.value;
  }
  if (Object.keys(issues).length || !base.ok) return { value: null, issues };
  return { value: { ...draft.extra, default: base.value, byModel }, issues: null };
}

export function parseChatPrice(draft: ChatPriceDraft): Parsed<ChatPrice & Record<string, unknown>> {
  const issues: Issues = {};
  const input = checkRate(draft.per1kInputTokens);
  const output = checkRate(draft.per1kOutputTokens);
  const minimum = checkCredits(draft.minimum);
  if (!input.ok) issues.per1kInputTokens = input.issue;
  if (!output.ok) issues.per1kOutputTokens = output.issue;
  if (!minimum.ok) issues.minimum = minimum.issue;
  if (!input.ok || !output.ok || !minimum.ok) return { value: null, issues };
  return { value: { ...draft.extra, per1kInputTokens: input.value, per1kOutputTokens: output.value, minimum: minimum.value }, issues: null };
}

export type PricingDraft = Partial<Record<MediaKind, MediaPriceDraft>> & { chat?: ChatPriceDraft };

/** Parses every present kind; `issues` is keyed `<kind>.<path>`. */
export function parsePricing(draft: PricingDraft): { values: Partial<Record<AIKind, unknown>>; issues: Issues } {
  const values: Partial<Record<AIKind, unknown>> = {};
  const issues: Issues = {};
  const collect = (kind: AIKind, parsed: Parsed<unknown>) => {
    if (parsed.issues) for (const [path, code] of Object.entries(parsed.issues)) issues[`${kind}.${path}`] = code;
    else values[kind] = parsed.value;
  };
  for (const kind of ['image', 'video', 'audio'] as const) {
    const media = draft[kind];
    if (media) collect(kind, parseMediaPrice(media));
  }
  if (draft.chat) collect('chat', parseChatPrice(draft.chat));
  return { values, issues };
}
