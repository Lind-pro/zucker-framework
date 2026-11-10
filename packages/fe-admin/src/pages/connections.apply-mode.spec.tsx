import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin } from '../test/harness';

const textField = { key: 'GOOGLE_CLIENT_ID', label: 'Client ID', type: 'text', configured: true, source: 'environment', value: 'id' };
const base = {
  category: 'Sign-in',
  storedRevision: 3,
  appliedRevision: 3,
  pendingRestart: false,
  canSave: true,
  saveUnavailableReason: null,
  fields: [textField],
};
const summary = (id: string, name: string) => ({
  id,
  name,
  category: 'Sign-in',
  source: 'server-environment',
  status: 'configured',
  enabled: true,
  missing: [],
  sdkAvailable: null,
  note: 'note',
});
const profiles = [
  // pendingRestart is true on purpose: a hot profile must never show it.
  { ...base, id: 'hot-one', name: 'Hot one', applyMode: 'hot', pendingRestart: true },
  { ...base, id: 'restart-one', name: 'Restart one', applyMode: 'restart', pendingRestart: true },
  { ...base, id: 'legacy-one', name: 'Legacy one', pendingRestart: true },
];
const routes = () => ({
  'GET /menu/tree': [],
  'GET /management/connections': {
    checkedAt: '2026-11-09T00:00:00.000Z',
    connections: profiles.map((profile) => summary(profile.id, profile.name)),
  },
  'GET /management/connection-settings': { profiles },
  ...Object.fromEntries(profiles.map((profile) => [`GET /management/connection-settings/${profile.id}`, profile])),
});
const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const rowOf = async (name: string) => {
  const table = await screen.findByRole('table', { name: 'Connections' });
  return within(table).getByText(name).closest('tr') as HTMLElement;
};

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('connections apply mode', () => {
  it('shows hot and restart badges, hides restart pending for hot, and keeps legacy rows unchanged', async () => {
    const server = createMockServer(routes());
    renderAdmin({ httpAdapter: server.adapter as never, locales }, { path: '/connections', permissions: ['config:query'] });
    const hot = within(await rowOf('Hot one'));
    expect(hot.getByText('Applies immediately')).toBeTruthy();
    expect(hot.queryByText('Server restart pending')).toBeNull();
    const restart = within(await rowOf('Restart one'));
    expect(restart.getByText('Applies after restart')).toBeTruthy();
    expect(restart.getByText('Server restart pending')).toBeTruthy();
    const legacy = within(await rowOf('Legacy one'));
    expect(legacy.queryByText('Applies immediately')).toBeNull();
    expect(legacy.queryByText('Applies after restart')).toBeNull();
    expect(legacy.getByText('Server restart pending')).toBeTruthy();
    expect(screen.getByText(/Each connection shows whether saved settings apply immediately/)).toBeTruthy();
  });

  it('shows the legacy notice when no profile reports an apply mode', async () => {
    const legacy = profiles.filter((profile) => profile.id === 'legacy-one');
    const server = createMockServer({
      ...routes(),
      'GET /management/connections': { checkedAt: '2026-11-09T00:00:00.000Z', connections: [summary('legacy-one', 'Legacy one')] },
      'GET /management/connection-settings': { profiles: legacy },
    });
    renderAdmin({ httpAdapter: server.adapter as never, locales }, { path: '/connections', permissions: ['config:query'] });
    await rowOf('Legacy one');
    expect(screen.getByText(/Saved settings apply after a server restart\./)).toBeTruthy();
  });

  async function saveOne(name: string, saved: Record<string, unknown>) {
    const server = createMockServer({ ...routes(), [`PUT /management/connection-settings/${saved.id}`]: { status: 200, data: saved } });
    renderAdmin({ httpAdapter: server.adapter as never, locales }, { path: '/connections', permissions: ['config:query', 'config:update'] });
    fireEvent.click(within(await rowOf(name)).getByRole('button', { name: 'Edit settings' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Client ID action' }), { target: { value: 'replace' } });
    fireEvent.change(await within(dialog).findByLabelText(/New Client ID/), { target: { value: 'new-id' } });
    return { server, dialog };
  }

  it('hot save says it applied immediately and never mentions a pending restart', async () => {
    const { server, dialog } = await saveOne('Hot one', { ...profiles[0], storedRevision: 4, appliedRevision: 4, pendingRestart: false });
    expect(within(dialog).getByText(/Changes apply as soon as they are saved/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save encrypted' }));
    expect(await screen.findByText('Saved encrypted and applied immediately')).toBeTruthy();
    expect(screen.queryByText('Saved encrypted; applies after a server restart')).toBeNull();
    const [put] = server.find('PUT', '/management/connection-settings/hot-one');
    expect(put?.body).toMatchObject({ expectedRevision: 3, values: { GOOGLE_CLIENT_ID: 'new-id' } });
  });

  it('restart save keeps the pending-restart message', async () => {
    const { dialog } = await saveOne('Restart one', { ...profiles[1], storedRevision: 4, appliedRevision: 3, pendingRestart: true });
    expect(within(dialog).getByText(/Changes apply after a server restart/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save encrypted' }));
    await waitFor(() => expect(screen.getByText('Saved encrypted; applies after a server restart')).toBeTruthy());
  });
});
