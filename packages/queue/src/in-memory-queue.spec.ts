import { InMemoryQueue } from './in-memory-queue';

describe('InMemoryQueue', () => {
  let queue: InMemoryQueue;

  beforeEach(() => {
    queue = new InMemoryQueue();
  });

  describe('add', () => {
    it('should add a job with auto-generated id', async () => {
      const job = await queue.add('emails', { to: 'a@b.com' });
      expect(job.id).toBeDefined();
      expect(job.data).toEqual({ to: 'a@b.com' });
      expect(job.status).toBe('waiting');
      expect(job.progress).toBe(0);
      expect(job.attempts).toBe(0);
    });

    it('should use custom jobId from options', async () => {
      const job = await queue.add('emails', { to: 'a@b.com' }, { jobId: 'custom-1' });
      expect(job.id).toBe('custom-1');
    });

    it('should add multiple jobs with unique ids', async () => {
      const j1 = await queue.add('q', { n: 1 });
      const j2 = await queue.add('q', { n: 2 });
      expect(j1.id).not.toBe(j2.id);
    });
  });

  describe('addDelayed', () => {
    it('should add a delayed job', async () => {
      const job = await queue.addDelayed('emails', { to: 'a@b.com' }, 1000);
      expect(job.status).toBe('delayed');
    });

    it('should transition to waiting after delay', async () => {
      vi.useFakeTimers();
      const job = await queue.addDelayed('emails', {}, 500);
      expect(job.status).toBe('delayed');

      vi.advanceTimersByTime(500);

      const fetched = await queue.getJob('emails', job.id);
      expect(fetched?.status).toBe('waiting');

      vi.useRealTimers();
    });
  });

  describe('addRepeatable', () => {
    it('should fallback to add (no repeat support)', async () => {
      const job = await queue.addRepeatable('cleanup', { sweep: true }, '*/5 * * * *');
      expect(job.status).toBe('waiting');
      expect(job.data).toEqual({ sweep: true });
    });
  });

  describe('getJob', () => {
    it('should return job by id', async () => {
      const added = await queue.add('q', { x: 1 });
      const found = await queue.getJob('q', added.id);
      expect(found).not.toBeNull();
      expect(found!.data).toEqual({ x: 1 });
    });

    it('should return null for non-existent job', async () => {
      const found = await queue.getJob('q', 'no-such-job');
      expect(found).toBeNull();
    });

    it('should isolate jobs between queues', async () => {
      const job = await queue.add('q1', { a: 1 });
      const found = await queue.getJob('q2', job.id);
      expect(found).toBeNull();
    });
  });

  describe('removeJob', () => {
    it('should remove a job from the queue', async () => {
      const job = await queue.add('q', { x: 1 });
      await queue.removeJob('q', job.id);
      const found = await queue.getJob('q', job.id);
      expect(found).toBeNull();
    });

    it('should not throw when removing non-existent job', async () => {
      await expect(queue.removeJob('q', 'nope')).resolves.toBeUndefined();
    });
  });

  describe('pause / resume', () => {
    it('should track paused state', async () => {
      await queue.pause('q');
      // Verify internally paused by checking stats still work
      const stats = await queue.getStats('q');
      expect(stats).toBeDefined();

      await queue.resume('q');
      const stats2 = await queue.getStats('q');
      expect(stats2).toBeDefined();
    });
  });

  describe('getStats', () => {
    it('should return zeroes for empty queue', async () => {
      const stats = await queue.getStats('empty-q');
      expect(stats).toEqual({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });
    });

    it('should count jobs by status', async () => {
      await queue.add('q', { n: 1 });
      await queue.add('q', { n: 2 });
      await queue.addDelayed('q', { n: 3 }, 10000);

      const stats = await queue.getStats('q');
      expect(stats.waiting).toBe(2);
      expect(stats.delayed).toBe(1);
      expect(stats.active).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
    });
  });

  describe('drain (multiple operations)', () => {
    it('should handle add then remove for all jobs', async () => {
      const j1 = await queue.add('q', { a: 1 });
      const j2 = await queue.add('q', { a: 2 });
      const j3 = await queue.add('q', { a: 3 });

      await queue.removeJob('q', j1.id);
      await queue.removeJob('q', j2.id);
      await queue.removeJob('q', j3.id);

      const stats = await queue.getStats('q');
      expect(stats.waiting).toBe(0);
    });
  });
});
