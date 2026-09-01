import { AxiosRequestConfig } from 'axios';

/** Standard API response envelope returned by the backend. */
export interface ApiResponse<T = unknown> {
  /** Business status code (e.g. 200 for success). */
  status?: number;
  /** Whether the request was successful. */
  success?: boolean;
  /** Human-readable response message. */
  message?: string;
  /** The typed response payload. */
  result?: T;
}

/** Callback invoked when an HTTP request encounters an error. */
export type ErrorHandler = (error: Error, response?: ApiResponse<unknown>) => void;

/** Extended Axios request configuration with additional control flags. */
export interface RequestConfig extends Omit<AxiosRequestConfig, 'method' | 'data'> {
  /** When true, suppresses the global error handler for this request. */
  _hideError?: boolean;
  /** Per-request error handler that overrides the global one. */
  errorHandler?: ErrorHandler;
  /** When true, returns the raw AxiosResponse instead of unwrapping. */
  _rawResponse?: boolean;
}

/** Configuration options for creating an HttpClient instance. */
export interface HttpClientConfig {
  /** Base URL prepended to all request paths. */
  baseURL?: string;
  /** Separate base URL used for streaming (SSE/fetch) requests. */
  streamBaseURL?: string;
  /** Request timeout in milliseconds (default: 60000). */
  timeout?: number;
  /** Default headers applied to every request. */
  headers?: Record<string, string>;
  /** Whether to send cookies with cross-origin requests. */
  withCredentials?: boolean;
  /** Business status code that indicates a successful response (default: 200). */
  successCode?: number;
  /** Storage key used when persisting the auth token. */
  tokenKey?: string;
  /** Retrieve the current access token for Authorization headers. */
  getToken?: () => string | null | undefined;
  /** Retrieve the current refresh token for silent renewal. */
  getRefreshToken?: () => string | null | undefined;
  /** Persist a new access token after refresh or header update. */
  setToken?: (token: string) => void;
  /** Persist a new refresh token after renewal. */
  setRefreshToken?: (token: string) => void;
  /** Clear all stored authentication data (tokens, user info). */
  clearAuth?: () => void;
  /** Async function that exchanges a refresh token for new token pair. */
  refreshTokenFn?: (refreshToken: string) => Promise<{ access_token: string; refresh_token: string }>;
  /** Global error handler invoked on request failures. */
  errorHandler?: ErrorHandler;
  /** Callback triggered on 401 Unauthorized responses. */
  onUnauthorized?: () => void;
  /** Callback triggered on 403 Forbidden responses. */
  onForbidden?: () => void;
}

/** Response shape returned by the file download method. */
export interface DownloadResponse {
  /** Raw file content as an ArrayBuffer. */
  data: ArrayBuffer;
  /** Response headers (e.g. Content-Disposition for filename). */
  headers: Record<string, string>;
  /** HTTP status code of the download response. */
  status: number;
}
