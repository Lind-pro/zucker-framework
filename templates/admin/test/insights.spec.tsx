/** Component tests for the operations insights page (features/insights). */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin, type MockRequest } from '../../../packages/fe-admin/src/test/harness';
import { insightPages, niceTicks } from '../src/features/insights';

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const range = { days: 3, tz: 'UTC', from: '2026-03-08', to: '2026-03-10', asOf: '2026-03-10T16:00:00.000Z' };
const dates = ['2026-03-08', '2026-03-09', '2026-03-10'];
const points = (values: Array<number | string>) => values.map((value, index) => ({ date: dates[index]!, value }));

const summary = {
  range,
  metrics: {
    revenue: { available: true, totals: [{ currency: 'EUR', amount: '8.50' }, { currency: 'USD', amount: '50.00' }] },
    refunds: { available: true, totals: [] },
    'new-users': { available: true, value: 2 },
    'paying-users': { available: true, value: 2 },
    'active-subscriptions': { available: true, value: 1, provider: 1 },
    'credits-granted': { available: true, value: 150 },
    'credits-consumed': { available: true, value: 30 },
    'ai-tasks': { available: true, value: 3, breakdown: [] },
    'chat-messages': { available: false },
    'signups-by-source': { available: true, items: [{ source: 'google', count: 2 }], attributed: 2, unattributed: 1 },
  },
};

function seriesFor(metric: string) {
  const head = { metric, range };
  switch (metric) {
    case 'revenue':
      return { ...head, unit: 'money', available: true, kind: 'daily', series: [
        { key: 'EUR', total: '8.50', points: points(['0', '8.50', '0']) },
        { key: 'USD', total: '50.00', points: points(['0', '30.00', '20.00']) }] };
    case 'refunds':
      return { ...head, unit: 'money', available: true, kind: 'daily', series: [] };
    case 'chat-messages':
      return { ...head, unit: 'count', available: false };
    case 'paying-users':
      return { ...head, unit: 'count', available: true, kind: 'daily', series: [{ key: 'total', points: points([0, 2, 1]) }] };
    case 'ai-tasks':
      return { ...head, unit: 'count', available: true, kind: 'daily', series: [
        { key: 'completed', total: 1, points: points([0, 1, 0]) }, { key: 'failed', total: 1, points: points([0, 0, 1]) }] };
    default:
      return { ...head, unit: 'count', available: true, kind: 'daily', series: [{ key: 'total', total: 2, points: points([1, 1, 0]) }] };
  }
}

function mount(permissions = ['insights:query']) {
  const server = createMockServer({
    'GET /menu/tree': [],
    'GET /management/insights/summary': summary,
    'GET /management/insights/series': (request: MockRequest) => ({ data: seriesFor(String(request.params.metric)) }),
  });
  renderAdmin({ httpAdapter: server.adapter as never, locales, extraPages: insightPages }, { path: '/insights', permissions });
  return server;
}

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('insights page', () => {
  it('keeps currencies apart and offers the same data as a table', async () => {
    const server = mount();
    const revenue = await screen.findByRole('region', { name: 'Revenue · USD' });
    expect(screen.getByRole('region', { name: 'Revenue · EUR' })).toBeTruthy();
    expect(within(revenue).getByRole('img', { name: 'Revenue · USD' })).toBeTruthy();
    fireEvent.click(within(revenue).getByRole('button', { name: 'Table' }));
    const table = within(revenue).getByRole('table', { name: 'Revenue · USD' });
    expect(within(table).getAllByRole('row')).toHaveLength(5); // header, three days (zero day included), total
    expect(table.textContent).toContain('$30.00');
    expect(table.textContent).toContain('$50.00');
    expect(table.textContent).not.toContain('€');
    const summaryCall = server.find('GET', '/management/insights/summary')[0]!;
    expect(summaryCall.params).toMatchObject({ days: 30 });
    expect(typeof summaryCall.params.tz).toBe('string');
    expect(server.find('GET', '/management/insights/series').map((call) => call.params.metric)).not.toContain('signups-by-source');
  });

  it('shows unavailable metrics, empty ranges and the source ranking', async () => {
    mount();
    expect(await screen.findByText('Nothing in this range.')).toBeTruthy();
    expect(screen.getAllByText('Not installed').length).toBeGreaterThanOrEqual(2); // tile and panel
    expect(screen.getByRole('list', { name: 'Sign-up sources' }).textContent).toContain('google');
    expect(screen.getByText('Without a source: 1')).toBeTruthy();
    expect(screen.getByText('1 billed by a payment provider')).toBeTruthy();
  });

  it('reloads with the chosen range', async () => {
    const server = mount();
    await screen.findByRole('region', { name: 'Revenue · USD' });
    fireEvent.change(screen.getByLabelText('Range'), { target: { value: '7' } });
    await waitFor(() => expect(server.find('GET', '/management/insights/summary').some((call) => call.params.days === 7)).toBe(true));
  });

  it('niceTicks gives clean, whole steps for counts', () => {
    expect(niceTicks(2, 4, true)).toEqual([0, 1, 2]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(95)).toEqual([0, 25, 50, 75, 100]);
  });
});
