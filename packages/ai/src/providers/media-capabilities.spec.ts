// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { DalleProvider } from './dalle.provider';
import { HttpAsyncTaskMediaProvider } from './http-async-task.provider';
import { getMediaGenerationCapabilities, MediaType } from '../media.interface';
import type { HttpAsyncTaskAdapterConfig } from './http-async-task.config';

it('refuses DALL-E 3 batches and unsupported references before opening an SDK client', async () => {
  const provider = new DalleProvider();
  const create = vi.spyOn(provider as unknown as { createClient(): Promise<unknown> }, 'createClient');
  await expect(provider.generate('test', { apiKey: 'synthetic', modelId: 'dall-e-3', count: 4 })).rejects.toThrow('output count');
  await expect(provider.generate('test', { apiKey: 'synthetic', modelId: 'dall-e-2', referenceImageUrls: ['data:image/png;base64,x'] })).rejects.toThrow('reference');
  expect(create).not.toHaveBeenCalled();
});

it('preserves every DALL-E 2 output, order and aggregate cost', async () => {
  const provider = new DalleProvider();
  const generate = vi.fn(async () => ({ data: Array.from({ length: 4 }, (_, i) => ({ url: `https://cdn.example/${i}.png`, revised_prompt: `image ${i}` })) }));
  vi.spyOn(provider as unknown as { createClient(): Promise<unknown> }, 'createClient').mockResolvedValue({ images: { generate } });
  const result = await provider.generate('test', { apiKey: 'synthetic', modelId: 'dall-e-2', count: 4 });
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({ n: 4 }), expect.anything());
  expect(result.outputs?.map(output => output.url)).toEqual(Array.from({ length: 4 }, (_, i) => `https://cdn.example/${i}.png`));
  expect(result.url).toBe(result.outputs?.[0]?.url);
  expect(result.cost).toBeCloseTo(result.outputs!.reduce((sum, output) => sum + output.cost, 0));
});

const adapter = (): HttpAsyncTaskAdapterConfig => ({
  id: 'synthetic', mediaType: MediaType.IMAGE, models: [{ id: 'synthetic-image', name: 'test', mediaType: MediaType.IMAGE }],
  baseUrl: 'https://provider.example', auth: { type: 'none' },
  submit: { path: '/generate', taskIdPath: 'id', fields: { count: 'n', referenceImageUrls: 'images' } },
  poll: { path: '/tasks/{taskId}', statusPath: 'status', status: { pending: ['pending'], completed: ['done'], failed: ['failed'] }, outputPath: 'outputs' },
  maxOutputs: 4, maxReferences: 4,
});

it('forwards multiple references without dropping or reordering them', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: 't1', status: 'pending' })));
  const provider = new HttpAsyncTaskMediaProvider(adapter(), { fetch });
  const referenceImageUrls = ['data:image/png;base64,first', 'data:image/png;base64,second', 'data:image/png;base64,third'];
  expect(getMediaGenerationCapabilities(provider, 'synthetic-image')).toEqual({ maxOutputs: 4, maxReferences: 4, referenceInput: 'multiple' });
  await provider.generate('test', { apiKey: '', modelId: 'synthetic-image', count: 3, referenceImageUrls });
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ n: 3, images: referenceImageUrls });
});

it('uses conservative capabilities when none were declared and rejects unmapped frame capabilities', () => {
  expect(getMediaGenerationCapabilities({}, 'unknown')).toEqual({ maxOutputs: 1, maxReferences: 0 });
  const config = adapter();
  config.maxReferences = 2; config.submit.fields = { count: 'n', firstFrameUrl: 'start' };
  expect(() => new HttpAsyncTaskMediaProvider(config)).toThrow('lastFrameUrl');
  config.submit.fields.lastFrameUrl = 'end';
  expect(getMediaGenerationCapabilities(new HttpAsyncTaskMediaProvider(config), 'synthetic-image')).toEqual({ maxOutputs: 4, maxReferences: 2, referenceInput: 'frames' });
});

it('rejects unsupported async output counts before dispatch', async () => {
  const fetch = vi.fn();
  const config = adapter(); config.maxOutputs = 1;
  const provider = new HttpAsyncTaskMediaProvider(config, { fetch });
  await expect(provider.generate('test', { apiKey: '', modelId: 'synthetic-image', count: 2 })).rejects.toThrow('capabilities');
  expect(fetch).not.toHaveBeenCalled();
});
