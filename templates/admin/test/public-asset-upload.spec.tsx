/** Public-asset upload button (WP 2.6 wiring): site-settings logo is filled from the upload response. */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin, type MockRequest } from '../../../packages/fe-admin/src/test/harness';
import { SiteSettingsPage } from '../src/pages/site-settings';

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const SETTINGS = '/content/manage/settings';
const settings = {
  name: 'Zucker', theme: 'default', appearance: 'dark', description: { zh: '', en: '' },
  navigation: { zh: [], en: [] }, footerLinks: { zh: [], en: [] }, logoUrl: '', social: [],
  banner: { enabled: false, text: { zh: '', en: '' }, href: '' },
};

function mount(upload: unknown) {
  const server = createMockServer({
    'GET /menu/tree': [],
    [`GET ${SETTINGS}`]: { settings, usingDefaults: false },
    [`PUT ${SETTINGS}`]: ({ body }: MockRequest) => ({ data: body }),
    'POST /management/public-assets': upload,
  });
  renderAdmin(
    { httpAdapter: server.adapter as never, locales, extraPages: [{ key: 'site', path: '/config', title: 'Site', permission: 'content:manage', component: SiteSettingsPage }] },
    { path: '/config', permissions: ['content:manage'] },
  );
  return server;
}

function choose(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => { cleanup(); localStorage.clear(); });

describe('public asset upload button', () => {
  it('uploads the chosen image as multipart `file` and writes the returned URL into the logo field', async () => {
    const url = `/api/public-assets/${'a'.repeat(64)}.png`;
    const server = mount({ sha256: 'a'.repeat(64), url, mimeType: 'image/png', size: 68, width: 1, height: 1, deduplicated: false });
    await screen.findByRole('button', { name: 'Upload logo' });
    choose(new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' }));
    await waitFor(() => expect((screen.getByLabelText('Logo image URL') as HTMLInputElement).value).toBe(url));
    const body = server.find('POST', '/management/public-assets')[0]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('file')).toBeInstanceOf(File);
  });

  it('shows the server message on 415 and leaves the field unchanged', async () => {
    mount({ status: 415, data: { status: 415, code: 'SVG_REJECTED', message: 'SVG images are not accepted' } });
    await screen.findByRole('button', { name: 'Upload logo' });
    choose(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect((screen.getByLabelText('Logo image URL') as HTMLInputElement).value).toBe('');
  });
});
