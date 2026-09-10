import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { DATA_PERMISSION_KEY } from '../decorators/constants';
import { OwnCreatedDataAccessHandler } from '../data-access/own-created.handler';
import { ResourceOwnershipGuard } from './resource-ownership.guard';

function harness(owner: string | null, grant = false) {
  const findUnique = vi.fn(async () => (owner === null ? null : { userId: owner }));
  const explicitGrant = vi.fn(async () => grant);
  const handler = new OwnCreatedDataAccessHandler(
    { model: () => ({ findUnique }) } as unknown as DatabaseAdapter,
    { hasExplicitGrant: explicitGrant },
  );
  const guard = new ResourceOwnershipGuard(new Reflector(), handler, { creatorField: 'userId' });
  const route = () => undefined;
  Reflect.defineMetadata(DATA_PERMISSION_KEY, { dataType: 'documents' }, route);
  const request = {
    user: { id: 'reader' },
    auth: { marker: true },
    method: 'GET',
    params: { id: 'doc' },
  };
  const context = {
    getHandler: () => route,
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { guard, context, request, findUnique, explicitGrant };
}

describe('ResourceOwnershipGuard', () => {
  it.each([
    ['reader', false, true],
    ['other', false, false],
    ['other', true, true],
    [null, true, false],
  ] as const)(
    'checks detail ownership and explicit grant: %s/%s',
    async (owner, grant, allowed) => {
      const h = harness(owner, grant);
      const auth = h.request.auth;
      await expect(h.guard.canActivate(h.context)).resolves.toBe(allowed);
      expect(h.request.auth).toBe(auth);
      expect(h.findUnique).toHaveBeenCalledWith({ where: { id: 'doc' }, select: { userId: true } });
    },
  );
  it('denies lookup and grant failures without falling back to permissions or empty filters', async () => {
    const h = harness('other', true);
    h.findUnique.mockRejectedValueOnce(new Error('db offline'));
    await expect(h.guard.canActivate(h.context)).resolves.toBe(false);
    expect(h.explicitGrant).not.toHaveBeenCalled();
    h.explicitGrant.mockRejectedValueOnce(new Error('grant store offline'));
    await expect(h.guard.canActivate(h.context)).resolves.toBe(false);
  });
  it('requires identity and denies unscoped collection access by default', async () => {
    const h = harness('reader');
    h.request.params.id = '';
    await expect(h.guard.canActivate(h.context)).resolves.toBe(false);
    h.request.user.id = '';
    await expect(h.guard.canActivate(h.context)).resolves.toBe(false);
  });
});
