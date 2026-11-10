import { describe, expect, it, vi } from 'vitest';
import { ReferenceGuard } from './reference.guard';

function run(request: unknown) {
  const assertNoReferences = vi.fn(async (_type: string, id: string) => {
    if (id === 'used') throw new Error('referenced');
  });
  const guard = new ReferenceGuard(
    { get: () => 'document' } as never,
    { assertNoReferences } as never,
  );
  const ctx = { getHandler: () => undefined, switchToHttp: () => ({ getRequest: () => request }) } as never;
  return { result: guard.canActivate(ctx), assertNoReferences };
}

describe('ReferenceGuard (review L10)', () => {
  it('checks params.id', async () => {
    await expect(run({ params: { id: 'used' } }).result).rejects.toThrow('referenced');
  });

  it('checks batch ids and crud where.id.in bodies', async () => {
    await expect(run({ params: {}, body: { ids: ['free', 'used'] } }).result).rejects.toThrow('referenced');
    await expect(run({ params: {}, body: { where: { id: { in: ['used'] } } } }).result).rejects.toThrow('referenced');
    const ok = run({ params: {}, body: { where: { id: 'free' } } });
    await expect(ok.result).resolves.toBe(true);
    expect(ok.assertNoReferences).toHaveBeenCalledWith('document', 'free');
  });
});
