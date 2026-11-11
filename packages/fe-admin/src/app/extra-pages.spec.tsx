/* Product pages (`extraPages`) run inside the shell's data router and can use the kit. */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { Link, useBlocker, useParams, useSearchParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../components/button';
import { ResourceTable } from '../components/data-table';
import { PageContainer } from '../components/layout';
import { crudLoader } from '../pages/shared';
import { createMockServer, renderAdmin } from '../test/harness';
import { useAdminApi } from './context';
import { findPage, matchesPath } from './menu';
import type { AdminPageDefinition } from './config';

function ReportList() {
  const api = useAdminApi();
  return (
    <PageContainer title="Reports">
      <ResourceTable<{ id: string; name: string }>
        label="Reports"
        load={crudLoader(api, '/reports')}
        rowKey={(row) => row.id}
        columns={[{ key: 'name', title: 'Name', render: (row) => <Link to={`/reports/${row.id}?tab=raw`}>{row.name}</Link> }]}
      />
    </PageContainer>
  );
}

function ReportDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const [dirty, setDirty] = useState(false);
  // useBlocker exists only in a data router (createBrowserRouter / createMemoryRouter).
  const blocker = useBlocker(dirty);
  return (
    <PageContainer title={`Report ${id}`}>
      <p>tab:{params.get('tab')}</p>
      <Button onClick={() => setParams({ tab: 'chart' })}>Chart</Button>
      <Button onClick={() => setDirty(true)}>Edit</Button>
      {blocker.state === 'blocked' && (
        <div role="alertdialog" aria-label="Unsaved">
          <Button onClick={() => blocker.reset?.()}>Stay</Button>
          <Button onClick={() => blocker.proceed?.()}>Leave</Button>
        </div>
      )}
    </PageContainer>
  );
}

const extraPages: AdminPageDefinition[] = [
  { key: 'reports', path: '/reports', title: { 'zh-CN': '报表', 'en-US': 'Reports' }, permission: 'reports:query', component: ReportList },
  { key: 'report', path: '/reports/:id', title: '报表详情', permission: 'reports:query', component: ReportDetail, hideInQuickLinks: true },
];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('matchesPath with route parameters', () => {
  it('matches one non-empty segment per :param and picks the most specific page', () => {
    expect(matchesPath('/reports/42', '/reports/:id')).toBe(true);
    expect(matchesPath('/reports/42/history', '/reports/:id')).toBe(true);
    expect(matchesPath('/reports', '/reports/:id')).toBe(false);
    expect(matchesPath('/reports//', '/reports/:id')).toBe(false);
    expect(matchesPath('/other/42', '/reports/:id')).toBe(false);
    expect(findPage(extraPages, '/reports/42')?.key).toBe('report');
    expect(findPage(extraPages, '/reports')?.key).toBe('reports');
  });
});

describe('extraPages in the data router', () => {
  it('use kit components, params, search params and navigation blocking', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'POST /reports/_query': { data: [{ id: '42', name: 'Weekly' }], total: 1 },
    });
    const app = renderAdmin({ httpAdapter: server.adapter as never, extraPages }, { path: '/reports', permissions: ['reports:query'] });
    const table = await screen.findByRole('table', { name: 'Reports' });
    fireEvent.click(await within(table).findByRole('link', { name: 'Weekly' }));
    expect(await screen.findByText('tab:raw')).toBeTruthy();
    expect(app.router.state.location.pathname).toBe('/reports/42');

    fireEvent.click(screen.getByRole('button', { name: 'Chart' }));
    expect(await screen.findByText('tab:chart')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await act(async () => {
      await app.router.navigate('/reports');
    });
    const prompt = await screen.findByRole('alertdialog', { name: 'Unsaved' });
    expect(app.router.state.location.pathname).toBe('/reports/42');
    fireEvent.click(within(prompt).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/reports'));
  });

  it('gate parameterized pages by permission like built-in pages', async () => {
    const server = createMockServer({ 'GET /menu/tree': [] });
    renderAdmin({ httpAdapter: server.adapter as never, extraPages }, { path: '/reports/42', permissions: ['users:query'] });
    expect(await screen.findByRole('heading', { name: '没有访问权限' })).toBeTruthy();
  });
});
