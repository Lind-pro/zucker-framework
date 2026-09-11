import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createUseAuthHydration } from './hydration';

describe('auth persistence hydration', () => {
  it('updates after hydration and releases the subscription on unmount', () => {
    let hydrated = false;
    let finish: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const useHydration = createUseAuthHydration({
      persist: {
        hasHydrated: () => hydrated,
        onFinishHydration: (listener) => {
          finish = listener;
          return unsubscribe;
        },
      },
    });
    const { result, unmount } = renderHook(useHydration);
    expect(result.current).toBe(false);
    act(() => {
      hydrated = true;
      finish?.();
    });
    expect(result.current).toBe(true);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('reflects an already hydrated store without a timer', () => {
    const useHydration = createUseAuthHydration({
      persist: { hasHydrated: () => true, onFinishHydration: () => () => undefined },
    });
    expect(renderHook(useHydration).result.current).toBe(true);
  });

  it('keeps a store without browser persistence unhydrated', () => {
    expect(renderHook(createUseAuthHydration({})).result.current).toBe(false);
  });
});
