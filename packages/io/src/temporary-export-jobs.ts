import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type TemporaryExportStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
export interface ExportProgress {
  progress: number;
  message?: string;
}
export interface ExportArtifact {
  buffer: Buffer;
  fileName: string;
  contentType: string;
}
export interface TemporaryExportJob<C> extends ExportProgress {
  id: string;
  context: C;
  status: TemporaryExportStatus;
  error?: string;
  filePath?: string;
  fileName?: string;
  contentType?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}
export interface TemporaryExportJobsOptions<C> {
  directory: string;
  ttlMs: number;
  cleanupIntervalMs: number;
  deduplicationKey(context: C): string;
  build(context: C, update: (progress: ExportProgress) => void): Promise<ExportArtifact>;
  progress?: Partial<
    Record<'pending' | 'processing' | 'preparing' | 'completed' | 'failed', string>
  >;
  createError?: (reason: 'not_ready' | 'expired') => Error;
  onError?: (job: TemporaryExportJob<C>, error: unknown) => void;
}

/** Process-local, expiring downloadable artifacts. This is explicitly not durable job storage. */
export class TemporaryExportJobs<C> {
  private readonly jobs = new Map<string, TemporaryExportJob<C>>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: TemporaryExportJobsOptions<C>) {
    this.timer = setInterval(() => {
      void this.cleanupExpired();
    }, options.cleanupIntervalMs);
    this.timer.unref?.();
  }
  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
  start(context: C): TemporaryExportJob<C> {
    const key = this.options.deduplicationKey(context);
    const active = [...this.jobs.values()].find(
      (job) =>
        (job.status === 'PENDING' || job.status === 'PROCESSING') &&
        this.options.deduplicationKey(job.context) === key,
    );
    if (active) return active;
    const now = new Date();
    const job: TemporaryExportJob<C> = {
      id: randomUUID(),
      context,
      status: 'PENDING',
      progress: 0,
      message: this.options.progress?.pending,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + this.options.ttlMs),
    };
    this.jobs.set(job.id, job);
    void this.run(job);
    return job;
  }
  get(id: string): TemporaryExportJob<C> | undefined {
    return this.jobs.get(id);
  }
  async download(job: TemporaryExportJob<C>) {
    if (job.status !== 'COMPLETED' || !job.filePath || !job.fileName || !job.contentType) {
      throw this.options.createError?.('not_ready') ?? new Error('Export is not ready');
    }
    try {
      await access(job.filePath);
    } catch {
      this.jobs.delete(job.id);
      throw this.options.createError?.('expired') ?? new Error('Export expired');
    }
    return {
      stream: createReadStream(job.filePath),
      fileName: job.fileName,
      contentType: job.contentType,
    };
  }
  private update(job: TemporaryExportJob<C>, patch: Partial<TemporaryExportJob<C>>): void {
    Object.assign(job, patch, { updatedAt: new Date() });
  }
  private async run(job: TemporaryExportJob<C>): Promise<void> {
    this.update(job, {
      status: 'PROCESSING',
      progress: 10,
      message: this.options.progress?.processing,
    });
    let path: string | undefined;
    try {
      await mkdir(this.options.directory, { recursive: true });
      const artifact = await this.options.build(job.context, (progress) =>
        this.update(job, progress),
      );
      this.update(job, { progress: 80, message: this.options.progress?.preparing });
      path = join(this.options.directory, `${job.id}-${basename(artifact.fileName)}`);
      await writeFile(path, artifact.buffer);
      // An export that expired while rendering must not leave an untracked file behind.
      if (!this.jobs.has(job.id)) {
        await unlink(path).catch(() => {});
        return;
      }
      this.update(job, {
        status: 'COMPLETED',
        progress: 100,
        message: this.options.progress?.completed,
        filePath: path,
        fileName: artifact.fileName,
        contentType: artifact.contentType,
      });
    } catch (error) {
      if (path) await unlink(path).catch(() => {});
      this.update(job, {
        status: 'FAILED',
        progress: 100,
        message: this.options.progress?.failed,
        error: error instanceof Error ? error.message : String(error),
        filePath: undefined,
      });
      this.options.onError?.(job, error);
    }
  }
  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.expiresAt.getTime() > now) continue;
      if (job.filePath) await unlink(job.filePath).catch(() => {});
      this.jobs.delete(id);
    }
  }
}
