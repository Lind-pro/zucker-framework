import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpAction } from './http-action';
import type { HttpActionConfig } from './http-action';

describe('HttpAction', () => {
  let action: HttpAction;

  beforeEach(() => {
    action = new HttpAction();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── validate ───────────────────────────────────────────────────────────────

  describe('validate()', () => {
    it('빈 URL이면 오류를 던져야 한다', () => {
      expect(() =>
        action.validate({ url: '', method: 'GET' }),
      ).toThrow('HTTP action URL is required');
    });

    it('공백만 있는 URL이면 오류를 던져야 한다', () => {
      expect(() =>
        action.validate({ url: '   ', method: 'GET' }),
      ).toThrow('HTTP action URL is required');
    });

    it('지원하지 않는 HTTP 메서드면 오류를 던져야 한다', () => {
      expect(() =>
        action.validate({ url: 'http://example.com', method: 'CONNECT' as any }),
      ).toThrow('Invalid HTTP method: CONNECT');
    });

    it('유효한 설정이면 오류를 던지지 않아야 한다', () => {
      expect(() =>
        action.validate({ url: 'http://example.com', method: 'POST' }),
      ).not.toThrow();
    });
  });

  // ─── GET 요청 ───────────────────────────────────────────────────────────────

  describe('GET 요청', () => {
    it('정상 응답을 JSON으로 파싱해야 한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ code: 0, data: 'ok' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://api.example.com/status',
        method: 'GET',
      };
      const promise = action.execute(config, {});
      vi.runAllTimers();
      const result = await promise;

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0][0]).toBe('http://api.example.com/status');
      expect(mockFetch.mock.calls[0][1].method).toBe('GET');
      expect(result).toEqual({ code: 0, data: 'ok' });
    });

    it('응답이 JSON이 아니면 텍스트 그대로 반환해야 한다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'plain text response',
      }));

      const config: HttpActionConfig = { url: 'http://example.com', method: 'GET' };
      const promise = action.execute(config, {});
      vi.runAllTimers();
      const result = await promise;

      expect(result).toBe('plain text response');
    });
  });

  // ─── POST 요청 ──────────────────────────────────────────────────────────────

  describe('POST 요청', () => {
    it('body를 JSON으로 직렬화하여 전송해야 한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{"success":true}',
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://api.example.com/data',
        method: 'POST',
        body: { deviceId: 'D001', value: 42 },
      };
      const promise = action.execute(config, {});
      vi.runAllTimers();
      await promise;

      const fetchCall = mockFetch.mock.calls[0][1];
      expect(fetchCall.method).toBe('POST');
      expect(fetchCall.body).toBe(JSON.stringify({ deviceId: 'D001', value: 42 }));
    });
  });

  // ─── URL 템플릿 변수 치환 ────────────────────────────────────────────────────

  describe('URL 템플릿 변수 치환', () => {
    it('URL 안의 ${variable}을 data에서 치환해야 한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{}',
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://api.example.com/devices/${deviceId}/status',
        method: 'GET',
      };
      const promise = action.execute(config, { deviceId: 'sensor-99' });
      vi.runAllTimers();
      await promise;

      expect(mockFetch.mock.calls[0][0]).toBe(
        'http://api.example.com/devices/sensor-99/status',
      );
    });

    it('중첩 경로 ${a.b}를 치환해야 한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{}',
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://api.example.com/${device.id}',
        method: 'GET',
      };
      const promise = action.execute(config, { device: { id: 'nested-id' } });
      vi.runAllTimers();
      await promise;

      expect(mockFetch.mock.calls[0][0]).toBe('http://api.example.com/nested-id');
    });

    it('body 템플릿 변수도 치환해야 한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{}',
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://api.example.com/report',
        method: 'POST',
        body: { name: '${name}', score: '${score}' },
      };
      const promise = action.execute(config, { name: 'Alice', score: 95 });
      vi.runAllTimers();
      await promise;

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(sentBody).toEqual({ name: 'Alice', score: '95' });
    });

    it('headers 템플릿 변수도 치환해야 한다', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{}',
      });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://api.example.com',
        method: 'GET',
        headers: { Authorization: 'Bearer ${token}' },
      };
      const promise = action.execute(config, { token: 'abc123' });
      vi.runAllTimers();
      await promise;

      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer abc123');
    });
  });

  // ─── 에러 처리 ───────────────────────────────────────────────────────────────

  describe('에러 처리', () => {
    it('HTTP 4xx/5xx 응답이면 오류를 던져야 한다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Not Found',
      }));

      const config: HttpActionConfig = { url: 'http://example.com/missing', method: 'GET' };
      const promise = action.execute(config, {});
      vi.runAllTimers();

      await expect(promise).rejects.toThrow('HTTP 404');
    });

    it('네트워크 오류면 오류를 전파해야 한다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

      const config: HttpActionConfig = { url: 'http://example.com', method: 'GET' };
      const promise = action.execute(config, {});
      vi.runAllTimers();

      await expect(promise).rejects.toThrow('network error');
    });

    it('retryCount 지정 시 실패 후 재시도해야 한다', async () => {
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce({ ok: true, text: async () => '"ok"' });
      vi.stubGlobal('fetch', mockFetch);

      const config: HttpActionConfig = {
        url: 'http://example.com',
        method: 'GET',
        retryCount: 1,
        retryDelay: 100,
      };
      const promise = action.execute(config, {});
      // advance past retryDelay and flush all pending timers/microtasks
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result).toBe('ok');
    });

    it('모든 재시도 실패 시 마지막 오류를 던져야 한다', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('always fails')));

      const config: HttpActionConfig = {
        url: 'http://example.com',
        method: 'GET',
        retryCount: 1,
        retryDelay: 50,
      };
      const promise = action.execute(config, {});
      // Attach rejection handler BEFORE running timers to avoid unhandled-rejection warning
      const expectation = expect(promise).rejects.toThrow('always fails');
      await vi.runAllTimersAsync();
      await expectation;
    });
  });

  // ─── M10: injection and destination policy ───────────────────────────────────

  describe('injection and destination policy', () => {
    const okFetch = () => vi.fn().mockResolvedValue({ ok: true, text: async () => '{}' });

    it('quotes in data cannot inject JSON body fields', async () => {
      const mockFetch = okFetch();
      vi.stubGlobal('fetch', mockFetch);
      await action.execute(
        { url: 'http://api.example.com/r', method: 'POST', body: { name: '${name}' } },
        { name: 'x","admin":true,"y":"' },
      );
      const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(sent).toEqual({ name: 'x","admin":true,"y":"' });
      expect(sent.admin).toBeUndefined();
    });

    it('URL placeholders are percent-encoded', async () => {
      const mockFetch = okFetch();
      vi.stubGlobal('fetch', mockFetch);
      await action.execute(
        { url: 'http://api.example.com/devices/${id}', method: 'GET' },
        { id: '../admin?x=@evil.com/' },
      );
      const sentUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(sentUrl.host).toBe('api.example.com');
      expect(sentUrl.pathname).toBe('/devices/..%2Fadmin%3Fx%3D%40evil.com%2F');
      expect(sentUrl.search).toBe('');
    });

    it.each([
      'http://127.0.0.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/',
      'http://localhost:8080/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'file:///etc/passwd',
    ])('refuses private or non-http destination %s by default', async (url) => {
      const mockFetch = okFetch();
      vi.stubGlobal('fetch', mockFetch);
      await expect(action.execute({ url, method: 'GET' }, {})).rejects.toThrow(/not allowed/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('allowPrivateNetwork opt-in permits internal destinations', async () => {
      const mockFetch = okFetch();
      vi.stubGlobal('fetch', mockFetch);
      await new HttpAction({ allowPrivateNetwork: true }).execute({ url: 'http://10.0.0.5/', method: 'GET' }, {});
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0][1].redirect).toBe('error');
    });

    it('caps response size', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'x'.repeat(20) }));
      await expect(
        new HttpAction({ maxResponseBytes: 10 }).execute({ url: 'http://api.example.com', method: 'GET' }, {}),
      ).rejects.toThrow(/exceeds/);
    });
  });
});
