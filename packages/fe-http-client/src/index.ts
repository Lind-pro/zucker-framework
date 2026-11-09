export {
  type ApiResponse,
  type ErrorHandler,
  type RequestConfig,
  type HttpClientConfig,
  type DownloadResponse,
} from './types';

export { HttpClient, createHttpClient, createCookieRefresh } from './http-client';
export {
  createKeepaliveCookieRefresh,
  createRefreshExchange,
  combineAbortSignals,
  refreshErrorStatus,
  RefreshTimeoutError,
  DEFAULT_REFRESH_GRACE_MS,
  DEFAULT_REFRESH_TIMEOUT_MS,
  type RefreshTransport,
  type RefreshExchangeOptions,
  type KeepaliveCookieRefreshOptions,
} from './cookie-refresh';
export {
  connectSse,
  parseSseEventBlock,
  readSseStream,
  type SseConnectionOptions,
  type SseEvent,
  type SseStreamOptions,
} from './sse';

export { BaseService } from './base.service';
export type { BaseQueryParams, OperatorMap, BaseResponse, PageResponse, BaseServiceConfig } from './base.service';
export { proxyHttpRequest, type ProxyHttpRequestOptions } from './proxy';
export { extractErrorMessage, type ExtractErrorMessageOptions } from './error-message';
