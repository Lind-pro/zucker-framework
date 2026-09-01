import axios from 'axios';
import { HttpClient } from './http-client';

// Mock axios
vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  const mockInstance = {
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    request: vi.fn(),
  };
  return {
    ...actual,
    default: {
      ...actual.default,
      create: vi.fn(() => mockInstance),
    },
  };
});

function getAxiosMock() {
  const createMock = vi.mocked(axios.create);
  return createMock.mock.results[0]?.value as {
    interceptors: {
      request: { use: ReturnType<typeof vi.fn> };
      response: { use: ReturnType<typeof vi.fn> };
    };
    request: ReturnType<typeof vi.fn>;
  };
}

describe('HttpClient', () => {
  let getToken: ReturnType<typeof vi.fn>;
  let getRefreshToken: ReturnType<typeof vi.fn>;
  let setToken: ReturnType<typeof vi.fn>;
  let setRefreshToken: ReturnType<typeof vi.fn>;
  let clearAuth: ReturnType<typeof vi.fn>;
  let onUnauthorized: ReturnType<typeof vi.fn>;
  let refreshTokenFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getToken = vi.fn().mockReturnValue('test-token');
    getRefreshToken = vi.fn().mockReturnValue('test-refresh');
    setToken = vi.fn();
    setRefreshToken = vi.fn();
    clearAuth = vi.fn();
    onUnauthorized = vi.fn();
    refreshTokenFn = vi.fn();
  });

  function createClient() {
    return new HttpClient({
      baseURL: '/api',
      getToken,
      getRefreshToken,
      setToken,
      setRefreshToken,
      clearAuth,
      onUnauthorized,
      refreshTokenFn,
    });
  }

  it('should create an axios instance with correct config', () => {
    createClient();
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: '/api',
        timeout: 60000,
      }),
    );
  });

  it('should set up request and response interceptors', () => {
    createClient();
    const mock = getAxiosMock();
    expect(mock.interceptors.request.use).toHaveBeenCalledTimes(1);
    expect(mock.interceptors.response.use).toHaveBeenCalledTimes(1);
  });

  describe('request interceptor', () => {
    it('should attach Bearer token to requests', () => {
      createClient();
      const mock = getAxiosMock();
      const requestInterceptor = mock.interceptors.request.use.mock.calls[0][0];

      const config = { headers: {} as Record<string, string> };
      const result = requestInterceptor(config);
      expect(result.headers['Authorization']).toBe('Bearer test-token');
    });

    it('should skip token when getToken returns null', () => {
      getToken.mockReturnValue(null);
      createClient();
      const mock = getAxiosMock();
      const requestInterceptor = mock.interceptors.request.use.mock.calls[0][0];

      const config = { headers: {} as Record<string, string> };
      const result = requestInterceptor(config);
      expect(result.headers['Authorization']).toBeUndefined();
    });

    it('should remove Content-Type for FormData', () => {
      createClient();
      const mock = getAxiosMock();
      const requestInterceptor = mock.interceptors.request.use.mock.calls[0][0];

      const config = {
        headers: { 'Content-Type': 'application/json' } as Record<string, string>,
        data: new FormData(),
      };
      const result = requestInterceptor(config);
      expect(result.headers['Content-Type']).toBeUndefined();
    });
  });

  describe('response interceptor — success', () => {
    it('should unwrap { status, result } envelope', () => {
      createClient();
      const mock = getAxiosMock();
      const successHandler = mock.interceptors.response.use.mock.calls[0][0];

      const response = {
        headers: {},
        data: { status: 200, result: { id: 1 }, message: 'ok' },
      };
      const result = successHandler(response);
      expect(result).toEqual({ id: 1 });
    });

    it('should reject when business status is not success code', async () => {
      createClient();
      const mock = getAxiosMock();
      const successHandler = mock.interceptors.response.use.mock.calls[0][0];

      const response = {
        headers: {},
        data: { status: 500, result: null, message: 'Internal error' },
      };
      await expect(successHandler(response)).rejects.toThrow('Internal error');
    });

    it('should pass through non-envelope data as-is', () => {
      createClient();
      const mock = getAxiosMock();
      const successHandler = mock.interceptors.response.use.mock.calls[0][0];

      const response = {
        headers: {},
        data: { id: 1, name: 'test' },
      };
      expect(successHandler(response)).toEqual({ id: 1, name: 'test' });
    });

    it('should update token from x-auth-token header', () => {
      createClient();
      const mock = getAxiosMock();
      const successHandler = mock.interceptors.response.use.mock.calls[0][0];

      const response = {
        headers: { 'x-auth-token': 'new-token-from-header' },
        data: { some: 'data' },
      };
      successHandler(response);
      expect(setToken).toHaveBeenCalledWith('new-token-from-header');
    });
  });

  describe('response interceptor — 401 + token refresh', () => {
    it('should attempt token refresh on first 401', async () => {
      refreshTokenFn.mockResolvedValue({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
      });

      createClient();
      const mock = getAxiosMock();
      const errorHandler = mock.interceptors.response.use.mock.calls[0][1];
      mock.request.mockResolvedValueOnce({ data: 'retried' });

      const error = {
        response: {
          status: 401,
          data: { message: 'Unauthorized' },
          config: { headers: {}, url: '/test' },
        },
        request: {},
      };

      await errorHandler(error);
      expect(refreshTokenFn).toHaveBeenCalledWith('test-refresh');
      expect(setToken).toHaveBeenCalledWith('new-access');
      expect(setRefreshToken).toHaveBeenCalledWith('new-refresh');
    });

    it('should reject queued requests when refresh fails', async () => {
      refreshTokenFn.mockRejectedValue(new Error('refresh failed'));

      createClient();
      const mock = getAxiosMock();
      const errorHandler = mock.interceptors.response.use.mock.calls[0][1];

      const error = {
        response: {
          status: 401,
          data: { message: 'Unauthorized' },
          config: { headers: {}, url: '/test' },
        },
        request: {},
      };

      await expect(errorHandler(error)).rejects.toThrow();
      expect(clearAuth).toHaveBeenCalled();
      expect(onUnauthorized).toHaveBeenCalled();
    });

    it('should call onUnauthorized after retry 401', async () => {
      createClient();
      const mock = getAxiosMock();
      const errorHandler = mock.interceptors.response.use.mock.calls[0][1];

      const error = {
        response: {
          status: 401,
          data: { message: 'Still unauthorized' },
          config: { headers: {}, url: '/test', _isRetry: true },
        },
        request: {},
      };

      await expect(errorHandler(error)).rejects.toThrow();
      expect(clearAuth).toHaveBeenCalled();
    });
  });

  describe('response interceptor — other errors', () => {
    it('should call onForbidden on 403', async () => {
      const onForbidden = vi.fn();
      new HttpClient({
        baseURL: '/api',
        getToken,
        onForbidden,
      });
      const mock = getAxiosMock();
      const errorHandler = mock.interceptors.response.use.mock.calls[0][1];

      const error = {
        response: {
          status: 403,
          data: { message: 'Forbidden' },
          config: {},
        },
        request: {},
      };

      await expect(errorHandler(error)).rejects.toThrow('Forbidden');
      expect(onForbidden).toHaveBeenCalled();
    });

    it('should handle network error (no response)', async () => {
      createClient();
      const mock = getAxiosMock();
      const errorHandler = mock.interceptors.response.use.mock.calls[0][1];

      const error = { request: {}, message: 'Network Error' };
      await expect(errorHandler(error)).rejects.toThrow('网络连接失败');
    });
  });
});
