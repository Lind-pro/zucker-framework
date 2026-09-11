import { describe, expect, it, vi } from 'vitest';
import { collectGraphUpdates } from './graph-update-execution';

describe('collectGraphUpdates', () => {
  it('consumes every node in an update and awaits progress before advancing', async () => {
    const order: string[] = [];
    async function* updates() {
      yield { first: { title: 'ready' }, second: { total: 2 } };
      order.push('next');
      yield { third: { total: 3 } };
    }
    const result = await collectGraphUpdates<{ title: string; total: number }>(updates(), {
      initialState: { total: 0 },
      onNodeComplete: async (node) => {
        order.push(node);
      },
    });
    expect(result).toEqual({ title: 'ready', total: 3 });
    expect(order).toEqual(['first', 'second', 'next', 'third']);
  });

  it('closes the iterator and propagates a rejected progress write', async () => {
    const closed = vi.fn();
    const failure = new Error('progress unavailable');
    async function* updates() {
      try {
        yield { first: { total: 1 } };
        yield { second: { total: 2 } };
      } finally {
        closed();
      }
    }
    await expect(
      collectGraphUpdates(updates(), {
        onNodeComplete: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('propagates graph cancellation without restarting the graph', async () => {
    const aborted = new Error('aborted');
    async function* updates() {
      yield { first: { total: 1 } };
      throw aborted;
    }
    await expect(collectGraphUpdates(updates())).rejects.toBe(aborted);
  });
});
