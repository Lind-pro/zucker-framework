import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http-client';
import type { AxiosAdapter, AxiosResponse } from 'axios';

describe('explicit raw JSON responses', () => {
  it('preserves third-party status/result fields and headers without changing ordinary unwrapping', async () => {
    const data = { status: 200, result: [1, 2], axis: ['a', 'b'] };
    const adapter: AxiosAdapter = async config => ({ config, data, status: 200, statusText: 'OK', headers: { 'x-auth-token': 'Bearer renewed' } });
    const setToken = vi.fn(); const client = new HttpClient({ setToken });
    expect(await client.get('/chart', undefined, { adapter })).toEqual([1, 2]);
    const raw = await client.get<AxiosResponse>('/chart', undefined, { adapter, _rawResponse: true });
    expect(raw.data).toEqual(data); expect(raw.status).toBe(200);
    expect(setToken).toHaveBeenCalledWith('renewed');
  });
});
