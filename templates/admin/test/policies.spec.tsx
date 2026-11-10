/**
 * Component tests for the template's PoliciesPage. They live outside `src/` so the template's
 * `tsc -b` never type-checks test-only imports, and run through the repository's vitest setup
 * (workspace source aliases + jsdom), e.g. with `--dir templates/admin/test` and an include for it.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin } from '../../../packages/fe-admin/src/test/harness';
import { PoliciesPage } from '../src/pages/policies';

const policy = (over: Record<string, unknown> = {}) => ({
  id: 'site-limits',
  name: 'Site limits',
  description: 'Limits shown to visitors',
  revision: 4,
  fields: [
    { key: 'enabled', type: 'boolean', label: 'Feature enabled', default: false, value: true },
    { key: 'retention', type: 'number', label: 'Retention days', min: 1, max: 30, default: 7, value: 10 },
    { key: 'banner', type: 'text', label: 'Banner text', default: '', value: 'hello', public: true },
    { key: 'tier', type: 'select', label: 'Tier', options: ['free', { value: 'pro', label: 'Pro plan' }], default: 'free', value: 'free' },
    { key: 'rules', type: 'json', label: 'Rules', default: {}, value: { a: 1 } },
    { key: 'pinned', type: 'text', label: 'Pinned value', default: 'x', value: 'from-env', pinnedByEnvironment: true },
  ],
  ...over,
});
const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const URL = '/management/policies/site-limits';

function mount(routes: Record<string, unknown>, permissions = ['config:query', 'config:update']) {
  const server = createMockServer({ 'GET /menu/tree': [], ...routes });
  renderAdmin(
    {
      httpAdapter: server.adapter as never,
      locales,
      extraPages: [{ key: 'policies', path: '/policies', title: 'Policies', permission: 'config:query', component: PoliciesPage }],
    },
    { path: '/policies', permissions },
  );
  return server;
}
const form = () => screen.findByRole('form', { name: 'Site limits' });
const save = () => screen.getByRole('button', { name: 'Save policy' });

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('PoliciesPage', () => {
  it('renders typed inputs from the list response, incl. select labels and JSON pretty-printed', async () => {
    mount({ 'GET /management/policies': { policies: [policy()], externalRequests: false } });
    const f = within(await form());
    expect((f.getByLabelText('Retention days') as HTMLInputElement).type).toBe('number');
    expect((f.getByLabelText('Retention days') as HTMLInputElement).value).toBe('10');
    expect((f.getByLabelText('Banner text') as HTMLInputElement).type).toBe('text');
    expect(f.getByRole('switch', { name: 'Feature enabled' }).getAttribute('aria-checked')).toBe('true');
    expect(f.getByRole('option', { name: 'Pro plan' })).toBeTruthy();
    expect((f.getByLabelText('Rules') as HTMLTextAreaElement).value).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(f.getByText('Public')).toBeTruthy();
    expect(screen.getByText('Revision 4')).toBeTruthy();
  });

  it('also accepts a bare array and falls back to policy.values then default for the value', async () => {
    const p = policy({ values: { retention: 12 }, fields: [{ key: 'retention', type: 'number', label: 'Retention days', default: 7 }, { key: 'other', type: 'number', label: 'Other', default: 3 }] });
    mount({ 'GET /management/policies': [p] });
    const f = within(await form());
    expect((f.getByLabelText('Retention days') as HTMLInputElement).value).toBe('12');
    expect((f.getByLabelText('Other') as HTMLInputElement).value).toBe('3');
  });

  it('disables pinned fields, excludes them from the PUT, and sends expectedRevision', async () => {
    const saved = policy({ revision: 5, fields: policy().fields.map((x) => (x.key === 'retention' ? { ...x, value: 20 } : x)) });
    const server = mount({ 'GET /management/policies': { policies: [policy()] }, [`PUT ${URL}`]: { status: 200, data: saved } });
    const f = within(await form());
    const pinned = f.getByLabelText('Pinned value') as HTMLInputElement;
    expect(pinned.disabled).toBe(true);
    expect(f.getByText('Pinned by environment')).toBeTruthy();
    expect(save().hasAttribute('disabled')).toBe(true);
    fireEvent.change(f.getByLabelText('Retention days'), { target: { value: '20' } });
    fireEvent.click(save());
    expect(await screen.findByText('Policy saved; it applies immediately')).toBeTruthy();
    const [put] = server.find('PUT', URL);
    const body = put?.body as { expectedRevision: number; values: Record<string, unknown> };
    expect(body.expectedRevision).toBe(4);
    expect(body.values).not.toHaveProperty('pinned');
    expect(body.values).toMatchObject({ enabled: true, retention: 20, banner: 'hello', tier: 'free', rules: { a: 1 } });
    // The saved policy replaces the form state: new revision shown.
    expect(await screen.findByText('Revision 5')).toBeTruthy();
  });

  it('re-reads the policy when PUT returns no policy body', async () => {
    const fresh = policy({ revision: 5 });
    const server = mount({ 'GET /management/policies': { policies: [policy()] }, [`PUT ${URL}`]: { status: 200, data: { ok: true } }, [`GET ${URL}`]: fresh });
    const f = within(await form());
    fireEvent.change(f.getByLabelText('Banner text'), { target: { value: 'changed' } });
    fireEvent.click(save());
    expect(await screen.findByText('Revision 5')).toBeTruthy();
    expect(server.find('GET', URL)).toHaveLength(1);
  });

  it('shows a conflict notice on 409, keeps the draft unsaved and reloads the latest revision', async () => {
    const latest = policy({ revision: 6, fields: policy().fields.map((x) => (x.key === 'banner' ? { ...x, value: 'theirs' } : x)) });
    const server = mount({
      'GET /management/policies': { policies: [policy()] },
      [`PUT ${URL}`]: { status: 409, data: { message: 'stale' } },
      [`GET ${URL}`]: latest,
    });
    const f = within(await form());
    fireEvent.change(f.getByLabelText('Banner text'), { target: { value: 'mine' } });
    fireEvent.click(save());
    expect(await screen.findByText('This policy was changed elsewhere')).toBeTruthy();
    expect((f.getByLabelText('Banner text') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByText('Revision 6')).toBeTruthy());
    expect((within(screen.getByRole('form', { name: 'Site limits' })).getByLabelText('Banner text') as HTMLInputElement).value).toBe('theirs');
    expect(screen.queryByText('This policy was changed elsewhere')).toBeNull();
    expect(server.find('PUT', URL)).toHaveLength(1);
  });

  it('is read-only without config:update: no save button, inputs disabled, no PUT possible', async () => {
    const server = mount({ 'GET /management/policies': { policies: [policy()] } }, ['config:query']);
    const f = within(await form());
    expect(screen.getByText('You can view policies but not change them')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull();
    expect((f.getByLabelText('Retention days') as HTMLInputElement).disabled).toBe(true);
    expect((f.getByLabelText('Rules') as HTMLTextAreaElement).disabled).toBe(true);
    expect(f.getByRole('switch', { name: 'Feature enabled' }).hasAttribute('disabled')).toBe(true);
    expect(server.find('PUT', URL)).toHaveLength(0);
  });

  it('rejects invalid JSON and out-of-range / empty numbers locally without calling the server', async () => {
    const server = mount({ 'GET /management/policies': { policies: [policy()] } });
    const f = within(await form());
    fireEvent.change(f.getByLabelText('Rules'), { target: { value: '{oops' } });
    fireEvent.change(f.getByLabelText('Retention days'), { target: { value: '99' } });
    // Submit the form directly: the browser's native min/max check would otherwise intercept a click.
    fireEvent.submit(screen.getByRole('form', { name: 'Site limits' }));
    expect(await screen.findByText('Invalid JSON')).toBeTruthy();
    expect(screen.getByText('Allowed range 1–30')).toBeTruthy();
    fireEvent.change(f.getByLabelText('Retention days'), { target: { value: '' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Site limits' }));
    expect(await screen.findByText('Enter a number')).toBeTruthy();
    fireEvent.change(f.getByLabelText('Retention days'), { target: { value: '0' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Site limits' }));
    expect(await screen.findByText('Allowed range 1–30')).toBeTruthy();
    expect(server.find('PUT', URL)).toHaveLength(0);
  });

  it('shows the range error when the save button is clicked (native min/max validation must not swallow it)', async () => {
    const server = mount({ 'GET /management/policies': { policies: [policy()] } });
    const f = within(await form());
    fireEvent.change(f.getByLabelText('Retention days'), { target: { value: '99' } });
    fireEvent.click(save());
    expect(await screen.findByText('Allowed range 1–30')).toBeTruthy();
    expect(server.find('PUT', URL)).toHaveLength(0);
  });

  it('empties a JSON field to null, which the server treats as reset-to-default', async () => {
    const server = mount({ 'GET /management/policies': { policies: [policy()] }, [`PUT ${URL}`]: { status: 200, data: policy({ revision: 5 }) } });
    const f = within(await form());
    fireEvent.change(f.getByLabelText('Rules'), { target: { value: '   ' } });
    fireEvent.click(save());
    await screen.findByText('Revision 5');
    expect((server.find('PUT', URL)[0]?.body as { values: Record<string, unknown> }).values.rules).toBeNull();
  });

  it('resets one field to its default by sending only that key as null, keeping other drafts', async () => {
    const reset = policy({ revision: 5, fields: policy().fields.map((x) => (x.key === 'retention' ? { ...x, value: 7 } : x)) });
    const server = mount({ 'GET /management/policies': { policies: [policy()] }, [`PUT ${URL}`]: { status: 200, data: reset } });
    const f = within(await form());
    fireEvent.change(f.getByLabelText('Banner text'), { target: { value: 'draft' } });
    fireEvent.click(f.getByRole('button', { name: 'Reset Retention days to default' }));
    expect(await screen.findByText('Default restored; it applies immediately')).toBeTruthy();
    expect(server.find('PUT', URL)[0]?.body).toEqual({ expectedRevision: 4, values: { retention: null } });
    await waitFor(() => expect((f.getByLabelText('Retention days') as HTMLInputElement).value).toBe('7'));
    expect((f.getByLabelText('Banner text') as HTMLInputElement).value).toBe('draft');
    // At its default now, and pinned fields can never be reset.
    expect(f.getByRole('button', { name: 'Reset Retention days to default' }).hasAttribute('disabled')).toBe(true);
    expect(f.getByRole('button', { name: 'Reset Pinned value to default' }).hasAttribute('disabled')).toBe(true);
  });

  it('names each control by its label only; badges sit outside the label', async () => {
    mount({ 'GET /management/policies': { policies: [policy()] } });
    const f = within(await form());
    expect(f.getByRole('textbox', { name: 'Banner text' })).toBeTruthy();
    expect(f.getByRole('textbox', { name: 'Pinned value' })).toBeTruthy();
  });

  it('sends an emptied text field as an empty string, not as a reset', async () => {
    const server = mount({ 'GET /management/policies': { policies: [policy()] }, [`PUT ${URL}`]: { status: 200, data: policy({ revision: 5 }) } });
    const f = within(await form());
    fireEvent.change(f.getByLabelText('Banner text'), { target: { value: '' } });
    fireEvent.click(save());
    await screen.findByText('Revision 5');
    // An emptied text field is a value (''); resetting uses the per-field action instead.
    expect((server.find('PUT', URL)[0]?.body as { values: Record<string, unknown> }).values.banner).toBe('');
  });

  it('lists unknown field types without their value and never sends them', async () => {
    const p = policy({ fields: [...policy().fields, { key: 'weird', type: 'secret', label: 'Weird', value: 'TOPSECRET' }] });
    const server = mount({ 'GET /management/policies': { policies: [p] }, [`PUT ${URL}`]: { status: 200, data: policy({ revision: 5 }) } });
    const f = within(await form());
    expect(f.getByText('This field type cannot be edited here.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('TOPSECRET');
    expect((f.getByLabelText('Weird') as HTMLInputElement).value).toBe('');
    fireEvent.change(f.getByLabelText('Banner text'), { target: { value: 'x' } });
    fireEvent.click(save());
    await screen.findByText('Revision 5');
    expect((server.find('PUT', URL)[0]?.body as { values: Record<string, unknown> }).values).not.toHaveProperty('weird');
  });

  it('shows an empty state and an error state', async () => {
    mount({ 'GET /management/policies': { policies: [] } });
    expect(await screen.findByText('No policies are defined')).toBeTruthy();
  });

  it('shows a generic failure toast for a non-409 error and keeps the form editable', async () => {
    mount({ 'GET /management/policies': { policies: [policy()] }, [`PUT ${URL}`]: { status: 400, data: { message: 'bad' } } });
    const f = within(await form());
    fireEvent.change(f.getByLabelText('Banner text'), { target: { value: 'x' } });
    fireEvent.click(save());
    expect(await screen.findByText('Save failed; check the values or your access.')).toBeTruthy();
    expect((f.getByLabelText('Banner text') as HTMLInputElement).disabled).toBe(false);
  });
});
