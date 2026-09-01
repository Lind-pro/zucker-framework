import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CompositeNotifierService, type FallbackStrategy } from './composite-notifier.service';
import { NotifyHistoryService } from './notify-history.service';
import type { SimpleNotifierProvider, NotifyMessage, NotifyChannel } from './notifier.interface';

function createProvider(channel: NotifyChannel, sendFn?: () => Promise<void>): SimpleNotifierProvider {
  return {
    channel,
    send: sendFn ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe('CompositeNotifierService', () => {
  let historyService: NotifyHistoryService;

  const makeMessage = (overrides: Partial<NotifyMessage> = {}): NotifyMessage => ({
    channel: 'EMAIL' as NotifyChannel,
    to: 'user@test.com',
    variables: {},
    subject: 'Test',
    ...overrides,
  });

  beforeEach(() => {
    historyService = new NotifyHistoryService();
  });

  describe('send', () => {
    it('should send via the primary channel provider', async () => {
      const emailProvider = createProvider('EMAIL' as NotifyChannel);
      const service = new CompositeNotifierService([emailProvider], historyService);
      const result = await service.send(makeMessage());
      expect(result.success).toBe(true);
      expect(result.channel).toBe('EMAIL');
      expect(emailProvider.send).toHaveBeenCalled();
    });

    it('should record history on successful send', async () => {
      const emailProvider = createProvider('EMAIL' as NotifyChannel);
      const service = new CompositeNotifierService([emailProvider], historyService);
      await service.send(makeMessage());
      const stats = historyService.getStats();
      expect(stats.total).toBe(1);
      expect(stats.success).toBe(1);
    });

    it('should throw after all attempts fail', async () => {
      const failProvider = createProvider('EMAIL' as NotifyChannel, vi.fn().mockRejectedValue(new Error('fail')));
      const strategy: FallbackStrategy = {
        maxAttempts: 1,
        channelPriority: ['EMAIL' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([failProvider], historyService, strategy);
      await expect(service.send(makeMessage())).rejects.toThrow('fail');
    });

    it('should record failed attempts in history', async () => {
      const failProvider = createProvider('EMAIL' as NotifyChannel, vi.fn().mockRejectedValue(new Error('err')));
      const strategy: FallbackStrategy = {
        maxAttempts: 1,
        channelPriority: ['EMAIL' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([failProvider], historyService, strategy);
      await service.send(makeMessage()).catch(() => {});
      const stats = historyService.getStats();
      expect(stats.failed).toBe(1);
    });
  });

  describe('timeout', () => {
    it('should timeout when provider takes too long', async () => {
      vi.useFakeTimers();
      const slowProvider = createProvider(
        'EMAIL' as NotifyChannel,
        vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      );
      const strategy: FallbackStrategy = {
        maxAttempts: 1,
        channelPriority: ['EMAIL' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([slowProvider], historyService, strategy);
      const sendPromise = service.send(makeMessage());
      vi.advanceTimersByTime(10_000);
      await expect(sendPromise).rejects.toThrow('Provider send timeout after 10000ms');
      vi.useRealTimers();
    });

    it('should clear timeout timer after successful send', async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const emailProvider = createProvider('EMAIL' as NotifyChannel);
      const strategy: FallbackStrategy = {
        maxAttempts: 1,
        channelPriority: ['EMAIL' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([emailProvider], historyService, strategy);
      await service.send(makeMessage());
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('should clear timeout timer after provider failure', async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const failProvider = createProvider('EMAIL' as NotifyChannel, vi.fn().mockRejectedValue(new Error('boom')));
      const strategy: FallbackStrategy = {
        maxAttempts: 1,
        channelPriority: ['EMAIL' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([failProvider], historyService, strategy);
      await service.send(makeMessage()).catch(() => {});
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  describe('fallback', () => {
    it('should fall back to secondary channel on primary failure', async () => {
      const emailFail = createProvider('EMAIL' as NotifyChannel, vi.fn().mockRejectedValue(new Error('email down')));
      const smsOk = createProvider('SMS' as NotifyChannel);
      const strategy: FallbackStrategy = {
        maxAttempts: 2,
        channelPriority: ['EMAIL' as NotifyChannel, 'SMS' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([emailFail, smsOk], historyService, strategy);
      const result = await service.send(makeMessage({ channel: 'EMAIL' as NotifyChannel }));
      expect(result.success).toBe(true);
      expect(result.channel).toBe('SMS');
    });

    it('should respect maxAttempts limit', async () => {
      const failProvider = createProvider('EMAIL' as NotifyChannel, vi.fn().mockRejectedValue(new Error('fail')));
      const smsProvider = createProvider('SMS' as NotifyChannel);
      const strategy: FallbackStrategy = {
        maxAttempts: 1,
        channelPriority: ['EMAIL' as NotifyChannel, 'SMS' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([failProvider, smsProvider], historyService, strategy);
      // maxAttempts=1 means only 1 attempt total, so SMS fallback should not be reached
      await expect(service.send(makeMessage())).rejects.toThrow('fail');
    });

    it('should degrade through multiple channels until success', async () => {
      const emailFail = createProvider('EMAIL' as NotifyChannel, vi.fn().mockRejectedValue(new Error('email down')));
      const smsFail = createProvider('SMS' as NotifyChannel, vi.fn().mockRejectedValue(new Error('sms down')));
      const webhookOk = createProvider('WEBHOOK' as NotifyChannel);
      const strategy: FallbackStrategy = {
        maxAttempts: 3,
        channelPriority: ['EMAIL' as NotifyChannel, 'SMS' as NotifyChannel, 'WEBHOOK' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([emailFail, smsFail, webhookOk], historyService, strategy);
      const result = await service.send(makeMessage({ channel: 'EMAIL' as NotifyChannel }));
      expect(result.success).toBe(true);
      expect(result.channel).toBe('WEBHOOK');
    });

    it('should record history for each attempt including failures', async () => {
      const recordSpy = vi.spyOn(historyService, 'record');
      const emailFail = createProvider('EMAIL' as NotifyChannel, vi.fn().mockRejectedValue(new Error('email down')));
      const smsOk = createProvider('SMS' as NotifyChannel);
      const strategy: FallbackStrategy = {
        maxAttempts: 2,
        channelPriority: ['EMAIL' as NotifyChannel, 'SMS' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([emailFail, smsOk], historyService, strategy);
      await service.send(makeMessage({ channel: 'EMAIL' as NotifyChannel }));
      // Should record: 1 failed EMAIL attempt + 1 successful SMS attempt
      expect(recordSpy).toHaveBeenCalledTimes(2);
      expect(recordSpy.mock.calls[0][1].success).toBe(false);
      expect(recordSpy.mock.calls[1][1].success).toBe(true);
    });
  });

  describe('historyService.record', () => {
    it('should call historyService.record with correct retryCount', async () => {
      const recordSpy = vi.spyOn(historyService, 'record');
      const emailProvider = createProvider('EMAIL' as NotifyChannel);
      const strategy: FallbackStrategy = {
        maxAttempts: 2,
        channelPriority: ['EMAIL' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([emailProvider], historyService, strategy);
      await service.send(makeMessage());
      expect(recordSpy).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'EMAIL' }),
        expect.objectContaining({ success: true }),
        { retryCount: 1 },
      );
    });

    it('should work without historyService (optional)', async () => {
      const emailProvider = createProvider('EMAIL' as NotifyChannel);
      const strategy: FallbackStrategy = {
        maxAttempts: 1,
        channelPriority: ['EMAIL' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([emailProvider], undefined, strategy);
      const result = await service.send(makeMessage());
      expect(result.success).toBe(true);
    });
  });

  describe('sendBatch', () => {
    it('should send to multiple recipients and collect results', async () => {
      const emailProvider = createProvider('EMAIL' as NotifyChannel);
      const strategy: FallbackStrategy = {
        maxAttempts: 2,
        channelPriority: ['EMAIL' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([emailProvider], historyService, strategy);
      const results = await service.sendBatch(
        { channel: 'EMAIL' as NotifyChannel, variables: {}, subject: 'Hi' },
        ['a@test.com', 'b@test.com', 'c@test.com'],
      );
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it('should return empty array for empty recipients', async () => {
      const emailProvider = createProvider('EMAIL' as NotifyChannel);
      const service = new CompositeNotifierService([emailProvider], historyService);
      const results = await service.sendBatch(
        { channel: 'EMAIL' as NotifyChannel, variables: {} },
        [],
      );
      expect(results).toEqual([]);
    });

    it('should include failure result for individual recipient failures', async () => {
      let callCount = 0;
      const sendFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error('recipient-fail');
      });
      const emailProvider = createProvider('EMAIL' as NotifyChannel, sendFn);
      const strategy: FallbackStrategy = {
        maxAttempts: 1,
        channelPriority: ['EMAIL' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([emailProvider], historyService, strategy);
      const results = await service.sendBatch(
        { channel: 'EMAIL' as NotifyChannel, variables: {} },
        ['a@test.com', 'b@test.com', 'c@test.com'],
      );
      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[2].success).toBe(true);
    });

    it('should return all failures when all recipients fail', async () => {
      const failProvider = createProvider('EMAIL' as NotifyChannel, vi.fn().mockRejectedValue(new Error('all-fail')));
      const strategy: FallbackStrategy = {
        maxAttempts: 1,
        channelPriority: ['EMAIL' as NotifyChannel],
        retryDelayMs: 0,
      };
      const service = new CompositeNotifierService([failProvider], historyService, strategy);
      const results = await service.sendBatch(
        { channel: 'EMAIL' as NotifyChannel, variables: {} },
        ['a@test.com', 'b@test.com'],
      );
      expect(results).toHaveLength(2);
      expect(results.every((r) => !r.success)).toBe(true);
      expect(results[0].error).toBe('all-fail');
    });
  });
});
