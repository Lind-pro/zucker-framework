import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServerLabel } from '../i18n/context';
import { createMockServer, renderAdmin } from '../test/harness';

const field = { key: 'GOOGLE_OAUTH_ENABLED', label: 'OAuth 登录', type: 'boolean', configured: true, source: 'environment', value: 'false' };
const profile = {
  id: 'identity-google',
  name: 'Google 登录',
  category: '登录',
  storedRevision: 0,
  appliedRevision: 0,
  pendingRestart: false,
  canSave: true,
  saveUnavailableReason: null,
  fields: [field, { ...field, key: 'GOOGLE_CLIENT_ID', label: 'Client ID', type: 'text', description: '可选说明', value: 'id' }],
};
const routes = {
  'GET /menu/tree': [],
  'GET /management/connections': {
    checkedAt: '2026-11-09T00:00:00.000Z',
    connections: [
      {
        id: 'identity-google',
        name: 'Google 登录',
        category: '登录',
        source: 'server-environment',
        status: 'disabled',
        enabled: false,
        missing: [],
        sdkAvailable: null,
        note: '仅校验本地配置与依赖',
        registeredProviderIds: ['a', 'b'],
      },
    ],
  },
  'GET /management/connection-settings': { profiles: [profile] },
  'GET /management/connection-settings/identity-google': profile,
};
const serverLabels = {
  'en-US': { 'Google 登录': 'Google sign-in', 登录: 'Sign-in', 'OAuth 登录': 'OAuth sign-in', 仅校验本地配置与依赖: 'Local checks only' },
};
const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('server-provided labels', () => {
  it('translates exact server text per locale and keeps unknown text', () => {
    const english = createServerLabel(serverLabels, 'en-US');
    expect(english('Google 登录')).toBe('Google sign-in');
    expect(english('未翻译')).toBe('未翻译');
    expect(english('toString')).toBe('toString');
    expect(createServerLabel(serverLabels, 'zh-CN')('Google 登录')).toBe('Google 登录');
    expect(createServerLabel(undefined, 'en-US')('Google 登录')).toBe('Google 登录');
    const viaFunction = createServerLabel((text, locale) => (locale === 'en-US' && text === '登录' ? 'Sign-in' : undefined), 'en-US');
    expect(viaFunction('登录')).toBe('Sign-in');
    expect(viaFunction('邮件')).toBe('邮件');
  });

  it('shows connection names, categories, notes and field labels in the active locale', async () => {
    localStorage.setItem('zucker-admin-locale', 'en-US');
    const server = createMockServer(routes);
    renderAdmin(
      { httpAdapter: server.adapter as never, locales, serverLabels },
      { path: '/connections', permissions: ['config:query', 'config:update'] },
    );
    const table = await screen.findByRole('table', { name: 'Connections' });
    const row = within(table).getByText('Google sign-in').closest('tr') as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByText('Sign-in')).toBeTruthy();
    expect(within(row).getByText('Local checks only')).toBeTruthy();
    expect(within(row).getByText(/a, b/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Edit settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit connection · Google sign-in' });
    expect(within(dialog).getByRole('combobox', { name: 'OAuth sign-in action' })).toBeTruthy();
    // Untranslated server text is shown as received rather than dropped.
    expect(within(dialog).getByText('可选说明')).toBeTruthy();
  });

  it('keeps the server text in the default locale', async () => {
    const server = createMockServer(routes);
    renderAdmin(
      { httpAdapter: server.adapter as never, locales, serverLabels },
      { path: '/connections', permissions: ['config:query'] },
    );
    const table = await screen.findByRole('table', { name: '连接配置' });
    expect(within(table).getByText('Google 登录')).toBeTruthy();
    expect(within(table).getByText(/a、b/)).toBeTruthy();
  });
});
