import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, meResponse, renderAdmin, type MockRequest } from '../test/harness';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

const odd = { id: 'a/b?c#d e', username: 'odd', email: 'odd@example.test', name: 'Odd', status: true, typeId: 'member' };

function mount(passwordReset: { path: string; method?: 'POST' | 'PUT' | 'PATCH'; minLength?: number }, handlers: Record<string, unknown> = {}) {
  const mock = createMockServer({
    'GET /menu/tree': [],
    'GET /authorize/me': meResponse(['*']),
    'POST /users/_query': { data: [odd], total: 1 },
    ...handlers,
  });
  renderAdmin({ httpAdapter: mock.adapter as never, users: { passwordReset } }, { path: '/users', permissions: ['*'] });
  return mock;
}
async function open() {
  fireEvent.click((await screen.findAllByRole('button', { name: '重置密码' }))[0]!);
  return screen.findByRole('dialog');
}
const fill = (dialog: HTMLElement, password: string, confirm = password) => {
  fireEvent.change(within(dialog).getByLabelText(/^新密码/), { target: { value: password } });
  fireEvent.change(within(dialog).getByLabelText(/确认新密码/), { target: { value: confirm } });
};
const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: '重置密码' }));
const resetCalls = (mock: ReturnType<typeof mount>) => mock.calls.filter(call => call.url.startsWith('/admin/') || call.url.startsWith('/users/') && call.method !== 'POST');

describe('users.passwordReset edge cases', () => {
  it('encodes the user id into the path and keeps the password out of the URL, query and headers', async () => {
    const encoded = `/admin/${encodeURIComponent(odd.id)}/password`;
    const mock = mount({ path: '/admin/:id/password', method: 'PATCH' }, { [`PATCH ${encoded}`]: { data: {} } });
    const dialog = await open();
    fill(dialog, 'synthetic-secret-1');
    submit(dialog);
    await waitFor(() => expect(mock.find('PATCH', encoded)).toHaveLength(1));
    const call = mock.find('PATCH', encoded)[0] as MockRequest;
    expect(call.body).toEqual({ password: 'synthetic-secret-1' });
    expect(call.url).not.toContain('synthetic-secret-1');
    expect(JSON.stringify(call.params)).not.toContain('synthetic-secret-1');
    expect(JSON.stringify(call.headers)).not.toContain('synthetic-secret-1');
    expect(call.url).not.toContain('#');
    expect(call.url).not.toContain('?');
  });

  it('blocks a mismatch without a minimum length, and sends nothing for a blank confirmation', async () => {
    const mock = mount({ path: '/admin/:id/password' });
    const dialog = await open();
    fill(dialog, 'one-password', 'another-password');
    submit(dialog);
    expect(await within(dialog).findByText('两次输入的密码不一致')).toBeTruthy();
    fill(dialog, 'one-password', '');
    submit(dialog);
    await act(async () => { await Promise.resolve(); });
    expect(resetCalls(mock)).toHaveLength(0);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('sends exactly one request when the submit button is pressed repeatedly', async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const encoded = `/admin/${encodeURIComponent(odd.id)}/password`;
    const mock = mount({ path: '/admin/:id/password' }, { [`POST ${encoded}`]: async () => { await gate; return { data: {} }; } });
    const dialog = await open();
    fill(dialog, 'synthetic-secret-2');
    submit(dialog); submit(dialog); submit(dialog);
    await waitFor(() => expect(mock.find('POST', encoded).length).toBeGreaterThan(0));
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.find('POST', encoded)).toHaveLength(1);
  });

  it('drops the typed password when the dialog is cancelled and reopened', async () => {
    const mock = mount({ path: '/admin/:id/password' });
    let dialog = await open();
    fill(dialog, 'synthetic-secret-3');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await open();
    expect((within(dialog).getByLabelText(/^新密码/) as HTMLInputElement).value).toBe('');
    expect((within(dialog).getByLabelText(/确认新密码/) as HTMLInputElement).value).toBe('');
    expect(resetCalls(mock)).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain('synthetic-secret-3');
  });

  it('the dialog fields are new-password inputs the browser must not autofill from saved logins', async () => {
    mount({ path: '/admin/:id/password' });
    const dialog = await open();
    for (const input of within(dialog).getAllByLabelText(/密码/)) {
      expect((input as HTMLInputElement).type).toBe('password');
      expect((input as HTMLInputElement).autocomplete).toBe('new-password');
    }
  });
});
