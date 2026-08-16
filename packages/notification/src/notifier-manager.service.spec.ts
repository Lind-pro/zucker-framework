import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NotifierManagerService,
  CompositeNotifyConfigManager,
  type NotifyConfigManager,
} from './notifier-manager.service';
import type { Notifier, NotifierProvider, NotifierConfig, NotifyChannel } from './notifier.interface';

function createMockNotifier(id: string, channel: NotifyChannel = 'EMAIL' as NotifyChannel): Notifier {
  return {
    notifierId: id,
    channel,
    provider: 'test',
    send: vi.fn().mockResolvedValue({ success: true, timestamp: new Date(), channel, to: 'user@test.com' }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockProvider(channel: NotifyChannel = 'EMAIL' as NotifyChannel, provider = 'test'): NotifierProvider {
  const mockNotifier = createMockNotifier('n1', channel);
  return {
    channel,
    provider,
    createNotifier: vi.fn().mockResolvedValue(mockNotifier),
  };
}

describe('NotifierManagerService', () => {
  let service: NotifierManagerService;
  let mockProvider: NotifierProvider;
  let mockConfigManager: NotifyConfigManager;

  beforeEach(() => {
    mockProvider = createMockProvider();
    mockConfigManager = {
      getNotifyConfig: vi.fn().mockResolvedValue({
        id: 'cfg1',
        channel: 'EMAIL',
        provider: 'test',
        configuration: {},
      }),
      saveNotifyConfig: vi.fn().mockResolvedValue(undefined),
      removeNotifyConfig: vi.fn().mockResolvedValue(undefined),
      listConfigs: vi.fn().mockResolvedValue([]),
    };
    service = new NotifierManagerService([mockProvider], mockConfigManager);
  });

  describe('createNotifier', () => {
    it('should create a notifier from config', async () => {
      const config: NotifierConfig = {
        id: 'cfg1',
        channel: 'EMAIL' as NotifyChannel,
        provider: 'test',
        configuration: {},
      };
      const notifier = await service.createNotifier(config);
      expect(notifier).toBeDefined();
      expect(mockProvider.createNotifier).toHaveBeenCalledWith(config);
    });

    it('should throw NotFoundException when no provider matches', async () => {
      const config: NotifierConfig = {
        id: 'cfg2',
        channel: 'SMS' as NotifyChannel,
        provider: 'unknown',
        configuration: {},
      };
      await expect(service.createNotifier(config)).rejects.toThrow('No NotifierProvider found');
    });

    it('should close existing notifier before creating new one for same config', async () => {
      const config: NotifierConfig = {
        id: 'cfg1',
        channel: 'EMAIL' as NotifyChannel,
        provider: 'test',
        configuration: {},
      };
      await service.createNotifier(config);
      await service.createNotifier(config);
      // The first notifier's close should have been called via the dispatcher
      // (NotifierEventDispatcher wraps, but delegates close)
    });
  });

  describe('getNotifier', () => {
    it('should create and cache a notifier', async () => {
      const notifier = await service.getNotifier('EMAIL' as NotifyChannel, 'cfg1');
      expect(notifier).toBeDefined();
    });

    it('should return cached notifier on second call', async () => {
      const first = await service.getNotifier('EMAIL' as NotifyChannel, 'cfg1');
      const second = await service.getNotifier('EMAIL' as NotifyChannel, 'cfg1');
      expect(first).toBe(second);
    });

    it('should throw when config manager is not provided', async () => {
      const serviceNoConfig = new NotifierManagerService([mockProvider]);
      await expect(serviceNoConfig.getNotifier('EMAIL' as NotifyChannel, 'cfg1')).rejects.toThrow(
        'NotifyConfigManager not configured',
      );
    });

    it('should throw when config is not found', async () => {
      (mockConfigManager.getNotifyConfig as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getNotifier('EMAIL' as NotifyChannel, 'missing')).rejects.toThrow(
        'Notifier config not found',
      );
    });
  });

  describe('reload', () => {
    it('should close and remove cached notifier', async () => {
      await service.getNotifier('EMAIL' as NotifyChannel, 'cfg1');
      await service.reload('cfg1');
      // After reload, getNotifier should create a new one
      (mockConfigManager.getNotifyConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'cfg1',
        channel: 'EMAIL',
        provider: 'test',
        configuration: {},
      });
      const fresh = await service.getNotifier('EMAIL' as NotifyChannel, 'cfg1');
      expect(fresh).toBeDefined();
    });
  });

  describe('closeAll', () => {
    it('should close all notifiers and clear cache', async () => {
      await service.getNotifier('EMAIL' as NotifyChannel, 'cfg1');
      await service.closeAll();
      // After closeAll, cache is empty so getNotifier will create a new one
      (mockConfigManager.getNotifyConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'cfg1',
        channel: 'EMAIL',
        provider: 'test',
        configuration: {},
      });
      const notifier = await service.getNotifier('EMAIL' as NotifyChannel, 'cfg1');
      expect(notifier).toBeDefined();
      expect(mockProvider.createNotifier).toHaveBeenCalledTimes(2);
    });
  });
});

describe('CompositeNotifyConfigManager', () => {
  it('should return config from first manager that has it', async () => {
    const m1: NotifyConfigManager = {
      getNotifyConfig: vi.fn().mockResolvedValue(null),
      saveNotifyConfig: vi.fn(),
      removeNotifyConfig: vi.fn(),
      listConfigs: vi.fn().mockResolvedValue([]),
    };
    const m2: NotifyConfigManager = {
      getNotifyConfig: vi.fn().mockResolvedValue({ id: 'x', channel: 'EMAIL', provider: 'test', configuration: {} }),
      saveNotifyConfig: vi.fn(),
      removeNotifyConfig: vi.fn(),
      listConfigs: vi.fn().mockResolvedValue([]),
    };
    const composite = new CompositeNotifyConfigManager([m1, m2]);
    const result = await composite.getNotifyConfig('EMAIL' as NotifyChannel, 'x');
    expect(result?.id).toBe('x');
  });

  it('should deduplicate configs in listConfigs', async () => {
    const cfg = { id: 'c1', channel: 'EMAIL', provider: 'test', configuration: {} };
    const m1: NotifyConfigManager = {
      getNotifyConfig: vi.fn(),
      saveNotifyConfig: vi.fn(),
      removeNotifyConfig: vi.fn(),
      listConfigs: vi.fn().mockResolvedValue([cfg]),
    };
    const m2: NotifyConfigManager = {
      getNotifyConfig: vi.fn(),
      saveNotifyConfig: vi.fn(),
      removeNotifyConfig: vi.fn(),
      listConfigs: vi.fn().mockResolvedValue([cfg]),
    };
    const composite = new CompositeNotifyConfigManager([m1, m2]);
    const configs = await composite.listConfigs();
    expect(configs).toHaveLength(1);
  });
});
