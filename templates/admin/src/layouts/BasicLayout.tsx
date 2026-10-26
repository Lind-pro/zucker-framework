import React, { useState, useEffect, useMemo } from 'react';
import { Outlet, useNavigate, useLocation, Link, Navigate } from 'react-router';
import { ProLayout } from '@ant-design/pro-components';
import type { MenuDataItem } from '@ant-design/pro-components';
import { LogoutOutlined, SunOutlined, MoonOutlined, UserOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Dropdown,
  Skeleton,
  theme,
  Button,
  Breadcrumb,
  Alert,
  Result,
  Grid,
} from 'antd';
import useAuthStore from '../stores/useAuthStore';
import useThemeStore from '../stores/useThemeStore';
import httpClient from '../lib/http-client';

import {
  adminRoutes,
  adminMenuName,
  visibleAdminMenus,
  type BackendMenuItem,
} from '../config/admin-navigation';
import { LanguageSwitcher, useAdminI18n, type AdminLocale } from '../i18n';

function toMenuDataItem(item: BackendMenuItem, locale: AdminLocale): MenuDataItem {
  return {
    key: item.id,
    name: adminMenuName(item, locale),
    path: item.path,
    children: item.children?.map((child) => toMenuDataItem(child, locale)),
  };
}

/** Recursively find breadcrumb chain for a given pathname in menu tree */
function findBreadcrumbChain(menus: MenuDataItem[], pathname: string): MenuDataItem[] | null {
  for (const item of menus) {
    if (item.path && pathname === item.path) {
      return [item];
    }
    if (item.children) {
      const chain = findBreadcrumbChain(item.children, pathname);
      if (chain) return [item, ...chain];
    }
  }
  return null;
}

const BasicLayout: React.FC = () => {
  const navigate = useNavigate();
  const { locale, t } = useAdminI18n();
  const screens = Grid.useBreakpoint();
  const { message } = AntdApp.useApp();
  const location = useLocation();
  const { user, isAuthenticated, token, logout, hasPermission } = useAuthStore();
  const { token: themeToken } = theme.useToken();
  const { themeMode, toggleTheme } = useThemeStore();
  const isDark = themeMode === 'dark';
  const [collapsed, setCollapsed] = useState(false);
  const [backendMenus, setBackendMenus] = useState<BackendMenuItem[]>([]);
  const menuRoutes = useMemo(
    () => backendMenus.map((item) => toMenuDataItem(item, locale)),
    [backendMenus, locale],
  );
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState(false),
    [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!isAuthenticated || !token) return;
    let active = true;
    httpClient
      .get<BackendMenuItem[]>('/menu/tree')
      .then((items) => {
        if (!active) return;
        setBackendMenus(visibleAdminMenus(items, hasPermission));
        setMenuError(false);
      })
      .catch(() => {
        if (active) setMenuError(true);
      })
      .finally(() => {
        if (active) setMenuLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isAuthenticated, token, hasPermission, retry]);

  const breadcrumbItems = useMemo(() => {
    const items: { title: React.ReactNode }[] = [
      { title: <Link to="/dashboard">{t('首页')}</Link> },
    ];
    const chain = findBreadcrumbChain(menuRoutes, location.pathname);
    if (chain) {
      chain.forEach((item, idx) => {
        const isLast = idx === chain.length - 1;
        items.push({
          title: isLast ? (
            <span>{item.name}</span>
          ) : (
            <Link to={item.path || '/dashboard'}>{item.name}</Link>
          ),
        });
      });
    }
    return items;
  }, [menuRoutes, location.pathname, t]);

  if (!isAuthenticated || !token) {
    return <Navigate to="/login" replace />;
  }

  const handleLogout = async () => {
    try {
      const result = await httpClient.post<{ success: boolean }>('/authorize/logout');
      if (result.success !== true) throw new Error('Unexpected logout response');
      logout();
      message.success(t('已成功退出登录', 'Signed out successfully'));
      navigate('/login');
    } catch {
      message.error(t('退出未完成，请重试', 'Could not sign out. Try again.'));
    }
  };

  if (menuLoading) {
    return (
      <div style={{ padding: 24 }}>
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  return (
    <ProLayout
      title={t('管理后台')}
      logo={null}
      layout="mix"
      navTheme={isDark ? 'realDark' : 'light'}
      fixedHeader
      fixSiderbar
      siderWidth={220}
      collapsed={collapsed}
      onCollapse={setCollapsed}
      location={{ pathname: location.pathname }}
      route={{ path: '/', routes: menuRoutes }}
      token={{
        sider: {
          colorMenuBackground: isDark ? '#0F172A' : '#fff',
          colorMenuItemDivider: isDark ? '#1E293B' : '#f0f0f0',
          colorTextMenu: isDark ? '#94A3B8' : '#64748B',
          colorTextMenuSelected: isDark ? '#818CF8' : themeToken.colorPrimary,
          colorBgMenuItemSelected: isDark ? 'rgba(67,56,202,0.15)' : '#EEF2FF',
          colorTextMenuItemHover: isDark ? '#818CF8' : themeToken.colorPrimary,
          colorBgMenuItemHover: isDark ? 'rgba(255,255,255,0.04)' : '#F8FAFC',
        },
        header: {
          colorBgHeader: isDark ? '#0F172A' : '#fff',
          heightLayoutHeader: 56,
        },
        pageContainer: {
          paddingBlockPageContainerContent: 24,
          paddingInlinePageContainerContent: 24,
        },
      }}
      actionsRender={() => [
        <LanguageSwitcher key="language" />,
        <Button
          key="theme-toggle"
          type="text"
          icon={isDark ? <SunOutlined /> : <MoonOutlined />}
          onClick={toggleTheme}
          title={
            isDark
              ? t('切换到亮色模式', 'Switch to light mode')
              : t('切换到暗色模式', 'Switch to dark mode')
          }
          style={{ fontSize: 16, color: isDark ? '#94A3B8' : '#64748B' }}
        />,
      ]}
      avatarProps={{
        size: 'small',
        title: (user?.username as string) || t('用户', 'User'),
        render: (_props, dom) => (
          <Dropdown
            menu={{
              items: [
                {
                  key: 'profile',
                  label: t('个人中心'),
                  icon: <UserOutlined />,
                  onClick: () => navigate('/profile'),
                },
                { type: 'divider' as const },
                {
                  key: 'logout',
                  label: t('退出登录', 'Sign out'),
                  icon: <LogoutOutlined />,
                  onClick: handleLogout,
                },
              ],
            }}
          >
            {dom}
          </Dropdown>
        ),
      }}
      headerContentRender={() =>
        screens.md ? <Breadcrumb items={breadcrumbItems} style={{ marginLeft: 16 }} /> : null
      }
      menuItemRender={(item, dom) => <Link to={item.path || '/dashboard'}>{dom}</Link>}
    >
      {menuError && (
        <Alert
          type="error"
          showIcon
          message={t('菜单加载失败', 'Could not load navigation')}
          description={t(
            '连接恢复后可重试；不会用示例菜单代替服务端结果。',
            'Try again when the connection is restored. Navigation uses the actual server result.',
          )}
          action={
            <Button
              onClick={() => {
                setMenuLoading(true);
                setRetry((value) => value + 1);
              }}
            >
              {t('重试')}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}
      {!menuError && menuRoutes.length === 0 && (
        <Alert
          type="info"
          message={t('当前没有可见菜单', 'No navigation is available')}
          description={t(
            '请由应用管理员分配已启用功能的权限和菜单。',
            'Ask an administrator to assign access and navigation for enabled features.',
          )}
          style={{ marginBottom: 16 }}
        />
      )}
      {adminRoutes[location.pathname]?.permission &&
      !hasPermission(adminRoutes[location.pathname]!.permission!) ? (
        <Result
          status="403"
          title={t('没有访问权限', 'Access denied')}
          subTitle={t(
            '请从已授权菜单选择功能，或联系应用管理员。',
            'Choose an authorized feature or contact an administrator.',
          )}
        />
      ) : (
        <Outlet />
      )}
    </ProLayout>
  );
};

export default BasicLayout;
