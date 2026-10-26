// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIImageProvider } from './openai-image.provider';

const source = { mimeType: 'image/png', imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJZkAAAAASUVORK5CYII=' };
const config = { apiKey: 'synthetic-key', model: 'gpt-image-2.5-flare', baseURL: 'https://synthetic-image.test/v1',
  quality: 'medium' as const, size: '1024x1024', outputFormat: 'png' as const, moderation: 'auto' as const };

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI image edits: real SDK serialization with a synthetic transport', () => {
  it('posts actual source files in order to images/edits instead of sending a text-only generation', async () => {
    const requests: Request[] = [];
    const forms: FormData[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      // The SDK probes whether fetch accepts platform FormData. No network is used.
      if (input === 'data:,') return new Response('');
      const request = new Request(input, init); requests.push(request);
      forms.push(await request.formData());
      return new Response(JSON.stringify({ data: [{ b64_json: 'ZWRpdGVk' }], usage: { input_tokens: 6, output_tokens: 8, total_tokens: 14 } }),
        { headers: { 'content-type': 'application/json', 'x-request-id': 'synthetic-edit-transport' } });
    }));
    const result = await new OpenAIImageProvider(config).editImage('Keep the first image; use the second as reference.', [source, source], { maxRetries: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://synthetic-image.test/v1/images/edits');
    expect(requests[0].method).toBe('POST');
    const form = forms[0];
    expect(form.get('model')).toBe('gpt-image-2.5-flare');
    expect(form.get('prompt')).toBe('Keep the first image; use the second as reference.');
    expect(form.get('output_format')).toBe('png');
    const images = form.getAll('image[]');
    expect(images).toHaveLength(2);
    for (let index = 0; index < images.length; index++) {
      const file = images[index];
      expect(file).toBeInstanceOf(File);
      if (typeof file === 'string') throw new Error('source was serialized as text');
      expect(file.name).toBe(`source-${index + 1}.png`);
      expect(file.type).toBe('image/png');
      expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from(source.imageBase64, 'base64'));
    }
    expect(result.providerMeta?.requestId).toBe('synthetic-edit-transport');
    expect(result.usage?.totalTokens).toBe(14);
  });

  it('dispatches once on an SDK-retriable HTTP failure when maxRetries is zero', async () => {
    let paidRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (input === 'data:,') return new Response('');
      paidRequests++;
      return new Response(JSON.stringify({ error: { message: 'synthetic unavailable', type: 'server_error' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    }));
    await expect(new OpenAIImageProvider(config).editImage('Keep the source.', [source], { maxRetries: 0 })).rejects.toMatchObject({ status: 503 });
    expect(paidRequests).toBe(1);
  });
});
