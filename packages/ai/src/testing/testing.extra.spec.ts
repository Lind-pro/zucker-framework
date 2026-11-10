import { describe, expect, it } from 'vitest';
import { AICallWrapper } from '../call-wrapper';
import { AIConfigService } from '../config.service';
import { StaticAIConfigSource } from '../config-sources/static-config.source';
import { MediaTaskStatus, MediaType, isAudioGenerationProvider, type MediaTaskResult } from '../media.interface';
import { NativeAIClient, type NativeChunk } from '../native-port';
import { FakeCallbackVerifier, FakeChatModel, FakeMediaProvider, fakeTokenCount } from '../testing';

const client = (fake: FakeChatModel) => new NativeAIClient(
  new AIConfigService(undefined, [new StaticAIConfigSource({ defaultConfig: { providerId: 'fake', modelId: 'fake-chat', apiKey: 'SECRET-KEY-123' } })]),
  new AICallWrapper(),
  fake.factory,
);
const request = { messages: [{ role: 'user' as const, content: 'hi there' }] };

describe('FakeChatModel details', () => {
  it('failAfterChunks fails after exactly N content chunks with the scripted error', async () => {
    for (const n of [0, 1, 2]) {
      const fake = new FakeChatModel({ script: [{ content: 'a b c d', failAfterChunks: n, error: 503 }] });
      const seen: string[] = [];
      await expect(client(fake).stream('chat', request, { maxAttempts: 1, onChunk: (c) => { if (c.content) seen.push(c.content); } }))
        .rejects.toMatchObject({ status: 503 });
      expect(seen).toEqual(['a ', 'b ', 'c ', 'd'].slice(0, n));
    }
  });

  it('failAfterChunks beyond the stream length still fails once the chunks are exhausted', async () => {
    const fake = new FakeChatModel({ script: [{ content: 'a b', failAfterChunks: 5 }] });
    await expect(client(fake).stream('chat', request)).rejects.toMatchObject({ status: 500 });
  });

  it('embeds deterministically, per input and dimension, within [-1, 1]', async () => {
    const fake = new FakeChatModel({ embeddingDimensions: 5 });
    const model = await fake.factory({ providerId: 'fake', modelId: 'm', apiKey: 'k' } as never);
    const signal = new AbortController().signal;
    const a = await model.embed!(['alpha', 'beta'], undefined, signal);
    const b = await new FakeChatModel({ embeddingDimensions: 5 }).embed(['alpha', 'beta'], undefined, signal);
    expect(a.embeddings).toEqual(b.embeddings);
    expect(a.embeddings[0]).toHaveLength(5);
    expect(a.embeddings[0]).not.toEqual(a.embeddings[1]);
    expect(a.embeddings.flat().every((v) => v >= -1 && v <= 1)).toBe(true);
    expect((await fake.embed(['alpha'], 3, signal)).embeddings[0]).toHaveLength(3);
    expect(a.usage).toEqual({ input: fakeTokenCount('alpha') + fakeTokenCount('beta'), output: 0, total: fakeTokenCount('alpha') + fakeTokenCount('beta') });
  });

  it('records requests but never the API key', async () => {
    const fake = new FakeChatModel();
    await client(fake).chat('chat', request);
    await client(fake).stream('chat', request);
    expect(fake.calls.map((c) => c.method)).toEqual(['chat', 'stream']);
    expect(JSON.stringify(fake.calls)).not.toContain('SECRET-KEY-123');
    expect(fake.lastConfig?.apiKey).toBe('SECRET-KEY-123'); // config is exposed deliberately for assertions on routing only
  });

  it('awaits onChunk per chunk: no next chunk is delivered before the previous handler settles', async () => {
    const fake = new FakeChatModel({ script: [{ reasoning: 'r', content: 'a b c' }] });
    const log: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await client(fake).stream('chat', request, {
      onChunk: async (chunk: NativeChunk) => {
        inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
        const label = chunk.reasoning ? 'r' : chunk.content ? chunk.content.trim() : 'usage';
        log.push(`start:${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        log.push(`end:${label}`);
        inFlight -= 1;
      },
    });
    expect(maxInFlight).toBe(1);
    expect(log).toEqual(['start:r', 'end:r', 'start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c', 'start:usage', 'end:usage']);
  });

  it('an async onChunk rejection aborts the stream and closes the provider iterator', async () => {
    const fake = new FakeChatModel({ defaultStep: { content: 'a b c d e' } });
    const seen: string[] = [];
    await expect(client(fake).stream('chat', request, {
      onChunk: async (c) => { if (c.content) seen.push(c.content); if (seen.length === 2) throw new Error('client closed'); },
    })).rejects.toThrow('client closed');
    expect(seen).toEqual(['a ', 'b ']);
  });

  it('reasoning is not part of the returned answer text', async () => {
    const fake = new FakeChatModel({ script: [{ reasoning: 'secret thoughts', content: 'answer' }] });
    expect((await client(fake).stream('chat', request)).content).toBe('answer');
  });
});

describe('FakeMediaProvider details', () => {
  it('records calls without apiKey/signal and reports audio capability', async () => {
    const provider = new FakeMediaProvider();
    expect(isAudioGenerationProvider(provider)).toBe(true);
    expect(isAudioGenerationProvider(new FakeMediaProvider({ supportedTypes: [MediaType.IMAGE] }))).toBe(false);
    const task = (await provider.generate('p', { apiKey: 'SECRET-KEY-123', modelId: 'fake-audio', signal: new AbortController().signal, lyrics: 'la' })) as MediaTaskResult;
    await provider.getTaskStatus(task.taskId, { apiKey: 'SECRET-KEY-123', modelId: 'fake-audio' });
    const dump = JSON.stringify(provider.calls);
    expect(dump).not.toContain('SECRET-KEY-123');
    expect(dump).toContain('"lyrics":"la"');
  });

  it('puts the whole cost on the first output and reports PROCESSING progress below 100', async () => {
    const provider = new FakeMediaProvider({ script: [{ pollsUntilDone: 3, outputs: 3, cost: 0.3 }] });
    const task = (await provider.generate('p', { apiKey: 'k', modelId: 'fake-image' })) as MediaTaskResult;
    const progress: number[] = [];
    let done: MediaTaskResult | undefined;
    for (let i = 0; i < 4; i += 1) {
      done = await provider.getTaskStatus(task.taskId, { apiKey: 'k', modelId: 'fake-image' });
      if (done.progress !== undefined) progress.push(done.progress);
    }
    expect(progress).toEqual([25, 50, 75, 100]);
    expect(done?.status).toBe(MediaTaskStatus.COMPLETED);
    expect(done?.outputs?.map((o) => o.cost)).toEqual([0.3, 0, 0]);
  });
});

describe('FakeCallbackVerifier details', () => {
  it('records accepted and rejected deliveries and honours custom header/token/provider', async () => {
    const verifier = new FakeCallbackVerifier({ providerId: 'p', header: 'X-Tok', token: 't' });
    expect(verifier.providerId).toBe('p');
    await expect(verifier.verify(Buffer.from('{"taskId":"a"}'), { 'x-tok': 't' })).resolves.toEqual({ providerTaskId: 'a' });
    await expect(verifier.verify('{"taskId":"a"}', { 'x-fake-signature': 'valid' })).resolves.toBeNull();
    await expect(verifier.verify('{"taskId":""}', { 'x-tok': 't' })).resolves.toBeNull();
    await expect(verifier.verify('{"taskId":5}', { 'x-tok': 't' })).resolves.toBeNull();
    await expect(verifier.verify('null', { 'x-tok': 't' })).resolves.toBeNull();
    expect(verifier.calls.map((c) => c.accepted)).toEqual([true, false, false, false, false]);
  });
});
