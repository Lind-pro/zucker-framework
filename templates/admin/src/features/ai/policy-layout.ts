import type { PolicyField, PolicyView } from '../../pages/policies';
import { isRecord } from './validation';

/** Generation kinds the AI policies are keyed by; `chat` is metered by tokens, the others per task. */
export const MEDIA_KINDS = ['image', 'video', 'audio'] as const;
export const AI_KINDS = [...MEDIA_KINDS, 'chat'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type AIKind = (typeof AI_KINDS)[number];

export const AI_PRICING_POLICY = 'ai-pricing';
export const AI_CATALOG_POLICY = 'ai-catalog';

export interface KindSlot {
  kind: AIKind;
  /** Effective value for this kind (env pin > saved > default), `undefined` when absent. */
  value: unknown;
  /** `POLICY_<ID>_<KEY>` pins the field holding this kind; the section is read-only and never written. */
  pinned: boolean;
}

/**
 * How a policy stores its per-kind tables. The server contract (WP 2.3) declares one `json` field per
 * kind (`image`, `video`, `audio`, `chat`), so each kind can be pinned and stays under the 16 KiB
 * per-field limit. A policy that instead declares a single `json` field holding the whole
 * `{ image, video, audio, chat }` object is also accepted and written back in the same shape.
 */
export interface PolicyLayout {
  slots: KindSlot[];
  /** PUT `values` for the edited kinds; pinned kinds are left out. */
  write(next: Partial<Record<AIKind, unknown>>): Record<string, unknown>;
}

function fieldValue(policy: PolicyView, field: PolicyField): unknown {
  if (field.value !== undefined) return field.value;
  if (policy.values && Object.prototype.hasOwnProperty.call(policy.values, field.key)) return policy.values[field.key];
  return field.default;
}

/** `null` when the policy has neither per-kind `json` fields nor exactly one `json` field. */
export function policyLayout(policy: PolicyView, kinds: readonly AIKind[]): PolicyLayout | null {
  const json = policy.fields.filter((field) => field.type === 'json');
  const perKind = json.filter((field) => (kinds as readonly string[]).includes(field.key));
  if (perKind.length) {
    const slots = kinds.flatMap((kind) => {
      const field = perKind.find((candidate) => candidate.key === kind);
      return field ? [{ kind, value: fieldValue(policy, field), pinned: field.pinnedByEnvironment === true }] : [];
    });
    return {
      slots,
      write: (next) =>
        Object.fromEntries(slots.filter((slot) => !slot.pinned && next[slot.kind] !== undefined).map((slot) => [slot.kind, next[slot.kind]])),
    };
  }
  const [single] = json;
  if (!single || json.length !== 1) return null;
  const whole = fieldValue(policy, single);
  const object = isRecord(whole) ? whole : {};
  const pinned = single.pinnedByEnvironment === true;
  return {
    slots: kinds.map((kind) => ({ kind, value: object[kind], pinned })),
    // Keys this editor does not know about are kept as they were.
    write: (next) => (pinned ? {} : { [single.key]: { ...object, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) } }),
  };
}
