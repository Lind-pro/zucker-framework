/** Component tests for the feedback triage page (features/feedback). */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin } from '../../../packages/fe-admin/src/test/harness';
import { feedbackPages, feedbackPatch } from '../src/features/feedback';

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const row = {
  id: 'fb-1', ownerId: 'user-1', type: 'bug', message: '<b>Export</b> fails', pagePath: '/account/files', locale: 'en', userAgent: 'Synthetic',
  status: 'open', reply: null, staffNote: null, handledBy: null, repliedAt: null, revision: 2, createdAt: '2026-11-10T10:00:00.000Z', updatedAt: '2026-11-10T10:00:00.000Z',
};

function mount(permissions: string[], routes: Record<string, unknown> = {}) {
  const server = createMockServer({
    'GET /menu/tree': [],
    'GET /management/feedback': { data: [row], total: 1, page: 1, pageSize: 20 },
    'GET /management/feedback/fb-1': row,
    ...routes,
  });
  renderAdmin({ httpAdapter: server.adapter as never, locales, extraPages: feedbackPages }, { path: '/feedback', permissions });
  return server;
}

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('feedback page', () => {
  it('lists feedback as plain text and saves a reply with expectedRevision and only changed fields', async () => {
    const server = mount(['feedback:query', 'feedback:update'], { 'PATCH /management/feedback/fb-1': { ...row, revision: 3, status: 'resolved', reply: 'Fixed' } });
    expect((await screen.findAllByText('<b>Export</b> fails')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]!);
    const form = within(await screen.findByRole('form', { name: 'Reply and status' }));
    fireEvent.change(form.getByLabelText('Status'), { target: { value: 'resolved' } });
    fireEvent.change(form.getByLabelText('Reply (shown to the user)'), { target: { value: '  Fixed  ' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.find('PATCH', '/management/feedback/fb-1')).toHaveLength(1));
    expect(server.find('PATCH', '/management/feedback/fb-1')[0]!.body).toEqual({ expectedRevision: 2, status: 'resolved', reply: 'Fixed' });
  });

  it('is read-only without feedback:update', async () => {
    mount(['feedback:query']);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Details' }))[0]!);
    const form = within(await screen.findByRole('form', { name: 'Reply and status' }));
    expect(form.getByRole('button', { name: 'Save' }).matches(':disabled')).toBe(true);
    expect(form.getByLabelText('Reply (shown to the user)').matches(':disabled')).toBe(true);
  });

  it('feedbackPatch rejects over-long text and empty changes', () => {
    expect(feedbackPatch(row as never, { status: 'open', reply: '', staffNote: '' })).toEqual({ error: 'unchanged' });
    expect(feedbackPatch(row as never, { status: 'open', reply: 'x'.repeat(2001), staffNote: '' })).toEqual({ error: 'reply' });
  });
});
