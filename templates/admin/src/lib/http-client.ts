import { createHttpClient, createCookieRefresh } from '@zucker-framework/fe-http-client';
import useAuthStore from '../stores/useAuthStore';

interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  pageIndex: number;
}

export const httpClient = createHttpClient({
  baseURL: '/api',
  timeout: 60000,
  withCredentials: true,
  refreshWithCookie: createCookieRefresh('/api/authorize/refresh'),
  refreshLockName: 'zucker-account-refresh',

  getToken: () => useAuthStore.getState().token,
  setToken: (token) => useAuthStore.getState().updateToken(token),
  clearAuth: () => useAuthStore.getState().logout(),

  onUnauthorized: () => {
    useAuthStore.getState().logout();
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`;
    }
  },

  onForbidden: () => {
    // 403 由各页面自行处理
  },
});

export const accountPublicClient = createHttpClient({
  baseURL: '/api', withCredentials: true,
  getToken: () => null, clearAuth: () => {}, onUnauthorized: () => {},
});

/**
 * 标准分页查询辅助函数 — 封装 POST /{path}/_query
 *
 * @param path  资源路径，如 '/users'、'/roles'
 * @param params ProTable 传入的 params（current 1-based，pageSize，以及搜索字段）
 * @returns     { data, total } 供 ProTable request 直接使用
 */
export async function queryRequest<T>(
  path: string,
  params: { current?: number; pageSize?: number; [key: string]: unknown } = {},
): Promise<{ data: T[]; total: number; success: boolean }> {
  const { current = 1, pageSize = 20, ...filters } = params;

  // 将搜索字段转换为 filter map 格式：{ "field$like": value, ... }
  const filterMap: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      filterMap[key] = value;
    }
  }

  const result = await httpClient.post<PaginatedResult<T>>(`${path}/_query`, {
    pageIndex: current - 1,
    pageSize,
    ...(Object.keys(filterMap).length > 0 ? { filter: filterMap } : {}),
  });

  return {
    data: result.data,
    total: result.total,
    success: true,
  };
}

export default httpClient;
