// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { FAKE_PNG_BASE64 } from '@zucker-framework/ai/testing';
import { createHash } from 'node:crypto';
import { AITaskService } from './ai-task.service';
import { createVerifiedOutputStore } from './adapters';

it.each(['buffered', 'streaming'])('does not start a %s upload after a deadline during lease renewal', async mode => {
  let release!: () => void;
  const lease = new Promise<void>(resolve => { release = resolve; });
  const put = vi.fn(async () => ({ storageKey: 'should-not-exist' }));
  // Exercise the private deadline boundary with a deterministic delayed lease rather than a timer-sensitive DB mock.
  const service = new AITaskService({ outputs: { put }, outputLimits: { downloadTimeoutMs: 15 } } as any) as any;
  const context = { signal: new AbortController().signal, assertActive: () => lease };
  const work = service.withOutputDeadline(context, (bounded: any) => {
    const args = [bounded, { id: 'task', ownerId: 'owner', kind: 'image' }, 0, { base64: FAKE_PNG_BASE64 },
      { fetch: vi.fn(), maxBytes: 1024, allowedContentTypes: ['image/png'], signal: bounded.signal }, 1, true];
    return mode === 'buffered' ? service.rehostBuffered(...args) : service.rehostStreaming(...args, put);
  });
  await expect(work).rejects.toMatchObject({ code: 'AI_OUTPUT_TIMEOUT' });
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(put).not.toHaveBeenCalled();
});

it('the buffered storage adapter never begins a write after cancellation during exists', async () => {
  let release!: (exists: boolean) => void;
  const exists = new Promise<boolean>(resolve => { release = resolve; });
  const write = vi.fn();
  const controller = new AbortController();
  const store = createVerifiedOutputStore({ store: { exists: () => exists, write, read: vi.fn() } });
  const body = Buffer.from(FAKE_PNG_BASE64, 'base64');
  const putting = store.put({ taskId: `ait_${'a'.repeat(64)}`, ownerId: 'owner', kind: 'image', index: 0, body,
    contentType: 'image/png', sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length, signal: controller.signal });
  const stopped = expect(putting).rejects.toThrow('stopped');
  controller.abort(new Error('stopped')); release(false);
  await stopped;
  expect(write).not.toHaveBeenCalled();
});
