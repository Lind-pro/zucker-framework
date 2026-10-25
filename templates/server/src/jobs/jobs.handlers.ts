import { BadRequestException, Injectable, type OnModuleInit } from '@nestjs/common';
import { FileAssetError } from '@zucker-framework/storage';
import { PostgresTaskRepository } from '@zucker-framework/task';
import { FilesService } from '../files/files.service';
import { DeliveryService } from '../delivery/delivery.service';
import { JobsService } from './jobs.service';

function recordInput(value: unknown): { value: string; notify: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Invalid record job');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'value' && key !== 'notify') || typeof input.value !== 'string'
    || !input.value.trim() || input.value.length > 1000 || (input.notify !== undefined && typeof input.notify !== 'boolean'))
    throw new BadRequestException('Invalid record job');
  return { value: input.value, notify: input.notify === true };
}
function assetInput(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1)
    throw new BadRequestException('Invalid file recovery job');
  const id = (value as { assetId?: unknown }).assetId;
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new BadRequestException('Invalid file asset ID');
  return id;
}

@Injectable()
export class DefaultJobHandlers implements OnModuleInit {
  constructor(private readonly jobs: JobsService, private readonly files: FilesService, private readonly delivery: DeliveryService) {}
  onModuleInit(): void {
    this.jobs.registerHandler({ kind: 'record', version: '1', maxAttempts: 3,
      parseUserInput: async (context, value) => {
        const payload = recordInput(value);
        if (payload.notify) this.delivery.assertConfigured();
        return { payload, resource: { type: 'job-record', id: context.taskId } };
      },
      handler: {
        execute: async context => {
          if (!context.task.userId) throw new BadRequestException('Record jobs require an owner');
          const payload = recordInput(context.task.payload);
          await context.assertActive(); await context.reportProgress('recording', 25);
          return payload;
        },
        complete: async (context, result) => {
          const payload = recordInput(result), ownerId = context.task.userId!;
          return this.jobs.database.transaction(async tx => {
            const completed = await new PostgresTaskRepository(tx).transition({ id: context.task.id,
              from: 'PROCESSING', to: 'COMPLETED', leaseToken: context.leaseToken,
              result: { recordId: context.task.id }, now: context.now() });
            if (!completed) return false;
            await tx.model('jobRecord').create({ data: { taskId: context.task.id, ownerId, value: payload.value } });
            if (payload.notify) await this.delivery.enqueueInTransaction(tx, { ownerId, taskId: context.task.id,
              idempotencyKey: `job-completed:${context.task.id}`, subject: 'Your background task completed',
              text: 'Your background task completed. Sign in to view its result.' });
            await this.jobs.applyTransactionHooks('completed', tx, context.task);
            return true;
          });
        },
        fail: (context, error) => this.jobs.database.transaction(async tx => {
          const failed = await new PostgresTaskRepository(tx).transition({ id: context.task.id, from: 'PROCESSING', to: 'FAILED',
            leaseToken: context.leaseToken, error, now: context.now() });
          if (!failed) return false;
          await this.jobs.applyTransactionHooks('failed', tx, context.task);
          return true;
        }),
      },
    });
    this.jobs.registerHandler({ kind: 'files.recover', version: '1', maxAttempts: 3,
      parseUserInput: async (context, value) => {
        const assetId = assetInput(value);
        await this.files.inspect(context.ownerId, assetId);
        return { payload: { assetId }, resource: { type: 'file-asset', id: assetId } };
      },
      handler: { execute: async context => {
        const assetId = assetInput(context.task.payload), ownerId = context.task.userId;
        if (!ownerId || context.task.resource.type !== 'file-asset' || context.task.resource.id !== assetId)
          throw new BadRequestException('Invalid file recovery ownership');
        await context.assertActive();
        const asset = await this.files.recover(ownerId, assetId);
        await context.assertActive();
        if (asset.state === 'pending') throw new FileAssetError('ASSET_NOT_READY');
        if (asset.state === 'deleted' && asset.cleanupStatus !== 'confirmed') throw new FileAssetError('DELETE_UNVERIFIED');
        return { assetId, state: asset.state, cleanupStatus: asset.cleanupStatus, cleanupConfirmedAt: asset.cleanupConfirmedAt };
      } },
    });
  }
}
