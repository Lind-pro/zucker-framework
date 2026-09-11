// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BullMqQueueProvider, BullMqWorkerHost } from '@zucker-framework/queue';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { MailCampaignService, type MailCampaignOptions } from './mail-campaign.service';
import type { MailService } from './mail.service';
const options: MailCampaignOptions = {
  database: { model: () => ({}) } as unknown as DatabaseAdapter,
  model: 'campaigns',
  redisUrl: 'redis://localhost:6379/8',
  queueName: 'mail-campaign',
  workerEnabled: true,
  concurrency: 1,
  deduplicationWindowMs: 1000,
  validate: async () => {},
  count: async () => 0,
  batchSize: 2,
  loadBatch: async () => [],
};
describe('MailCampaignService queue lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the Framework queue adapter for worker startup and shutdown', async () => {
    const register = vi
      .spyOn(BullMqWorkerHost.prototype, 'register')
      .mockImplementation(() => undefined);
    const workerClose = vi.spyOn(BullMqWorkerHost.prototype, 'close').mockResolvedValue(undefined);
    const queueClose = vi
      .spyOn(BullMqQueueProvider.prototype, 'close')
      .mockResolvedValue(undefined);
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const service = new MailCampaignService(
      { ...options, database: { model: () => ({ updateMany }) } as unknown as DatabaseAdapter },
      {} as MailService,
    );
    const processCampaign = vi.spyOn(service, 'processCampaign').mockResolvedValue(undefined);

    await service.onModuleInit();
    await Promise.resolve();

    expect(register).toHaveBeenCalledTimes(1);
    const definition = register.mock.calls[0][0];
    expect(definition.queueName).toBe('mail-campaign');
    await definition.handler({ data: { campaignId: 'campaign-1' } } as never);
    expect(processCampaign).toHaveBeenCalledWith('campaign-1');

    await service.onModuleDestroy();
    expect(workerClose).toHaveBeenCalledTimes(1);
    expect(queueClose).toHaveBeenCalledTimes(1);
  });

  it('keeps web-only producers free of a worker lifecycle', async () => {
    const register = vi
      .spyOn(BullMqWorkerHost.prototype, 'register')
      .mockImplementation(() => undefined);
    const queueClose = vi
      .spyOn(BullMqQueueProvider.prototype, 'close')
      .mockResolvedValue(undefined);
    const service = new MailCampaignService(
      { ...options, workerEnabled: false },
      {} as MailService,
    );

    await service.onModuleInit();
    expect(register).not.toHaveBeenCalled();

    await service.onModuleDestroy();
    expect(queueClose).toHaveBeenCalledTimes(1);
  });
});
