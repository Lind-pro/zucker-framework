import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockServer, meResponse, renderAdmin } from '../test/harness';

const THIRTY_SECONDS = 30_000;
let now = 1_700_000_000_000;

function setup(reloadOnFocus: boolean | undefined, permissions = ['users:query', 'roles:query']) {
  let me = meResponse(permissions);
  const server = createMockServer({
    'GET /menu/tree': [],
    'GET /authorize/me': () => ({ data: me }),
    'POST /users/_query': { data: [], total: 0 },
    'POST /users/_count': { total: 0 },
  });
  const app = renderAdmin({ httpAdapter: server.adapter as never, ...(reloadOnFocus === undefined ? {} : { session: { reloadOnFocus } }) },
    { path: '/users', permissions });
  return { app, server, setMe: (next: ReturnType<typeof meResponse>) => { me = next; }, meCalls: () => server.find('GET', '/authorize/me').length };
}
const fire = async (type: 'focus' | 'online') => { await act(async () => { window.dispatchEvent(new Event(type)); await Promise.resolve(); }); };
const advance = (ms: number) => { now += ms; };

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('session.reloadOnFocus', () => {
  it('is off by default: focus and online never re-read the account', async () => {
    const { meCalls } = setup(undefined);
    await screen.findByRole('heading', { level: 1, name: '用户' });
    advance(10 * THIRTY_SECONDS);
    await fire('focus'); await fire('online');
    expect(meCalls()).toBe(0);
  });

  it('does nothing within 30 s of mounting or of the previous reload (throttled), then reloads once per window', async () => {
    const { meCalls } = setup(true);
    await screen.findByRole('heading', { level: 1, name: '用户' });
    await fire('focus');
    advance(THIRTY_SECONDS - 1);
    await fire('focus'); await fire('online');
    expect(meCalls()).toBe(0);
    advance(1);
    await fire('focus');
    expect(meCalls()).toBe(1);
    // Burst after a reload is throttled across both events.
    await fire('focus'); await fire('online'); await fire('focus');
    expect(meCalls()).toBe(1);
    advance(THIRTY_SECONDS);
    await fire('online');
    expect(meCalls()).toBe(2);
  });

  it('applies revoked and granted permissions without a reload', async () => {
    const { app, setMe, meCalls } = setup(true, ['users:query', 'roles:query']);
    await screen.findByRole('heading', { level: 1, name: '用户' });
    expect(app.session.store.getState().permissions).toEqual(expect.arrayContaining(['users:query', 'roles:query']));
    setMe(meResponse(['users:query', 'dictionary:query']));
    advance(THIRTY_SECONDS);
    await fire('focus');
    await vi.waitFor(() => expect(app.session.store.getState().permissions).toContain('dictionary:query'));
    expect(app.session.store.getState().permissions).not.toContain('roles:query');
    expect(meCalls()).toBe(1);
  });

  it('ignores a failed reload: no crash, the session stays and the next window retries', async () => {
    const { app, server, setMe, meCalls } = setup(true);
    await screen.findByRole('heading', { level: 1, name: '用户' });
    server.set('GET /authorize/me', { status: 500, data: { message: 'down' } });
    advance(THIRTY_SECONDS);
    await fire('focus');
    await vi.waitFor(() => expect(meCalls()).toBe(1));
    expect(app.session.store.getState().token).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: '用户' })).toBeTruthy();
    // A malformed answer is ignored too.
    server.set('GET /authorize/me', { data: { nope: true } });
    advance(THIRTY_SECONDS);
    await fire('focus');
    await vi.waitFor(() => expect(meCalls()).toBe(2));
    expect(app.session.store.getState().permissions).toContain('users:query');
    server.set('GET /authorize/me', () => ({ data: meResponse(['users:query']) }));
    setMe(meResponse(['users:query']));
    advance(THIRTY_SECONDS);
    await fire('online');
    await vi.waitFor(() => expect(meCalls()).toBe(3));
  });

  it('does not apply an answer for a different account', async () => {
    const { app, setMe, meCalls } = setup(true);
    await screen.findByRole('heading', { level: 1, name: '用户' });
    setMe(meResponse(['*'], 'someone-else'));
    advance(THIRTY_SECONDS);
    await fire('focus');
    await vi.waitFor(() => expect(meCalls()).toBe(1));
    expect(app.session.store.getState().permissions).not.toContain('*');
    expect(app.session.store.getState().user?.id).toBe('admin-1');
  });

  it('does not read the account when signed out, and stops listening after unmount', async () => {
    const { app, meCalls } = setup(true);
    await screen.findByRole('heading', { level: 1, name: '用户' });
    act(() => { app.session.store.getState().logout(); });
    advance(THIRTY_SECONDS);
    await fire('focus');
    expect(meCalls()).toBe(0);
    cleanup();
    advance(THIRTY_SECONDS);
    await fire('focus');
    expect(meCalls()).toBe(0);
  });
});
