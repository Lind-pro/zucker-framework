import type { AIKind } from './policy-layout';
import type { Issues } from './pricing-model';
import { MAX_ROWS, checkLabel, checkModel, checkProvider, isRecord, rowId } from './validation';

/** One `ai-catalog` entry: a provider/model pair the web UI offers for a kind (public policy). */
export interface CatalogEntry {
  providerId: string;
  model: string;
  /** Display name; omitted when empty (the UI then shows the model id). */
  label?: string;
}

export interface CatalogRow {
  id: string;
  providerId: string;
  model: string;
  label: string;
  /** Stored entry keys this editor does not manage; written back unchanged. */
  extra: Record<string, unknown>;
}

export function catalogDraft(value: unknown): CatalogRow[] {
  return (Array.isArray(value) ? value : []).map((entry) => {
    const { providerId, model, label, ...extra } = isRecord(entry) ? entry : {};
    return {
      id: rowId(),
      providerId: typeof providerId === 'string' ? providerId : '',
      model: typeof model === 'string' ? model : '',
      label: typeof label === 'string' ? label : '',
      extra,
    };
  });
}

/** Validates one kind's list: well-formed ids, optional short label, unique provider/model pairs. */
export function parseCatalog(rows: readonly CatalogRow[]): { value: CatalogEntry[]; issues: null } | { value: null; issues: Issues } {
  const issues: Issues = {};
  if (rows.length > MAX_ROWS) issues.rows = 'tooMany';
  const value: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const provider = checkProvider(row.providerId);
    const model = checkModel(row.model);
    const label = checkLabel(row.label);
    if (!provider.ok) issues[`${row.id}.providerId`] = provider.issue;
    if (!model.ok) issues[`${row.id}.model`] = model.issue;
    if (!label.ok) issues[`${row.id}.label`] = label.issue;
    if (!provider.ok || !model.ok || !label.ok) continue;
    const pair = `${provider.value}\u0000${model.value}`;
    if (seen.has(pair)) {
      issues[`${row.id}.model`] = 'duplicate';
      continue;
    }
    seen.add(pair);
    value.push({ ...row.extra, providerId: provider.value, model: model.value, ...(label.value ? { label: label.value } : {}) });
  }
  return Object.keys(issues).length ? { value: null, issues } : { value, issues: null };
}

/** Model ids per kind, for the pricing editor's suggestions. */
export function catalogModels(value: Partial<Record<AIKind, unknown>>): Partial<Record<AIKind, string[]>> {
  return Object.fromEntries(
    Object.entries(value).map(([kind, list]) => [kind, [...new Set(catalogDraft(list).map((row) => row.model.trim()).filter(Boolean))]]),
  );
}
