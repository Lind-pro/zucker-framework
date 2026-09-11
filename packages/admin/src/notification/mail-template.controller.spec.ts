// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { PermissionsGuard, type PermissionService } from '@zucker-framework/auth';
import { createMailTemplateAdminController } from './mail-template.controller';

const PREVIEW = Symbol('PREVIEW');
function harness() {
  const Controller = createMailTemplateAdminController({
    path: 'mail/templates',
    permissions: { read: 'mail:read', write: 'mail:write' },
    auditModule: 'templates',
    previewService: PREVIEW,
  });
  const templates = {
    list: vi.fn(),
    findOne: vi.fn().mockResolvedValue({ key: 'notice' }),
    create: vi.fn(),
    seed: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    options: { defaultLocale: 'fr' },
    draftContents: vi.fn().mockReturnValue('localized'),
  };
  const preview = {
    previewTemplate: vi.fn().mockResolvedValue({ html: 'preview' }),
    renderRawHtml: vi.fn().mockReturnValue('draft'),
  };
  const controller = new Controller({ templates }, preview) as {
    preview(id: string, body: { locale?: string }): Promise<unknown>;
    previewHtml(body: Record<string, unknown>): unknown;
    create(body: Record<string, unknown>): unknown;
    list(): unknown;
  };
  return { Controller, controller, templates, preview };
}

describe('shared mail template admin routes', () => {
  it('uses the persisted key and host preview context without owning business sample data', async () => {
    const { controller, templates, preview } = harness();
    expect(await controller.preview('stored-id', {})).toEqual({ html: 'preview' });
    expect(templates.findOne).toHaveBeenCalledWith('stored-id');
    expect(preview.previewTemplate).toHaveBeenCalledWith('notice', 'fr');
    expect(controller.previewHtml({ locale: 'en', bodyEn: 'HTML' })).toEqual({ html: 'draft' });
    expect(preview.renderRawHtml).toHaveBeenCalledWith('localized', 'en');
  });
  it('separates read and write permissions on the generated controller', async () => {
    const { Controller, controller } = harness();
    const check = vi.fn(async (_id, permissions: string[]) =>
      permissions.every((value) => value === 'mail:read'),
    );
    const guard = new PermissionsGuard(new Reflector(), {
      hasPermission: check,
    } as unknown as PermissionService);
    const context = (method: 'create' | 'list') =>
      ({
        getClass: () => Controller,
        getHandler: () => controller[method],
        switchToHttp: () => ({ getRequest: () => ({ user: { id: 'reader' } }) }),
      }) as unknown as ExecutionContext;
    expect(await guard.canActivate(context('list'))).toBe(true);
    expect(await guard.canActivate(context('create'))).toBe(false);
    expect(check).toHaveBeenLastCalledWith('reader', ['mail:write']);
  });
});
