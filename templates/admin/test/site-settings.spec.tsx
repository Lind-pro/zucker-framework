/** Component tests for the template's SiteSettingsPage (logo, social links, banner). */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMockServer,
  renderAdmin,
  type MockRequest,
} from '../../../packages/fe-admin/src/test/harness';
import { SiteSettingsPage } from '../src/pages/site-settings';

const locales = {
  'zh-CN': { label: '中文', messages: {} },
  'en-US': { label: 'English', messages: {} },
};
// Settings saved before logoUrl/social/banner existed come back without them.
const legacy = {
  name: 'Zucker',
  theme: 'default',
  appearance: 'dark',
  description: { zh: '', en: '' },
  navigation: { zh: [], en: [] },
  footerLinks: { zh: [], en: [] },
};

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('SiteSettingsPage', () => {
  it('edits logo, social links and banner and rejects an enabled banner without text', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /content/manage/settings': { settings: legacy, usingDefaults: false },
      'PUT /content/manage/settings': ({ body }: MockRequest) => ({ data: body }),
    });
    renderAdmin(
      {
        httpAdapter: server.adapter as never,
        locales,
        extraPages: [
          {
            key: 'site',
            path: '/config',
            title: 'Site',
            permission: 'content:manage',
            component: SiteSettingsPage,
          },
        ],
      },
      { path: '/config', permissions: ['content:manage'] },
    );
    fireEvent.change(await screen.findByLabelText('Logo image URL'), {
      target: { value: '/logo.svg' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add social link' }));
    fireEvent.change(screen.getByLabelText('Platform 1'), { target: { value: 'GitHub' } });
    fireEvent.change(screen.getByLabelText('Social link URL 1'), {
      target: { value: 'https://github.com/example' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Show the banner' }));
    fireEvent.change(screen.getByLabelText('Banner link'), { target: { value: '/pricing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save site settings' }));
    expect(
      await screen.findByText('An enabled banner needs text in at least one language'),
    ).toBeTruthy();
    expect(server.find('PUT', '/content/manage/settings')).toHaveLength(0);

    const tabs = screen.getByRole('tablist', { name: 'Language' });
    fireEvent.mouseDown(within(tabs).getByRole('tab', { name: 'English' }), { button: 0 });
    fireEvent.change(await screen.findByLabelText('Banner text'), {
      target: { value: 'Launch week' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save site settings' }));
    await waitFor(() => expect(server.find('PUT', '/content/manage/settings')).toHaveLength(1));
    expect(server.find('PUT', '/content/manage/settings')[0]!.body).toMatchObject({
      logoUrl: '/logo.svg',
      social: [{ platform: 'github', href: 'https://github.com/example' }],
      banner: { enabled: true, text: { zh: '', en: 'Launch week' }, href: '/pricing' },
    });
  });
});
