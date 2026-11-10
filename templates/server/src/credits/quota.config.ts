export const QUOTA_OPTIONS = Symbol('QUOTA_OPTIONS');
export const DEFAULT_PRODUCTION_RECORD_LIMIT = 100;
export interface QuotaOptions { recordLimit?: number; period: 'daily' | 'monthly'; reservationTtlMs: number }
export function quotaOptionsFromEnvironment(env: NodeJS.ProcessEnv): QuotaOptions {
  // The demo `record` job is member-submittable; production gets a default daily cap unless the operator
  // sets an explicit limit or opts out with `off`.
  const configured = env.QUOTA_RECORD_LIMIT?.trim();
  const limit = configured === 'off' ? undefined : configured || (env.NODE_ENV === 'production' ? String(DEFAULT_PRODUCTION_RECORD_LIMIT) : undefined);
  const period = env.QUOTA_RECORD_PERIOD ?? 'daily';
  const reservationTtlMs = Number(env.QUOTA_RESERVATION_TTL_MS ?? 900000);
  if (period !== 'daily' && period !== 'monthly') throw new Error('QUOTA_RECORD_PERIOD must be daily or monthly');
  if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs < 1000 || reservationTtlMs > 86400000) throw new Error('Invalid QUOTA_RESERVATION_TTL_MS');
  if (limit && (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 2147483647)) throw new Error('Invalid QUOTA_RECORD_LIMIT');
  return { ...(limit ? { recordLimit: Number(limit) } : {}), period, reservationTtlMs };
}
export function quotaPeriod(now: Date, mode: QuotaOptions['period']): { period: string; endsAt: Date } {
  const year = now.getUTCFullYear(), month = now.getUTCMonth(), day = now.getUTCDate();
  return { period: now.toISOString().slice(0, mode === 'daily' ? 10 : 7),
    endsAt: new Date(Date.UTC(year, mode === 'monthly' ? month + 1 : month, mode === 'monthly' ? 1 : day + 1)) };
}
