import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createCookieRefresh } from './http-client';

afterEach(() => vi.restoreAllMocks());
describe('cookie refresh transport', () => {
  it('uses credentials and exposes only the access token from a response envelope', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { result: { access_token: 'access', refresh_token: 'private' } } });
    await expect(createCookieRefresh('/auth/refresh')()).resolves.toEqual({ access_token: 'access' });
    expect(post).toHaveBeenCalledWith('/auth/refresh', {}, { withCredentials: true });
  });
  it('rejects a missing access token', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { result: {} } });
    await expect(createCookieRefresh('/auth/refresh')()).rejects.toThrow('Invalid access-token');
  });
  it('attaches the HTTP status to a malformed 200 and forwards the abort signal', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { result: {} } });
    const controller = new AbortController();
    await expect(createCookieRefresh('/auth/refresh')(controller.signal)).rejects.toMatchObject({ status: 200 });
    expect(post).toHaveBeenCalledWith('/auth/refresh', {}, { withCredentials: true, signal: controller.signal });
  });
});
