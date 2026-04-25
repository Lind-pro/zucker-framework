import axios, { AxiosInstance, AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import {
  ApiResponse,
  ErrorHandler,
  RequestConfig,
  HttpClientConfig,
  DownloadResponse,
} from './types';

/** Extended request config with retry flag for token refresh logic */
interface RetryableRequestConfig extends InternalAxiosRequestConfig {
  _isRetry?: boolean;
}

const DEFAULT_CONFIG = {
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: false,
  successCode: 200,
  tokenKey: 'token',
  errorHandler: () => {},
};

interface InternalConfig {
  baseURL?: string;
  streamBaseURL?: string;
  timeout: number;
  headers: Record<string, string>;
  withCredentials: boolean;
  successCode: number;
  tokenKey: string;
  getToken: () => string | null | undefined;
  getRefreshToken: () => string | null | undefined;
  setToken: (token: string) => void;
  setRefreshToken: (token: string) => void;
  clearAuth: () => void;
  refreshTokenFn?: (refreshToken: string) => Promise<{ access_token: string; refresh_token: string }>;
  errorHandler: (error: Error, response?: ApiResponse<unknown>) => void;
  onUnauthorized: () => void;
  onForbidden: () => void;
}

export class HttpClient {
  private api: AxiosInstance;
  private config: InternalConfig;
  private isRefreshing = false;
  private refreshSubscribers: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = [];

  constructor(config: HttpClientConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      baseURL: config.baseURL,
      streamBaseURL: config.streamBaseURL,
      ...config,
      headers: {
        ...DEFAULT_CONFIG.headers,
        ...config.headers,
      },
      getToken: config.getToken || (() => null),
      getRefreshToken: config.getRefreshToken || (() => null),
      setToken: config.setToken || (() => {}),
      setRefreshToken: config.setRefreshToken || (() => {}),
      clearAuth: config.clearAuth || (() => {}),
      refreshTokenFn: config.refreshTokenFn,
      onUnauthorized: config.onUnauthorized || this.defaultUnauthorizedHandler,
      onForbidden: config.onForbidden || (() => {}),
    };

    this.api = axios.create({
      baseURL: this.config.baseURL,
      timeout: this.config.timeout,
      headers: this.config.headers,
      withCredentials: this.config.withCredentials,
    });

    this.setupRequestInterceptor();
    this.setupResponseInterceptor();
  }

  private setupRequestInterceptor(): void {
    this.api.interceptors.request.use(
      (config) => {
        const token = this.config.getToken();
        if (token && config.headers) {
          config.headers['Authorization'] = `Bearer ${token}`;
        }
        if (config.data instanceof FormData && config.headers) {
          delete config.headers['Content-Type'];
        }
        return config;
      },
      (error) => Promise.reject(error),
    );
  }

  private setupResponseInterceptor(): void {
    this.api.interceptors.response.use(
      (response: AxiosResponse) => {
        const newToken =
          response.headers['x-auth-token'] ||
          response.headers['authorization'] ||
          response.headers['x-token'];

        if (newToken) {
          const token =
            typeof newToken === 'string' && newToken.startsWith('Bearer ')
              ? newToken.slice(7)
              : newToken;
          this.config.setToken(token);
        }

        if (response.data instanceof ArrayBuffer || response.data instanceof Blob) {
          return response;
        }

        const data = response.data;

        if (typeof data === 'object' && data !== null) {
          const contentType = response.headers['content-type'];
          if (
            contentType?.includes('application/octet-stream') ||
            contentType?.includes('application/vnd.ms-excel') ||
            contentType?.includes('application/pdf')
          ) {
            return data;
          }

          const isTransformFormat = 'status' in data && 'result' in data;

          if (isTransformFormat) {
            const success = data.status === this.config.successCode;
            if (!success && data.message) {
              return Promise.reject(new Error(data.message));
            }
            return data.result;
          }

          return data;
        }

        return data;
      },
      async (error: AxiosError) => {
        if (error.response) {
          const { status, config: originalRequest } = error.response;
          const data = error.response.data as Record<string, unknown>;
          const errorMsg = (data?.message as string) || `请求失败 (${status})`;

          if (status === 401) {
            const isRetry = (originalRequest as RetryableRequestConfig)?._isRetry;
            if (isRetry) {
              this.config.clearAuth();
              const isLoginPage = typeof window !== 'undefined' &&
                (window.location.pathname === '/login' || window.location.pathname.endsWith('/login'));
              if (!isLoginPage) {
                this.config.onUnauthorized();
              }
              return Promise.reject(Object.assign(new Error(errorMsg), { _authHandled: true }));
            }

            const refreshToken = this.config.getRefreshToken?.();
            const refreshFn = this.config.refreshTokenFn;

            if (refreshToken && refreshFn && originalRequest) {
              if (!this.isRefreshing) {
                this.isRefreshing = true;
                try {
                  const tokens = await refreshFn(refreshToken);
                  this.config.setToken(tokens.access_token);
                  this.config.setRefreshToken?.(tokens.refresh_token);
                  this.refreshSubscribers.forEach(({ resolve }) => resolve(tokens.access_token));
                  this.refreshSubscribers = [];
                  originalRequest.headers = originalRequest.headers || {};
                  originalRequest.headers['Authorization'] = `Bearer ${tokens.access_token}`;
                  (originalRequest as RetryableRequestConfig)._isRetry = true;
                  return this.api.request(originalRequest);
                } catch (refreshError) {
                  this.refreshSubscribers.forEach(({ reject }) => reject(refreshError));
                  this.refreshSubscribers = [];
                  this.config.clearAuth();
                  const isLoginPage = typeof window !== 'undefined' &&
                    (window.location.pathname === '/login' || window.location.pathname.endsWith('/login'));
                  if (!isLoginPage) {
                    this.config.onUnauthorized();
                  }
                  return Promise.reject(Object.assign(new Error(errorMsg), { _authHandled: true }));
                } finally {
                  this.isRefreshing = false;
                }
              } else {
                return new Promise((resolve, reject) => {
                  this.refreshSubscribers.push({
                    resolve: (token: string) => {
                      originalRequest.headers = originalRequest.headers || {};
                      originalRequest.headers['Authorization'] = `Bearer ${token}`;
                      (originalRequest as RetryableRequestConfig)._isRetry = true;
                      this.api.request(originalRequest).then(resolve).catch(reject);
                    },
                    reject,
                  });
                });
              }
            }

            const isLoginPage = typeof window !== 'undefined' &&
              (window.location.pathname === '/login' || window.location.pathname.endsWith('/login'));
            if (!isLoginPage) {
              this.config.clearAuth();
              this.config.onUnauthorized();
            }
            return Promise.reject(Object.assign(new Error(errorMsg), { _authHandled: true }));
          } else if (status === 403) {
            this.config.onForbidden();
            return Promise.reject(Object.assign(new Error(errorMsg), { _authHandled: true }));
          } else {
            return Promise.reject(new Error(errorMsg));
          }
        } else if (error.request) {
          return Promise.reject(new Error('网络连接失败，请检查您的网络'));
        } else {
          return Promise.reject(new Error('请求错误: ' + error.message));
        }
      },
    );
  }

  private defaultUnauthorizedHandler = (): void => {
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
    }
  };

  private async request<T>(
    path: string,
    options: RequestConfig & { method: string; data?: unknown } = { method: 'GET' },
  ): Promise<T> {
    const { errorHandler, _hideError, _rawResponse, ...axiosOptions } = options;

    try {
      const response = await this.api.request<T>({
        url: path,
        ...axiosOptions,
      });
      return response as unknown as T;
    } catch (error) {
      const err = error as Error & { _authHandled?: boolean };
      if (!_hideError && !err._authHandled) {
        if (errorHandler) {
          errorHandler(err);
        } else {
          this.config.errorHandler(err);
        }
      }
      throw err;
    }
  }

  async get<T>(
    path: string,
    params?: Record<string, unknown>,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET', params });
  }

  async post<T>(
    path: string,
    data?: unknown,
    params?: Record<string, unknown>,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', data, params });
  }

  async put<T>(
    path: string,
    data?: unknown,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PUT', data });
  }

  async patch<T>(
    path: string,
    data?: unknown,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PATCH', data });
  }

  async delete<T>(
    path: string,
    params?: Record<string, unknown>,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE', params });
  }

  async upload<T>(
    path: string,
    formData: FormData,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.post<T>(path, formData, undefined, {
      ...options,
      headers: {
        ...(options.headers || {}),
        'Content-Type': 'multipart/form-data',
      },
    });
  }

  async downloadFile(
    path: string,
    params?: Record<string, unknown>,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<DownloadResponse> {
    const response = await this.api.request({
      url: path,
      method: 'GET',
      params,
      responseType: 'arraybuffer',
      ...options,
    });

    return {
      data: response.data,
      headers: response.headers as Record<string, string>,
      status: response.status,
    };
  }

  async fetchStream(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: unknown;
      params?: Record<string, unknown>;
      headers?: Record<string, string>;
      timeout?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const { method = 'POST', body, params, headers = {}, timeout, signal: externalSignal } = options;

    const baseURL = this.config.streamBaseURL || this.config.baseURL || '';
    let url = `${baseURL}${path}`;

    if (params) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          searchParams.append(key, String(value));
        }
      });
      const queryString = searchParams.toString();
      if (queryString) {
        url += `${url.includes('?') ? '&' : '?'}${queryString}`;
      }
    }

    const requestHeaders: Record<string, string> = {
      ...this.config.headers,
      ...headers,
    };

    const token = this.config.getToken();
    if (token) {
      requestHeaders['Authorization'] = `Bearer ${token}`;
    }

    let requestBody: string | FormData | undefined;
    if (body) {
      if (body instanceof FormData) {
        delete requestHeaders['Content-Type'];
        requestBody = body;
      } else {
        requestHeaders['Content-Type'] = 'application/json';
        requestBody = JSON.stringify(body);
      }
    }

    let controller: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let signal: AbortSignal | undefined;

    if (externalSignal) {
      signal = externalSignal;
    } else {
      controller = new AbortController();
      signal = controller.signal;
      if (timeout) {
        timeoutId = setTimeout(() => controller!.abort(), timeout);
      }
    }

    try {
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal,
        credentials: this.config.withCredentials ? 'include' : 'same-origin',
      });

      if (timeoutId) clearTimeout(timeoutId);

      if (response.status === 401) {
        this.config.clearAuth();
        this.config.onUnauthorized();
        throw Object.assign(new Error('未授权，请先登录'), { _authHandled: true });
      }

      if (response.status === 403) {
        this.config.onForbidden();
        throw Object.assign(new Error('没有访问权限'), { _authHandled: true });
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '请求失败');
        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.message || errorJson.error || errorText;
        } catch {
          // not JSON
        }
        throw new Error(errorMessage);
      }

      return response;
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          const timeoutError = new Error('请求超时');
          this.config.errorHandler(timeoutError);
          throw timeoutError;
        }
        if (!(error as Error & { _authHandled?: boolean })._authHandled) {
          this.config.errorHandler(error);
        }
        throw error;
      }
      const unknownError = new Error('请求失败');
      this.config.errorHandler(unknownError);
      throw unknownError;
    }
  }

  getAxiosInstance(): AxiosInstance {
    return this.api;
  }
}

/**
 * Factory function to create an HttpClient instance.
 * Convenience wrapper around `new HttpClient(config)`.
 */
export function createHttpClient(config: HttpClientConfig = {}): HttpClient {
  return new HttpClient(config);
}
