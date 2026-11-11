import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageContainer,
  Panel,
  Select,
  errorStatus,
  useAdminApi,
  useAdminI18n,
  useResource,
} from '@zucker-framework/fe-admin';
import { useState, type ReactNode } from 'react';
import { useText } from '../../text';
import { ChartOrTable, ChartPalette, ColumnChart, LineChart, RankBars, SeriesTable, type ChartSeries } from './charts';
import {
  INSIGHT_RANGES,
  browserTimeZone,
  formatCount,
  formatDay,
  formatMoney,
  toNumber,
  type DailySeries,
  type InsightSeries,
  type InsightSummary,
} from './format';

const SERIES_METRICS = ['revenue', 'refunds', 'new-users', 'paying-users', 'credits-granted', 'credits-consumed', 'ai-tasks', 'chat-messages'] as const;
type SeriesMetric = (typeof SERIES_METRICS)[number];
/** AI task status buckets in a fixed palette order (a status keeps its colour whatever else is present). */
const AI_STATUSES = ['completed', 'failed', 'cancelled', 'in_progress'] as const;

interface Loaded {
  summary: InsightSummary;
  series: Partial<Record<SeriesMetric, InsightSeries>>;
}

type Tx = (zh: string, en: string) => string;

function Tile({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{children}</div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Daily response → chart series (one per key), or null when the metric is unavailable or not daily. */
function daily(response: InsightSeries | undefined): { dates: string[]; series: DailySeries[] } | null {
  if (!response || !response.available || response.kind !== 'daily') return null;
  return { dates: response.series[0]?.points.map((point) => point.date) ?? [], series: response.series };
}

/**
 * Operations insights: revenue and refunds per currency (never added across currencies), sign-ups,
 * paying users, subscriptions, credits, AI tasks and chat usage over a local-day range. Aggregates
 * only; every chart has the same data as a table.
 */
export function InsightsPage() {
  const api = useAdminApi();
  const tx = useText();
  const { locale } = useAdminI18n();
  const [days, setDays] = useState<number>(30);
  const [tz, setTz] = useState(browserTimeZone);
  const [zoneFallback, setZoneFallback] = useState(false);
  const data = useResource<Loaded>(
    async (signal) => {
      let summary: InsightSummary;
      try {
        summary = (await api.get('/management/insights/summary', { days, tz }, { signal })) as InsightSummary;
      } catch (error) {
        // A zone the server's runtime does not know: fall back to UTC once instead of failing the page.
        if (errorStatus(error) === 400 && tz !== 'UTC') {
          setZoneFallback(true);
          setTz('UTC');
        }
        throw error;
      }
      const settled = await Promise.allSettled(
        SERIES_METRICS.map((metric) => api.get('/management/insights/series', { metric, days, tz }, { signal }) as Promise<InsightSeries>),
      );
      const series: Loaded['series'] = {};
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') series[SERIES_METRICS[index]!] = result.value;
      });
      return { summary, series };
    },
    [days, tz],
  );
  const title = tx('运营洞察', 'Insights');
  const count = (value: number) => formatCount(value, locale);
  const viewLabels = { chart: tx('图表', 'Chart'), table: tx('表格', 'Table') };
  const tableLabels = { date: tx('日期', 'Date'), total: tx('合计', 'Total') };

  const controls = (
    <>
      <Select
        aria-label={tx('时间范围', 'Range')}
        value={String(days)}
        onChange={(event) => setDays(Number(event.target.value))}
        options={INSIGHT_RANGES.map((value) => ({ value: String(value), label: tx(`最近 ${value} 天`, `Last ${value} days`) }))}
      />
      <Button variant="outline" onClick={data.reload}>{tx('刷新', 'Refresh')}</Button>
    </>
  );

  let body: ReactNode;
  if (data.loading && !data.data) body = <LoadingState />;
  else if (data.error || !data.data) body = <ErrorState message={tx('无法加载运营数据。', 'Insights could not be loaded.')} onRetry={data.reload} />;
  else body = <InsightsBody loaded={data.data} tx={tx} locale={locale} count={count} viewLabels={viewLabels} tableLabels={tableLabels} />;

  return (
    <PageContainer
      title={title}
      description={tx('按本地日期汇总的收入、退款、注册、积分与 AI 用量。只显示汇总值，不含用户身份信息。', 'Revenue, refunds, sign-ups, credits and AI usage by local day. Aggregates only, no user identities.')}
      actions={controls}
    >
      <ChartPalette />
      {zoneFallback && <Notice tone="warning" title={tx('服务器不支持浏览器时区，已改用 UTC。', "The server does not support this browser's time zone; showing UTC.")} />}
      {data.data && (
        <p className="text-xs text-muted-foreground">
          {formatDay(data.data.summary.range.from, locale)} – {formatDay(data.data.summary.range.to, locale)} · {data.data.summary.range.tz}
        </p>
      )}
      {body}
    </PageContainer>
  );
}

function InsightsBody({ loaded, tx, locale, count, viewLabels, tableLabels }: {
  loaded: Loaded; tx: Tx; locale: string; count: (value: number) => string;
  viewLabels: { chart: string; table: string }; tableLabels: { date: string; total: string };
}) {
  const { metrics } = loaded.summary;
  const unavailable = tx('未安装', 'Not installed');
  const money = (totals: Array<{ currency: string; amount: string }>) =>
    totals.length ? (
      <ul className="space-y-0.5">{totals.map((total) => <li key={total.currency}>{formatMoney(total.amount, total.currency, locale)}</li>)}</ul>
    ) : <span>0</span>;
  const value = (metric: { available: false } | { available: true; value: number }) => (metric.available ? count(metric.value) : unavailable);

  const countChart = (metric: SeriesMetric, label: string) => {
    const response = loaded.series[metric];
    if (response && !response.available) return <EmptyState>{unavailable}</EmptyState>;
    const parsed = daily(response);
    if (!parsed) return <ErrorState message={tx('无法加载该指标。', 'This metric could not be loaded.')} />;
    const entry = parsed.series[0];
    const series: ChartSeries = { key: entry?.key ?? 'total', label, slot: 0, values: entry?.points.map((point) => toNumber(point.value)) ?? [],
      display: entry?.points.map((point) => count(toNumber(point.value))) ?? [] };
    return (
      <ChartOrTable labels={viewLabels}
        chart={<ColumnChart label={label} dates={parsed.dates} series={series} locale={locale} formatTick={count} />}
        table={<SeriesTable caption={label} dates={parsed.dates} series={[series]} locale={locale} labels={tableLabels}
          totals={entry?.total !== undefined ? [count(toNumber(entry.total))] : undefined} />}
      />
    );
  };

  /** One small chart per currency: amounts in different currencies never share an axis or a sum. */
  const moneyCharts = (metric: 'revenue' | 'refunds', label: string) => {
    const response = loaded.series[metric];
    if (response && !response.available) return <EmptyState>{unavailable}</EmptyState>;
    const parsed = daily(response);
    if (!parsed) return <ErrorState message={tx('无法加载该指标。', 'This metric could not be loaded.')} />;
    if (!parsed.series.length) return <EmptyState>{tx('该时间范围内没有记录。', 'Nothing in this range.')}</EmptyState>;
    return (
      <div className="grid gap-6 lg:grid-cols-2">
        {parsed.series.map((entry) => {
          const currency = entry.key, caption = `${label} · ${currency}`;
          const series: ChartSeries = { key: currency, label: currency, slot: 0, values: entry.points.map((point) => toNumber(point.value)),
            display: entry.points.map((point) => formatMoney(String(point.value), currency, locale)) };
          return (
            <section key={currency} aria-label={caption} className="min-w-0">
              <h3 className="mb-1 text-sm font-medium">{currency}</h3>
              <ChartOrTable labels={viewLabels}
                chart={<LineChart label={caption} dates={parsed.dates} series={[series]} locale={locale}
                  formatTick={(tick) => formatMoney(String(tick), currency, locale, true)} />}
                table={<SeriesTable caption={caption} dates={parsed.dates} series={[series]} locale={locale} labels={tableLabels}
                  totals={[formatMoney(String(entry.total ?? '0'), currency, locale)]} />}
              />
            </section>
          );
        })}
      </div>
    );
  };

  const creditsChart = () => {
    const granted = loaded.series['credits-granted'], consumed = loaded.series['credits-consumed'];
    if ((granted && !granted.available) && (consumed && !consumed.available)) return <EmptyState>{unavailable}</EmptyState>;
    const parts = [
      { parsed: daily(granted), key: 'granted', label: tx('发放', 'Granted'), slot: 0 },
      { parsed: daily(consumed), key: 'consumed', label: tx('消耗', 'Consumed'), slot: 1 },
    ].filter((part) => part.parsed);
    const dates = parts[0]?.parsed?.dates ?? [];
    if (!parts.length) return <ErrorState message={tx('无法加载该指标。', 'This metric could not be loaded.')} />;
    const series: ChartSeries[] = parts.map((part) => {
      const points = part.parsed!.series[0]?.points ?? [];
      return { key: part.key, label: part.label, slot: part.slot, values: points.map((point) => toNumber(point.value)), display: points.map((point) => count(toNumber(point.value))) };
    });
    const caption = tx('积分', 'Credits');
    return (
      <ChartOrTable labels={viewLabels}
        chart={<LineChart label={caption} dates={dates} series={series} locale={locale} formatTick={count} integer />}
        table={<SeriesTable caption={caption} dates={dates} series={series} locale={locale} labels={tableLabels}
          totals={parts.map((part) => { const total = part.parsed!.series[0]?.total; return total === undefined ? null : count(toNumber(total)); })} />}
      />
    );
  };

  const aiChart = () => {
    const response = loaded.series['ai-tasks'];
    if (response && !response.available) return <EmptyState>{unavailable}</EmptyState>;
    const parsed = daily(response);
    if (!parsed) return <ErrorState message={tx('无法加载该指标。', 'This metric could not be loaded.')} />;
    const statusLabel: Record<string, string> = {
      completed: tx('成功', 'Completed'), failed: tx('失败', 'Failed'), cancelled: tx('已取消', 'Cancelled'), in_progress: tx('进行中', 'In progress'),
    };
    const series: ChartSeries[] = AI_STATUSES.flatMap((status, slot) => {
      const entry = parsed.series.find((candidate) => candidate.key === status);
      return entry ? [{ key: status, label: statusLabel[status]!, slot, values: entry.points.map((point) => toNumber(point.value)),
        display: entry.points.map((point) => count(toNumber(point.value))) }] : [];
    });
    const caption = tx('AI 任务', 'AI tasks');
    return (
      <ChartOrTable labels={viewLabels}
        chart={<LineChart label={caption} dates={parsed.dates} series={series} locale={locale} formatTick={count} integer />}
        table={<SeriesTable caption={caption} dates={parsed.dates} series={series} locale={locale} labels={tableLabels}
          totals={series.map((entry) => { const total = parsed.series.find((candidate) => candidate.key === entry.key)?.total; return total === undefined ? null : count(toNumber(total)); })} />}
      />
    );
  };

  const sources = metrics['signups-by-source'];
  const active = metrics['active-subscriptions'];
  const aiTasks = metrics['ai-tasks'];
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Tile label={tx('收入', 'Revenue')}>{metrics.revenue.available ? money(metrics.revenue.totals) : unavailable}</Tile>
        <Tile label={tx('退款', 'Refunds')}>{metrics.refunds.available ? money(metrics.refunds.totals) : unavailable}</Tile>
        <Tile label={tx('新注册用户', 'New users')}>{value(metrics['new-users'])}</Tile>
        <Tile label={tx('付费用户', 'Paying users')}>{value(metrics['paying-users'])}</Tile>
        <Tile label={tx('有效订阅（当前）', 'Active subscriptions (now)')}
          hint={active.available ? tx(`其中支付商订阅 ${count(active.provider)}`, `${count(active.provider)} billed by a payment provider`) : undefined}>
          {value(active)}
        </Tile>
        <Tile label={tx('发放积分', 'Credits granted')}>{value(metrics['credits-granted'])}</Tile>
        <Tile label={tx('消耗积分', 'Credits consumed')}>{value(metrics['credits-consumed'])}</Tile>
        <Tile label={tx('AI 任务', 'AI tasks')}>{value(aiTasks)}</Tile>
        <Tile label={tx('聊天消息', 'Chat messages')}>{value(metrics['chat-messages'])}</Tile>
      </div>
      <Panel title={tx('收入（按币种）', 'Revenue by currency')}>{moneyCharts('revenue', tx('收入', 'Revenue'))}</Panel>
      <Panel title={tx('退款（按币种）', 'Refunds by currency')}>{moneyCharts('refunds', tx('退款', 'Refunds'))}</Panel>
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title={tx('新注册用户', 'New users')}>{countChart('new-users', tx('新注册用户', 'New users'))}</Panel>
        <Panel title={tx('付费用户', 'Paying users')}>{countChart('paying-users', tx('付费用户', 'Paying users'))}</Panel>
        <Panel title={tx('积分', 'Credits')}>{creditsChart()}</Panel>
        <Panel title={tx('AI 任务', 'AI tasks')}>{aiChart()}</Panel>
        <Panel title={tx('聊天消息', 'Chat messages')}>{countChart('chat-messages', tx('聊天消息', 'Chat messages'))}</Panel>
        <Panel title={tx('注册来源（前 10）', 'Sign-up sources (top 10)')}>
          {!sources.available ? <EmptyState>{unavailable}</EmptyState> : sources.items.length ? (
            <div className="space-y-3">
              <RankBars label={tx('注册来源', 'Sign-up sources')} items={sources.items.map((item) => ({ key: item.source, value: item.count, text: count(item.count) }))} />
              <p className="text-xs text-muted-foreground">{tx(`无来源标记：${count(sources.unattributed)}`, `Without a source: ${count(sources.unattributed)}`)}</p>
            </div>
          ) : <EmptyState>{tx('该时间范围内没有带来源的注册。', 'No attributed sign-ups in this range.')}</EmptyState>}
        </Panel>
      </div>
    </>
  );
}
