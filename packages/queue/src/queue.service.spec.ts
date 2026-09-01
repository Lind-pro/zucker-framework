import { QueueService } from './queue.service';
import type { QueueProvider, Job, QueueStats } from './queue.interface';

function createMockProvider(): QueueProvider {
  const mockJob: Job = {
    id: 'job-1',
    data: { task: 'test' },
    status: 'waiting',
    progress: 0,
    attempts: 0,
    createdAt: new Date(),
  };

  return {
    add: vi.fn().mockResolvedValue(mockJob),
    ensure: vi.fn().mockResolvedValue(mockJob),
    addDelayed: vi.fn().mockResolvedValue({ ...mockJob, status: 'delayed' }),
    addRepeatable: vi.fn().mockResolvedValue(mockJob),
    getJob: vi.fn().mockResolvedValue(mockJob),
    removeJob: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({
      waiting: 5,
      active: 2,
      completed: 10,
      failed: 1,
      delayed: 3,
    } satisfies QueueStats),
  };
}

describe('QueueService', () => {
  let service: QueueService;
  let provider: QueueProvider;

  beforeEach(() => {
    provider = createMockProvider();
    service = new QueueService(provider);
  });

  describe('add', () => {
    it('should delegate to provider.add', async () => {
      const job = await service.add('emails', { to: 'a@b.com' }, { priority: 1 });
      expect(provider.add).toHaveBeenCalledWith('emails', { to: 'a@b.com' }, { priority: 1 });
      expect(job.id).toBe('job-1');
    });
  });

  describe('ensure', () => {
    it('should delegate to provider.ensure', async () => {
      const options = { jobId: 'job-1', attempts: 3 };
      const job = await service.ensure('emails', { to: 'a@b.com' }, options);
      expect(provider.ensure).toHaveBeenCalledWith('emails', { to: 'a@b.com' }, options);
      expect(job.id).toBe('job-1');
    });
  });

  describe('addDelayed', () => {
    it('should delegate to provider.addDelayed', async () => {
      const job = await service.addDelayed('emails', { to: 'a@b.com' }, 5000);
      expect(provider.addDelayed).toHaveBeenCalledWith(
        'emails',
        { to: 'a@b.com' },
        5000,
        undefined,
      );
      expect(job.status).toBe('delayed');
    });
  });

  describe('addRepeatable', () => {
    it('should delegate to provider.addRepeatable', async () => {
      await service.addRepeatable('cleanup', {}, '*/5 * * * *');
      expect(provider.addRepeatable).toHaveBeenCalledWith('cleanup', {}, '*/5 * * * *', undefined);
    });
  });

  describe('getJob', () => {
    it('should return job from provider', async () => {
      const job = await service.getJob('emails', 'job-1');
      expect(provider.getJob).toHaveBeenCalledWith('emails', 'job-1');
      expect(job?.id).toBe('job-1');
    });
  });

  describe('removeJob', () => {
    it('should delegate to provider.removeJob', async () => {
      await service.removeJob('emails', 'job-1');
      expect(provider.removeJob).toHaveBeenCalledWith('emails', 'job-1');
    });
  });

  describe('pause / resume', () => {
    it('should delegate pause', async () => {
      await service.pause('emails');
      expect(provider.pause).toHaveBeenCalledWith('emails');
    });

    it('should delegate resume', async () => {
      await service.resume('emails');
      expect(provider.resume).toHaveBeenCalledWith('emails');
    });
  });

  describe('getStats', () => {
    it('should return queue statistics', async () => {
      const stats = await service.getStats('emails');
      expect(provider.getStats).toHaveBeenCalledWith('emails');
      expect(stats).toEqual({
        waiting: 5,
        active: 2,
        completed: 10,
        failed: 1,
        delayed: 3,
      });
    });
  });
});
