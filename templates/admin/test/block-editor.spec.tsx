/**
 * Component tests for the content editor's form-based block editor (features/blocks) through the
 * template's ContentPage. Run with the repository vitest setup, e.g.
 * `pnpm exec vitest run templates/admin/test/block-editor.spec.tsx`.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMockServer,
  renderAdmin,
  type MockRequest,
} from '../../../packages/fe-admin/src/test/harness';
import { describeField } from '../src/features/blocks';
import { ContentPage } from '../src/pages/content';

const locales = {
  'zh-CN': { label: '中文', messages: {} },
  'en-US': { label: 'English', messages: {} },
};
const ENTRIES = '/content/manage/entries';

function mount(routes: Record<string, unknown> = {}) {
  const server = createMockServer({
    'GET /menu/tree': [],
    [`GET ${ENTRIES}`]: { data: [], total: 0 },
    'GET /content/manage/categories': [],
    'GET /content/manage/files': { data: [], issues: [] },
    [`POST ${ENTRIES}`]: ({ body }: MockRequest) => ({ data: { id: 'e1', ...(body as object) } }),
    ...routes,
  });
  renderAdmin(
    {
      httpAdapter: server.adapter as never,
      locales,
      extraPages: [
        {
          key: 'content',
          path: '/content',
          title: 'Content',
          permission: 'content:manage',
          component: ContentPage,
        },
      ],
    },
    { path: '/content', permissions: ['content:manage'] },
  );
  return server;
}
/** Radix tabs switch on mouse down. */
const openTab = (dialog: HTMLElement, name: RegExp) =>
  fireEvent.mouseDown(within(dialog).getByRole('tab', { name }), { button: 0 });
async function openEditor() {
  fireEvent.click(await screen.findByRole('button', { name: 'New entry' }));
  return screen.findByRole('dialog');
}
function addBlock(dialog: HTMLElement, type: string) {
  fireEvent.change(within(dialog).getByLabelText('Block type'), { target: { value: type } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add block' }));
}

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('block editor', () => {
  it('adds and reorders blocks, surfaces the validator field path, then saves a v2 document', async () => {
    const server = mount();
    const dialog = await openEditor();
    fireEvent.change(within(dialog).getByLabelText(/^Path/), { target: { value: 'home' } });
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'Home' } });
    openTab(dialog, /^Blocks/);
    addBlock(dialog, 'hero');
    addBlock(dialog, 'features');
    addBlock(dialog, 'cta');
    expect(within(dialog).getByRole('tab', { name: 'Blocks (3)' })).toBeTruthy();

    // Move the CTA (block 3) above the features block.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move Block 3 up' }));
    const titles = () =>
      Array.from(dialog.querySelectorAll('[data-block-path] .truncate')).map(
        (node) => node.textContent,
      );
    expect(titles()).toEqual(['1. Hero#hero', '2. Call to action#cta', '3. Features#features']);

    // Empty required hero heading: blocked client-side with a readable field path, no request.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    expect(await within(dialog).findByText('Block 1 · Hero › Heading: Required')).toBeTruthy();
    const heading = dialog.querySelector<HTMLInputElement>('[data-field="blocks.0.heading"]')!;
    expect(heading.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(server.find('POST', ENTRIES)).toHaveLength(0);

    fireEvent.change(heading, { target: { value: 'Build faster' } });
    expect(heading.getAttribute('aria-invalid')).toBeNull();
    fireEvent.change(dialog.querySelector('[data-field="blocks.1.heading"]')!, {
      target: { value: 'Start today' },
    });
    fireEvent.change(dialog.querySelector('[data-field="blocks.1.action.label"]')!, {
      target: { value: 'Sign up' },
    });
    fireEvent.change(dialog.querySelector('[data-field="blocks.1.action.href"]')!, {
      target: { value: 'javascript:alert(1)' },
    });
    fireEvent.change(dialog.querySelector('[data-field="blocks.2.heading"]')!, {
      target: { value: 'Features' },
    });
    fireEvent.change(dialog.querySelector('[data-field="blocks.2.items.0.title"]')!, {
      target: { value: 'Fast' },
    });
    fireEvent.change(dialog.querySelector('[data-field="blocks.2.items.0.text"]')!, {
      target: { value: 'Very fast' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    expect(
      await within(dialog).findByText(
        'Block 2 · Call to action › Button › URL: Enter an http(s) URL or a site path',
      ),
    ).toBeTruthy();

    fireEvent.change(dialog.querySelector('[data-field="blocks.1.action.href"]')!, {
      target: { value: '/register' },
    });
    // Hide the features block: kept in the draft, never public.
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Show Block 3' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(server.find('POST', ENTRIES)).toHaveLength(1));
    const body = server.find('POST', ENTRIES)[0]!.body as {
      document: { version: number; blocks: Array<Record<string, unknown>> };
    };
    expect(body.document.version).toBe(2);
    expect(body.document.blocks.map((block) => [block.type, block.id, block.enabled])).toEqual([
      ['hero', 'hero', true],
      ['cta', 'cta', true],
      ['features', 'features', false],
    ]);
    expect(body.document.blocks[1]).toMatchObject({
      action: { label: 'Sign up', href: '/register' },
    });
  });

  it('previews enabled blocks with the shared renderer and applies advanced JSON', async () => {
    mount();
    const dialog = await openEditor();
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'Landing' } });
    openTab(dialog, /^Advanced JSON/);
    const json = within(dialog).getByLabelText('Blocks (JSON array)');
    fireEvent.change(json, { target: { value: '[{"type":"unknown"}]' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply JSON' }));
    expect(
      within(dialog).getByText('Expected an array of blocks, each with a supported type'),
    ).toBeTruthy();
    fireEvent.change(json, {
      target: {
        value: JSON.stringify([
          { id: 'top', type: 'hero', enabled: true, heading: 'Hello preview', text: 'Intro' },
          {
            id: 'price',
            type: 'pricing',
            enabled: true,
            heading: 'Plans',
            text: '',
            plans: ['pro'],
            showCreditPacks: true,
          },
          {
            id: 'secret',
            type: 'cta',
            enabled: false,
            heading: 'Hidden CTA',
            text: '',
            action: { label: 'Go', href: '/go' },
          },
        ]),
      },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply JSON' }));
    expect(within(dialog).getByRole('tab', { name: 'Blocks (3)' })).toBeTruthy();

    openTab(dialog, /^Preview/);
    expect(await within(dialog).findByText('Hello preview')).toBeTruthy();
    expect(dialog.querySelector('section[data-block-type="pricing"]')).toBeTruthy();
    expect(within(dialog).getByText(/Pricing cards: pro, plus credit packs/)).toBeTruthy();
    expect(within(dialog).queryByText('Hidden CTA')).toBeNull();

    // An invalid draft is not previewed; the field path is shown instead.
    openTab(dialog, /^Blocks/);
    fireEvent.change(dialog.querySelector('[data-field="blocks.1.plans"]')!, {
      target: { value: 'Pro!' },
    });
    openTab(dialog, /^Preview/);
    expect(
      await within(dialog).findByText(/Block 2 · Pricing › Plans 1: Use lowercase letters/),
    ).toBeTruthy();
  });

  it('describes nested field paths from the field table', () => {
    const tx = (_zh: string, en: string) => en;
    expect(describeField('blocks.0.items.1.image.src', [{ type: 'showcase' }], tx)).toBe(
      'Block 1 · Showcase › Item 2 › Cover image › Image URL',
    );
    expect(describeField('seo.title', [], tx)).toBe('SEO title');
  });
});
