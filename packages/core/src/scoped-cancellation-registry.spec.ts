import { describe, expect, it, vi } from 'vitest';
import { ScopedCancellationRegistry } from './scoped-cancellation-registry';

describe('ScopedCancellationRegistry', () => {
  it('coordinates one key without cancelling other work', () => {
    const registry = new ScopedCancellationRegistry();
    const first = registry.register('a');
    const second = registry.register('b');
    expect(registry.abort('a')).toBe(true);
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    expect(registry.abort('a')).toBe(false);
  });

  it('preserves replacement and cleanup policy without aborting a forgotten signal', () => {
    const onReplace = vi.fn();
    const registry = new ScopedCancellationRegistry({ onReplace });
    const original = registry.register('a');
    const replacement = registry.register('a');
    expect(onReplace).toHaveBeenCalledWith('a');
    expect(original.aborted).toBe(false);
    registry.cleanup('a');
    expect(registry.abort('a')).toBe(false);
    expect(replacement.aborted).toBe(false);
  });
});
