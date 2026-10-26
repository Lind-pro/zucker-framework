// @vitest-environment node
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import { describe, expect, it, vi } from 'vitest';
import { AccessLogService, OperationLogService, type PersistentLogOptions } from './persistent-logs';

function setup(options: PersistentLogOptions) {
  const create = vi.fn().mockResolvedValue({ id: 'saved' });
  const db = { model: () => ({ create }) as unknown as ModelOperations } as DatabaseAdapter;
  return { create, access: new AccessLogService(db, undefined, options), operation: new OperationLogService(db, undefined, options) };
}

describe('consumer log persistence policy', () => {
  it('waits for durable observation acknowledgement before deciding whether to sample details', async () => {
    let acknowledge: (accepted: boolean) => void = () => {};
    const completionObservation = new Promise<boolean>((resolve) => { acknowledge = resolve; });
    const policy = vi.fn((_input, context) => !context.completionObserved);
    const { access, create } = setup({ accessShouldPersist: policy });
    const write = access.log({ action: 'search', statusCode: 200 }, { completionObservation });
    await Promise.resolve();
    expect(policy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    acknowledge(true);
    await write;
    expect(policy).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200 }), { completionObserved: true });
    expect(create).not.toHaveBeenCalled();
  });

  it('retains details when aggregation fails or is not installed, while not adding columns to legacy schema', async () => {
    const policy = vi.fn((_input, context) => !context.completionObserved);
    const { access, create } = setup({ accessShouldPersist: policy });
    await access.log({ action: 'search', statusCode: 503, requestId: 'req-1' }, { completionObservation: Promise.resolve(false) });
    await access.log({ action: 'search' });
    await access.log({ action: 'search' }, { completionObservation: Promise.reject(new Error('unavailable')) });
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[0][0].data).not.toHaveProperty('statusCode');
    expect(create.mock.calls[0][0].data).not.toHaveProperty('requestId');
  });

  it.each([
    () => { throw new Error('bad policy'); },
    () => Promise.reject(new Error('unavailable')),
    () => undefined as unknown as boolean,
  ])('keeps logs when policy fails or does not return a boolean', async (policy) => {
    const { access, operation, create } = setup({ accessShouldPersist: policy, operationShouldPersist: policy });
    await access.log({ action: 'search' });
    await operation.log({ module: 'billing', action: 'payment-confirmed' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('supports async business classification without suppressing independent access details', async () => {
    const { access, operation, create } = setup({ operationShouldPersist: async (input) => input.action !== 'search' });
    await operation.log({ module: 'catalog', action: 'search' });
    expect(create).not.toHaveBeenCalled();
    await operation.log({ module: 'billing', action: 'payment-confirmed' });
    await access.log({ action: 'search' });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
