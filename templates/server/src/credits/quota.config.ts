export const QUOTA_OPTIONS = Symbol('QUOTA_OPTIONS');
export interface QuotaOptions { recordLimit?: number; period: 'daily' | 'monthly'; reservationTtlMs: number }
export function quotaOptionsFromEnvironment(env: NodeJS.ProcessEnv): QuotaOptions {
  const limit = env.QUOTA_RECORD_LIMIT?.trim(), period = env.QUOTA_RECORD_PERIOD ?? 'daily';
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
