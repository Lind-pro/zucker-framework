import { expect, it, vi } from 'vitest';
import { DalleProvider } from '@zucker-framework/ai';
import { AITasksService } from '../src/ai-tasks/ai-tasks.service';

// Pure host boundary checks: no DI container, persistent DB, network or paid provider.
function host(provider: { getCapabilities?: (model: string) => { maxOutputs: number; maxReferences: number; referenceInput?: 'single' | 'multiple' | 'frames' } }) {
  const entry = { providerId: 'test-provider', kinds: ['image', 'video'], provider, config: { apiKey: 'synthetic' } };
  const service = Object.create(AITasksService.prototype) as AITasksService;
  const read = vi.fn(async (_owner: string, id: string) => ({ asset: { mimeType: 'image/png' }, body: Buffer.from(id) }));
  Object.assign(service, { catalog: { offered: async () => ({ model: 'test-model' }), mediaProvider: () => entry }, files: { read }, env: {} });
  return { service, read, resolve: (request: unknown) => (service as unknown as { resolveProvider(request: unknown): Promise<{ config: Record<string, unknown> }> }).resolveProvider(request) };
}
const refs = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003'];
const input = { kind: 'image', providerId: 'test-provider', model: 'dall-e-3', prompt: 'test' };

it('rejects unsupported DALL-E counts and references at parsing before the hold/submit path', async () => {
  const { service } = host(new DalleProvider());
  await expect(service.parseSubmit({ ...input, options: { count: 4 } })).rejects.toMatchObject({ response: { code: 'AI_TASK_UNSUPPORTED_COUNT' } });
  await expect(service.parseSubmit({ ...input, references: [refs[0]] })).rejects.toMatchObject({ response: { code: 'AI_TASK_UNSUPPORTED_REFERENCES' } });
  await expect(service.parseSubmit({ ...input, model: 'dall-e-2', options: { count: 4 } })).resolves.toMatchObject({ options: { count: 4 } });
});

it('resolves all supported references as owner-scoped inline images in original order', async () => {
  const { service, read, resolve } = host({ getCapabilities: () => ({ maxOutputs: 4, maxReferences: 4, referenceInput: 'multiple' }) });
  const parsed = await service.parseSubmit({ ...input, references: refs });
  const { config } = await resolve({ ownerId: 'owner-a', kind: 'image', providerId: 'test-provider', model: 'test-model', input: { references: parsed.references } });
  expect(read.mock.calls).toEqual(refs.map(id => ['owner-a', id]));
  expect(config.referenceImageUrls).toEqual(refs.map(id => `data:image/png;base64,${Buffer.from(id).toString('base64')}`));
});

it('maps two video references to first and last frames and rejects a third', async () => {
  const { service, resolve } = host({ getCapabilities: () => ({ maxOutputs: 1, maxReferences: 2, referenceInput: 'frames' }) });
  await expect(service.parseSubmit({ ...input, kind: 'video', references: refs })).rejects.toMatchObject({ response: { code: 'AI_TASK_UNSUPPORTED_REFERENCES' } });
  const { config } = await resolve({ ownerId: 'owner', kind: 'video', providerId: 'test-provider', model: 'test-model', input: { references: refs.slice(0, 2) } });
  expect(config.firstFrameUrl).toBe(`data:image/png;base64,${Buffer.from(refs[0]).toString('base64')}`);
  expect(config.lastFrameUrl).toBe(`data:image/png;base64,${Buffer.from(refs[1]).toString('base64')}`);
});

it('does not silently accept reference images from an undeclared provider', async () => {
  const { service } = host({});
  await expect(service.parseSubmit({ ...input, references: refs.slice(0, 1) })).rejects.toMatchObject({ response: { code: 'AI_TASK_UNSUPPORTED_REFERENCES' } });
});
