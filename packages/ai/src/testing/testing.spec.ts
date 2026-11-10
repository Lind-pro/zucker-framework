import { describe, expect, it } from 'vitest';
import { AICallWrapper } from '../call-wrapper';
import { AIConfigService } from '../config.service';
import { StaticAIConfigSource } from '../config-sources/static-config.source';
import { MediaTaskStatus, MediaType, type MediaTaskResult } from '../media.interface';
import { NativeAIClient, type NativeChunk } from '../native-port';
import { FakeCallbackVerifier, FakeChatModel, FakeMediaProvider, fakeTokenCount } from '../testing';

const media = { apiKey: 'synthetic', modelId: 'fake-image' };

describe('FakeMediaProvider', () => {
  it('is deterministic across instances and runs the async poll script', async () => {
    const run = async () => {
      const provider = new FakeMediaProvider({ script: [{ pollsUntilDone: 2, outputs: 2 }] });
      const task = (await provider.generate('cat', media)) as MediaTaskResult;
      const states = [];
      for (let i = 0; i < 3; i += 1) states.push(await provider.getTaskStatus(task.taskId, media));
      return { task, states, calls: provider.calls };
    };
    const first = await run();
    expect(await run()).toEqual(first);
    expect(first.task).toMatchObject({ taskId: 'fake-media-task-1', status: MediaTaskStatus.PENDING });
    expect(first.states.map((state) => state.status)).toEqual([MediaTaskStatus.PROCESSING, MediaTaskStatus.PROCESSING, MediaTaskStatus.COMPLETED]);
    expect(first.states[2].outputs).toHaveLength(2);
    expect(first.states[2].result?.base64).toBeTruthy();
    expect(JSON.stringify(first.calls)).not.toContain('synthetic');
  });

  it('scripts sync results, reported and thrown failures, submit rejection and url outputs', async () => {
    const provider = new FakeMediaProvider().enqueue(
      { mode: 'sync', outputKind: 'url', cost: 0.5 },
      { mode: 'sync', outcome: 'failure', error: 'policy' },
      { outcome: 'failure', error: 'gpu lost' },
      { outcome: 'failure', throwStatus: 503 },
      { submitStatus: 429 },
    );
    expect(await provider.generate('a', { ...media, modelId: 'fake-audio' })).toMatchObject({
      url: 'https://fake-media.invalid/fake-media-task-1/0.mp3', mediaType: MediaType.AUDIO, cost: 0.5,
    });
    await expect(provider.generate('b', media)).rejects.toMatchObject({ status: 422 });
    const reported = (await provider.generate('c', media)) as MediaTaskResult;
    expect(await provider.getTaskStatus(reported.taskId, media)).toMatchObject({ status: MediaTaskStatus.FAILED, error: 'gpu lost' });
    const thrown = (await provider.generate('d', media)) as MediaTaskResult;
    await expect(provider.getTaskStatus(thrown.taskId, media)).rejects.toMatchObject({ status: 503 });
    await expect(provider.generate('e', media)).rejects.toMatchObject({ status: 429 });
    await expect(provider.getTaskStatus('nope', media)).rejects.toMatchObject({ status: 404 });
    expect(provider.pendingSteps).toBe(0);
  });

  it('honours delays and cancellation', async () => {
    const provider = new FakeMediaProvider({ defaultStep: { delayMs: 10_000 } });
    const controller = new AbortController();
    const pending = provider.generate('x', { ...media, signal: controller.signal });
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
  });
});

describe('FakeCallbackVerifier', () => {
  it('accepts only the token header with a task id', async () => {
    const verifier = new FakeCallbackVerifier();
    await expect(verifier.verify('{"taskId":"t1"}', { 'X-Fake-Signature': 'valid' })).resolves.toEqual({ providerTaskId: 't1' });
    await expect(verifier.verify('{"taskId":"t1"}', { 'x-fake-signature': 'forged' })).resolves.toBeNull();
    await expect(verifier.verify('not json', { 'x-fake-signature': 'valid' })).resolves.toBeNull();
  });
});

describe('FakeChatModel through NativeAIClient', () => {
  const client = (fake: FakeChatModel) => new NativeAIClient(
    new AIConfigService(undefined, [new StaticAIConfigSource({ defaultConfig: { providerId: 'fake', modelId: 'fake-chat', apiKey: 'k' } })]),
    new AICallWrapper(),
    fake.factory,
  );
  const request = { messages: [{ role: 'user' as const, content: 'hello world' }] };

  it('streams scripted reasoning, content and deterministic usage to onChunk', async () => {
    const fake = new FakeChatModel({ script: [{ reasoning: 'think', content: 'a b c' }] });
    const seen: NativeChunk[] = [];
    const result = await client(fake).stream('chat', request, { onChunk: (chunk) => { seen.push(chunk); } });
    expect(result.content).toBe('a b c');
    expect(seen[0]).toEqual({ reasoning: 'think' });
    expect(seen.filter((chunk) => chunk.content).map((chunk) => chunk.content)).toEqual(['a ', 'b ', 'c']);
    const input = fakeTokenCount('hello world');
    const output = fakeTokenCount('a b c') + fakeTokenCount('think');
    expect(result.usage).toEqual({ input, output, total: input + output });
    expect(fake.lastConfig?.modelId).toBe('fake-chat');
  });

  it('echoes by default and scripts failures before and during the stream', async () => {
    const fake = new FakeChatModel().enqueue({}, { error: 429 }, { content: 'x y z', failAfterChunks: 1 });
    expect((await client(fake).chat('chat', request)).content).toBe('Echo: hello world');
    await expect(client(fake).chat('chat', request, { maxAttempts: 1 })).rejects.toMatchObject({ status: 429 });
    const seen: NativeChunk[] = [];
    await expect(client(fake).stream('chat', request, { onChunk: (chunk) => { seen.push(chunk); } })).rejects.toMatchObject({ status: 500 });
    expect(seen).toEqual([{ content: 'x ' }]);
  });

  it('stops the stream when the caller aborts and when onChunk throws', async () => {
    const slow = new FakeChatModel({ defaultStep: { content: 'a b c', delayMs: 10_000 } });
    const controller = new AbortController();
    const pending = client(slow).stream('chat', request, { signal: controller.signal });
    controller.abort(new Error('client gone'));
    await expect(pending).rejects.toThrow();

    const fake = new FakeChatModel({ defaultStep: { content: 'a b c' } });
    await expect(client(fake).stream('chat', request, { onChunk: () => { throw new Error('sse closed'); } })).rejects.toThrow('sse closed');
  });
});

describe('fake reset()', () => {
  it('FakeChatModel.reset drops pending steps and calls, keeps the default step', async () => {
    const { FakeChatModel } = await import('../testing');
    const fake = new FakeChatModel({ script: [{ content: 'first' }], defaultStep: { content: 'default' } });
    await fake.chat({ messages: [{ role: 'user', content: 'x' }] } as never, new AbortController().signal);
    fake.enqueue({ content: 'queued' });
    expect(fake.reset()).toBe(fake);
    expect(fake.pendingSteps).toBe(0);
    expect(fake.calls).toHaveLength(0);
    const reply = await fake.chat({ messages: [{ role: 'user', content: 'y' }] } as never, new AbortController().signal);
    expect(reply.content).toBe('default');
  });

  it('FakeMediaProvider.reset drops pending steps and calls', async () => {
    const { FakeMediaProvider } = await import('../testing');
    const fake = new FakeMediaProvider({ script: [{ outcome: 'failure' }] });
    fake.reset();
    expect(fake.pendingSteps).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});
