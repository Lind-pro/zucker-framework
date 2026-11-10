import axios, { AxiosInstance, AxiosError, AxiosResponse } from 'axios';
import { ApiResponse, RequestConfig, HttpClientConfig, DownloadResponse } from './types';

/** A failed refresh transport is not evidence that its credentials were rejected. */
function normalizeRefreshFailure(error: unknown): Error & { status?: number } {
  const received = error as { status?: unknown; response?: { status?: unknown } } | null | undefined;
  const status = received?.response?.status ?? received?.status;
  return Object.assign(new Error(error instanceof Error ? error.message : 'Token refresh failed'), {
    cause: error,
    ...(received?.response ? { response: received.response } : {}),
    ...(typeof status === 'number' ? { status, _httpStatus: status } : {}),
  });
}

/**
 * 生成请求 ID（UUID v4，crypto 不可用时退化为时间戳+随机数）
 */
function generateRequestId(): string {
  try {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  } catch {}
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const ABSOLUTE_URL = /^([a-z][a-z\d+\-.]*:)?\/\//i;

function originOf(url: string | undefined, base?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url, base).origin;
  } catch {
    return null;
  }
}

function currentOrigin(): string | undefined {
  try {
    return typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null'
      ? window.location.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/** Refresh result carrying an optional rotated refresh token for the refreshTokenFn flow. */
type RefreshResult = { access_token: string; refresh_token?: string };

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: false,
  successCode: 200,
  tokenKey: 'token',
  errorHandler: () => {
    // 默认不做任何处理，由调用方提供自定义错误处理器
  },
};

/**
 * 内部配置类型
 */
interface InternalConfig {
  baseURL?: string;
  streamBaseURL?: string;
  timeout: number;
  headers: Record<string, string>;
  withCredentials: boolean;
  successCode: number;
  tokenKey: string;
  getToken: () => string | null | undefined;
  setToken: (token: string) => void;
  clearAuth: () => void;
  refreshTokenFn?: HttpClientConfig['refreshTokenFn'];
  refreshWithCookie?: HttpClientConfig['refreshWithCookie'];
  refreshLockName?: string;
  trustedOrigins?: readonly string[];
  acceptResponseToken?: HttpClientConfig['acceptResponseToken'];
  getRefreshToken?: HttpClientConfig['getRefreshToken'];
  setRefreshToken?: HttpClientConfig['setRefreshToken'];
  errorHandler: (error: Error, response?: ApiResponse<unknown>) => void;
  onUnauthorized: () => void;
  onForbidden: () => void;
  onResponseError?: HttpClientConfig['onResponseError'];
}

/**
 * HTTP客户端类
 */
export class HttpClient {
  private api: AxiosInstance;
  private config: InternalConfig;
  private refreshPromise?: Promise<{ access_token: string }>;

  constructor(config: HttpClientConfig = {}) {
    // 合并配置
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
      setToken: config.setToken || (() => {}),
      clearAuth: config.clearAuth || (() => {}),
      refreshTokenFn: config.refreshTokenFn,
      onUnauthorized: config.onUnauthorized || this.defaultUnauthorizedHandler,
      onForbidden: config.onForbidden || this.defaultForbiddenHandler,
      refreshWithCookie: config.refreshWithCookie,
      refreshLockName: config.refreshLockName,
      getRefreshToken: config.getRefreshToken,
      setRefreshToken: config.setRefreshToken,
      onResponseError: config.onResponseError,
    };

    // 创建axios实例
    this.api = axios.create({
      baseURL: this.config.baseURL,
      timeout: this.config.timeout,
      headers: this.config.headers,
      withCredentials: this.config.withCredentials,
    });

    // 添加请求拦截器
    this.setupRequestInterceptor();

    // 添加响应拦截器
    this.setupResponseInterceptor();
  }

  /**
   * 设置请求拦截器
   */
  private setupRequestInterceptor(): void {
    this.api.interceptors.request.use(
      (config) => {
        // 添加 token 到请求头
        // Never leak the bearer to an origin other than the API's (M9).
        const token = this.config.getToken();
        if (token && config.headers && this.isTrustedUrl(this.resolveRequestUrl(config))) {
          config.headers['Authorization'] = `Bearer ${token}`;
        }

        // 注入 X-Request-Id（前后端 / 日志链路对齐用）
        if (config.headers && !config.headers['X-Request-Id']) {
          config.headers['X-Request-Id'] = generateRequestId();
        }

        // 处理FormData，让浏览器自动设置Content-Type
        if (config.data instanceof FormData && config.headers) {
          delete config.headers['Content-Type'];
        }

        return config;
      },
      (error) => {
        return Promise.reject(error);
      },
    );
  }

  /**
   * 设置响应拦截器
   * 处理后端 TransformInterceptor 返回的统一格式:
   * { status: 200, message: 'success', result: data, timestamp: ... }
   */
  private setupResponseInterceptor(): void {
    this.api.interceptors.response.use(
      (response: AxiosResponse) => {
        // 检查响应头中的新token并更新（仅可信来源、且会话未变化）
        this.adoptResponseToken(response);

        // Explicit opt-out is needed by consumers of third-party JSON schemas.
        if ((response.config as RequestConfig | undefined)?._rawResponse) return response;

        // 处理文件流数据
        if (response.data instanceof ArrayBuffer || response.data instanceof Blob) {
          return response;
        }

        // 处理标准JSON响应
        const data = response.data;

        if (typeof data === 'object' && data !== null) {
          // 文件流响应直接返回
          const contentType = String(response.headers['content-type'] ?? '');
          if (
            contentType?.includes('application/octet-stream') ||
            contentType?.includes('application/vnd.ms-excel') ||
            contentType?.includes('application/pdf')
          ) {
            return data;
          }

          // 后端 TransformInterceptor 格式: { status: 200, message: 'success', result: data }
          const isTransformFormat = 'status' in data && 'result' in data;

          if (isTransformFormat) {
            const success = data.status === this.config.successCode;

            if (!success && data.message) {
              // errorHandler 由 request() 的 catch 统一调用，避免重复
              return Promise.reject(new Error(data.message));
            }
            // A numeric non-success business status is a failure even without a message.
            if (!success && typeof data.status === 'number') {
              return Promise.reject(
                Object.assign(new Error(`请求失败 (${data.status})`), { code: String(data.status), response }),
              );
            }

            // 直接返回 result 中的业务数据
            return data.result;
          }

          // 非 TransformInterceptor 格式，直接返回
          return data;
        }

        return data;
      },
      async (error: AxiosError) => {
        if (axios.isCancel(error)) return Promise.reject(error);
        if (error.response) {
          const { status, config: originalRequest } = error.response;
          const data = await readErrorData(error.response.data);
          // Decoding a Blob is asynchronous: the consumer may have changed
          // session and canceled this request while the body was being read.
          // Never apply stale authentication or error side effects afterward.
          if (originalRequest?.signal?.aborted) throw new axios.CanceledError(undefined, originalRequest);
          const message = data?.message;
          const errorMsg = typeof message === 'string' ? message : Array.isArray(message) ? message.join('；') : `请求失败 (${status})`;
          // 后端结构化错误 { message, code, details } —— 把 code/details 拍平到
          // error 对象上，业务层可以 (err as { code?: string }).code === 'XXX'
          // 来路由不同 UX（如 EMAIL_ALREADY_REGISTERED 跳登录）
          const errorCode = typeof data?.code === 'string' ? data.code : undefined;
          const errorDetails =
            data?.details && typeof data.details === 'object'
              ? (data.details as Record<string, unknown>)
              : undefined;
          const attachStatus = (err: Error, extra?: Record<string, unknown>) =>
            Object.assign(err, {
              // Preserve transport evidence, including Blob/ArrayBuffer bodies that
              // callers may decode using their own domain error schema.
              cause: error,
              response: error.response,
              request: error.request,
              config: error.config,
              code: error.code,
              status,
              _httpStatus: status,
              ...(errorCode ? { code: errorCode } : {}),
              ...(errorDetails ? { details: errorDetails } : {}),
              ...extra,
            });

          // A foreign origin's 401/403 says nothing about this application's session.
          const trustedRequest = !!originalRequest && this.isTrustedUrl(this.resolveRequestUrl(originalRequest));
          // 处理401未授权错误
          if (status === 401 && trustedRequest) {
            // 检查是否是重试的请求，避免无限循环
            const isRetry = (originalRequest as any)?._isRetry;
            if (isRetry) {
              // 重试后仍然 401，直接清除认证并 reject
              this.config.clearAuth();
              const isLoginPage =
                typeof window !== 'undefined' &&
                (window.location.pathname === '/login' ||
                  window.location.pathname.endsWith('/login'));
              if (!isLoginPage) {
                this.config.onUnauthorized();
              }
              return Promise.reject(attachStatus(new Error(errorMsg), { _authHandled: true }));
            }

            const refreshFn = this.resolveRefresh();

            // HttpOnly refresh cookie 由浏览器自动携带
            if (refreshFn && originalRequest) {
              try {
                const failedAccessToken = this.readBearerToken(originalRequest.headers);
                const tokens = await this.refreshAccessToken(refreshFn, failedAccessToken);
                if (originalRequest.signal?.aborted) throw new axios.CanceledError();
                // refreshWithCrossTabLock already stored the token after re-checking the session.
                originalRequest.headers = originalRequest.headers || {};
                originalRequest.headers['Authorization'] = `Bearer ${tokens.access_token}`;
                (originalRequest as any)._isRetry = true;
                return this.api.request(originalRequest);
              } catch (refreshError) {
                if (originalRequest.signal?.aborted || axios.isCancel(refreshError)) {
                  throw new axios.CanceledError();
                }
                const failure = normalizeRefreshFailure(refreshError);
                if (failure.status !== 401 && failure.status !== 403) return Promise.reject(failure);
                this.config.clearAuth();
                const isLoginPage =
                  typeof window !== 'undefined' &&
                  (window.location.pathname === '/login' ||
                    window.location.pathname.endsWith('/login'));
                if (!isLoginPage) {
                  this.config.onUnauthorized();
                }
                return Promise.reject(attachStatus(new Error(errorMsg), { _authHandled: true }));
              }
            }

            // 没有 refresh token 或刷新函数，直接处理 401
            const isLoginPage =
              typeof window !== 'undefined' &&
              (window.location.pathname === '/login' ||
                window.location.pathname.endsWith('/login'));
            this.config.clearAuth();
            if (!isLoginPage) {
              this.config.onUnauthorized();
            }
            return Promise.reject(attachStatus(new Error(errorMsg), { _authHandled: true }));
          }
          // 处理403禁止访问错误
          else if (status === 403 && trustedRequest) {
            this.config.onForbidden();
            return Promise.reject(attachStatus(new Error(errorMsg), { _authHandled: true }));
          } else {
            const normalized = attachStatus(new Error(errorMsg));
            if (this.config.onResponseError?.(normalized, data) === true) {
              Object.assign(normalized, { _responseHandled: true });
            }
            return Promise.reject(normalized);
          }
        } else if (error.request) {
          // 请求发出但未收到响应
          return Promise.reject(
            Object.assign(new Error('网络连接失败，请检查您的网络'), { _network: true }),
          );
        } else {
          // 请求配置出错
          return Promise.reject(new Error('请求错误: ' + error.message));
        }
      },
    );
  }

  private resolveRefresh(): (() => Promise<RefreshResult>) | undefined {
    if (this.config.refreshWithCookie) return this.config.refreshWithCookie;
    const refresh = this.config.refreshTokenFn;
    if (!refresh || !this.config.getRefreshToken?.()) return undefined;
    return async () => {
      // Re-read after acquiring the cross-tab lock: another caller may have rotated it.
      const token = this.config.getRefreshToken?.();
      if (!token) throw new Error('Refresh token unavailable');
      // The rotated refresh token is stored only after the session re-check below.
      return refresh(token);
    };
  }

  /** Resolve a request's target the way axios combines baseURL and url (no query string). */
  private resolveRequestUrl(config: { url?: string; baseURL?: string }): string {
    const url = config.url ?? '';
    if (ABSOLUTE_URL.test(url)) return url;
    const base = config.baseURL ?? this.config.baseURL;
    if (!base) return url;
    return url ? `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}` : base;
  }

  /** Whether a fully resolved request URL targets the API (or an explicitly trusted) origin. */
  private isTrustedUrl(url: string): boolean {
    if (!ABSOLUTE_URL.test(url)) return true; // relative: same origin as the page / baseURL path
    const here = currentOrigin();
    const origin = originOf(url, here);
    if (!origin) return false;
    if (origin === here) return true;
    const trusted = [this.config.baseURL, this.config.streamBaseURL, ...(this.config.trustedOrigins ?? [])];
    return trusted.some((candidate) => {
      if (!candidate || !ABSOLUTE_URL.test(candidate)) return false;
      return originOf(candidate, here) === origin;
    });
  }

  /** Adopt a token sent in a response header only when it cannot move the tab to another session. */
  private adoptResponseToken(response: AxiosResponse): void {
    const accept = this.config.acceptResponseToken ?? true;
    if (accept === false) return;
    const raw =
      response.headers['x-auth-token'] ||
      response.headers['authorization'] ||
      response.headers['x-token'];
    if (typeof raw !== 'string' || !raw) return;
    const request = response.config;
    if (!request || request.signal?.aborted) return;
    const url = this.resolveRequestUrl(request);
    if (!this.isTrustedUrl(url)) return;
    // The request must have been sent with the credential that is still current: a late
    // response after sign-out or an account switch must not restore the old session.
    const sent = this.readBearerToken(request.headers) ?? null;
    if (sent !== (this.config.getToken() ?? null)) return;
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
    if (!token || token === sent) return;
    if (typeof accept === 'function' && !accept(token, { url })) return;
    this.config.setToken(token);
  }

  private refreshAccessToken(
    refresh: () => Promise<RefreshResult>,
    failedAccessToken?: string,
  ): Promise<{ access_token: string }> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshWithCrossTabLock(refresh, failedAccessToken).finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  private async refreshWithCrossTabLock(
    refresh: () => Promise<RefreshResult>,
    failedAccessToken?: string,
  ): Promise<{ access_token: string }> {
    const execute = async () => {
      const currentAccessToken = this.config.getToken();
      if (failedAccessToken && currentAccessToken && currentAccessToken !== failedAccessToken) {
        return { access_token: currentAccessToken };
      }

      const tokens = await refresh();
      // Re-check the session after the (possibly long) refresh: a sign-out or account switch
      // that happened meanwhile must not be overwritten with the refreshed credentials.
      const afterRefresh = this.config.getToken();
      if ((afterRefresh ?? null) !== (currentAccessToken ?? null)) {
        if (afterRefresh) return { access_token: afterRefresh };
        throw new axios.CanceledError('Session ended during token refresh');
      }
      this.config.setToken(tokens.access_token);
      if (tokens.refresh_token) this.config.setRefreshToken?.(tokens.refresh_token);
      return { access_token: tokens.access_token };
    };

    if (typeof navigator === 'undefined' || !navigator.locks) {
      return execute();
    }

    const lockName =
      this.config.refreshLockName ?? `zucker:http-refresh:${this.config.baseURL ?? 'default'}`;
    return navigator.locks.request(lockName, execute);
  }

  private readBearerToken(headers: unknown): string | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const source = headers as {
      get?: (name: string) => unknown;
      Authorization?: unknown;
      authorization?: unknown;
    };
    const value =
      (typeof source.get === 'function' ? source.get('Authorization') : undefined) ??
      source.Authorization ??
      source.authorization;
    return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined;
  }

  /**
   * 默认的401处理
   */
  private defaultUnauthorizedHandler = (): void => {
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
    }
  };

  /**
   * 默认的403处理
   */
  private defaultForbiddenHandler = (): void => {
    // 默认不做任何处理，由调用方提供自定义处理器
  };

  /**
   * 通用请求方法
   */
  private async request<T>(
    path: string,
    options: RequestConfig & { method: string; data?: unknown } = {
      method: 'GET',
    },
  ): Promise<T> {
    const { errorHandler, _hideError, ...axiosOptions } = options;

    try {
      // 响应拦截器已完成数据解包：
      // - 二进制/流数据 → 返回完整 AxiosResponse
      // - TransformInterceptor 格式 → 返回 data.result（业务数据，可能为 null）
      // - 其他格式 → 返回 data 本身
      // 因此 response 可能是任意类型（包括 null），直接透传即可
      const response = await this.api.request<T>({
        url: path,
        ...axiosOptions,
      });

      return response as unknown as T;
    } catch (error) {
      const err = error as Error & {
        _authHandled?: boolean;
        _responseHandled?: boolean;
        code?: string;
        name?: string;
        message?: string;
      };
      // 2026-05-18 修：请求被主动 abort（用户切页面 / unmount cleanup / 上层 stale-request 守卫）
      // 不该作为错误弹 toast — 那是预期的取消，不是服务器错误。axios v1+ 取消错误
      // name="CanceledError"、code="ERR_CANCELED"；fetch 抛 "AbortError"。统一过滤。
      const isCanceled =
        err.name === 'CanceledError' ||
        err.name === 'AbortError' ||
        err.code === 'ERR_CANCELED' ||
        err.message === 'canceled';
      const skipHandler = err._authHandled || err._responseHandled || isCanceled;
      if (!_hideError && !skipHandler) {
        if (errorHandler) {
          errorHandler(err);
        } else {
          this.config.errorHandler(err);
        }
      }
      throw err;
    }
  }

  /**
   * GET请求
   */
  async get<T>(
    path: string,
    params?: Record<string, unknown>,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET', params });
  }

  /**
   * POST请求
   */
  async post<T>(
    path: string,
    data?: unknown,
    params?: Record<string, unknown>,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: 'POST',
      data,
      params,
    });
  }

  /**
   * PUT请求
   */
  async put<T>(
    path: string,
    data?: unknown,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: 'PUT',
      data,
    });
  }

  /**
   * PATCH请求
   */
  async patch<T>(
    path: string,
    data?: unknown,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: 'PATCH',
      data,
    });
  }

  /**
   * DELETE请求
   */
  async delete<T>(
    path: string,
    params?: Record<string, unknown>,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE', params });
  }

  /**
   * 获取二进制流数据，适用于文件下载
   */
  async getStream<T>(
    path: string,
    params?: Record<string, unknown>,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.get<T>(path, params, {
      ...options,
      responseType: 'arraybuffer',
    });
  }

  /**
   * POST方式获取二进制流数据
   */
  async postStream<T>(
    path: string,
    data?: unknown,
    params?: Record<string, unknown>,
    options: Omit<RequestConfig, 'method' | 'data'> = {},
  ): Promise<T> {
    return this.post<T>(path, data, params, {
      ...options,
      responseType: 'arraybuffer',
      _rawResponse: true,
    });
  }

  /**
   * 下载文件，返回完整响应以便获取响应头
   */
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

  /**
   * 文件上传
   */
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

  /**
   * SSE 流式请求（使用原生 fetch）
   * 用于 Server-Sent Events 等需要读取流的场景
   *
   * @param path 请求路径
   * @param options 请求选项
   * @returns 原始 Response 对象，可读取 body stream
   *
   * @example
   * const response = await httpClient.fetchStream('/api/stream', {
   *   method: 'POST',
   *   body: { query: 'test' }
   * });
   * const reader = response.body?.getReader();
   */
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
    const {
      method = 'POST',
      body,
      params,
      headers = {},
      timeout,
      signal: externalSignal,
    } = options;

    // 构建完整 URL（SSE 流式请求优先使用 streamBaseURL 绕过不支持流式的代理层）
    const baseURL = this.config.streamBaseURL || this.config.baseURL || '';
    let url = `${baseURL}${path}`;

    // 添加查询参数
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

    // 构建请求头
    const requestHeaders: Record<string, string> = {
      ...this.config.headers,
      ...headers,
    };

    // 添加 Authorization（仅发往 API / 可信来源）
    const trustedRequest = this.isTrustedUrl(url);
    const token = this.config.getToken();
    if (token && trustedRequest) {
      requestHeaders['Authorization'] = `Bearer ${token}`;
    }

    // 注入 X-Request-Id
    if (!requestHeaders['X-Request-Id']) {
      requestHeaders['X-Request-Id'] = generateRequestId();
    }

    // 处理请求体
    let requestBody: string | undefined;
    if (body) {
      if (body instanceof FormData) {
        // FormData 不设置 Content-Type，让浏览器自动设置
        delete requestHeaders['Content-Type'];
        requestBody = body as any;
      } else {
        requestHeaders['Content-Type'] = 'application/json';
        requestBody = JSON.stringify(body);
      }
    }

    // 设置超时和 abort signal
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let signal: AbortSignal | undefined;

    if (externalSignal && !timeout) {
      // 使用外部提供的 signal
      signal = externalSignal;
    } else {
      // 创建内部 controller；同时跟随外部 signal，使 timeout 与调用方取消可以并存
      const internal = new AbortController();
      signal = internal.signal;
      if (externalSignal) {
        if (externalSignal.aborted) internal.abort(externalSignal.reason);
        else externalSignal.addEventListener('abort', () => internal.abort(externalSignal.reason), { once: true });
      }
      if (timeout) {
        timeoutId = setTimeout(() => internal.abort(new DOMException('Timeout', 'AbortError')), timeout);
      }
    }

    try {
      let response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal,
        credentials: this.config.withCredentials ? 'include' : 'same-origin',
      });

      if (timeoutId) clearTimeout(timeoutId);

      // 处理 401 未授权（外部来源的 401 与本应用会话无关）
      if (response.status === 401 && trustedRequest) {
        const refreshFn = this.resolveRefresh();

        // 尝试刷新 token
        if (refreshFn) {
          try {
            const tokens = await awaitWithSignal(this.refreshAccessToken(refreshFn, token ?? undefined), signal);
            externalSignal?.throwIfAborted();

            requestHeaders['Authorization'] = `Bearer ${tokens.access_token}`;

          } catch (error) {
            if (externalSignal?.aborted) throw externalSignal.reason ?? error;
            if (axios.isCancel(error)) throw error;
            // 如果已经处理过（例如 retryResponse.status === 401 的 throw 被捕获），直接向上抛出避免重复处理
            if ((error as { _authHandled?: boolean } | null)?._authHandled) throw error;
            const failure = normalizeRefreshFailure(error);
            if (failure.status !== 401 && failure.status !== 403) throw failure;
            this.config.clearAuth();
            this.config.onUnauthorized();
            throw Object.assign(new Error('认证失败'), { _authHandled: true });
          }
          // Transport/permission failures after refresh are not failed authentication.
          response = await fetch(url, {
            method, headers: requestHeaders, body: requestBody, signal,
            credentials: this.config.withCredentials ? 'include' : 'same-origin',
          });
          if (response.status === 401) {
            this.config.clearAuth();
            this.config.onUnauthorized();
            throw Object.assign(new Error('认证失败'), { _authHandled: true });
          }
        } else {
          // 没有刷新 token 的能力，直接处理 401
          this.config.clearAuth();
          this.config.onUnauthorized();
          throw Object.assign(new Error('未授权，请先登录'), { _authHandled: true });
        }
      }

      // 处理 403 禁止访问
      if (response.status === 403 && trustedRequest) {
        this.config.onForbidden();
        throw Object.assign(new Error('没有访问权限'), { _authHandled: true });
      }

      // 其他错误状态
      if (!response.ok) {
        const errorText = await response.text().catch(() => '请求失败');
        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.message || errorJson.error || errorText;
        } catch {
          // 不是 JSON，使用原始文本
        }
        throw Object.assign(new Error(errorMessage), { status: response.status, _httpStatus: response.status });
      }

      return response;
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);

      // Caller cancellation is not a timeout or lost authentication, including
      // aborts while awaiting a shared refresh. Never show a global failure toast.
      if (externalSignal?.aborted) throw externalSignal.reason ?? error;
      // The session ended while refreshing: an expected cancellation, not a failure toast.
      if (axios.isCancel(error)) throw error;
      // DOMException is not always an Error instance of this realm (e.g. jsdom).
      if ((error as { name?: unknown } | null)?.name === 'AbortError') {
        const timeoutError = new Error('请求超时');
        this.config.errorHandler(timeoutError);
        throw timeoutError;
      }
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

  /**
   * 获取原始axios实例（用于特殊场景）
   */
  getAxiosInstance(): AxiosInstance {
    return this.api;
  }
}

/** Decode bounded JSON error bodies without changing the original transport evidence. */
async function readErrorData(body: unknown): Promise<Record<string, unknown>> {
  const maxBytes = 1024 * 1024;
  try {
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      if (body.size > maxBytes) return {};
      body = JSON.parse(await body.text());
    } else if (body instanceof ArrayBuffer) {
      if (body.byteLength > maxBytes) return {};
      body = JSON.parse(new TextDecoder().decode(body));
    }
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown> : {};
  } catch {
    // Non-JSON files and unsupported encodings still retain response.data.
    return {};
  }
}

/** Stop waiting without cancelling a shared refresh needed by other requests. */
function awaitWithSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export function createHttpClient(config: HttpClientConfig = {}): HttpClient {
  return new HttpClient(config);
}

/** Refresh through an HttpOnly cookie without exposing a refresh token to the caller. */
export function createCookieRefresh(url: string): (signal?: AbortSignal) => Promise<{ access_token: string }> {
  return async (signal) => {
    const response = await axios.post(url, {}, signal ? { withCredentials: true, signal } : { withCredentials: true });
    const payload = response.data?.result ?? response.data;
    if (typeof payload?.access_token !== 'string' || !payload.access_token) {
      // An HTTP answer arrived: carry its status so callers know nothing is still in flight.
      throw Object.assign(new Error('Invalid access-token refresh response'), { status: response.status });
    }
    return { access_token: payload.access_token };
  };
}
