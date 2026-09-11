// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { MailTemplateCatalog } from './template-catalog';

function harness() {
  const model = {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn(async ({ data }) => ({ id: 'stored', ...data })),
    update: vi.fn(async ({ data }) => ({ id: 'stored', ...data })),
    delete: vi.fn(),
  };
  const db = { model: vi.fn(() => model) } as unknown as DatabaseAdapter;
  const catalog = new MailTemplateCatalog({
    database: db,
    model: 'templates',
    defaultLocale: 'fr',
    contentFields: { fr: 'bodyFr', en: 'bodyEn' },
    builtIns: [
      {
        key: 'notice',
        name: 'Notice',
        description: 'A notice',
        contents: { fr: '<p>{{name}}</p>', en: '<p>Hello {{name}} {{link}}</p>' },
        metadata: { category: 'service' },
      },
    ],
    fallback: () => ({ fr: '{{content}}', en: null }),
  });
  return { model, db, catalog };
}

describe('persistent localized mail templates', () => {
  it('uses active database overrides, locale fallback and current records on subsequent reads', async () => {
    const { catalog, model } = harness();
    model.findUnique.mockResolvedValueOnce({
      isActive: true,
      bodyFr: 'DB {{name}}',
      bodyEn: '   ',
    });
    expect(catalog.select(await catalog.resolve('notice'), 'en-US')).toBe('DB {{name}}');
    model.findUnique.mockResolvedValueOnce({ isActive: false, bodyFr: 'Disabled', bodyEn: null });
    expect(catalog.select(await catalog.resolve('notice'), 'en-US')).toBe(
      '<p>Hello {{name}} {{link}}</p>',
    );
    model.findUnique.mockRejectedValueOnce(new Error('database unavailable'));
    expect(catalog.select(await catalog.resolve('unknown'))).toBe('{{content}}');
  });
  it('renders escaped values, preserves unknown variables and excludes prototype properties', () => {
    const { catalog } = harness();
    expect(
      catalog.interpolate('{{name}} {{nil}} {{missing}}', { name: '<b>"A"</b>', nil: null }),
    ).toBe('&lt;b&gt;&quot;A&quot;&lt;/b&gt;  {{missing}}');
    expect(
      catalog.interpolate('<a href="{{url}}">{{name}}</a>', {
        url: 'javascript:alert(1)',
        name: 'Safe',
      }),
    ).toBe('<a href="#">Safe</a>');
    expect(catalog.interpolate('{{toString}}', {})).toBe('{{toString}}');
    expect(catalog.hasBuiltIn('__proto__')).toBe(false);
  });
  it('lists persisted templates ahead of built-ins and seeds all language variants', async () => {
    const { catalog, model } = harness();
    model.findMany.mockResolvedValueOnce([{ id: 'custom', key: 'notice', name: 'Override' }]);
    expect(await catalog.list()).toEqual([
      { id: 'custom', key: 'notice', name: 'Override', isBuiltIn: false },
    ]);
    expect(await catalog.seed('notice')).toMatchObject({
      key: 'notice',
      bodyFr: '<p>{{name}}</p>',
      bodyEn: '<p>Hello {{name}} {{link}}</p>',
      variables: ['name', 'link'],
      isActive: true,
    });
  });
  it('whitelists writes, validates required content and recomputes variables after updates', async () => {
    const { catalog, model } = harness();
    await expect(catalog.create({ key: 'bad/key', name: 'Bad', bodyFr: 'HTML' })).rejects.toThrow(
      'key',
    );
    await expect(catalog.create({ key: 'ok', name: 'Good', bodyFr: '' })).rejects.toThrow('bodyFr');
    await catalog.create({
      key: 'custom',
      name: 'Custom',
      bodyFr: '{{one}}',
      bodyEn: null,
      injected: 'ignored',
    });
    expect(model.create.mock.calls[0][0].data).not.toHaveProperty('injected');
    model.findUnique.mockResolvedValueOnce({
      id: 'stored',
      key: 'custom',
      bodyFr: '{{one}}',
      bodyEn: '{{two}}',
    });
    await catalog.update('stored', { bodyFr: '{{three}}', injected: 'ignored' });
    expect(model.update).toHaveBeenCalledWith({
      where: { id: 'stored' },
      data: { bodyFr: '{{three}}', variables: ['three', 'two'] },
    });
  });
});
