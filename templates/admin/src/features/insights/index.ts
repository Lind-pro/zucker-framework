import type { AdminPageDefinition } from '@zucker-framework/fe-admin';
import { ChartLine } from 'lucide-react';
import { InsightsPage } from './insights-page';

/**
 * Operations insights (aggregates of revenue, sign-ups, credits and AI usage). Requires
 * `insights:query`, kept apart from `dashboard:query` because it shows revenue. Register with
 * `...insightPages` in `features/index.ts`; the menu entry comes from the server's menu records.
 */
export const insightPages: AdminPageDefinition[] = [
  {
    key: 'insights',
    path: '/insights',
    title: { 'zh-CN': '运营洞察', 'en-US': 'Insights' },
    permission: 'insights:query',
    component: InsightsPage,
    icon: ChartLine,
  },
];

export { InsightsPage } from './insights-page';
export { ColumnChart, LineChart, RankBars, SeriesTable, type ChartSeries } from './charts';
export { formatMoney, niceTicks, type InsightSeries, type InsightSummary } from './format';
