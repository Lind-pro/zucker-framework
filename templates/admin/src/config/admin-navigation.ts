/** Consumer route/permission catalog. This never grants server permissions. */
import { translateAdminText, type AdminLocale } from '../i18n/messages.ts';
export const adminRoutes: Readonly<Record<string, { name: string; permission?: string }>> = {
  '/dashboard': { name: '概览', permission: 'dashboard:query' },
  '/users': { name: '用户', permission: 'users:query' },
  '/roles': { name: '角色', permission: 'roles:query' },
  '/permissions': { name: '权限', permission: 'permissions:query' },
  '/menu': { name: '菜单', permission: 'menu:query' },
  '/dictionary': { name: '数据字典', permission: 'dictionary:query' },
  '/connections': { name: '连接配置', permission: 'config:query' },
  '/config': { name: '站点配置', permission: 'content:manage' },
  '/credit': { name: '积分', permission: 'credit:query' },
  '/access-log': { name: '访问日志', permission: 'logging:query' },
  '/form-engine': { name: '动态表单', permission: 'form:query' },
  '/system-monitor': { name: '健康检查', permission: 'dashboard:query' },
  '/content': { name: '页面、博客与文档', permission: 'content:manage' },
  '/content/categories': { name: '博客分类', permission: 'content:manage' },
  '/records/api-keys': { name: 'API 密钥', permission: 'api-keys:query' },
  '/refunds': { name: '退款管理', permission: 'billing:refund' },
  '/records/orders': { name: '订单', permission: 'billing:query' },
  '/records/subscriptions': { name: '订阅', permission: 'billing:query' },
  '/records/jobs': { name: '任务', permission: 'jobs:query' },
  '/records/deliveries': { name: '通知投递', permission: 'notification:query' },
  '/records/files': { name: '文件资产', permission: 'files:query' },
  '/records/operation-logs': { name: '操作审计', permission: 'logging:query' },
  '/profile': { name: '个人中心' },
};
export interface BackendMenuItem {
  id: string;
  name: string;
  path?: string;
  icon?: string;
  parentId?: string;
  sortOrder: number;
  status: boolean;
  permissions: string[];
  properties?: Record<string, unknown>;
  children?: BackendMenuItem[];
}
const starterPaths: Readonly<Record<string, string>> = {
  dashboard: '/dashboard',
  users: '/users',
  roles: '/roles',
  permissions: '/permissions',
  'api-keys': '/records/api-keys',
  content: '/content',
  categories: '/content/categories',
  config: '/config',
  orders: '/records/orders',
  subscriptions: '/records/subscriptions',
  credit: '/credit',
  refunds: '/refunds',
  jobs: '/records/jobs',
  deliveries: '/records/deliveries',
  files: '/records/files',
  'access-log': '/access-log',
  'operation-logs': '/records/operation-logs',
  'system-monitor': '/system-monitor',
  connections: '/connections',
  menu: '/menu',
  dictionary: '/dictionary',
  form: '/form-engine',
};
const starterGroups: Readonly<Record<string, string>> = {
  identity: '用户与权限',
  site: '内容与站点',
  commerce: '交易与额度',
  operations: '运行与审计',
  system: '系统设置',
};
/** Translate only unchanged starter records; custom names, paths and menu identities are user data. */
export function adminMenuName(item: BackendMenuItem, locale: AdminLocale): string {
  if (!item.id.startsWith('starter:')) return item.name;
  const key = item.id.slice('starter:'.length),
    path = starterPaths[key];
  const original = path ? adminRoutes[path]?.name : starterGroups[key];
  return original && item.name === original && (item.path || undefined) === path
    ? translateAdminText(locale, original)
    : item.name;
}
export function visibleAdminMenus(
  items: BackendMenuItem[],
  hasPermission: (permission: string) => boolean,
): BackendMenuItem[] {
  return items
    .filter((item) => item.status !== false)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .flatMap((item) => {
      const children = visibleAdminMenus(item.children ?? [], hasPermission);
      if (!item.path) return children.length ? [{ ...item, children }] : [];
      const route = adminRoutes[item.path];
      if (!route || (route.permission && !hasPermission(route.permission)))
        return children.length ? [{ ...item, path: undefined, children }] : [];
      return [{ ...item, children }];
    });
}
