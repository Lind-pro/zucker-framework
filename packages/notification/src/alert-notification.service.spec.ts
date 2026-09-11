// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AlertNotificationService,
  type AlertNotificationOptions,
} from './alert-notification.service';
import { createWebhookAlertChannel } from './providers/alert-webhook';
const services: AlertNotificationService[] = [];
const alert = { level: 'CRITICAL', title: 'Synthetic failure', message: 'Synthetic diagnostic' };
function service(channels: AlertNotificationOptions['channels'], defaults = ['first']) {
  const value = new AlertNotificationService({
    channels,
    defaultChannels: { CRITICAL: defaults },
    deduplicationWindowMs: 300_000,
    fingerprint: (message) => `${message.level}:${message.title}`,
  });
  services.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((value) => value.onModuleDestroy()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('alert notification delivery', () => {
  it('deduplicates concurrent requests and reports only completed sends as sent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let finish!: () => void;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const dispatcher = service({ first: { send } });
    const pending = dispatcher.sendAlert(alert);
    expect(await dispatcher.sendAlert(alert)).toMatchObject({ status: 'deduplicated' });
    finish();
    expect(await pending).toMatchObject({ status: 'sent' });
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300_000);
    expect(dispatcher.getStats().cachedAlerts).toBe(0);
  });
  it('keeps independent channels running and distinguishes partial/unconfigured delivery', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const dispatcher = service(
      { first: { send }, second: { send: vi.fn().mockRejectedValue(new Error('rejected')) } },
      ['first', 'second', 'missing'],
    );
    expect(await dispatcher.sendAlert(alert)).toMatchObject({
      status: 'partial',
      channels: [
        { channel: 'first', status: 'sent' },
        { channel: 'second', status: 'failed' },
        { channel: 'missing', status: 'unconfigured' },
      ],
    });
    expect(await service({}).sendAlert(alert)).toEqual({
      status: 'skipped',
      channels: [{ channel: 'first', status: 'unconfigured' }],
    });
  });
  it('drains active delivery and refuses new work after shutdown', async () => {
    let finish!: () => void;
    const dispatcher = service({
      first: {
        send: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      },
    });
    const pending = dispatcher.sendAlert(alert);
    let closed = false;
    const closing = dispatcher.onModuleDestroy().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(await dispatcher.sendAlert({ ...alert, title: 'Later' })).toMatchObject({
      status: 'skipped',
    });
    finish();
    await pending;
    await closing;
    expect(closed).toBe(true);
  });
  it('uses provider-specific envelopes and checks chat-provider acknowledgements', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
    vi.stubGlobal('fetch', fetch);
    const channel = createWebhookAlertChannel({
      url: 'https://example.invalid/secret-hook',
      format: 'dingtalk',
    });
    await channel.send({ ...alert, timestamp: '2026-01-01T00:00:00Z' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      msgtype: 'markdown',
      markdown: { title: alert.title },
    });
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ errcode: 40001 }) });
    await expect(channel.send({ ...alert, timestamp: '2026-01-01T00:00:00Z' })).rejects.toThrow(
      'rejected',
    );
  });
});
