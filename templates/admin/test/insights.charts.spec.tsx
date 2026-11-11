/** Insights page additions (WP 3.5b, Sonnet): UTC fallback notice, chart tooltips and the AI-task legend. */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockServer, renderAdmin, type MockRequest } from '../../../packages/fe-admin/src/test/harness';
import { insightPages } from '../src/features/insights';

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const dates = ['2026-03-08', '2026-03-09', '2026-03-10'];
const rangeFor = (tz: string) => ({ days: 30, tz, from: '2026-03-08', to: '2026-03-10', asOf: '2026-03-10T16:00:00.000Z' });
const points = (values: Array<number | string>) => values.map((value, index) => ({ date: dates[index]!, value }));
const available = (value: number) => ({ available: true, value });

const summaryFor = (tz: string) => ({
  range: rangeFor(tz),
  metrics: {
    revenue: { available: true, totals: [{ currency: 'USD', amount: '50.00' }] },
    refunds: { available: true, totals: [] },
    'new-users': available(3), 'paying-users': available(2), 'active-subscriptions': { available: true, value: 1, provider: 0 },
    'credits-granted': available(150), 'credits-consumed': available(30),
    'ai-tasks': { available: true, value: 3, breakdown: [] }, 'chat-messages': available(2),
    'signups-by-source': { available: true, items: [], attributed: 0, unattributed: 0 },
  },
});

function seriesFor(metric: string, tz: string) {
  const head = { metric, range: rangeFor(tz) };
  switch (metric) {
    case 'revenue':
      return { ...head, unit: 'money', available: true, kind: 'daily', series: [{ key: 'USD', total: '50.00', points: points(['0', '30.00', '20.00']) }] };
    case 'refunds':
      return { ...head, unit: 'money', available: true, kind: 'daily', series: [] };
    case 'credits-granted':
    case 'credits-consumed':
      return { ...head, unit: 'credits', available: true, kind: 'daily', series: [{ key: 'total', total: 5, points: points([1, 2, 2]) }] };
    case 'ai-tasks':
      // `failed` and `in_progress` only: each keeps its own palette slot (1 and 3) whatever else is present.
      return { ...head, unit: 'count', available: true, kind: 'daily', series: [
        { key: 'failed', total: 2, points: points([0, 1, 1]) }, { key: 'in_progress', total: 1, points: points([0, 0, 1]) }] };
    default:
      return { ...head, unit: 'count', available: true, kind: 'daily', series: [{ key: 'total', total: 3, points: points([1, 2, 0]) }] };
  }
}

function mount(handlers: { summary?: (request: MockRequest) => unknown } = {}) {
  const server = createMockServer({
    'GET /menu/tree': [],
    'GET /management/insights/summary': handlers.summary ?? ((request: MockRequest) => ({ data: summaryFor(String(request.params.tz)) })),
    'GET /management/insights/series': (request: MockRequest) => ({ data: seriesFor(String(request.params.metric), String(request.params.tz)) }),
  });
  renderAdmin({ httpAdapter: server.adapter as never, locales, extraPages: insightPages }, { path: '/insights', permissions: ['insights:query'] });
  return server;
}

/** The chart `<div>` that owns an `<svg role="img" aria-label=…>`. */
const chartOf = (name: string) => screen.getByRole('img', { name }).parentElement!;

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('insights page: time zone fallback', () => {
  it('falls back to UTC with a notice when the server rejects the browser zone', async () => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...original.call(this), timeZone: 'Pacific/Synthetic' };
    });
    const server = mount({
      summary: (request) => request.params.tz === 'UTC'
        ? { data: summaryFor('UTC') }
        : { status: 400, data: { code: 'INSIGHTS_INVALID', message: 'tz is not supported by the database' } },
    });
    expect(await screen.findByText("The server does not support this browser's time zone; showing UTC.")).toBeTruthy();
    await screen.findByRole('region', { name: 'Revenue · USD' });
    const zones = server.find('GET', '/management/insights/summary').map((call) => call.params.tz);
    expect(zones[0]).toBe('Pacific/Synthetic');
    expect(zones.at(-1)).toBe('UTC');
    // Every series request after the fallback uses UTC; none carries the rejected zone.
    expect(server.find('GET', '/management/insights/series').every((call) => call.params.tz === 'UTC')).toBe(true);
    expect(screen.getByText(/· UTC$/)).toBeTruthy();
  });

  it('shows no notice when the browser zone is accepted', async () => {
    mount();
    await screen.findByRole('region', { name: 'Revenue · USD' });
    expect(screen.queryByText(/does not support this browser's time zone/)).toBeNull();
  });
});

describe('insights page: tooltips', () => {
  it('a column shows its day and formatted value on hover and hides on leave', async () => {
    mount();
    await screen.findByRole('region', { name: 'Revenue · USD' });
    const chart = chartOf('New users');
    expect(within(chart).queryByRole('status')).toBeNull();
    const columns = chart.querySelectorAll('svg > rect');
    expect(columns).toHaveLength(dates.length);
    fireEvent.pointerEnter(columns[1]!);
    const tooltip = within(chart).getByRole('status');
    expect(tooltip.textContent).toContain('Mar 9');
    expect(tooltip.textContent).toContain('New users');
    expect(tooltip.textContent).toContain('2');
    fireEvent.pointerLeave(columns[1]!);
    expect(within(chart).queryByRole('status')).toBeNull();
  });

  it('a line follows the pointer to the nearest day and formats money in its currency', async () => {
    mount();
    await screen.findByRole('region', { name: 'Revenue · USD' });
    const chart = chartOf('Revenue · USD');
    const surface = Array.from(chart.querySelectorAll('svg > rect')).at(-1)!;
    // jsdom has no layout: give the hover surface a 100px box and move to its far right.
    surface.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 10, width: 100, height: 10, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(surface, { clientX: 100 });
    const tooltip = within(chart).getByRole('status');
    expect(tooltip.textContent).toContain('Mar 10');
    expect(tooltip.textContent).toContain('$20.00');
    fireEvent.pointerMove(surface, { clientX: 50 });
    expect(within(chart).getByRole('status').textContent).toContain('$30.00');
    fireEvent.pointerLeave(surface);
    expect(within(chart).queryByRole('status')).toBeNull();
  });
});

describe('insights page: AI task legend', () => {
  it('names every drawn status, with distinct swatches, and single series charts have no legend', async () => {
    mount();
    await screen.findByRole('region', { name: 'Revenue · USD' });
    const ai = chartOf('AI tasks');
    const legend = within(ai).getByRole('list');
    const items = within(legend).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['Failed', 'In progress']);
    const swatches = items.map((item) => (item.querySelector('span[aria-hidden]') as HTMLElement).style.background);
    expect(swatches[0]).toBeTruthy();
    expect(swatches[0]).not.toBe(swatches[1]);
    // The lines are drawn in the same colours as the legend swatches.
    const stroke = (key: string) => ai.querySelector(`g[data-series="${key}"] path`)!.getAttribute('stroke');
    expect([stroke('failed'), stroke('in_progress')]).toEqual(swatches);
    // The credits chart has two series (granted/consumed) and a legend; one-series charts have none.
    expect(within(chartOf('Credits')).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Granted', 'Consumed']);
    expect(within(chartOf('New users')).queryByRole('list')).toBeNull();
    expect(within(chartOf('Revenue · USD')).queryByRole('list')).toBeNull();
  });

  it('labels statuses in Chinese', async () => {
    localStorage.setItem('zucker-admin-locale', 'zh-CN');
    mount();
    const ai = await waitFor(() => chartOf('AI 任务'));
    expect(within(within(ai).getByRole('list')).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['失败', '进行中']);
  });
});
