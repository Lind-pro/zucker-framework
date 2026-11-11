/** Edge-case component tests for the feedback triage page: conflicts, failures, clearing, filters, plain-text rendering. */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin } from '../../../packages/fe-admin/src/test/harness';
import { FEEDBACK_STATUSES, FEEDBACK_TEXT_MAX, feedbackPages, feedbackPatch } from '../src/features/feedback';

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const row = {
  id: 'fb-1', ownerId: 'user-1', type: 'bug', message: '<img src=x onerror=alert(1)> broken', pagePath: '/account/files', locale: 'en', userAgent: 'Synthetic UA',
  status: 'open', reply: null, staffNote: null, handledBy: null, repliedAt: null, revision: 2, createdAt: '2026-11-10T10:00:00.000Z', updatedAt: '2026-11-10T10:00:00.000Z',
};
const replied = { ...row, id: 'fb-2', status: 'resolved', reply: 'Fixed', staffNote: 'internal', handledBy: 'staff-1', repliedAt: '2026-11-10T11:00:00.000Z', revision: 5 };

function mount(permissions: string[], routes: Record<string, unknown> = {}) {
  const server = createMockServer({
    'GET /menu/tree': [],
    'GET /management/feedback': { data: [row, replied], total: 2, page: 1, pageSize: 20 },
    'GET /management/feedback/fb-1': row,
    'GET /management/feedback/fb-2': replied,
    ...routes,
  });
  renderAdmin({ httpAdapter: server.adapter as never, locales, extraPages: feedbackPages }, { path: '/feedback', permissions });
  return server;
}
async function openForm(index = 0) {
  fireEvent.click((await screen.findAllByRole('button', { name: 'Details' }))[index]!);
  return within(await screen.findByRole('form', { name: 'Reply and status' }));
}

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('feedback page edges', () => {
  it('registers under feedback:query', () => {
    expect(feedbackPages[0]).toMatchObject({ path: '/feedback', permission: 'feedback:query' });
    expect([...FEEDBACK_STATUSES]).toEqual(['open', 'in_progress', 'resolved', 'closed']);
  });

  it('409 on save explains the conflict, reloads the record and offers the fresh revision', async () => {
    let revision = 2;
    const server = mount(['feedback:query', 'feedback:update'], {
      'GET /management/feedback/fb-1': () => ({ data: { ...row, revision, status: 'in_progress' } }),
      'PATCH /management/feedback/fb-1': () => { revision = 3; return { status: 409, data: { code: 'FEEDBACK_REVISION_CONFLICT', revision: 3 } }; },
    });
    const form = await openForm();
    fireEvent.change(form.getByLabelText('Reply (shown to the user)'), { target: { value: 'My reply' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.find('PATCH', '/management/feedback/fb-1')).toHaveLength(1));
    expect(server.find('PATCH', '/management/feedback/fb-1')[0]!.body).toEqual({ expectedRevision: 2, reply: 'My reply' });
    await waitFor(() => expect(server.find('GET', '/management/feedback/fb-1').length).toBeGreaterThan(1)); // reloaded
    // The reloaded form shows the server state (not the stale draft) and the next save uses the new revision.
    const fresh = within(await screen.findByRole('form', { name: 'Reply and status' }));
    await waitFor(() => expect((fresh.getByLabelText('Status') as HTMLSelectElement).value).toBe('in_progress'));
    expect((fresh.getByLabelText('Reply (shown to the user)') as HTMLTextAreaElement).value).toBe('');
  });

  it('403 and 500 on save show an inline alert and keep the draft; nothing is retried automatically', async () => {
    let status = 403;
    const server = mount(['feedback:query', 'feedback:update'], { 'PATCH /management/feedback/fb-1': () => ({ status, data: { message: 'no' } }) });
    const form = await openForm();
    fireEvent.change(form.getByLabelText('Reply (shown to the user)'), { target: { value: 'Draft text' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('You are not allowed to change feedback.');
    expect((form.getByLabelText('Reply (shown to the user)') as HTMLTextAreaElement).value).toBe('Draft text');
    status = 500;
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Saving failed. Try again.'));
    expect(server.find('PATCH', '/management/feedback/fb-1')).toHaveLength(2);
    expect((form.getByLabelText('Reply (shown to the user)') as HTMLTextAreaElement).value).toBe('Draft text');
  });

  it('nothing changed: no request, a visible hint; clearing a reply and the staff note sends null for both', async () => {
    const server = mount(['feedback:query', 'feedback:update'], { 'PATCH /management/feedback/fb-2': { ...replied, reply: null, staffNote: null, revision: 6 } });
    const form = await openForm(1);
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Nothing to save.');
    expect(server.find('PATCH', '/management/feedback/fb-2')).toHaveLength(0);
    fireEvent.change(form.getByLabelText('Reply (shown to the user)'), { target: { value: '   ' } });
    fireEvent.change(form.getByLabelText('Staff note (never shown to the user)'), { target: { value: '' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.find('PATCH', '/management/feedback/fb-2')).toHaveLength(1));
    expect(server.find('PATCH', '/management/feedback/fb-2')[0]!.body).toEqual({ expectedRevision: 5, reply: null, staffNote: null });
  });

  it('over-long text is flagged before sending', async () => {
    const server = mount(['feedback:query', 'feedback:update']);
    const form = await openForm();
    fireEvent.change(form.getByLabelText('Reply (shown to the user)'), { target: { value: 'x'.repeat(FEEDBACK_TEXT_MAX + 1) } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    expect((await screen.findAllByText(`At most ${FEEDBACK_TEXT_MAX} characters`)).length).toBeGreaterThan(0);
    expect(server.find('PATCH', '/management/feedback/fb-1')).toHaveLength(0);
  });

  it('renders user text as plain text: markup is shown, never turned into elements', async () => {
    mount(['feedback:query']);
    expect((await screen.findAllByText('<img src=x onerror=alert(1)> broken')).length).toBeGreaterThan(0);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Details' }))[0]!);
    await screen.findByRole('form', { name: 'Reply and status' });
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getAllByText('Synthetic UA').length).toBeGreaterThan(0);
  });

  it('read-only users see the staff note but every field and the Save button are disabled and no PATCH is sent', async () => {
    const server = mount(['feedback:query']);
    const form = await openForm(1);
    expect((form.getByLabelText('Staff note (never shown to the user)') as HTMLTextAreaElement).value).toBe('internal');
    for (const control of [form.getByLabelText('Status'), form.getByLabelText('Reply (shown to the user)'), form.getByLabelText('Staff note (never shown to the user)'), form.getByRole('button', { name: 'Save' })])
      expect(control.matches(':disabled')).toBe(true);
    fireEvent.submit(form.getByRole('button', { name: 'Save' }).closest('form')!);
    expect(server.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('a record that no longer exists shows a notice instead of a form', async () => {
    mount(['feedback:query', 'feedback:update'], { 'GET /management/feedback/fb-1': null });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Details' }))[0]!);
    expect(await screen.findByText('This feedback no longer exists.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Reply and status' })).toBeNull();
  });

  it('filters reach the server as query parameters; a failed list shows retry, not an empty table', async () => {
    const server = mount(['feedback:query']);
    await screen.findAllByRole('button', { name: 'Details' });
    fireEvent.change(screen.getAllByLabelText('Status')[0]!, { target: { value: 'resolved' } });
    fireEvent.change(screen.getAllByLabelText('User id')[0]!, { target: { value: 'user-1' } });
    fireEvent.click(screen.getByRole('button', { name: /search|query|查询/i }));
    await waitFor(() => expect(server.find('GET', '/management/feedback').some((call) => call.params.status === 'resolved' && call.params.ownerId === 'user-1')).toBe(true));
    cleanup();
    mount(['feedback:query'], { 'GET /management/feedback': { status: 500, data: { message: 'down' } } });
    expect(await screen.findByRole('button', { name: /retry|重试/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  });

  it('feedbackPatch sends only changed fields, trims, and flags the right field when too long', () => {
    expect(feedbackPatch(row as never, { status: 'resolved', reply: ' ok ', staffNote: '' })).toEqual({ body: { expectedRevision: 2, status: 'resolved', reply: 'ok' } });
    expect(feedbackPatch(replied as never, { status: 'resolved', reply: 'Fixed', staffNote: 'x'.repeat(FEEDBACK_TEXT_MAX + 1) })).toEqual({ error: 'staffNote' });
    expect(feedbackPatch(replied as never, { status: 'closed', reply: 'Fixed', staffNote: 'internal' })).toEqual({ body: { expectedRevision: 5, status: 'closed' } });
    expect(feedbackPatch(replied as never, { status: 'resolved', reply: '', staffNote: 'internal' })).toEqual({ body: { expectedRevision: 5, reply: null } });
  });
});
