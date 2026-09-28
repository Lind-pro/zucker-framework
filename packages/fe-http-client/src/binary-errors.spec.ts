// @vitest-environment node
import { AxiosError, type AxiosAdapter } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http-client';

describe('binary error normalization', () => {
  const json = JSON.stringify({ message: ['配额不足', '请稍后重试'], code: 'QUOTA', details: { remaining: 0 } });
  it.each([new Blob([json]), new TextEncoder().encode(json).buffer])('decodes Chinese JSON and keeps original response bytes', async body => {
    const adapter: AxiosAdapter = async config => { throw new AxiosError('bad response', 'ERR_BAD_RESPONSE', config, {}, { config, data: body, status: 400, statusText: '', headers: {} }); };
    const errorHandler = vi.fn();
    await expect(new HttpClient({ errorHandler }).get('/download', {}, { adapter })).rejects.toMatchObject({ message: '配额不足；请稍后重试', code: 'QUOTA', details: { remaining: 0 }, status: 400, response: { data: body } });
    expect(errorHandler).toHaveBeenCalledOnce();
  });
  it.each([new Blob(['not-json']), new Blob(['x'.repeat(1024 * 1024 + 1)]), new TextEncoder().encode('null').buffer])('falls back safely for non-object, malformed or oversized bodies', async body => {
    const adapter: AxiosAdapter = async config => { throw new AxiosError('bad response', undefined, config, {}, { config, data: body, status: 403, statusText: '', headers: {} }); };
    await expect(new HttpClient().get('/download', {}, { adapter })).rejects.toMatchObject({ message: '请求失败 (403)', response: { data: body } });
  });
});
