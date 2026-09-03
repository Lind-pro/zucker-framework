import React, { useState, useEffect, useMemo } from 'react';
import { Outlet, useNavigate, useLocation, Link, Navigate } from 'react-router';
import { ProLayout } from '@ant-design/pro-components';
import type { MenuDataItem } from '@ant-design/pro-components';
import { LogoutOutlined, SunOutlined, MoonOutlined, UserOutlined } from '@ant-design/icons';
import { Dropdown, Skeleton, message, theme, Button, Breadcrumb } from 'antd';
import useAuthStore from '../stores/useAuthStore';
import useThemeStore from '../stores/useThemeStore';
import httpClient from '../lib/http-client';

interface BackendMenuItem {
  id: string;
  name: string;
  path?: string;
  icon?: string;
  type?: 'directory' | 'menu' | 'button';
  sortIndex?: number;
  children?: BackendMenuItem[];
}

function toMenuDataItem(item: BackendMenuItem): MenuDataItem | null {
  if (item.type === 'button') return null;
  const menuItem: MenuDataItem = {
    key: item.id,
    name: item.name,
    path: item.path,
  };
  if (item.children && item.children.length > 0) {
    const children = item.children
      .map(toMenuDataItem)
      .filter((c): c is MenuDataItem => c !== null);
    if (children.length > 0) menuItem.children = children;
  }
  return menuItem;
}

/** Recursively find breadcrumb chain for a given pathname in menu tree */
function findBreadcrumbChain(
  menus: MenuDataItem[],
  pathname: string,
): MenuDataItem[] | null {
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
  const location = useLocation();
  const { user, isAuthenticated, token, logout } = useAuthStore();
  const { token: themeToken } = theme.useToken();
  const { themeMode, toggleTheme } = useThemeStore();
  const isDark = themeMode === 'dark';
  const [collapsed, setCollapsed] = useState(false);
  const [menuRoutes, setMenuRoutes] = useState<MenuDataItem[]>([]);
  const [menuLoading, setMenuLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated || !token) return;
    httpClient
      .get<BackendMenuItem[]>('/menu/tree')
      .then((items) => {
        const routes = items
          .map(toMenuDataItem)
          .filter((c): c is MenuDataItem => c !== null);
        setMenuRoutes(routes);
      })
      .catch(() => {
        // silently degrade when menu loading fails
      })
      .finally(() => setMenuLoading(false));
  }, [isAuthenticated, token]);

  const breadcrumbItems = useMemo(() => {
    const items: { title: React.ReactNode }[] = [
      { title: <Link to="/dashboard">首页</Link> },
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
  }, [menuRoutes, location.pathname]);

  if (!isAuthenticated || !token) {
    return <Navigate to="/login" replace />;
  }

  const handleLogout = () => {
    logout();
    message.success('已成功退出登录');
    navigate('/login');
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
      title="管理后台"
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
        <Button
          key="theme-toggle"
          type="text"
          icon={isDark ? <SunOutlined /> : <MoonOutlined />}
          onClick={toggleTheme}
          title={isDark ? '切换到亮色模式' : '切换到暗色模式'}
          style={{ fontSize: 16, color: isDark ? '#94A3B8' : '#64748B' }}
        />,
      ]}
      avatarProps={{
        size: 'small',
        title: (user?.username as string) || '用户',
        render: (_props, dom) => (
          <Dropdown
            menu={{
              items: [
                {
                  key: 'profile',
                  label: '个人中心',
                  icon: <UserOutlined />,
                  onClick: () => navigate('/profile'),
                },
                { type: 'divider' as const },
                {
                  key: 'logout',
                  label: '退出登录',
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
      headerContentRender={() => (
        <Breadcrumb items={breadcrumbItems} style={{ marginLeft: 16 }} />
      )}
      menuItemRender={(item, dom) => (
        <Link to={item.path || '/dashboard'}>{dom}</Link>
      )}
    >
      <Outlet />
    </ProLayout>
  );
};

export default BasicLayout;
