import { Link } from 'react-router';
import { Button, buttonClass } from '../components/button';
import { EmptyState, LoadingState, Notice } from '../components/feedback';
import { PageContainer, Panel } from '../components/layout';
import { useAdmin, usePageTitle, usePermissionCheck, useResource } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import type { AdminMessageKey } from '../i18n/zh-CN';

interface Metric {
  key: string;
  label: AdminMessageKey;
  path: string;
  permission: string;
  count: (signal: AbortSignal) => Promise<unknown>;
}

const validCount = (value: unknown): number => {
  const total = Array.isArray(value) ? value.length : (value as { total?: unknown } | null)?.total;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw new Error('Invalid count');
  return total;
};

/** Authorized resource counts; an unreadable count is shown as unavailable, never as zero. */
export function DashboardPage() {
  const { session, config, pages } = useAdmin();
  const { t } = useAdminI18n();
  const can = usePermissionCheck();
  const title = usePageTitle();
  const { endpoints, permissions: codes } = config;
  const all: Metric[] = [
    {
      key: 'users',
      label: 'dashboard.users',
      path: '/users',
      permission: codes.users.query,
      count: (signal) => session.api.post(`${endpoints.users}/_count`, {}, { signal }),
    },
    {
      key: 'roles',
      label: 'dashboard.roles',
      path: '/roles',
      permission: codes.roles.query,
      count: (signal) => session.api.post(`${endpoints.roles}/_count`, {}, { signal }),
    },
    {
      key: 'permissions',
      label: 'dashboard.permissions',
      path: '/permissions',
      permission: codes.permissions.query,
      count: (signal) => session.api.post(`${endpoints.permissions}/_count`, {}, { signal }),
    },
    {
      key: 'plans',
      label: 'dashboard.plans',
      path: '/plans',
      permission: codes.plans.query,
      count: (signal) => session.api.get(endpoints.plans, undefined, { signal }),
    },
    {
      key: 'credits',
      label: 'dashboard.credits',
      path: '/credit',
      permission: codes.credit.query,
      count: (signal) => session.api.get(endpoints.credits, { page: 1, pageSize: 1 }, { signal }),
    },
  ];
  const definitions = all.filter((metric) => can(metric.permission) && pages.some((page) => page.path === metric.path));
  const metrics = useResource(
    (signal) =>
      Promise.all(
        definitions.map(async (metric) => {
          try {
            return { metric, value: validCount(await metric.count(signal)) };
          } catch {
            return { metric, value: null };
          }
        }),
      ),
    [definitions.map((metric) => metric.key).join()],
  );
  const links = pages.filter(
    (page) => !page.hideInQuickLinks && page.key !== 'dashboard' && page.key !== 'profile' && can(page.permission),
  );
  return (
    <PageContainer
      title={t('page.dashboard')}
      description={t('dashboard.description')}
      actions={<Button onClick={metrics.reload}>{t('common.refresh')}</Button>}
    >
      {metrics.loading && !metrics.data ? (
        <LoadingState />
      ) : metrics.data?.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {metrics.data.map(({ metric, value }) => (
            <div key={metric.key} className="rounded-xl border bg-card p-4">
              <p className="text-sm text-muted-foreground">{t(metric.label)}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{value ?? t('dashboard.unavailable')}</p>
              {value === null ? (
                <Notice tone="warning" className="mt-3" title={t('dashboard.unavailableHint')} />
              ) : (
                <Link to={metric.path} className="mt-2 inline-block text-sm">
                  {t('dashboard.viewRecords')}
                </Link>
              )}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState>{t('dashboard.noMetrics')}</EmptyState>
      )}
      {links.length > 0 && (
        <Panel title={t('dashboard.quickLinks')}>
          <div className="flex flex-wrap gap-2">
            {links.map((page) => (
              <Link key={page.key} to={page.path} className={buttonClass('outline', 'md')}>
                {title(page)}
              </Link>
            ))}
          </div>
        </Panel>
      )}
    </PageContainer>
  );
}
