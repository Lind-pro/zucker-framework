import { definePolicy, type PolicyValue } from '@zucker-framework/back-office/settings';

/**
 * AI product policies (hot-applied, admin-editable through `/management/policies/:id`, WP 2.5 pages).
 * One `json` field per kind (`image`, `video`, `audio`, `chat`) so each kind can be pinned with
 * `POLICY_AI_PRICING_<KIND>` / `POLICY_AI_CATALOG_<KIND>` and stays below the 16 KiB field limit.
 * Register with `PolicyModule.forRoot({ policies: [...AI_POLICIES] })`.
 */
export const AI_MEDIA_KINDS = ['image', 'video', 'audio'] as const;
export type AIMediaKind = (typeof AI_MEDIA_KINDS)[number];
export type AIKind = AIMediaKind | 'chat';

export interface MediaPrice { default: number; byModel: Record<string, number> }
export interface ChatPrice { per1kInputTokens: number; per1kOutputTokens: number; minimum: number }
export interface CatalogEntry { providerId: string; model: string; label?: string }

export const MAX_CREDITS = 2_147_483_647;
export const MAX_TOKEN_RATE = 1_000_000;
export const MAX_CATALOG_ROWS = 100;
export const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const credits = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_CREDITS;
/** Non-negative, at most four decimals (the admin editor's rule), bounded. */
const rate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TOKEN_RATE
  && Math.abs(Math.round(value * 10_000) - value * 10_000) < 1e-6;

export function parseMediaPrice(value: unknown, kind: string): MediaPrice {
  if (!record(value) || Object.keys(value).some(key => key !== 'default' && key !== 'byModel') || !credits(value.default))
    throw new Error(`${kind} needs {default, byModel} with whole credits`);
  const byModel = value.byModel ?? {};
  if (!record(byModel) || Object.keys(byModel).length > MAX_CATALOG_ROWS
    || Object.entries(byModel).some(([model, cost]) => !MODEL_ID.test(model) || !credits(cost)))
    throw new Error(`${kind}.byModel maps model ids to whole credits`);
  return { default: value.default as number, byModel: { ...(byModel as Record<string, number>) } };
}

export function parseChatPrice(value: unknown): ChatPrice {
  if (!record(value) || Object.keys(value).some(key => !['per1kInputTokens', 'per1kOutputTokens', 'minimum'].includes(key))
    || !rate(value.per1kInputTokens) || !rate(value.per1kOutputTokens) || !credits(value.minimum))
    throw new Error('chat needs per1kInputTokens, per1kOutputTokens (0..1000000, 4 decimals) and a whole-credit minimum');
  return { per1kInputTokens: value.per1kInputTokens as number, per1kOutputTokens: value.per1kOutputTokens as number, minimum: value.minimum as number };
}

export function parseCatalog(value: unknown, kind: string): CatalogEntry[] {
  if (!Array.isArray(value) || value.length > MAX_CATALOG_ROWS) throw new Error(`${kind} catalog must be a list of at most ${MAX_CATALOG_ROWS} entries`);
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!record(entry) || Object.keys(entry).some(key => !['providerId', 'model', 'label'].includes(key))
      || typeof entry.providerId !== 'string' || !PROVIDER_ID.test(entry.providerId)
      || typeof entry.model !== 'string' || !MODEL_ID.test(entry.model)
      || (entry.label !== undefined && (typeof entry.label !== 'string' || entry.label.length > 80 || CONTROL.test(entry.label))))
      throw new Error(`${kind} catalog entries are {providerId, model, label?}`);
    const pair = `${entry.providerId}\u0000${entry.model}`;
    if (seen.has(pair)) throw new Error(`${kind} catalog lists ${entry.providerId}/${entry.model} twice`);
    seen.add(pair);
    return { providerId: entry.providerId, model: entry.model, ...(entry.label ? { label: entry.label } : {}) };
  });
}

export interface AIPricingValues {
  [key: string]: PolicyValue;
  image: PolicyValue; video: PolicyValue; audio: PolicyValue; chat: PolicyValue;
}
export type AICatalogValues = AIPricingValues;

/** Credits per task (media: `byModel[model]` else `default`, times the requested `count`) and token rates for chat. 0 = free. */
export const AI_PRICING_POLICY = definePolicy<AIPricingValues>({
  id: 'ai-pricing',
  name: 'AI pricing',
  fields: [
    { key: 'image', type: 'json', default: { default: 2, byModel: {} }, label: 'Image credits per task' },
    { key: 'video', type: 'json', default: { default: 20, byModel: {} }, label: 'Video credits per task' },
    { key: 'audio', type: 'json', default: { default: 10, byModel: {} }, label: 'Audio credits per task' },
    { key: 'chat', type: 'json', default: { per1kInputTokens: 0.5, per1kOutputTokens: 1.5, minimum: 1 },
      label: 'Chat credits', description: 'ceil(in/1000 × per1kInputTokens + out/1000 × per1kOutputTokens), at least minimum; minimum is held before streaming.' },
  ],
  validate(values) {
    for (const kind of AI_MEDIA_KINDS) parseMediaPrice(values[kind], kind);
    parseChatPrice(values.chat);
  },
});

/**
 * Provider/model pairs the product offers per kind. Public (`GET /site/public/config`, `GET /ai/catalog`).
 * Requests for a pair outside this list are refused. An empty `chat` list offers every enabled chat
 * connection with its configured model id.
 */
export const AI_CATALOG_POLICY = definePolicy<AICatalogValues>({
  id: 'ai-catalog',
  name: 'AI catalog',
  fields: [
    { key: 'image', type: 'json', public: true, default: [{ providerId: 'ai-openai', model: 'dall-e-3', label: 'DALL·E 3' }], label: 'Image models' },
    { key: 'video', type: 'json', public: true, default: [], label: 'Video models' },
    { key: 'audio', type: 'json', public: true, default: [], label: 'Music/audio models (experimental)' },
    { key: 'chat', type: 'json', public: true, default: [], label: 'Chat models', description: 'Empty: every enabled chat connection with its configured model.' },
  ],
  validate(values) {
    for (const kind of [...AI_MEDIA_KINDS, 'chat'] as const) parseCatalog(values[kind], kind);
  },
});

export const AI_POLICIES = [AI_PRICING_POLICY, AI_CATALOG_POLICY] as const;
