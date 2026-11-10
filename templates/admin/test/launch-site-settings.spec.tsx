/**
 * Launch-readiness coverage for the site settings page: legacy documents, limits, validation
 * problems and permission hiding. Run with
 * `pnpm exec vitest run templates/admin/test/launch-site-settings.spec.tsx`.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin, type MockRequest } from '../../../packages/fe-admin/src/test/harness';
import { SiteSettingsPage, siteSettingsProblem } from '../src/pages/site-settings';

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const SETTINGS = '/content/manage/settings';
const legacy = {
  name: 'Zucker',
  theme: 'default',
  appearance: 'dark',
  description: { zh: '简介', en: 'About' },
  navigation: { zh: [{ label: '价格', href: '/pricing' }], en: [{ label: 'Pricing', href: '/pricing' }] },
  footerLinks: { zh: [], en: [{ label: 'Terms', href: '/terms' }] },
};
const tx = (_zh: string, en: string) => en;

function mount(routes: Record<string, unknown> = {}, permissions = ['content:manage'], routePermission = 'content:manage') {
  const server = createMockServer({
    'GET /menu/tree': [],
    [`GET ${SETTINGS}`]: { settings: legacy, usingDefaults: false },
    [`PUT ${SETTINGS}`]: ({ body }: MockRequest) => ({ data: body }),
    ...routes,
  });
  renderAdmin(
    { httpAdapter: server.adapter as never, locales, extraPages: [{ key: 'site', path: '/config', title: 'Site', permission: routePermission, component: SiteSettingsPage }] },
    { path: '/config', permissions },
  );
  return server;
}
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save site settings' }));
const puts = (server: ReturnType<typeof mount>) => server.find('PUT', SETTINGS);
const lastPut = (server: ReturnType<typeof mount>) => puts(server)[0]!.body as Record<string, unknown>;

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('siteSettingsProblem', () => {
  const base = () => ({
    name: 'Site', theme: 'default', appearance: 'dark' as const,
    description: { zh: '', en: '' }, navigation: { zh: [], en: [] }, footerLinks: { zh: [], en: [] },
    logoUrl: '', social: [] as { platform: string; href: string }[],
    banner: { enabled: false, text: { zh: '', en: '' }, href: '' },
  });
  const problem = (patch: Record<string, unknown>) => siteSettingsProblem({ ...base(), ...patch } as never, tx);

  it('accepts the defaults', () => expect(problem({})).toBeNull());

  it('requires a site name and complete links in either language', () => {
    expect(problem({ name: '   ' })).toMatch(/site name/);
    expect(problem({ navigation: { zh: [], en: [{ label: '', href: '/a' }] } })).toMatch(/every link/);
    expect(problem({ footerLinks: { zh: [{ label: 'x', href: '  ' }], en: [] } })).toMatch(/every link/);
    expect(problem({ navigation: { zh: [{ label: 'x', href: '/a' }], en: [] } })).toBeNull();
  });

  it.each([
    ['javascript:alert(1)', true], ['data:image/svg+xml,x', true], ['//cdn.test/x.png', true], ['  ', false], ['', false], ['/logo.svg', false], ['https://cdn.test/l.png', false],
  ])('logo %j -> problem=%s', (logoUrl, bad) => {
    expect(problem({ logoUrl }) !== null).toBe(bad);
  });

  it.each([
    ['github', 'https://github.com/x', false],
    ['x', '/x', false],
    ['a'.repeat(32), 'https://e.test', false],
    ['a'.repeat(33), 'https://e.test', true],
    ['', 'https://e.test', true],
    ['GitHub', 'https://e.test', true],
    ['1abc', 'https://e.test', true],
    ['git hub', 'https://e.test', true],
    ['github', 'javascript:x', true],
    ['github', '', true],
  ])('social %s %s -> problem=%s', (platform, href, bad) => {
    expect(problem({ social: [{ platform, href }] }) !== null).toBe(bad);
  });

  it('banner link must be safe; an enabled banner needs trimmed text in some language', () => {
    expect(problem({ banner: { enabled: false, text: { zh: '', en: '' }, href: 'javascript:x' } })).toMatch(/banner link/);
    expect(problem({ banner: { enabled: true, text: { zh: ' ', en: '\n' }, href: '' } })).toMatch(/needs text/);
    expect(problem({ banner: { enabled: true, text: { zh: '', en: 'Hi' }, href: '/pricing' } })).toBeNull();
    expect(problem({ banner: { enabled: true, text: { zh: '你好', en: '' }, href: '' } })).toBeNull();
    // a disabled banner never needs text
    expect(problem({ banner: { enabled: false, text: { zh: '', en: '' }, href: '' } })).toBeNull();
  });
});

describe('SiteSettingsPage', () => {
  it('opens a legacy document (no logo/social/banner) and re-saves it with defaults and nothing lost', async () => {
    const server = mount();
    expect(((await screen.findByLabelText('Logo image URL')) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/^Site name/) as HTMLInputElement).value).toBe('Zucker');
    expect(screen.queryByLabelText('Platform 1')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Show the banner' }).getAttribute('aria-checked')).toBe('false');
    save();
    await waitFor(() => expect(puts(server)).toHaveLength(1));
    expect(lastPut(server)).toEqual({
      ...legacy,
      logoUrl: '',
      social: [],
      banner: { enabled: false, text: { zh: '', en: '' }, href: '' },
    });
  });

  it('merges a partial banner and null-ish new fields from older servers', async () => {
    const server = mount({ [`GET ${SETTINGS}`]: { settings: { ...legacy, logoUrl: null, social: null, banner: { enabled: true, text: { en: 'Sale' } } }, usingDefaults: false } });
    await screen.findByLabelText('Logo image URL');
    save();
    await waitFor(() => expect(puts(server)).toHaveLength(1));
    expect(lastPut(server)).toMatchObject({ logoUrl: '', social: [], banner: { enabled: true, text: { zh: '', en: 'Sale' }, href: '' } });
  });

  it('shows the defaults notice until the first successful save', async () => {
    mount({ [`GET ${SETTINGS}`]: { settings: legacy, usingDefaults: true } });
    expect(await screen.findByText('Default site settings are in use; saving stores them.')).toBeTruthy();
    save();
    await waitFor(() => expect(screen.queryByText('Default site settings are in use; saving stores them.')).toBeNull());
  });

  it('keeps the defaults notice when the save fails and keeps the draft', async () => {
    const server = mount({ [`GET ${SETTINGS}`]: { settings: legacy, usingDefaults: true }, [`PUT ${SETTINGS}`]: { status: 400, data: { message: 'bad' } } });
    fireEvent.change(await screen.findByLabelText(/^Site name/), { target: { value: 'Renamed' } });
    save();
    await waitFor(() => expect(puts(server)).toHaveLength(1));
    expect(await screen.findAllByText('Save failed; check link formats, field lengths or access.')).not.toHaveLength(0);
    expect(screen.getByText('Default site settings are in use; saving stores them.')).toBeTruthy();
    expect((screen.getByLabelText(/^Site name/) as HTMLInputElement).value).toBe('Renamed');
    // the form is usable again
    expect((screen.getByRole('button', { name: 'Save site settings' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a failed load shows an error with retry', async () => {
    let calls = 0;
    mount({ [`GET ${SETTINGS}`]: () => (++calls === 1 ? { status: 500, data: { message: 'x' } } : { data: { settings: legacy, usingDefaults: false } }) });
    fireEvent.click(await screen.findByRole('button', { name: /Retry/ }));
    expect(await screen.findByLabelText(/^Site name/)).toBeTruthy();
  });

  it('social links: at most 12, platform ids are lower-cased as typed, delete works', async () => {
    mount();
    await screen.findByLabelText('Logo image URL');
    const add = () => screen.getByRole('button', { name: 'Add social link' }) as HTMLButtonElement;
    for (let i = 0; i < 12; i++) fireEvent.click(add());
    expect(add().disabled).toBe(true);
    expect(screen.queryByLabelText('Platform 13')).toBeNull();
    fireEvent.change(screen.getByLabelText('Platform 1'), { target: { value: 'GitHub' } });
    expect((screen.getByLabelText('Platform 1') as HTMLInputElement).value).toBe('github');
    expect(screen.getByLabelText('Platform 1').getAttribute('maxlength')).toBe('32');
    fireEvent.click(screen.getByRole('button', { name: 'Delete social link 12' }));
    expect(add().disabled).toBe(false);
    expect(screen.queryByLabelText('Platform 12')).toBeNull();
  });

  it('twelve social links with valid values are all saved in order', { timeout: 60_000 }, async () => {
    const server = mount();
    await screen.findByLabelText('Logo image URL');
    for (let i = 1; i <= 12; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Add social link' }));
      fireEvent.change(screen.getByLabelText(`Platform ${i}`), { target: { value: `site${i}` } });
      fireEvent.change(screen.getByLabelText(`Social link URL ${i}`), { target: { value: `https://example.test/${i}` } });
    }
    save();
    await waitFor(() => expect(puts(server)).toHaveLength(1));
    const social = lastPut(server).social as Array<{ platform: string }>;
    expect(social.map((s) => s.platform)).toEqual(Array.from({ length: 12 }, (_, i) => `site${i + 1}`));
  });

  it.each([
    ['an incomplete social link', async () => { fireEvent.click(screen.getByRole('button', { name: 'Add social link' })); }, /Social links need/],
    ['a hostile social URL', async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add social link' }));
      fireEvent.change(screen.getByLabelText('Platform 1'), { target: { value: 'x' } });
      fireEvent.change(screen.getByLabelText('Social link URL 1'), { target: { value: 'javascript:alert(1)' } });
    }, /Social links need/],
    ['a hostile logo URL', async () => { fireEvent.change(screen.getByLabelText('Logo image URL'), { target: { value: 'javascript:alert(1)' } }); }, /logo URL/],
    ['a hostile banner link', async () => { fireEvent.change(screen.getByLabelText('Banner link'), { target: { value: 'data:text/html,x' } }); }, /banner link/],
    ['a blank site name', async () => { fireEvent.change(screen.getByLabelText(/^Site name/), { target: { value: '  ' } }); }, /site name/],
    ['an incomplete navigation link', async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Add link' })[0]!); }, /every link/],
  ])('%s blocks the save with a message and sends nothing', async (_name, act, message) => {
    const server = mount();
    await screen.findByLabelText('Logo image URL');
    await act();
    save();
    expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
    expect(puts(server)).toHaveLength(0);
  });

  it('the logo thumbnail only appears for a safe URL and never leaks a referrer', async () => {
    const { container } = (mount(), { container: document.body });
    const logo = await screen.findByLabelText('Logo image URL');
    fireEvent.change(logo, { target: { value: 'javascript:alert(1)' } });
    expect(container.querySelector('img')).toBeNull();
    fireEvent.change(logo, { target: { value: 'https://cdn.example.test/logo.svg' } });
    const img = container.querySelector('img[src="https://cdn.example.test/logo.svg"]');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('text limits are enforced on the inputs', async () => {
    mount();
    await screen.findByLabelText('Logo image URL');
    expect(screen.getByLabelText(/^Site name/).getAttribute('maxlength')).toBe('100');
    expect(screen.getByLabelText('Logo image URL').getAttribute('maxlength')).toBe('2048');
    expect(screen.getByLabelText('Banner link').getAttribute('maxlength')).toBe('2048');
    expect(screen.getByLabelText('Banner text').getAttribute('maxlength')).toBe('200');
    expect(screen.getByLabelText('Description').getAttribute('maxlength')).toBe('500');
  });

  it('navigation and footer lists stop at 12 links', async () => {
    mount();
    await screen.findByLabelText('Logo image URL');
    const addNav = () => screen.getAllByRole('button', { name: 'Add link' })[0] as HTMLButtonElement;
    for (let i = 0; i < 11; i++) fireEvent.click(addNav()); // legacy zh has 1
    expect(addNav().disabled).toBe(true);
  });

  it('banner text is per language: each language tab keeps its own text and both are saved', async () => {
    const server = mount();
    await screen.findByLabelText('Logo image URL');
    fireEvent.click(screen.getByRole('switch', { name: 'Show the banner' }));
    fireEvent.change(screen.getByLabelText('Banner text'), { target: { value: '中文公告' } });
    const tabs = screen.getByRole('tablist', { name: 'Language' });
    fireEvent.mouseDown(within(tabs).getByRole('tab', { name: 'English' }), { button: 0 });
    expect((await screen.findByLabelText('Banner text') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Banner text'), { target: { value: 'English notice' } });
    fireEvent.mouseDown(within(tabs).getByRole('tab', { name: '中文' }), { button: 0 });
    expect((await screen.findByLabelText('Banner text') as HTMLInputElement).value).toBe('中文公告');
    save();
    await waitFor(() => expect(puts(server)).toHaveLength(1));
    expect(lastPut(server).banner).toEqual({ enabled: true, text: { zh: '中文公告', en: 'English notice' }, href: '' });
  });

  it('without content:manage the form is read-only: no Save button and Enter cannot send a PUT', async () => {
    const server = mount({}, ['content:read'], 'content:read');
    await screen.findByLabelText('Logo image URL');
    expect(screen.queryByRole('button', { name: 'Save site settings' })).toBeNull();
    // Pressing Enter in a text field submits the form even though the Save button is hidden.
    fireEvent.submit(screen.getByLabelText(/^Site name/).closest('form')!);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(puts(server)).toHaveLength(0);
  });
});
