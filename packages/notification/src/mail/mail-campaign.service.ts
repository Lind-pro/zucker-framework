import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  BadRequestException,
} from '@nestjs/common';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import {
  BullMqQueueProvider,
  BullMqWorkerHost,
  bullMqConnectionFromUrl,
} from '@zucker-framework/queue';
import { MailService } from './mail.service';
import { dispatchMailBatch, type MailBatchRecipient } from './mail-batch';

export interface MailCampaignOptions {
  database: DatabaseAdapter;
  model: string;
  redisUrl: string;
  queueName: string;
  workerEnabled: boolean;
  concurrency: number;
  deduplicationWindowMs: number;
  validate: (params: EnqueueCampaignParams) => Promise<void>;
  count: (params: EnqueueCampaignParams) => Promise<number>;
  batchSize: number;
  /** Return recipients ordered by stable id, strictly after the supplied cursor. */
  loadBatch: (
    params: EnqueueCampaignParams,
    cursor: string | undefined,
    limit: number,
  ) => Promise<MailBatchRecipient[]>;
}
export interface MailCampaignRecord extends EnqueueCampaignParams {
  id: string;
  status: string;
  total: number;
}

interface CampaignJobData {
  campaignId: string;
}

export interface EnqueueCampaignParams {
  template: string;
  subject: string;
  filter: string;
  userIds?: string[];
  excludeUserIds?: string[];
  actorUserId?: string;
}

/**
 * 群发邮件任务编排（异步）。
 *
 * 设计：
 *  - enqueue 立即落库 mailCampaigns（status=pending）+ 入队，返回 campaignId，HTTP 不阻塞
 *  - Worker 异步消费：游标分批拉用户 → dispatchBatch（幂等+限并发）→ 实时回写进度
 *  - Worker 在 onModuleInit 创建（避免单测/构建时连 Redis），onModuleDestroy 优雅关闭
 *  - 失败明细落 emailLogs（受权限保护）；campaign 仅存计数 + 失败原因摘要
 */
@Injectable()
export class MailCampaignService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailCampaignService.name);
  private queue: BullMqQueueProvider | null = null;
  private workers: BullMqWorkerHost | null = null;
  private started = false;
  private readonly campaigns: ModelOperations<MailCampaignRecord>;
  constructor(
    private readonly options: MailCampaignOptions,
    private readonly mailService: MailService,
  ) {
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1)
      throw new Error('Invalid mail campaign batch size');
    this.campaigns = options.database.model(options.model) as ModelOperations<MailCampaignRecord>;
  }

  async onModuleInit(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.queue = new BullMqQueueProvider({
      connection: bullMqConnectionFromUrl(this.options.redisUrl, { role: 'producer' }),
    });

    if (!this.options.workerEnabled) {
      this.logger.debug('Campaign worker disabled; producer-only mode');
      return;
    }

    // Finish recovery before accepting work; otherwise startup can fail a newly claimed campaign.
    try {
      await this.reapOrphanedCampaigns();
    } catch (error) {
      await this.onModuleDestroy();
      throw error;
    }
    this.workers = new BullMqWorkerHost({
      connection: bullMqConnectionFromUrl(this.options.redisUrl, { role: 'worker' }),
      onError: (queueName, error) => {
        this.logger.error(`Mail worker error: queue=${queueName}, message=${error.message}`);
      },
    });
    this.workers.register<CampaignJobData, void>({
      queueName: this.options.queueName,
      concurrency: 1,
      handler: ({ data }) => this.processCampaign(data.campaignId),
    });
    this.logger.debug('邮件群发队列 worker 已启动');
  }

  async onModuleDestroy(): Promise<void> {
    const workers = this.workers,
      queue = this.queue;
    this.workers = null;
    this.queue = null;
    try {
      await workers?.close();
    } finally {
      await queue?.close();
    }
  }

  /**
   * 回收中断的 campaign：worker 启动时把残留 running 标 failed。
   * 单 worker 部署模型下，worker 刚启动时没有任何任务在跑，所以 running 必为
   * 上次进程被 kill（部署/崩溃）遗留的孤儿，标 failed 让前端进度条停转。
   */
  private async reapOrphanedCampaigns(): Promise<void> {
    const r = await this.campaigns.updateMany({
      where: { status: 'running' },
      data: {
        status: 'failed',
        error: '进程重启导致任务中断',
        finishedAt: new Date(),
      },
    });
    if (r.count > 0) {
      this.logger.warn(`reaper: ${r.count} 个中断的 running campaign 已标记 failed`);
    }
  }

  /**
   * 创建 campaign 记录并入队，返回 campaignId（不阻塞等待发送完成）。
   */
  async enqueue(params: EnqueueCampaignParams): Promise<{ campaignId: string; total: number }> {
    if (!this.queue) throw new BadRequestException('邮件队列未就绪');
    await this.options.validate(params);
    const total = await this.options.count(params);

    const campaign = await this.campaigns.create({
      data: {
        template: params.template,
        subject: params.subject,
        filter: params.filter,
        userIds: params.userIds ?? undefined,
        excludeUserIds: params.excludeUserIds ?? undefined,
        status: 'pending',
        total,
        actorUserId: params.actorUserId,
      },
    });

    try {
      await this.queue.add(
        this.options.queueName,
        { campaignId: campaign.id },
        {
          name: 'send',
          jobId: campaign.id, // 入队级幂等：同 campaign 不会有两个 job（防重复入队/重投）
          removeOnComplete: 100,
          removeOnFail: 200,
          attempts: 1, // campaign 内部已逐用户容错，整体不重试避免重复发送
        },
      );
    } catch (error) {
      await this.campaigns.update({
        where: { id: campaign.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    this.logger.log(
      `群发任务已入队: campaignId=${campaign.id}, template=${params.template}, total=${total}`,
    );
    return { campaignId: campaign.id, total };
  }

  async getCampaign(id: string) {
    return this.campaigns.findUnique({ where: { id } });
  }

  /** @param onlyActorUserId 传入时仅返回该 actor 创建的 campaign（非 full 权限管理员） */
  async listCampaigns(limit = 20, onlyActorUserId?: string) {
    return this.campaigns.findMany({
      where: onlyActorUserId ? { actorUserId: onlyActorUserId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
    });
  }

  /**
   * Worker 主逻辑：分批发送并实时回写进度。
   * 公开以便单测直接驱动（不经过 BullMQ）。
   */
  async processCampaign(campaignId: string): Promise<void> {
    // 原子认领：仅当仍为 pending 时置 running。防多 worker / job 重投双跑同一 campaign
    // （先读后写存在 TOCTOU；updateMany 条件更新是一次原子操作）
    const claim = await this.campaigns.updateMany({
      where: { id: campaignId, status: 'pending' },
      data: { status: 'running', startedAt: new Date() },
    });
    if (claim.count === 0) {
      this.logger.warn(`群发任务无法认领（不存在或非 pending），跳过: ${campaignId}`);
      return;
    }

    const campaign = await this.campaigns.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) return;

    // 邮件服务未配置：提前失败，避免逐用户全部计为 failed 且不写日志
    if (!this.mailService.isMailEnabled()) {
      await this.campaigns.update({
        where: { id: campaignId },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: '邮件服务未配置（无可用 provider）',
        },
      });
      this.logger.error(`群发终止：邮件服务未配置, campaignId=${campaignId}`);
      return;
    }

    const totals = { attempted: 0, sent: 0, skipped: 0, failed: 0 };
    const failedSamples: Array<{ email: string; reason: string }> = [];

    try {
      const resolved = await this.mailService.resolveTemplate(campaign.template);
      let quotaExhausted = false;
      let cursor: string | undefined;
      for (;;) {
        const batch = await this.options.loadBatch(campaign, cursor, this.options.batchSize);
        if (batch.length === 0) break;
        const r: Awaited<ReturnType<typeof dispatchMailBatch>> = quotaExhausted
          ? { attempted: 0, sent: 0, skipped: batch.length, quotaExhausted: true }
          : await dispatchMailBatch(this.mailService, {
              template: campaign.template,
              subject: campaign.subject,
              recipients: batch,
              failedSamples,
              resolved,
              campaignId: campaign.id,
              concurrency: this.options.concurrency,
              deduplicationWindowMs: this.options.deduplicationWindowMs,
            });
        quotaExhausted = r.quotaExhausted;
        totals.attempted += r.attempted;
        totals.sent += r.sent;
        totals.skipped += r.skipped;
        // failedSamples 仅采样前 50 条；真实失败数用 attempted - sent 推导
        totals.failed = totals.attempted - totals.sent;

        // 每批回写一次进度
        await this.campaigns.update({
          where: { id: campaignId },
          data: {
            attempted: totals.attempted,
            sent: totals.sent,
            skipped: totals.skipped,
            failed: totals.failed,
          },
        });
        if (batch.length < this.options.batchSize) break;
        cursor = batch[batch.length - 1].id;
      }

      await this.campaigns.update({
        where: { id: campaignId },
        data: { status: 'completed', finishedAt: new Date() },
      });
      this.logger.log(
        `群发完成: campaignId=${campaignId}, attempted=${totals.attempted}, sent=${totals.sent}, failed=${totals.failed}, skipped=${totals.skipped}`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.campaigns.update({
        where: { id: campaignId },
        data: { status: 'failed', finishedAt: new Date(), error: reason },
      });
      this.logger.error(`群发任务异常终止: campaignId=${campaignId} - ${reason}`);
      throw err; // 让 BullMQ 记录 job failed
    }
  }
}
