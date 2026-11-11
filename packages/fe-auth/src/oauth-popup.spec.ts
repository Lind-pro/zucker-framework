import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimOAuthPopup,
  openOAuthPopup,
  parseOAuthPopupMessage,
  type OAuthPopupChannel,
  type OAuthPopupChannelFactory,
} from './oauth-popup';

const STATE = 'state-0123456789abcdef';

/** In-memory BroadcastChannel bus: delivers to every other channel of the same name, asynchronously. */
function createBus() {
  const channels = new Map<string, Set<OAuthPopupChannel>>();
  const names: string[] = [];
  const factory: OAuthPopupChannelFactory = (name) => {
    names.push(name);
    const peers = channels.get(name) ?? new Set<OAuthPopupChannel>();
    channels.set(name, peers);
    const channel: OAuthPopupChannel = {
      onmessage: null,
      postMessage(message) {
        for (const peer of peers) {
          if (peer !== channel) queueMicrotask(() => peer.onmessage?.({ data: message }));
        }
      },
      close() {
        peers.delete(channel);
      },
    };
    peers.add(channel);
    return channel;
  };
  const inject = (name: string, data: unknown) => {
    for (const peer of channels.get(name) ?? []) peer.onmessage?.({ data });
  };
  return { factory, names, inject, open: (name: string) => channels.get(name)?.size ?? 0 };
}

function fakeWindow(popup: { closed: boolean; close: () => void } | null = { closed: false, close: vi.fn() }) {
  return { open: vi.fn(() => popup), popup };
}

describe('openOAuthPopup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves blocked and releases the channel when window.open returns null', async () => {
    const bus = createBus();
    const win = fakeWindow(null);
    await expect(openOAuthPopup({ url: '/oauth/start', state: STATE, windowImpl: win, channelFactory: bus.factory }))
      .resolves.toEqual({ status: 'blocked' });
    expect(bus.open(`zucker-oauth:${STATE}`)).toBe(0);
  });

  it('completes over ready/claim/done with a safe return path', async () => {
    const bus = createBus();
    const win = fakeWindow();
    const result = openOAuthPopup({ url: '/oauth/start', state: STATE, windowImpl: win, channelFactory: bus.factory });
    expect(win.open).toHaveBeenCalledWith('/oauth/start', 'zucker-oauth', expect.any(String));

    const claimed = claimOAuthPopup(STATE, { channelFactory: bus.factory, windowImpl: { close: vi.fn() } });
    await vi.advanceTimersByTimeAsync(0);
    const claim = await claimed;
    expect(claim).not.toBeNull();
    claim!.complete('/console?tab=1');
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toEqual({ status: 'completed', returnPath: '/console?tab=1' });
    expect(bus.names).toEqual([`zucker-oauth:${STATE}`, `zucker-oauth:${STATE}`]);
  });

  it('the popup keeps its result until the opener acknowledges it, and both sides close the popup', async () => {
    const bus = createBus();
    const name = `zucker-oauth:${STATE}`;
    const popupWindow = { close: vi.fn() };
    const seen: unknown[] = [];
    // Popup claims first; an observer records the traffic.
    const observer = bus.factory(name);
    observer.onmessage = (event) => seen.push(event.data);
    const claimed = claimOAuthPopup(STATE, { channelFactory: bus.factory, windowImpl: popupWindow });
    observer.postMessage({ type: 'claim' });
    await vi.advanceTimersByTimeAsync(0);
    const claim = await claimed;
    claim!.fail('ACCESS_DENIED');
    // No opener yet: the popup stays open and re-posts its result.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(popupWindow.close).not.toHaveBeenCalled();
    expect(seen.filter((m) => (m as { type: string }).type === 'failed').length).toBeGreaterThan(1);
    // The opener (late) receives it, acknowledges and closes the popup it opened.
    const popupHandle = { closed: false, close: vi.fn() };
    const result = openOAuthPopup({ url: '/x', state: STATE, windowImpl: fakeWindow(popupHandle), channelFactory: bus.factory });
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toEqual({ status: 'failed', code: 'ACCESS_DENIED' });
    expect(popupHandle.close).toHaveBeenCalled();
    expect(popupWindow.close).toHaveBeenCalledTimes(1);
    expect(seen).toContainEqual({ type: 'ack' });
    observer.close();
    expect(bus.open(name)).toBe(0);
  });

  it('a popup whose result is never acknowledged closes itself after a bounded wait', async () => {
    const bus = createBus();
    const popupWindow = { close: vi.fn() };
    const claimed = claimOAuthPopup(STATE, { channelFactory: bus.factory, windowImpl: popupWindow });
    bus.inject(`zucker-oauth:${STATE}`, { type: 'claim' });
    const claim = await claimed;
    claim!.complete();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(popupWindow.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(popupWindow.close).toHaveBeenCalledTimes(1);
    expect(bus.open(`zucker-oauth:${STATE}`)).toBe(0);
  });

  it('drops an unsafe return path and reports failure codes', async () => {
    const bus = createBus();
    const name = `zucker-oauth:${STATE}`;
    const first = openOAuthPopup({ url: '/x', state: STATE, windowImpl: fakeWindow(), channelFactory: bus.factory });
    bus.inject(name, { type: 'done', returnPath: '//evil.example' });
    await expect(first).resolves.toEqual({ status: 'completed' });

    const second = openOAuthPopup({ url: '/x', state: STATE, windowImpl: fakeWindow(), channelFactory: bus.factory });
    bus.inject(name, { type: 'failed', code: 'not a code <script>' });
    await expect(second).resolves.toEqual({ status: 'failed', code: 'OAUTH_FAILED' });
  });

  it('ignores malformed messages and times out, closing the popup', async () => {
    const bus = createBus();
    const win = fakeWindow();
    const name = `zucker-oauth:${STATE}`;
    const result = openOAuthPopup({ url: '/x', state: STATE, timeoutMs: 1_000, windowImpl: win, channelFactory: bus.factory });
    for (const data of [
      null, 'done', ['done'], { type: 'done', returnPath: '/a', token: 'secret' }, { type: 'done', returnPath: 5 },
      { type: 'failed' }, { type: 'claimx' }, { type: 'ready', extra: 1 },
    ]) bus.inject(name, data);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ status: 'timeout' });
    expect(win.popup!.close).toHaveBeenCalled();
  });

  it('resolves closed when the user closes the popup', async () => {
    const bus = createBus();
    const popup = { closed: false, close: vi.fn() };
    const result = openOAuthPopup({ url: '/x', state: STATE, windowImpl: fakeWindow(popup), channelFactory: bus.factory });
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ status: 'closed' });
  });

  it('rejects a weak state at call time', () => {
    expect(() => openOAuthPopup({ url: '/x', state: 'short', windowImpl: fakeWindow(), channelFactory: createBus().factory }))
      .toThrow(TypeError);
  });
});

describe('claimOAuthPopup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns null when no opener claims within the default 3000 ms (not earlier)', async () => {
    const bus = createBus();
    const claimed = claimOAuthPopup(STATE, { channelFactory: bus.factory });
    let settled = false; void claimed.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(claimed).resolves.toBeNull();
    expect(bus.open(`zucker-oauth:${STATE}`)).toBe(0);
  });

  it('returns null without BroadcastChannel or with a malformed state', async () => {
    await expect(claimOAuthPopup('bad state', { channelFactory: createBus().factory })).resolves.toBeNull();
  });
});

describe('parseOAuthPopupMessage', () => {
  it('accepts exact shapes only', () => {
    expect(parseOAuthPopupMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseOAuthPopupMessage({ type: 'done' })).toEqual({ type: 'done' });
    expect(parseOAuthPopupMessage({ type: 'ack' })).toEqual({ type: 'ack' });
    expect(parseOAuthPopupMessage({ type: 'ack', ok: true })).toBeNull();
    expect(parseOAuthPopupMessage({ type: 'failed', code: 'X' })).toEqual({ type: 'failed', code: 'X' });
    expect(parseOAuthPopupMessage({ type: 'done', ticket: 't' })).toBeNull();
    expect(parseOAuthPopupMessage(Object.assign(Object.create({ polluted: 1 }), { type: 'ready' }))).toBeNull();
  });
});
