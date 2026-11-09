import { useEffect, useState } from 'react';
import { Button } from '../components/button';
import { LoadingState, Notice, StatusBadge, type Tone } from '../components/feedback';
import { Switch } from '../components/inputs';
import { PageContainer } from '../components/layout';
import { useAdmin, useAdminApi } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import { formatDateTime } from '../lib/format';

interface Health {
  status: 'up' | 'down' | 'degraded';
  checks: Record<string, { status: string; details?: Record<string, unknown> }>;
  timestamp: string;
}

const isHealth = (value: unknown): value is Health =>
  !!value &&
  typeof value === 'object' &&
  ['up', 'down', 'degraded'].includes((value as Health).status) &&
  !!(value as Health).checks &&
  typeof (value as Health).checks === 'object';
const tone = (status: string): Tone => (status === 'up' ? 'success' : status === 'down' ? 'danger' : 'warning');

/** Process and registered dependency checks (`GET /health`). A failed read is not reported as DOWN. */
export function HealthPage() {
  const { config } = useAdmin();
  const api = useAdminApi();
  const { t, locale } = useAdminI18n();
  const [health, setHealth] = useState<Health | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [auto, setAuto] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api
      .get<unknown>(config.endpoints.health, undefined, { signal: controller.signal })
      .then((result) => {
        if (!isHealth(result)) throw new Error('Unexpected health response');
        setHealth(result);
        setFailed(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // A 503 with a health body is a real DOWN result, not a read failure.
        const body = (error as { response?: { data?: unknown } })?.response?.data;
        if (isHealth(body)) {
          setHealth(body);
          setFailed(false);
        } else setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, config.endpoints.health, version]);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => setVersion((value) => value + 1), 30000);
    return () => clearInterval(timer);
  }, [auto]);
  const label = (status: string) =>
    status === 'up' ? t('health.up') : status === 'down' ? t('health.down') : status === 'degraded' ? t('health.degraded') : t('common.unknown');
  const checks = Object.entries(health?.checks ?? {});
  return (
    <PageContainer
      title={t('page.health')}
      description={t('health.description')}
      actions={
        <>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={auto} onCheckedChange={setAuto} aria-label={t('health.autoRefresh')} />
            {t('health.autoRefresh')}
          </label>
          <Button loading={loading} onClick={() => setVersion((value) => value + 1)}>
            {t('common.refresh')}
          </Button>
        </>
      }
    >
      {failed && (
        <Notice tone="danger" title={t('health.failed')}>
          {t('health.failedDescription')}
        </Notice>
      )}
      {loading && !health && !failed ? (
        <LoadingState />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-xl border bg-card p-4">
            <p className="text-sm text-muted-foreground">{t('health.latest')}</p>
            <p className="mt-2">
              {health ? <StatusBadge tone={tone(health.status)}>{label(health.status)}</StatusBadge> : t('common.unknown')}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">{health ? formatDateTime(health.timestamp, locale) : t('health.noResult')}</p>
          </div>
          {checks.map(([name, check]) => (
            <div key={name} className="rounded-xl border bg-card p-4">
              <p className="text-sm font-medium break-all">{name}</p>
              <p className="mt-2">
                <StatusBadge tone={tone(check.status)}>{label(check.status)}</StatusBadge>
              </p>
            </div>
          ))}
        </div>
      )}
      {health && !checks.length && (
        <Notice tone="info" title={t('health.noProbes')}>
          {t('health.noProbesDescription')}
        </Notice>
      )}
    </PageContainer>
  );
}
