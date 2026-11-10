// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailCampaignService } from './mail-campaign.service';
import { MailService } from './mail.service';
import type { DatabaseAdapter } from '@zucker-framework/core';
/**
 * MailCampaignService 单测：直接驱动 processCampaign，不经 BullMQ/Redis
 * （不调用 onModuleInit，故不会建立 Redis 连接）
 */
describe('MailCampaignService.processCampaign', () => {
  let service: MailCampaignService;
  let campaignUpdate: ReturnType<typeof vi.fn>;
  let campaignUpdateMany: ReturnType<typeof vi.fn>;
  let campaignFindUnique: ReturnType<typeof vi.fn>;
  let loadBatch: ReturnType<typeof vi.fn>;
  let dispatchBatch: ReturnType<typeof vi.fn>;
  let isMailEnabled: ReturnType<typeof vi.fn>;
  let resolveTemplate: ReturnType<typeof vi.fn>;

  const baseCampaign = {
    id: 'c1',
    template: 'notice',
    subject: '更新',
    filter: 'all',
    userIds: null,
    excludeUserIds: null,
    status: 'running', // 认领后读到的状态
  };

  beforeEach(() => {
    campaignUpdate = vi.fn().mockResolvedValue({});
    campaignUpdateMany = vi.fn().mockResolvedValue({ count: 1 }); // 默认认领成功
    campaignFindUnique = vi.fn().mockResolvedValue({ ...baseCampaign });
    loadBatch = vi.fn();
    dispatchBatch = vi.fn();
    isMailEnabled = vi.fn().mockReturnValue(true);
    resolveTemplate = vi.fn().mockResolvedValue({ zh: '<p>{{username}}</p>', en: null });

    const database = {
      model: () => ({
        findUnique: campaignFindUnique,
        update: campaignUpdate,
        updateMany: campaignUpdateMany,
      }),
    } as unknown as DatabaseAdapter;
    const mail = {
      isMailEnabled,
      resolveTemplate,
      history: { sentUserIds: vi.fn().mockResolvedValue([]) },
      sendResolved: dispatchBatch,
      isDailyQuota: () => false,
    } as unknown as MailService;
    service = new MailCampaignService(
      {
        database,
        model: 'campaigns',
        queueName: 'campaigns',
        redisUrl: 'redis://localhost:6379',
        workerEnabled: true,
        concurrency: 1,
        deduplicationWindowMs: 60_000,
        validate: async () => {},
        count: async () => 0,
        loadBatch,
        batchSize: 2,
      },
      mail,
    );
  });

  it('正常流程：CAS 认领 → running → completed，回写计数', async () => {
    loadBatch
      .mockResolvedValueOnce([
        { id: 'u1', email: 'one@example.test', data: {} },
        { id: 'u2', email: 'two@example.test', data: {} },
      ])
      .mockResolvedValueOnce([{ id: 'u3', email: 'three@example.test', data: {} }]);
    dispatchBatch
      .mockResolvedValueOnce({ success: true, error: null })
      .mockResolvedValueOnce({ success: true, error: null })
      .mockResolvedValueOnce({ success: false, error: 'delivery failed' });

    await service.processCampaign('c1');

    // 认领走 updateMany 条件更新
    expect(campaignUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c1', status: 'pending' },
        data: expect.objectContaining({ status: 'running' }),
      }),
    );
    const last = campaignUpdate.mock.calls[campaignUpdate.mock.calls.length - 1][0].data;
    expect(last).toMatchObject({ status: 'completed' });
    const progressCalls = campaignUpdate.mock.calls.filter(
      (c) => c[0].data.attempted !== undefined,
    );
    const lastProgress = progressCalls[progressCalls.length - 1][0].data;
    expect(lastProgress).toMatchObject({ attempted: 3, sent: 2, failed: 1, skipped: 0 });
    // 模板每 campaign 只解析一次
    expect(resolveTemplate).toHaveBeenCalledTimes(1);
    expect(loadBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'c1' }),
      undefined,
      2,
    );
    expect(loadBatch).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'c1' }), 'u2', 2);
  });

  it('认领失败（count=0，已被其他 worker 抢或非 pending）→ 跳过', async () => {
    campaignUpdateMany.mockResolvedValue({ count: 0 });
    campaignFindUnique.mockResolvedValue({ ...baseCampaign, status: 'completed' });
    await service.processCampaign('c1');
    expect(loadBatch).not.toHaveBeenCalled();
    expect(campaignUpdate).not.toHaveBeenCalled();
    expect(campaignUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('a re-delivered job for a campaign still running marks it interrupted instead of sending', async () => {
    campaignUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    await service.processCampaign('c1');
    expect(loadBatch).not.toHaveBeenCalled();
    expect(campaignUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'c1', status: 'running' },
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  it('邮件服务未配置 → 提前标 failed，不进入发送', async () => {
    isMailEnabled.mockReturnValue(false);
    await service.processCampaign('c1');
    expect(loadBatch).not.toHaveBeenCalled();
    const failedUpdate = campaignUpdate.mock.calls.find((c) => c[0].data.status === 'failed');
    expect(failedUpdate[0].data.error).toContain('邮件服务未配置');
  });

  it('发送过程抛错：标记 failed 并记录 error', async () => {
    loadBatch.mockRejectedValue(new Error('redis gone'));
    await expect(service.processCampaign('c1')).rejects.toThrow('redis gone');
    const failedUpdate = campaignUpdate.mock.calls.find((c) => c[0].data.status === 'failed');
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate[0].data.error).toBe('redis gone');
  });
});
