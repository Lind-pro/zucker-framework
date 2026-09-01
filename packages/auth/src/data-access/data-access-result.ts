import { type Term } from '@zucker/core';

/**
 * Re-export Term from @zucker/core for backward compatibility.
 * In Java hsweb, the same Term class (from ezorm) is used in both
 * query building and data-access filter conditions.
 */
export type { Term };

export interface DataAccessResult {
  /** Whether access is allowed */
  allowed: boolean;
  /** WHERE conditions to inject into queries (AND logic) */
  filterConditions?: Term[];
  /** Fields that should be denied/stripped from the result */
  denyFields?: string[];
}

/** Create an allowed result with no extra conditions */
export function allowResult(): DataAccessResult {
  return { allowed: true };
}

/** Create a denied result */
export function denyResult(): DataAccessResult {
  return { allowed: false };
}

/** Create an allowed result with filter conditions */
export function filterResult(filterConditions: Term[], denyFields?: string[]): DataAccessResult {
  return { allowed: true, filterConditions, denyFields };
}

/**
 * Merge multiple DataAccessResults with AND logic.
 * - If any result is denied, the merged result is denied.
 * - All filterConditions are concatenated.
 * - All denyFields are merged (union).
 */
export function mergeResults(results: DataAccessResult[]): DataAccessResult {
  if (results.length === 0) return allowResult();

  const denied = results.some((r) => !r.allowed);
  if (denied) return denyResult();

  const filterConditions: Term[] = [];
  const denyFieldSet = new Set<string>();

  for (const result of results) {
    if (result.filterConditions) {
      filterConditions.push(...result.filterConditions);
    }
    if (result.denyFields) {
      result.denyFields.forEach((f) => denyFieldSet.add(f));
    }
  }

  return {
    allowed: true,
    filterConditions: filterConditions.length > 0 ? filterConditions : undefined,
    denyFields: denyFieldSet.size > 0 ? Array.from(denyFieldSet) : undefined,
  };
}
