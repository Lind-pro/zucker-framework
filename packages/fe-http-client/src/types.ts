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
  refreshTokenFn?: (
    refreshToken: string,
  ) => Promise<{ access_token: string; refresh_token: string }>;
  /** Refresh using a browser-managed HttpOnly cookie, without exposing a refresh token to JavaScript. */
  refreshWithCookie?: () => Promise<{ access_token: string }>;
  /**
   * Extra origins (e.g. `https://files.example.com`) that may receive the `Authorization`
   * bearer and whose response-header tokens may be adopted. Requests relative to `baseURL`,
   * requests to the `baseURL`/`streamBaseURL` origin and same-origin requests are always trusted;
   * any other absolute URL is sent without the bearer.
   */
  trustedOrigins?: readonly string[];
  /**
   * Adoption of tokens returned in `x-auth-token` / `authorization` / `x-token` response headers.
   * Default true: adopted only from trusted origins, when the request is not aborted and was sent
   * with the access token that is still current (so a late response never restores a session
   * that signed out or switched). false disables adoption; a function adds a consumer check.
   */
  acceptResponseToken?: boolean | ((token: string, context: { url: string }) => boolean);
  /** Optional browser lock name shared by applications using the same refresh session. */
  refreshLockName?: string;
  /** Handle non-authentication response errors; return true to suppress the general error handler. */
  onResponseError?: (error: Error, response: Record<string, unknown>) => boolean | void;
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
